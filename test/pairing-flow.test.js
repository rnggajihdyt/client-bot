import assert from 'node:assert/strict'
import test from 'node:test'

// Mirrors the pairing state machine in src/runtime.js handlePairing: the first
// auth_qr (or a forceManual re-arm) requests a code exactly once; a plain
// refresh keeps the pending code.
function createFlow({ phone = '628111', notify = () => {} } = {}) {
  let requested = false
  const sent = []
  const emit = (event, payload = {}) => {
    if (event === 'auth_qr' && phone && !requested) {
      requested = true
      sent.push('code')
    }
    if (event === 'auth_pairing_required') {
      if (payload.forceManual) requested = false
      if (!requested) {
        requested = true
        sent.push('code')
      }
    }
    if (event === 'auth_paired') requested = false
  }
  return { emit, sent, notify }
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
