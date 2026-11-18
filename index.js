import { createPinoLogger } from 'zapo-js'
import { config } from './src/config.js'
import { openRegistry, listSessions } from './src/registry.js'
import { createRuntime } from './src/runtime.js'
import './src/commands/demo.js' // registers the demo commands
import './src/commands/ppob.js' // info / format1..4 menus
import './src/commands/ppob-core.js' // SAL/CH/DAFTAR/TUKAR/dll
import './src/commands/prefix.js' // setprefix (owner only)

const logger = await createPinoLogger({ level: config.logLevel, pretty: true })

// Session registry: which WA numbers exist + their pairing phone.
const registryPath = `${config.sessionDir}/_registry.sqlite`
openRegistry(registryPath)

const runtime = createRuntime(logger)

// Startup: connect every session = env SESSIONS ∪ registry entries.
const sessions = [
  ...new Set([
    ...(process.env.SESSIONS ?? config.sessionId).split(',').map((s) => s.trim()).filter(Boolean),
    ...listSessions().map((s) => s.id),
  ]),
]

// Pairing code for startup sessions goes to the console only.
for (const sessionId of sessions) {
  await runtime.startSession(sessionId)
}

// Graceful shutdown — disconnect keeps credentials so we resume without re-pairing.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    logger.info('shutting down')
    await runtime.stopAll()
    process.exit(0)
  })
}

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
