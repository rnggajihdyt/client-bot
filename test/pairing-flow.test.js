import assert from 'node:assert/strict'
import test from 'node:test'

// Mirrors the pairing state machine in src/runtime.js handlePairing: the first
// auth_qr (or a forceManual re-arm) requests a code; a failed request retries
// through a timer with a per-round attempt cap so WA's 429 rate-limit is not
// hammered on every refresh (20s).
const MAX_CODE_ATTEMPTS = 6

function createFlow({ phone = '628111', fail = () => false } = {}) {
  let requested = false
  let attempts = 0
  const sent = []
  const request = (force = false) => {
    if (!phone) return
    if (force) attempts = 0
    if (attempts >= MAX_CODE_ATTEMPTS) {
      requested = false
      return
    }
    attempts += 1
    if (!fail(attempts)) sent.push('code')
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
      request(true)
    }
    if (event === 'auth_paired') requested = false
  }
  return { emit, retry: () => request(), sent, attempts: () => attempts }
}

test('first auth_qr with a known phone requests the pairing code once', () => {
  const f = createFlow()
  f.emit('auth_qr', { qr: 'refs' })
  f.emit('auth_qr', { qr: 'refs2' })
  assert.deepEqual(f.sent, ['code'])
})

test('auth_qr without a phone falls back to QR (no code request)', () => {
  const f = createFlow({ phone: '' })
  f.emit('auth_qr', { qr: 'refs' })
  assert.deepEqual(f.sent, [])
})

test('plain pairing refresh does not re-request, forceManual does', () => {
  const f = createFlow()
  f.emit('auth_qr')
  f.emit('auth_pairing_required', { forceManual: false })
  assert.deepEqual(f.sent, ['code'])
  f.emit('auth_pairing_required', { forceManual: true })
  assert.deepEqual(f.sent, ['code', 'code'])
})

test('429 beruntun: auth_qr tidak memicu minta ulang, retry dibatasi', () => {
  const f = createFlow({ fail: () => true })
  f.emit('auth_qr')
  assert.equal(f.attempts(), 1)

  // refresh 20 dtk selama gagal tidak menambah percobaan (yang jalan = retry)
  for (let i = 0; i < 10; i++) f.emit('auth_qr')
  assert.equal(f.attempts(), 1)

  // retry otomatis terus gagal sampai batas, lalu putaran ditutup
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) f.retry()
  assert.equal(f.sent.length, 0)
  assert.equal(f.attempts(), MAX_CODE_ATTEMPTS)
  f.emit('auth_qr')
  assert.equal(f.attempts(), 1, 'auth_qr memulai putaran baru setelah batas')
})

test('forceManual mereset hitungan percobaan', () => {
  const f = createFlow({ fail: () => true })
  f.emit('auth_qr')
  for (let i = 0; i < 4; i++) f.retry()
  assert.equal(f.attempts(), 5)
  f.emit('auth_pairing_required', { forceManual: true })
  assert.equal(f.attempts(), 1)
})
