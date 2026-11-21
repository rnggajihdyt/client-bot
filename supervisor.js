import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Supervisor: keeps index.js alive across crashes, periodic cycles, and code
// changes. The supervisor process itself stays up continuously and passes its
// original SUPERVISOR_STARTED_AT timestamp to every child so reported uptime
// never resets on reload.
const DEFAULT_ROOT = dirname(fileURLToPath(import.meta.url))
const ROOT_FILES = new Set(['index.js', '.env', 'package.json'])
const CODE_EXT = /\.(?:js|mjs|cjs|json)$/i
const IGNORED_PATH = /(?:^|[/\\])(?:\.git|\.auth|\.data|logs|node_modules|test)(?:[/\\]|$)|\.sqlite(?:-wal|-shm|-journal)?$|\.log$|\.tmp$|\.swp$|~$/i

export function isWatchedChange(scope, filename) {
  if (!filename) return false
  const clean = String(filename).replace(/\\/g, '/')
  if (IGNORED_PATH.test(clean)) return false
  if (scope === 'root') return ROOT_FILES.has(clean)
  if (scope === 'src') return CODE_EXT.test(clean)
  return false
}

export function runSupervisor({
  root = process.env.SUPERVISOR_ROOT ? resolve(process.env.SUPERVISOR_ROOT) : DEFAULT_ROOT,
  entry = process.env.SUPERVISOR_ENTRY ? resolve(process.env.SUPERVISOR_ENTRY) : null,
  cycleHours = Number(process.env.CYCLE_HOURS ?? 10),
  watchChanges = process.env.WATCH_CHANGES !== 'false',
  debounceMs = Number(process.env.WATCH_DEBOUNCE_MS ?? 500),
  restartDelayMs = 250,
  gracefulStopMs = 5_000,
  maxBackoffMs = 60_000,
} = {}) {
  const entryPath = entry ?? join(root, 'index.js')
  const logDir = join(root, 'logs')
  const supervisorStartedAt = Number(process.env.SUPERVISOR_STARTED_AT) || Date.now()

  mkdirSync(logDir, { recursive: true })

  function log(line) {
    const msg = `[${new Date().toISOString()}] [supervisor] ${line}`
    console.log(msg)
    // Survives console loss (service restart, closed terminal).
    try {
      appendFileSync(join(logDir, 'supervisor.log'), msg + '\n')
    } catch {
      // logging must never kill the supervisor
    }
  }

  let child = null
  let stopping = false
  let plannedRestart = false
  let pendingReload = false
  let restarts = 0
  let backoff = 1_000
  let restartTimer = null
  let debounceTimer = null
  const watchers = []

  function requestChildStop(reason, { planned = false } = {}) {
    if (!child || child.exitCode !== null) return
    if (planned) plannedRestart = true
    log(reason)
    // On Windows, SIGTERM terminates immediately without running handlers; IPC
    // lets index.js close sockets and SQLite handles cleanly first.
    if (child.connected) {
      try {
        child.send('shutdown')
      } catch {
        child.kill('SIGTERM')
      }
    } else {
      child.kill('SIGTERM')
    }
    const target = child
    const force = setTimeout(() => {
      if (target.exitCode === null) {
        log('child did not exit in time, forcing kill')
        target.kill('SIGKILL')
      }
    }, gracefulStopMs)
    force.unref?.()
    target.once('exit', () => clearTimeout(force))
  }

  function start() {
    if (stopping) return
    restartTimer = null
    plannedRestart = false
    const startedAt = Date.now()
    const flags = [
      cycleHours > 0 ? `cycle ${cycleHours}h` : null,
      watchChanges ? 'watch on' : null,
    ].filter(Boolean)
    log(`starting ${entryPath}${flags.length ? ` (${flags.join(', ')})` : ''}`)

    child = spawn(process.execPath, ['--env-file-if-exists=.env', entryPath], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        SUPERVISOR_STARTED_AT: String(supervisorStartedAt),
        SUPERVISOR_RESTARTS: String(restarts),
      },
      cwd: root,
    })

    const cycle =
      cycleHours > 0
        ? setTimeout(() => {
            requestChildStop(`cycle ${cycleHours}h reached, restarting`, { planned: true })
          }, cycleHours * 3_600_000)
        : null
    cycle?.unref?.()

    child.on('exit', (code, signal) => {
      if (cycle) clearTimeout(cycle)
      if (stopping) {
        process.exit(0)
        return
      }
      if (plannedRestart || pendingReload) {
        plannedRestart = false
        pendingReload = false
        backoff = 1_000
        restarts += 1
        log(`child reloaded cleanly (#${restarts}, uptime preserved), starting in ${restartDelayMs}ms`)
        restartTimer = setTimeout(start, restartDelayMs)
        return
      }
      // A run that lasted > 5 min was healthy: reset the backoff.
      backoff = Date.now() - startedAt > 300_000 ? 1_000 : Math.min(backoff * 2, maxBackoffMs)
      restarts += 1
      log(`child exited (code=${code} signal=${signal}), restart in ${backoff}ms`)
      restartTimer = setTimeout(start, backoff)
    })

    if (pendingReload) {
      pendingReload = false
      requestChildStop('applying queued file change, restarting', { planned: true })
    }
  }

  function triggerReload(changedFile) {
    if (stopping) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (stopping) return
      if (child && child.exitCode === null) {
        if (plannedRestart) {
          pendingReload = true
          return
        }
        requestChildStop(`change detected (${changedFile}), restarting`, { planned: true })
      } else if (restartTimer) {
        // Already scheduled to start: upcoming start will pick up the change.
        pendingReload = false
      } else {
        start()
      }
    }, debounceMs)
  }

  function setupWatchers() {
    if (!watchChanges) return
    const watchTargets = [
      { scope: 'root', path: root, recursive: false },
      { scope: 'src', path: join(root, 'src'), recursive: true },
    ]
    for (const target of watchTargets) {
      if (!existsSync(target.path)) continue
      try {
        const w = watch(target.path, { recursive: target.recursive }, (_event, filename) => {
          if (!isWatchedChange(target.scope, filename)) return
          const label = target.scope === 'src' ? `src/${String(filename).replace(/\\/g, '/')}` : String(filename)
          triggerReload(label)
        })
        w.on('error', (err) => log(`watcher error (${target.scope}): ${err.message}`))
        watchers.push(w)
      } catch (err) {
        log(`watcher gagal dipasang (${target.scope}): ${err.message}`)
      }
    }
  }

  function closeWatchers() {
    clearTimeout(debounceTimer)
    clearTimeout(restartTimer)
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    watchers.length = 0
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      closeWatchers()
      if (!child || child.exitCode !== null) {
        log('stopping')
        process.exit(0)
        return
      }
      requestChildStop(`stopping (${signal})`)
      setTimeout(() => process.exit(0), gracefulStopMs + 500).unref()
    })
  }

  setupWatchers()
  start()
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runSupervisor()
