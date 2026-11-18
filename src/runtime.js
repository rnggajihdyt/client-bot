import { WaClient } from 'zapo-js'
import qrcode from 'qrcode-terminal'
import { config } from './config.js'
import { store } from './store.js'
import { attachHandlers } from './handler.js'
import { setSessionStatus, getSession } from './registry.js'

const formatCode = (code) => code.match(/.{1,4}/g)?.join('-') ?? code

// Connects WhatsApp sessions at runtime (no restart) and keeps their clients
// alive for reconnect + graceful shutdown.
export function createRuntime(logger) {
  const clients = new Map()
  const api = { startSession, stopSession, stopAll, clients }

  function connectWithRetry(client, sessionId) {
    const MAX_ATTEMPTS = 10
    let attempt = 0

    client.on('connection', (event) => {
      if (event.status === 'open') {
        attempt = 0
        logger.info({ sessionId }, 'connected')
        return
      }
      if (event.isLogout) {
        logger.error({ sessionId }, 'logged out — re-pairing required')
        return
      }
      void reconnect()
    })

    async function reconnect() {
      if (attempt >= MAX_ATTEMPTS) {
        logger.error({ sessionId }, `giving up after ${attempt} attempts`)
        return
      }
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt)
      attempt += 1
      logger.info({ sessionId }, `reconnecting in ${delayMs}ms (attempt ${attempt})`)
      await new Promise((r) => setTimeout(r, delayMs))
      try {
        await client.connect()
      } catch (err) {
        logger.error({ sessionId, err }, 'reconnect failed')
        void reconnect()
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

  async function stopSession(sessionId) {
    const client = clients.get(sessionId)
    clients.delete(sessionId)
    setSessionStatus(sessionId, 'off')
    if (client) await client.disconnect().catch(() => {})
  }

  async function stopAll() {
    const all = [...clients.values()]
    clients.clear()
    await Promise.allSettled(all.map((c) => c.disconnect()))
  }

  return api
}