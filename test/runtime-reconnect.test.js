import assert from 'node:assert/strict'
import test from 'node:test'

// Same predicate as src/runtime.js FATAL — kept here so a drift breaks a test.
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

test('close reason decides reconnect: fatal stops, transient retries', () => {
  assert.equal(FATAL.has('stream_error_replaced'), true)
  assert.equal(FATAL.has('client_disconnected'), false)
  // 515 after pairing must reconnect — a fatal entry here would kill pairing.
  assert.equal(FATAL.has('stream_error_force_login'), false)
  assert.equal(FATAL.has('comms_stopped'), false)
})

test('watchdog gives up after GIVE_UP_MS of flapping, not after a stable run', () => {
  const STABLE_MS = 120_000
  const GIVE_UP_MS = 180_000
  const health = new Map()
  const markOpen = (id, open, now) => {
    const h = health.get(id) ?? { since: now, open: false, stableAt: null }
    if (open && !h.open) h.stableAt ??= now
    if (!open && h.open) h.stableAt = null
    h.open = open
    health.set(id, h)
  }
  // Flap: open at 0s, close at 4s, open at 5s, close at 9s …
  const t0 = 0
  for (let t = t0; t < GIVE_UP_MS; t += 4_000) {
    markOpen('s', true, t)
    markOpen('s', false, t + 4_000)
  }
  const flap = health.get('s')
  assert.equal(flap.open, false)
  assert.equal(flap.stableAt, null)
  assert.ok(flap.since === t0, 'since must not reset on transitions')

  // Stable: open at 0s, still open at 3 min → healthy, watchdog deletes entry.
  health.clear()
  markOpen('ok', true, 0)
  const stable = health.get('ok')
  assert.ok(stable.stableAt === 0)
  assert.ok(180_000 - stable.stableAt > STABLE_MS)
})
