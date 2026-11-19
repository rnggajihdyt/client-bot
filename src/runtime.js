import { WaClient } from 'zapo-js'
import qrcode from 'qrcode-terminal'
import { config } from './config.js'
import { store } from './store.js'
import { attachHandlers } from './handler.js'
import { setSessionStatus, getSession } from './registry.js'

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

// Connects WhatsApp sessions at runtime (no restart) and keeps their clients
// alive for reconnect + graceful shutdown.
export function createRuntime(logger) {
  const clients = new Map()
  const api = { startSession, stopSession, stopAll, clients }

  // Watchdog: a client that never reaches a stable connection is rebuilt from
  // scratch (disconnect + fresh WaClient). Real state comes from the
  // 'connection' event — getState() only reports auth, not the socket.
  const STABLE_MS = 120_000
  const GIVE_UP_MS = 180_000
  const health = new Map() // sessionId -> { since, open }
  const markOpen = (sessionId, open) => {
    const h = health.get(sessionId) ?? { since: Date.now(), open: false }
    if (open !== h.open) Object.assign(h, { since: Date.now(), open })
    health.set(sessionId, h)
  }

  function connectWithRetry(client, sessionId) {
    // Unbounded: a 10h uptime target must survive more than 10 drops.
    let attempt = 0
    let reconnecting = false

    client.on('connection', (event) => {
      // Stale client (rebuilt or stopped): ignore everything, stop looping.
      if (clients.get(sessionId) !== client) return
      markOpen(sessionId, event.status === 'open')
      if (event.status === 'open') {
        attempt = 0
        logger.info({ sessionId }, 'connected')
        return
      }
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
            return // a close event will drive the next loop if it drops again
          } catch (err) {
            logger.error({ sessionId, err }, 'reconnect failed')
          }
        }
      } finally {
        reconnecting = false
      }
    }
  }

  // Always link-code: request the 8-char code as soon as the server is ready.
  function handlePairing(client, sessionId, notify) {
    client.on('auth_qr', ({ qr, ttlMs }) => {
      // No phone to pair with → fall back to QR in the terminal.
      if (getSession(sessionId)?.pairing_phone || config.pairingPhone) return
      logger.info({ sessionId }, `QR valid for ${ttlMs}ms — scan from WhatsApp → Linked devices`)
      qrcode.generate(qr, { small: true })
    })

    client.on('auth_pairing_required', async () => {
      const phone = getSession(sessionId)?.pairing_phone || config.pairingPhone
      if (!phone) {
        logger.error({ sessionId }, 'pairing phone unknown — SESIBUAT.ID.ADMIN.NOMORWA')
        return
      }
      try {
        const code = await client.auth.requestPairingCode(phone)
        logger.info({ sessionId }, `Enter on phone ${phone}: ${formatCode(code)}`)
        await notify?.(`*Pairing ${sessionId}*\nNomor: ${phone}\nKode: ${formatCode(code)}\n\nBuka WhatsApp di nomor itu → Perangkat tertaut → Tautkan dengan nomor telepon, lalu masukkan kode.`)
      } catch (err) {
        logger.error({ sessionId, err }, 'requestPairingCode failed')
        await notify?.(`Gagal minta kode pairing untuk ${sessionId}. Cek nomor ${phone}.`)
      }
    })

    client.on('auth_paired', ({ credentials }) => {
      logger.info({ sessionId }, `Paired as ${credentials.meJid}`)
      void notify?.(`Session ${sessionId} berhasil tertaut sebagai ${credentials.meJid}.`)
    })

    client.on('auth_passkey_required', ({ hasSigner }) => {
      if (!hasSigner) logger.warn({ sessionId }, 'passkey required — link cannot proceed headless')
    })
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
    handlePairing(client, sessionId, notify)
    connectWithRetry(client, sessionId)
    attachHandlers(client, sessionId, logger, api)
    setSessionStatus(sessionId, 'on')

    // connect() stays pending until paired; never await it here.
    client.connect().catch((err) => logger.error({ sessionId, err }, 'connect failed'))
    return client
  }

  // Watchdog interval — helpers above; interval at the bottom of createRuntime.
  const watchdog = setInterval(() => {
    const now = Date.now()
    for (const sessionId of clients.keys()) {
      const h = health.get(sessionId) ?? { since: now }
      if (h.open) {
        if (now - h.since > STABLE_MS) health.delete(sessionId) // healthy again
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
    if (client) await client.disconnect().catch(() => {})
    await startSession(sessionId)
  }

  async function stopSession(sessionId) {
    const client = clients.get(sessionId)
    clients.delete(sessionId)
    setSessionStatus(sessionId, 'off')
    // Graceful disconnect keeps credentials; the close event's
    // client_disconnected reason must not trigger a reconnect.
    if (client) await client.disconnect().catch(() => {})
  }

  async function stopAll() {
    const all = [...clients.values()]
    clients.clear()
    await Promise.allSettled(all.map((c) => c.disconnect()))
  }

  return api
}