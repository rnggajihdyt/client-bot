import { createPinoLogger } from 'zapo-js'
import { config } from './src/config.js'
import { openRegistry, closeRegistry, listSessions } from './src/registry.js'
import { createRuntime } from './src/runtime.js'
import './src/commands/demo.js' // registers the demo commands
import './src/commands/ppob.js' // info / format1..4 menus
import './src/commands/ppob-core.js' // SAL/CH/DAFTAR/TUKAR/dll
import './src/commands/supplier.js' // APIKEY/BELI/CEK/REK
import './src/commands/deposit.js' // TIKET/TPAY (BTL stays in ppob-core stubs until wired)
import './src/commands/prefix.js' // setprefix (owner only)
import './src/commands/owner.js' // status/sessions/restart/cmd/env (owner only)
import { startWebhookServer, startPoller } from './src/webhook.js'
import { startReportServer } from './src/reportweb.js'
import { startCatalogSyncCron } from './src/catalog.js'

const logger = await createPinoLogger({ level: config.logLevel, pretty: true })

// Session registry: which WA numbers exist + their pairing phone.
const registryPath = `${config.sessionDir}/_registry.sqlite`
openRegistry(registryPath)

const runtime = createRuntime(logger)
// Commands (owner.js) and the webhook notify path reach live clients here.
globalThis.__waRuntime = runtime

// Startup: connect every session in the registry. `SESSIONS`/`DEFAULT_SESSION`
// only bootstrap a brand-new install (empty registry) — otherwise a session
// deleted with SESIHAPUS would keep coming back from env on every restart.
const registered = listSessions().map((s) => s.id)
const fromEnv = (process.env.SESSIONS ?? config.sessionId)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const sessions = registered.length ? registered : [...new Set(fromEnv)]

// Startup sessions have no owner chat yet: pairing output goes to the console.
for (const sessionId of sessions) {
  await runtime.startSession(sessionId, { notify: runtime.consoleNotify(sessionId) })
}

// Supplier webhook (POST /webhook/<token>/<session>) + cron poll yang jadi jalur
// utama penyelesaian transaksi. Server webhook dibiarkan hidup tapi tidak perlu
// didaftarkan di dashboard ICS selama transaksi memakai CEK/poll.
let webhookServer
let poller
let catalogCron
let reportServer
try {
  webhookServer = startWebhookServer(logger)
  reportServer = startReportServer(logger)
  poller = startPoller(logger, () => [...runtime.clients.keys()])
  catalogCron = startCatalogSyncCron(logger, () => [...runtime.clients.keys()])
} catch (err) {
  logger.error({ err: err?.message }, 'webhook server gagal start')
}

// Graceful shutdown — disconnect keeps credentials so we resume without re-pairing.
// Handles both POSIX signals and supervisor IPC ('shutdown') for clean Windows restarts.
let shuttingDown = false
async function shutdown(reason = 'signal') {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ reason }, 'shutting down')
  const force = setTimeout(() => process.exit(0), 4_000)
  force.unref?.()
  clearInterval(poller)
  catalogCron?.stop()
  webhookServer?.close()
  reportServer?.close()
  await runtime.stopAll()
  closeRegistry()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(signal))
}
process.on('message', (msg) => {
  if (msg === 'shutdown') void shutdown('supervisor')
})

// Staying alive beats dying: a failed send or a stray rejection must not kill
// every session. Log and continue. A genuinely wedged process exits non-zero so
// the supervisor restarts it instead of serving a dead loop.
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection')
})
let uncaught = 0
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
  uncaught += 1
  if (uncaught >= 5) {
    logger.error('too many uncaught exceptions — exiting for supervisor restart')
    process.exit(1)
  }
})
