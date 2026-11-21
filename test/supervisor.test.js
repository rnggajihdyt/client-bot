import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { isWatchedChange } from '../supervisor.js'

test('isWatchedChange: memantau kode & .env, mengabaikan state/db/log', () => {
  assert.equal(isWatchedChange('root', 'index.js'), true)
  assert.equal(isWatchedChange('root', '.env'), true)
  assert.equal(isWatchedChange('root', 'package.json'), true)
  assert.equal(isWatchedChange('root', 'README.md'), false)
  assert.equal(isWatchedChange('root', '.data/sessions/owner.sqlite'), false)
  assert.equal(isWatchedChange('root', '.auth/state.sqlite-wal'), false)
  assert.equal(isWatchedChange('root', 'logs/supervisor.log'), false)

  assert.equal(isWatchedChange('src', 'handler.js'), true)
  assert.equal(isWatchedChange('src', 'commands\\owner.js'), true)
  assert.equal(isWatchedChange('src', 'config.json'), true)
  assert.equal(isWatchedChange('src', 'temp.tmp'), false)
  assert.equal(isWatchedChange('src', 'x.sqlite'), false)
})

async function waitForLines(filePath, count, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(filePath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (lines.length >= count) return lines.map((l) => JSON.parse(l))
    } catch {
      // file not created yet
    }
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error(`Timed out waiting for ${count} run(s) in ${filePath}`)
}

test('supervisor auto-restart saat file di src/ berubah sambil mempertahankan SUPERVISOR_STARTED_AT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-test-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  const runsFile = join(dir, 'runs.jsonl')
  const dummyEntry = join(dir, 'index.js')
  writeFileSync(join(dir, 'src', 'mod.js'), 'export const v = 1\n')
  writeFileSync(
    dummyEntry,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(runsFile)}, JSON.stringify({
  pid: process.pid,
  startedAt: process.env.SUPERVISOR_STARTED_AT,
  restarts: process.env.SUPERVISOR_RESTARTS,
}) + '\\n')
process.on('message', (msg) => {
  if (msg === 'shutdown') process.exit(0)
})
setInterval(() => {}, 60_000)
`
  )

  const sup = spawn(process.execPath, [resolve('supervisor.js')], {
    env: {
      ...process.env,
      SUPERVISOR_ROOT: dir,
      SUPERVISOR_ENTRY: dummyEntry,
      CYCLE_HOURS: '0',
      WATCH_CHANGES: 'true',
      WATCH_DEBOUNCE_MS: '100',
    },
    stdio: 'ignore',
  })

  try {
    const [first] = await waitForLines(runsFile, 1)
    assert.ok(Number(first.startedAt) > 0)
    assert.equal(first.restarts, '0')

    // Trigger file change inside src/
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(dir, 'src', 'mod.js'), 'export const v = 2\n')

    const runs = await waitForLines(runsFile, 2)
    assert.notEqual(runs[1].pid, runs[0].pid, 'child harus restart dengan PID baru')
    assert.equal(runs[1].startedAt, runs[0].startedAt, 'SUPERVISOR_STARTED_AT harus tetap sama agar uptime kontinu')
    assert.equal(runs[1].restarts, '1')
  } finally {
    sup.kill()
    await new Promise((r) => sup.once('exit', r))
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore temp cleanup lock on Windows
    }
  }
})
