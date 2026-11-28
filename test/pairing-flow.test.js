import assert from 'node:assert/strict'
import test from 'node:test'

// Mirrors the pairing state machine in src/runtime.js handlePairing + watchdog:
// the first auth_qr (or forceManual) opens a round; requests are serialised by a
// global slot; a 429 backs off 5/15/30 minutes and closes the round after the
// third one. Sessions in status `pairing` are only rebuilt every 15 minutes.
const MAX_CODE_ATTEMPTS = 6
const PAIRING_REBUILD_MS = 15 * 60 * 1000
const RATE_LIMIT_BACKOFF_MS = [5, 15, 30].map((m) => m * 60_000)

function createFlow({ phone = '628111', status = 'pairing', fail = () => '', strikes = new Map() } = {}) {
  let requested = false
  let attempts = 0
  let timerMs = null
  const sent = []
  const request = ({ force = false } = {}) => {
    if (!phone) return
    if (force) {
      attempts = 0
      strikes.delete('s')
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
    const n = limited ? (strikes.get('s') ?? 0) + 1 : 0
    if (n) strikes.set('s', n)
    else strikes.delete('s')
    timerMs = limited
      ? RATE_LIMIT_BACKOFF_MS[Math.min(n, RATE_LIMIT_BACKOFF_MS.length) - 1]
      : Math.min(120_000, 15_000 * 2 ** (attempts - 1))
    if (limited && n >= RATE_LIMIT_BACKOFF_MS.length) requested = false
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
      strikes.delete('s')
      status = 'on'
    }
  }
  return {
    emit,
    retry: () => request(),
    watchdogRebuild: (now, since) => !(status === 'pairing' && now - since <= PAIRING_REBUILD_MS),
    stats: () => ({ attempts, rateLimited: strikes.get('s') ?? 0, timerMs, sent: sent.length }),
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

// Mirrors the status set at startSession: `on` hanya kalau kredensial sudah
// terdaftar (`meJid`); kredensial setengah jadi dihitung belum tertaut.
const bootStatus = (creds) => (creds?.meJid ? 'on' : 'pairing')

test('sesi tanpa kredensial terdaftar tampil pairing, bukan on', () => {
  assert.equal(bootStatus(null), 'pairing')
  assert.equal(bootStatus({ noiseKeyPair: {} }), 'pairing')
  assert.equal(bootStatus({ meJid: '628@s.whatsapp.net' }), 'on')
})

test('hitungan 429 bertahan saat klien dibangun ulang', () => {
  const strikes = new Map()
  const a = createFlow({ fail: () => '429 rate-overlimit', strikes })
  a.emit('auth_qr')
  a.retry()
  a.retry()
  assert.equal(strikes.get('s'), 3)
  // klien baru (watchdog rebuild) tidak mengulang jeda dari 5 menit
  const b = createFlow({ fail: () => '429', strikes })
  b.emit('auth_qr')
  assert.equal(b.stats().timerMs, 30 * 60_000)
})

test('status pairing menahan rebuild sampai 15 menit', () => {
  const f = createFlow()
  f.emit('auth_qr')
  assert.equal(f.watchdogRebuild(10 * 60_000, 0), false)
  assert.equal(f.watchdogRebuild(PAIRING_REBUILD_MS + 1, 0), true)
})

// Mirrors centralClient + deliverAdmin/flushPendingAdmin in src/runtime.js:
// pesan admin ditunda kalau belum ada klien terbuka, lalu dikirim saat ada yang
// open; klien pusat diutamakan, klien lain hanya cadangan.
function createRouter() {
  const clients = new Map() // id -> { open, sent }
  const pending = new Map()
  const add = (id, open, bootstrap = false) => clients.set(id, { open, bootstrap, sent: [] })
  const central = (excludeId) => {
    let fallback = null
    for (const [id, c] of clients) {
      if (id === excludeId || !c.open) continue
      if (c.bootstrap) return c
      fallback ??= c
    }
    return fallback
  }
  const deliver = (sessionId, text) => {
    const c = central(sessionId)
    if (!c) return pending.set(sessionId, text)
    c.sent.push(text)
  }
  const flush = (fromId) => {
    const c = clients.get(fromId)
    if (!c?.open) return
    for (const [sessionId, text] of pending) {
      if (sessionId === fromId) continue
      pending.delete(sessionId)
      c.sent.push(text)
    }
  }
  return { add, deliver, flush, clients, pending, open: (id) => (clients.get(id).open = true) }
}

test('kode ditunda kalau belum ada klien, terkirim begitu pusat open', () => {
  const r = createRouter()
  r.add('owner', false, true)
  r.deliver('FUAD', 'kode')
  assert.equal(r.pending.has('FUAD'), true)
  r.open('owner')
  r.flush('owner')
  assert.deepEqual(r.clients.get('owner').sent, ['kode'])
  assert.equal(r.pending.size, 0)
})

test('klien bukan pusat dipakai sebagai cadangan', () => {
  const r = createRouter()
  r.add('BRSTORE', true)
  r.deliver('FUAD', 'kode')
  assert.deepEqual(r.clients.get('BRSTORE').sent, ['kode'])
})

test('pusat didahulukan dari klien biasa', () => {
  const r = createRouter()
  r.add('BRSTORE', true)
  r.add('owner', true, true)
  r.deliver('FUAD', 'kode')
  assert.deepEqual(r.clients.get('owner').sent, ['kode'])
  assert.deepEqual(r.clients.get('BRSTORE').sent, [])
})
