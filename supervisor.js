import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Supervisor: keeps index.js alive. Restarts after a crash, and recycles the
// child every CYCLE_HOURS so a long-running process never drifts (the store
// persists credentials, so a restart does not re-pair).
const ROOT = dirname(fileURLToPath(import.meta.url))
const CYCLE_HOURS = Number(process.env.CYCLE_HOURS ?? 10)
const MAX_BACKOFF_MS = 60_000
const LOG_DIR = join(ROOT, 'logs')

mkdirSync(LOG_DIR, { recursive: true })

function log(line) {
  const msg = `[${new Date().toISOString()}] [supervisor] ${line}`
  console.log(msg)
  // Survives console loss (service restart, closed terminal).
  try {
    appendFileSync(join(LOG_DIR, 'supervisor.log'), msg + '\n')
  } catch {
    // logging must never kill the supervisor
  }
}

let child = null
let stopping = false
let backoff = 1_000

function start() {
  const startedAt = Date.now()
  log(`starting index.js${CYCLE_HOURS > 0 ? ` (cycle ${CYCLE_HOURS}h)` : ''}`)
  child = spawn(process.execPath, ['--env-file-if-exists=.env', join(ROOT, 'index.js')], {
    stdio: 'inherit',
    env: process.env,
    cwd: ROOT,
  })

  const cycle = setTimeout(() => {
    log(`cycle ${CYCLE_HOURS}h reached, restarting`)
    child?.kill('SIGTERM')
  }, CYCLE_HOURS * 3_600_000)

  child.on('exit', (code, signal) => {
    clearTimeout(cycle)
    if (stopping) return
    // A run that lasted > 5 min was healthy: reset the backoff.
    backoff = Date.now() - startedAt > 300_000 ? 1_000 : Math.min(backoff * 2, MAX_BACKOFF_MS)
    log(`child exited (code=${code} signal=${signal}), restart in ${backoff}ms`)
    setTimeout(start, backoff)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    log('stopping')
    child?.kill(signal)
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}

start()
