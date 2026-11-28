import { WaClient } from 'zapo-js'
import qrcode from 'qrcode-terminal'
import { config } from './config.js'
import { store } from './store.js'
import { attachHandlers } from './handler.js'
import { setSessionStatus, getSession, isBootstrapSession, createSession } from './registry.js'
import { runOnboarding } from './apikey.js'
import { createHumanController, withJitter } from './human.js'

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
  const rearmers = new Map() // sessionId -> mulai ulang permintaan kode
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

  function connectWithRetry(client, sessionId, human) {
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
        // Ada klien hidup: kirim pesan admin yang tadi tertunda.
        flushPendingAdmin(sessionId)
        // First open of this client: warm up briefly before going online and
        // pushing the ICS apikey gate to the admin from this session's client.
        if (!onboarded) {
          onboarded = true
          void (async () => {
            await human.onOpen()
            if (clients.get(sessionId) !== client) return
            const sendToAdmin = (jid, text) => client.message.send(jid, text)
            await runOnboarding(logger, sessionId, sendToAdmin)
          })().catch((err) => logger.warn({ sessionId, err: err?.message }, 'onboarding gagal'))
        } else {
          void human.onOpen().catch(() => {})
        }
        return
      }
      human.onClose()
      // Always surface why: without the reason/code a flap loop is unguessable.
      logger.warn(
        { sessionId, reason: event.reason, code: event.code, isLogout: event.isLogout },
        'connection closed'
      )
      if (event.isLogout || FATAL.has(event.reason)) {
        logger.error({ sessionId, reason: event.reason, code: event.code }, 'logged out — re-pairing required')
        // Perangkat dicabut: reconnecting dengan kredensial yang sama hanya
        // mengulang kegagalan yang sama. Status `pairing` menahan watchdog dan
        // memberi tahu admin, supaya tidak ada 1000 percobaan kode sia-sia.
        setSessionStatus(sessionId, 'pairing')
        alertAdmin(
          sessionId,
          `Session ${sessionId} ter-logout (${event.reason || 'perangkat dihapus'}).\n` +
            `Perlu taut ulang. Kirim SESION.${sessionId} saat siap menerima kode.`
        )
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
          const baseDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
          const delayMs = withJitter(baseDelayMs, human.profile.jitterRatio)
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

  // Kode pairing diteruskan ke admin sesi lewat klien sesi pusat: klien sesi itu
  // sendiri bisa mati tepat setelah kode terbit. Kode yang sama tidak dikirim
  // ulang sebelum CODE_RESEND_MS supaya tidak spam.
  const CODE_RESEND_MS = 10 * 60 * 1000
  const codeSent = new Map() // sessionId -> { code, at }

  // Sesi pusat (bootstrap) diutamakan, tapi klien mana pun yang terbuka dipakai
  // sebagai cadangan: saat semua sesi rusak, justru hanya ada satu yang hidup.
  function centralClient(excludeId) {
    let fallback = null
    for (const [id, c] of clients) {
      if (id === excludeId || !health.get(id)?.open) continue
      if (isBootstrapSession(id)) return c
      fallback ??= c
    }
    return fallback
  }

  // Pesan ke admin tidak dibuang kalau belum ada klien terhubung (mis. saat boot
  // sesi pusat belum terbuka): disimpan dan dikirim begitu ada sesi pusat open.
  const PENDING_TTL_MS = 10 * 60 * 1000
  const pendingAdmin = new Map() // sessionId tujuan -> { jid, text, at }
  // Hitungan 429 disimpan per sesi (bukan per klien) supaya jeda panjang tidak
  // hilang saat watchdog membangun ulang klien.
  const rateLimitStrikes = new Map() // sessionId -> jumlah 429 berturut

  function deliverAdmin(sessionId, text) {
    const adminNohp = getSession(sessionId)?.admin_nohp
    if (!adminNohp) return // sesi pusat (owner) tidak punya admin penerima
    const jid = `${adminNohp}@s.whatsapp.net`
    const central = centralClient(sessionId)
    if (!central) {
      pendingAdmin.set(sessionId, { jid, text, at: Date.now() })
      logger.warn({ sessionId }, 'tidak ada klien terhubung — pesan admin ditunda')
      return
    }
    void central.message
      .send(jid, text)
      .catch((err) => logger.warn({ sessionId, err: err?.message }, 'kirim pesan ke admin gagal'))
  }

  function flushPendingAdmin(fromSessionId) {
    const central = clients.get(fromSessionId)
    if (!central || !health.get(fromSessionId)?.open) return
    const now = Date.now()
    for (const [sessionId, p] of pendingAdmin) {
      if (sessionId === fromSessionId) continue
      pendingAdmin.delete(sessionId)
      if (now - p.at > PENDING_TTL_MS) continue
      void central.message
        .send(p.jid, p.text)
        .catch((err) => logger.warn({ sessionId, err: err?.message }, 'kirim pesan tertunda ke admin gagal'))
    }
  }

  function forwardPairingCode(sessionId, code, text) {
    const prev = codeSent.get(sessionId)
    if (prev?.code === code && Date.now() - prev.at < CODE_RESEND_MS) return
    codeSent.set(sessionId, { code, at: Date.now() })
    deliverAdmin(sessionId, text)
  }

  // Sesi yang butuh taut ulang ditandai status `pairing`: watchdog tidak
  // membangunnya ulang tiap 3 menit, dan permintaan kode diserialkan supaya boot
  // beberapa sesi tidak menembak WhatsApp serentak (pemicu 429).
  const ALERT_RESEND_MS = 30 * 60 * 1000
  const alertSent = new Map() // sessionId -> at
  const PAIRING_REBUILD_MS = 15 * 60 * 1000
  const RATE_LIMIT_BACKOFF_MS = [5, 15, 30].map((m) => m * 60_000)
  let pairingChain = Promise.resolve()
  // ponytail: satu antrean global, tanpa timeout sendiri — kalau satu permintaan
  // menggantung, sesi lain ikut menunggu. Pindah ke antrean ber-timeout kalau
  // pernah kejadian (klien sudah punya connectTimeoutMs 15 dtk).
  const withPairingSlot = (fn) => (pairingChain = pairingChain.then(fn, fn))

  function alertAdmin(sessionId, text) {
    if (!getSession(sessionId)?.admin_nohp) return
    const at = alertSent.get(sessionId)
    if (at && Date.now() - at < ALERT_RESEND_MS) return
    alertSent.set(sessionId, Date.now())
    deliverAdmin(sessionId, text)
  }

  // Phone known -> link-code; no phone -> QR in the terminal. The QR path
  // requests nothing, so it can render on every refresh and wait for a scan.
  function handlePairing(client, sessionId, notify) {
    const phone = () => getSession(sessionId)?.pairing_phone || config.pairingPhone

    // Fresh sessions surface as `auth_qr` (zapo emits `auth_pairing_required`
    // only on refresh/re-arm). With a phone known, the first QR is the cue to
    // request the code; without one, fall back to QR in the terminal.
    let requested = false
    let attempts = 0
    let retryTimer = null
    const MAX_CODE_ATTEMPTS = 6
    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
    }

    client.on('auth_qr', ({ qr, ttlMs }) => {
      if (!phone()) {
        logger.info({ sessionId }, `QR valid for ${ttlMs}ms — scan from WhatsApp → Linked devices`)
        qrcode.generate(qr, { small: true })
        return
      }
      if (requested) return
      requested = true
      attempts = 0
      void requestCode()
    })

    // 429 `companion hello iq failed` muncul kalau minta kode terus-menerus.
    // Dua lapis penahan: satu permintaan sekali jalan (slot global) dan jeda
    // panjang khusus 429; setelah 3x 429 putaran ditutup sampai ada pemicu baru.
    async function requestCode({ force = false } = {}) {
      if (clients.get(sessionId) !== client) return
      const p = phone()
      if (!p) return
      if (force) {
        clearRetry()
        attempts = 0
        rateLimitStrikes.delete(sessionId)
      }
      if (attempts >= MAX_CODE_ATTEMPTS) {
        requested = false // biarkan auth_qr berikutnya memulai putaran baru
        return
      }
      attempts += 1
      await withPairingSlot(async () => {
        if (clients.get(sessionId) !== client) return
        try {
          await client.auth.requestPairingCode(p)
          // The code surfaces via the `auth_pairing_code` listener below.
        } catch (err) {
          const limited = /429|rate-limit/i.test(String(err?.message ?? ''))
          const strikes = limited ? (rateLimitStrikes.get(sessionId) ?? 0) + 1 : 0
          if (strikes) rateLimitStrikes.set(sessionId, strikes)
          else rateLimitStrikes.delete(sessionId)
          const delayMs = limited
            ? RATE_LIMIT_BACKOFF_MS[Math.min(strikes, RATE_LIMIT_BACKOFF_MS.length) - 1]
            : Math.min(120_000, 15_000 * 2 ** (attempts - 1))
          if (limited && strikes >= RATE_LIMIT_BACKOFF_MS.length) {
            requested = false // putaran ditutup: tunggu auth_qr/forceManual/SESION
          }
          logger.warn(
            { sessionId, attempt: attempts, rateLimited: strikes, retryMs: delayMs, err: err?.message },
            'requestPairingCode failed'
          )
          // Notifikasi owner cukup sekali per putaran, bukan tiap percobaan.
          if (attempts === 1) {
            await notify?.(
              `Gagal minta kode pairing untuk ${sessionId}. Mencoba lagi otomatis (±${Math.round(delayMs / 1000)} dtk).`
            )
          }
          clearRetry()
          if (requested) {
            retryTimer = setTimeout(() => void requestCode(), delayMs)
            retryTimer.unref?.()
          }
        }
      })
    }

    client.on('auth_pairing_code', ({ code }) => {
      const p = phone()
      const text = `*Pairing ${sessionId}*\nNomor: ${p}\nKode: ${formatCode(code)}\n\nBuka WhatsApp di nomor itu → Perangkat tertaut → Tautkan dengan nomor telepon, lalu masukkan kode.`
      // Startup sessions have no owner chat: console only.
      logger.info({ sessionId }, `Pairing ${sessionId} nomor ${p}: ${formatCode(code)}`)
      if (notify) void notify(text)
      // Klien sesi bisa mati setelah kode terbit: kirim juga ke admin sesi.
      forwardPairingCode(sessionId, code, text)
    })

    // Re-arm: forceManual means the pending code died with its connection and
    // a fresh one must be requested; a plain refresh means it's still valid.
    client.on('auth_pairing_required', ({ forceManual } = {}) => {
      if (!phone()) return
      if (forceManual) requested = false
      if (requested) return
      requested = true
      void requestCode({ force: true })
    })

    client.on('auth_paired', ({ credentials }) => {
      requested = false
      attempts = 0
      rateLimitStrikes.delete(sessionId)
      clearRetry()
      setSessionStatus(sessionId, 'on')
      alertSent.delete(sessionId)
      logger.info({ sessionId }, `Paired as ${credentials.meJid}`)
      void notify?.(`Session ${sessionId} berhasil tertaut sebagai ${credentials.meJid}.`)
    })

    client.on('auth_passkey_required', ({ hasSigner }) => {
      if (!hasSigner) logger.warn({ sessionId }, 'passkey required — link cannot proceed headless')
    })

    // Dipakai SESION: mulai putaran baru walaupun sebelumnya kena batas 429.
    rearmers.set(sessionId, () => {
      if (!phone()) return
      clearRetry()
      attempts = 0
      rateLimitStrikes.delete(sessionId)
      requested = true
      void requestCode({ force: true })
    })
  }

  // Startup sessions have no owner chat to notify into, so anything the pairing
  // flow would send is printed to the log instead of silently dropped.
  function consoleNotify(sessionId) {
    return (text) => logger.info({ sessionId }, String(text).replace(/\n+/g, ' | '))
  }

  // QR pairing (bootstrap, no phone on record) creates an owner session in the
  // registry so the next start resumes it instead of forgetting it.
  function registerBootstrapSession(sessionId, meJid) {
    // Only the env bootstrap session may be armed by QR; any other id must come
    // from SESIBUAT so it has a shop admin (and never equals its own bot number).
    if (!isBootstrapSession(sessionId) || getSession(sessionId)) return
    const waNohp = String(meJid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
    try {
      createSession({ id: sessionId, label: 'Owner (QR)', adminNohp: '', pairingPhone: '', waNohp, status: 'on' })
      logger.info({ sessionId, meJid }, 'session owner (QR) didaftarkan ke registry')
    } catch (err) {
      // WhatsApp is already paired; a registry hiccup must not take it down.
      logger.error({ sessionId, err: err?.message }, 'gagal daftarkan session owner')
    }
  }

  async function startSession(sessionId, { notify, rearm = false } = {}) {
    if (clients.has(sessionId)) {
      if (rearm) rearmers.get(sessionId)?.()
      return clients.get(sessionId)
    }

    const rawClient = new WaClient(
      {
        store,
        sessionId,
        connectTimeoutMs: 15_000,
        nodeQueryTimeoutMs: 30_000,
        history: { enabled: true, requireFullSync: true },
      },
      logger
    )
    const human = createHumanController(rawClient, sessionId, logger)
    const client = human.client
    clients.set(sessionId, client)
    // Pastikan ada patokan waktu supaya watchdog bisa menghitung umur koneksi
    // walau klien belum pernah memancarkan event apa pun.
    if (!health.has(sessionId)) health.set(sessionId, { since: Date.now(), open: false, stableAt: null })
    handlePairing(client, sessionId, notify ?? consoleNotify(sessionId))
    connectWithRetry(client, sessionId, human)
    client.on('auth_paired', ({ credentials }) => registerBootstrapSession(sessionId, credentials.meJid))
    handles.set(sessionId, attachHandlers(client, sessionId, logger, api, human))
    // Status `on` hanya kalau kredensial terdaftar (`meJid` ada); sisanya
    // `pairing`. Kredensial setengah jadi (noise key saja) tetap dihitung belum
    // tertaut — itulah yang membuat FUAD/UMMUL dulu tampil `on`.
    const creds = await store.session(sessionId).auth.load().catch(() => null)
    setSessionStatus(sessionId, creds?.meJid ? 'on' : 'pairing')

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
      // Sesi menunggu taut ulang: jangan bangun ulang tiap 3 menit, cukup tiap
      // 15 menit (maks 4x/jam), bukan 20x/menit.
      if (getSession(sessionId)?.status === 'pairing' && now - h.since <= PAIRING_REBUILD_MS) continue
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
    rearmers.delete(sessionId)
    handles.get(sessionId)?.close()
    handles.delete(sessionId)
    if (client) await client.disconnect().catch(() => {})
    await startSession(sessionId, { notify: consoleNotify(sessionId) })
  }

  async function stopSession(sessionId) {
    const client = clients.get(sessionId)
    clients.delete(sessionId)
    rearmers.delete(sessionId)
    handles.get(sessionId)?.close()
    handles.delete(sessionId)
    setSessionStatus(sessionId, 'off')
    // Graceful disconnect keeps credentials; the close event's
    // client_disconnected reason must not trigger a reconnect.
    if (client) await client.disconnect().catch(() => {})
  }

  async function stopAll() {
    const entries = [...clients.entries()]
    clients.clear()
    rearmers.clear()
    await Promise.allSettled(
      entries.map(async ([id, client]) => {
        handles.get(id)?.close()
        handles.delete(id)
        await client.disconnect().catch(() => {})
      })
    )
  }

  return api
}