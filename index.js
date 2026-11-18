import { createPinoLogger, WaClient } from 'zapo-js'
import qrcode from 'qrcode-terminal'
import { config } from './src/config.js'
import { store } from './src/store.js'
import { attachHandlers } from './src/handler.js'
import './src/commands/demo.js' // registers the demo commands
import './src/commands/ppob.js' // info / format1..4 menus
import './src/commands/ppob-core.js' // SAL/CH/DAFTAR/TUKAR/dll
import './src/commands/prefix.js' // setprefix (owner only)

const logger = await createPinoLogger({ level: config.logLevel, pretty: true })

// PPOB data is per session (.data/sessions/<id>.sqlite), opened by the handler.
// Each session's root admin is seeded by SESIBUAT, so nothing to seed here.

const sessions = (process.env.SESSIONS ?? config.sessionId)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function handlePairing(client, sessionId) {
  const wantsQr = config.pairingMode === 'qr' || config.pairingMode === 'both'
  const wantsCode = config.pairingMode === 'code' || config.pairingMode === 'both'

  client.on('auth_qr', ({ qr, ttlMs }) => {
    if (!wantsQr) return
    logger.info({ sessionId }, `QR valid for ${ttlMs}ms — scan from WhatsApp → Linked devices`)
    qrcode.generate(qr, { small: true })
  })

  client.on('auth_pairing_required', async () => {
    if (!wantsCode) return
    if (!config.pairingPhone) {
      logger.error({ sessionId }, 'PAIRING_PHONE not set — cannot request pairing code')
      return
    }
    try {
      const code = await client.auth.requestPairingCode(config.pairingPhone)
      logger.info({ sessionId }, `Enter on phone: ${code.match(/.{1,4}/g)?.join('-')}`)
    } catch (err) {
      logger.error({ sessionId, err }, 'requestPairingCode failed')
    }
  })

  client.on('auth_paired', ({ credentials }) => {
    logger.info({ sessionId }, `Paired as ${credentials.meJid}`)
  })

  client.on('auth_passkey_required', ({ hasSigner }) => {
    if (!hasSigner) {
      logger.warn({ sessionId }, 'passkey required but no signer configured — link cannot proceed')
    }
  })
}

function connectWithRetry(client, sessionId) {
  const MAX_ATTEMPTS = 10
  let attempt = 0

  client.on('connection', (event) => {
    if (event.status === 'open') {
      attempt = 0
      logger.info({ sessionId, isNewLogin: event.isNewLogin }, 'connected')
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

const clients = sessions.map((sessionId) => {
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
  handlePairing(client, sessionId)
  connectWithRetry(client, sessionId)
  attachHandlers(client, sessionId, logger)
  return { sessionId, client }
})

await Promise.all(clients.map(({ client }) => client.connect()))

// Graceful shutdown — disconnect keeps credentials so we resume without re-pairing.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    logger.info('shutting down')
    await Promise.allSettled(clients.map(({ client }) => client.disconnect()))
    process.exit(0)
  })
}

// Staying alive beats dying: a failed send or a stray rejection must not kill
// every session. Log and continue.
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection')
})
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
})
