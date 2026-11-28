import assert from 'node:assert/strict'
import test from 'node:test'

// Mirrors the pairing state machine in src/runtime.js handlePairing + watchdog:
// the first auth_qr (or forceManual) opens a round; requests are serialised by a
// global slot; a 429 backs off 5/15/30 minutes and closes the round after the
// third one. Sessions in status `pairing` are only rebuilt every 15 minutes.
const MAX_CODE_ATTEMPTS = 6
const PAIRING_REBUILD_MS = 15 * 60 * 1000
const RATE_LIMIT_BACKOFF_MS = [5, 15, 30].map((m) => m * 60_000)

function createFlow({ phone = '628111', status = 'pairing', fail = () => '' } = {}) {
  let requested = false
  let attempts = 0
  let rateLimited = 0
  let timerMs = null
  const sent = []
  const request = ({ force = false } = {}) => {
    if (!phone) return
    if (force) {
      attempts = 0
      rateLimited = 0
    }
    if (attempts >= MAX_CODE_ATTEMPTS) {
      requested = false
      return
    }
    attempts += 1
    const err = fail(attempts)
    if (!err) {
      sent.push('code')
      return
    }
    const limited = /429|rate-limit/i.test(err)
    rateLimited = limited ? rateLimited + 1 : 0
    timerMs = limited
      ? RATE_LIMIT_BACKOFF_MS[Math.min(rateLimited, RATE_LIMIT_BACKOFF_MS.length) - 1]
      : Math.min(120_000, 15_000 * 2 ** (attempts - 1))
    if (limited && rateLimited >= RATE_LIMIT_BACKOFF_MS.length) requested = false
  }
  const emit = (event, payload = {}) => {
    if (event === 'auth_qr') {
      if (!phone || requested) return
      requested = true
      attempts = 0
      request()
    }
    if (event === 'auth_pairing_required') {
      if (payload.forceManual) requested = false
      if (requested) return
      requested = true
      request({ force: true })
    }
    if (event === 'auth_paired') {
      requested = false
      attempts = 0
      rateLimited = 0
      status = 'on'
    }
  }
  return {
    emit,
    retry: () => request(),
    watchdogRebuild: (now, since) => !(status === 'pairing' && now - since <= PAIRING_REBUILD_MS),
    stats: () => ({ attempts, rateLimited, timerMs, sent: sent.length }),
  }
}

test('first auth_qr with a known phone requests the pairing code once', () => {
  const f = createFlow()
  f.emit('auth_qr')
  f.emit('auth_qr')
  assert.equal(f.stats().sent, 1)
})

test('auth_qr without a phone falls back to QR (no code request)', () => {
  const f = createFlow({ phone: '' })
  f.emit('auth_qr')
  assert.equal(f.stats().sent, 0)
})

test('plain pairing refresh does not re-request, forceManual does', () => {
  const f = createFlow()
  f.emit('auth_qr')
  f.emit('auth_pairing_required', { forceManual: false })
  assert.equal(f.stats().sent, 1)
  f.emit('auth_pairing_required', { forceManual: true })
  assert.equal(f.stats().sent, 2)
})

test('429 beruntun: jeda 5 lalu 15 lalu 30 menit, putaran ditutup', () => {
  const f = createFlow({ fail: () => '429 rate-overlimit' })
  f.emit('auth_qr')
  assert.equal(f.stats().timerMs, 5 * 60_000)
  f.retry()
  assert.equal(f.stats().timerMs, 15 * 60_000)
  f.retry()
  assert.equal(f.stats().timerMs, 30 * 60_000)
  assert.equal(f.stats().sent, 0)

  // putaran ditutup: auth_qr baru boleh memulai lagi, percobaan kembali 1
  f.emit('auth_qr')
  assert.equal(f.stats().attempts, 1)
})

test('auth_qr saat gagal tidak memulai permintaan lain (yang jalan = timer)', () => {
  const f = createFlow({ fail: () => '429 rate-overlimit' })
  f.emit('auth_qr')
  for (let i = 0; i < 10; i++) f.emit('auth_qr')
  assert.equal(f.stats().attempts, 1)
})

test('gagal bukan 429 tetap 15 dtk x2, bukan menit', () => {
  const f = createFlow({ fail: () => 'timeout' })
  f.emit('auth_qr')
  assert.equal(f.stats().timerMs, 15_000)
  f.retry()
  assert.equal(f.stats().timerMs, 30_000)
})

test('forceManual mereset hitungan dan jeda 429', () => {
  const f = createFlow({ fail: () => '429 rate-overlimit' })
  f.emit('auth_qr')
  f.retry()
  f.retry()
  assert.equal(f.stats().rateLimited, 3)
  f.emit('auth_pairing_required', { forceManual: true })
  assert.equal(f.stats().attempts, 1)
  assert.equal(f.stats().rateLimited, 1)
})

test('auth_paired mengembalikan status ke on', () => {
  const f = createFlow()
  f.emit('auth_qr')
  f.emit('auth_paired')
  // sudah on: watchdog memakai ambang normal (3 menit), bukan 15 menit
  assert.equal(f.watchdogRebuild(4 * 60_000, 0), true)
})

test('status pairing menahan rebuild sampai 15 menit', () => {
  const f = createFlow()
  f.emit('auth_qr')
  assert.equal(f.watchdogRebuild(10 * 60_000, 0), false)
  assert.equal(f.watchdogRebuild(PAIRING_REBUILD_MS + 1, 0), true)
})
