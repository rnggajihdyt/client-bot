import { WaClient } from 'zapo-js'
import qrcode from 'qrcode-terminal'
import { config } from './config.js'
import { store } from './store.js'
import { attachHandlers } from './handler.js'
import { setSessionStatus, getSession, isBootstrapSession, createSession } from './registry.js'
import { runOnboarding } from './apikey.js'

const formatCode = (code) => code.match(/.{1,4}/g)?.join('-') ?? code

// Reasons that mean "re-pair required": reconnecting with the same credentials
// only produces the same failure in a loop.
const FATAL = new Set([
  'stream_error_replaced',
  'stream_error_device_removed',
  'stream_error_force_logout',
  'failure_not_authorized',
  'failure_banned',
  'failure_locked',
  'failure_bad_user_agent',
  'primary_identity_key_change',
])

// Removes every domain of a session from the shared auth store. Pairing a
// deleted session again would otherwise resume the *old* credentials, and the
// server never asks for a new code.
const STORE_DOMAINS = [
  'auth',
  'signal',
  'preKey',
  'session',
  'identity',
  'senderKey',
  'appState',
  'privacyToken',
  'messages',
  'threads',
  'contacts',
]

export async function wipeSessionStore(sessionId) {
  const bundle = store.session(sessionId)
  for (const domain of STORE_DOMAINS) await bundle[domain].clear()
  await bundle.destroyCaches?.()
  await bundle.destroy()
}

// Connects WhatsApp sessions at runtime (no restart) and keeps their clients
// alive for reconnect + graceful shutdown.
export function createRuntime(logger) {
  const clients = new Map()
  const handles = new Map() // sessionId -> handler bundle (owns its DB handle)
  const api = { startSession, stopSession, stopAll, clients, consoleNotify }

  // Watchdog: a client that never reaches a stable connection is rebuilt from
  // scratch (disconnect + fresh WaClient). Real state comes from the
  // 'connection' event — getState() only reports auth, not the socket.
  // `since` is set once at registration and never reset by transitions, so a
  // fast open/close flap still accumulates past GIVE_UP_MS and gets rebuilt.
  const STABLE_MS = 120_000
  const GIVE_UP_MS = 180_000
  const health = new Map() // sessionId -> { since, open, stableAt }
  const markOpen = (sessionId, open) => {
    const now = Date.now()
    const h = health.get(sessionId) ?? { since: now, open: false, stableAt: null }
    if (open && !h.open) h.stableAt ??= now
    if (!open && h.open) h.stableAt = null
    h.open = open
    health.set(sessionId, h)
  }

  function connectWithRetry(client, sessionId, notify) {
    // Unbounded: a 10h uptime target must survive more than 10 drops.
    let attempt = 0
    let reconnecting = false
    let onboarded = false

    client.on('connection', (event) => {
      // Stale client (rebuilt or stopped): ignore everything, stop looping.
      if (clients.get(sessionId) !== client) return
      markOpen(sessionId, event.status === 'open')
      if (event.status === 'open') {
        attempt = 0
        logger.info({ sessionId }, 'connected')
        // First open of this client: push the ICS apikey gate to the admin.
        // Resumed pairings never emit auth_paired, so this is the only hook
        // that fires for both fresh and reconnected sessions.
        if (!onboarded) {
          onboarded = true
          void runOnboarding(logger, sessionId, notify).catch((err) =>
            logger.warn({ sessionId, err: err?.message }, 'onboarding gagal')
          )
        }
        return
      }
      // Always surface why: without the reason/code a flap loop is unguessable.
      logger.warn(
        { sessionId, reason: event.reason, code: event.code, isLogout: event.isLogout },
        'connection closed'
      )
      if (event.isLogout || FATAL.has(event.reason)) {
        logger.error({ sessionId, reason: event.reason, code: event.code }, 'logged out — re-pairing required')
        return
      }
      // A single drop can surface more than one close event; without this
      // guard each one starts its own loop and they stack up.
      if (reconnecting) return
      void reconnect()
    })

    async function reconnect() {
      reconnecting = true
      try {
        for (;;) {
          const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
          attempt += 1
          logger.info({ sessionId }, `reconnecting in ${delayMs}ms (attempt ${attempt})`)
          await new Promise((r) => setTimeout(r, delayMs))
          if (clients.get(sessionId) !== client) return // stopped or rebuilt
          try {
            await client.connect()
            // connect() resolving only means the handshake started paying off;
            // a drop inside that window fires its own close event. Wait a beat
            // and check we're actually open before leaving the loop, else this
            // races the close handler into a tight reconnect spin.
            await new Promise((r) => setTimeout(r, 250))
            if (clients.get(sessionId) !== client) return // stopped or rebuilt
            if (health.get(sessionId)?.open) return
            logger.debug({ sessionId }, 'connect() resolved without open — retrying')
          } catch (err) {
            logger.error({ sessionId, err }, 'reconnect failed')
          }
        }
      } finally {
        reconnecting = false
      }
    }
  }

  // Phone known -> link-code; no phone -> QR in the terminal. The QR path
  // requests nothing, so it can render on every refresh and wait for a scan.
  function handlePairing(client, sessionId, notify) {
    const phone = () => getSession(sessionId)?.pairing_phone || config.pairingPhone

    // Fresh sessions surface as `auth_qr` (zapo emits `auth_pairing_required`
    // only on refresh/re-arm). With a phone known, the first QR is the cue to
    // request the code; without one, fall back to QR in the terminal.
    let requested = false
    client.on('auth_qr', ({ qr, ttlMs }) => {
      if (!phone()) {
        logger.info({ sessionId }, `QR valid for ${ttlMs}ms — scan from WhatsApp → Linked devices`)
        qrcode.generate(qr, { small: true })
        return
      }
      if (requested) return
      requested = true
      void requestCode()
    })

    async function requestCode() {
      const p = phone()
      if (!p) return
      try {
        await client.auth.requestPairingCode(p)
        // The code surfaces via the `auth_pairing_code` listener below.
      } catch (err) {
        logger.error({ sessionId, err }, 'requestPairingCode failed')
        requested = false
        await notify?.(`Gagal minta kode pairing untuk ${sessionId}. Cek nomor ${p}.`)
      }
    }

    client.on('auth_pairing_code', ({ code }) => {
      const p = phone()
      // Pairing code at startup goes to the console only: the owner chat does
      // not exist yet, so `notify` is absent. Later sessions push it to chat.
      logger.info({ sessionId }, `Pairing ${sessionId} nomor ${p}: ${formatCode(code)}`)
      if (!notify) return
      void notify(
        `*Pairing ${sessionId}*\nNomor: ${p}\nKode: ${formatCode(code)}\n\nBuka WhatsApp di nomor itu → Perangkat tertaut → Tautkan dengan nomor telepon, lalu masukkan kode.`
      )
    })

    // Re-arm: forceManual means the pending code died with its connection and
    // a fresh one must be requested; a plain refresh means it's still valid.
    client.on('auth_pairing_required', ({ forceManual } = {}) => {
      if (!phone()) return
      if (forceManual) requested = false
      if (requested) return
      requested = true
      void requestCode()
    })

    client.on('auth_paired', ({ credentials }) => {
      requested = false
      logger.info({ sessionId }, `Paired as ${credentials.meJid}`)
      void notify?.(`Session ${sessionId} berhasil tertaut sebagai ${credentials.meJid}.`)
    })

    client.on('auth_passkey_required', ({ hasSigner }) => {
      if (!hasSigner) logger.warn({ sessionId }, 'passkey required — link cannot proceed headless')
    })
  }

  // Startup sessions have no owner chat to notify into, so anything the pairing
  // flow would send is printed to the log instead of silently dropped.
  function consoleNotify(sessionId) {
    return (text) => logger.info({ sessionId }, String(text).replace(/\n+/g, ' | '))
  }

  // QR pairing (bootstrap, no phone on record) creates an account in the registry
  // so the next start resumes it instead of forgetting it.
  function registerBootstrapSession(sessionId, meJid) {
    // Only the env bootstrap session may be armed by QR; any other id must come
    // from SESIBUAT so it has an admin (and never equals its own bot number).
    if (!isBootstrapSession(sessionId) || getSession(sessionId)) return
    try {
      createSession({ id: sessionId, label: 'Bootstrap (QR)', adminNohp: '', pairingPhone: '', status: 'on' })
      logger.info({ sessionId, meJid }, 'session QR didaftarkan ke registry')
    } catch (err) {
      // WhatsApp is already paired; a registry hiccup must not take it down.
      logger.error({ sessionId, err: err?.message }, 'gagal daftarkan session bootstrap')
    }
  }

  async function startSession(sessionId, { notify } = {}) {
    if (clients.has(sessionId)) return clients.get(sessionId)

    const client = new WaClient(
      {
        store,
        sessionId,
        connectTimeoutMs: 15_000,
        nodeQueryTimeoutMs: 30_000,
        history: { enabled: true, requireFullSync: true },
      },
      logger
    )
    clients.set(sessionId, client)
    handlePairing(client, sessionId, notify ?? consoleNotify(sessionId))
    connectWithRetry(client, sessionId, notify)
    client.on('auth_paired', ({ credentials }) => registerBootstrapSession(sessionId, credentials.meJid))
    handles.set(sessionId, attachHandlers(client, sessionId, logger, api))
    setSessionStatus(sessionId, 'on')

    // connect() stays pending until paired; never await it here.
    client.connect().catch((err) => logger.error({ sessionId, err }, 'connect failed'))
    return client
  }

  // Watchdog interval — helpers above; interval at the bottom of createRuntime.
  const watchdog = setInterval(() => {
    const now = Date.now()
    for (const sessionId of clients.keys()) {
      const h = health.get(sessionId) ?? { since: now, open: false, stableAt: null }
      if (h.stableAt && now - h.stableAt > STABLE_MS) {
        health.delete(sessionId) // healthy again
        continue
      }
      if (now - h.since > GIVE_UP_MS) {
        logger.error({ sessionId }, 'watchdog: no stable connection, rebuilding client')
        health.delete(sessionId)
        void rebuild(sessionId)
      }
    }
  }, 30_000)
  watchdog.unref?.()

  async function rebuild(sessionId) {
    const client = clients.get(sessionId)
    clients.delete(sessionId)
    handles.get(sessionId)?.close()
    handles.delete(sessionId)
    if (client) await client.disconnect().catch(() => {})
    await startSession(sessionId, { notify: consoleNotify(sessionId) })
  }

  async function stopSession(sessionId) {
    const client = clients.get(sessionId)
    clients.delete(sessionId)
    handles.get(sessionId)?.close()
    handles.delete(sessionId)
    setSessionStatus(sessionId, 'off')
    // Graceful disconnect keeps credentials; the close event's
    // client_disconnected reason must not trigger a reconnect.
    if (client) await client.disconnect().catch(() => {})
  }

  async function stopAll() {
    const all = [...clients.keys()]
    clients.clear()
    await Promise.allSettled(all.map((id) => stopSession(id)))
  }

  return api
}