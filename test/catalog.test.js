import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'catalog-test-'))
process.env.SESSION_DIR = join(dir, 'sessions')

const { openDb } = await import('../src/db.js')
const { ensureFreshCatalog, resetCatalogCache, syncAllSessions, syncCatalog } = await import('../src/catalog.js')

let fetchCalls = 0
let mockProducts = []
let failNext = false
let fetchDelayMs = 0

const origFetch = globalThis.fetch
globalThis.fetch = async () => {
  fetchCalls += 1
  if (fetchDelayMs > 0) await new Promise((r) => setTimeout(r, fetchDelayMs))
  if (failNext) {
    return { ok: false, status: 500, text: async () => JSON.stringify({ success: false, message: 'ICS down' }) }
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, data: mockProducts }),
  }
}

test('TTL cache: hit dalam 60 dtk tidak fetch ulang, miss setelah TTL menarik status terbaru', async () => {
  const db = openDb(join(dir, 'sessions', 'shop1.sqlite'))
  db.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })

  resetCatalogCache(db.path)
  fetchCalls = 0
  failNext = false
  mockProducts = [{ code: 'XDA40', name: 'XL 40GB', price: 76000, type: 'xda', status: 'available', stock: 5 }]

  let clock = 1_000_000
  const r1 = await ensureFreshCatalog(db, { ttlMs: 60_000, now: () => clock })
  assert.equal(r1.synced, true)
  assert.equal(fetchCalls, 1)
  assert.equal(db.effectivePrice(1, 'XDA40').status_supplier, 'available')

  // Dalam 30 detik: cache hit, tidak panggil ICS
  clock += 30_000
  mockProducts = [{ code: 'XDA40', name: 'XL 40GB', price: 77000, type: 'xda', status: 'empty', stock: 0 }]
  const r2 = await ensureFreshCatalog(db, { ttlMs: 60_000, now: () => clock })
  assert.equal(r2.synced, false)
  assert.equal(r2.fresh, true)
  assert.equal(fetchCalls, 1)
  assert.equal(db.effectivePrice(1, 'XDA40').status_supplier, 'available')

  // Lewat 60 detik: cache basi, tunggu refresh (Opsi A) -> status berubah ke empty + harga baru
  clock += 31_000
  const r3 = await ensureFreshCatalog(db, { ttlMs: 60_000, now: () => clock })
  assert.equal(r3.synced, true)
  assert.equal(fetchCalls, 2)
  const p = db.effectivePrice(1, 'XDA40')
  assert.equal(p.status_supplier, 'empty')
  assert.equal(p.aktif, 0)
  assert.equal(p.harga_modal, 77000)

  db.close()
})

test('single-flight: 5 panggilan paralel saat cache basi hanya memicu 1 request ICS', async () => {
  const db = openDb(join(dir, 'sessions', 'shop2.sqlite'))
  db.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  resetCatalogCache(db.path)
  fetchCalls = 0
  failNext = false
  fetchDelayMs = 40
  mockProducts = [{ code: 'PULSA10', name: 'Pulsa 10', price: 9500, type: 'xda', status: 'available', stock: 10 }]

  const results = await Promise.all(
    Array.from({ length: 5 }, () => ensureFreshCatalog(db, { ttlMs: 60_000 }))
  )
  fetchDelayMs = 0
  assert.equal(fetchCalls, 1, 'harus single-flight 1 request saja')
  assert.ok(results.every((r) => r.synced && r.total === 1))
  db.close()
})

test('produk hilang dari ICS ditandai removed tanpa menghapus markup produk yang bertahan', async () => {
  const db = openDb(join(dir, 'sessions', 'shop3.sqlite'))
  db.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
  resetCatalogCache(db.path)
  failNext = false
  mockProducts = [
    { code: 'P1', name: 'P1', price: 1000, type: 'xda', status: 'available', stock: 5 },
    { code: 'P2', name: 'P2', price: 2000, type: 'xda', status: 'available', stock: 5 },
  ]
  await syncCatalog(db)
  db.setProdukMarkup('P1', 350)

  // P2 hilang dari respons ICS berikutnya
  mockProducts = [{ code: 'P1', name: 'P1', price: 1100, type: 'xda', status: 'available', stock: 4 }]
  const stats = await syncCatalog(db)
  assert.equal(stats.removed, 1)
  assert.equal(db.effectivePrice(1, 'P1').markup, 350, 'markup P1 tetap terjaga')
  assert.equal(db.effectivePrice(1, 'P1').hargaEfektif, 1450)
  const p2 = db.effectivePrice(1, 'P2')
  assert.equal(p2.aktif, 0)
  assert.equal(p2.status_supplier, 'removed')
  db.close()
})

test('fallback ke cache DB saat ICS error sementara pada ensureFreshCatalog', async () => {
  const db = openDb(join(dir, 'sessions', 'shop4.sqlite'))
  db.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  db.upsertProdukIcs({ code: 'OLD1', name: 'Old', price: 5000, type: 'xda', status: 'available', stock: 3 })
  resetCatalogCache(db.path)
  failNext = true

  const r = await ensureFreshCatalog(db, { ttlMs: 60_000 })
  failNext = false
  assert.equal(r.synced, false)
  assert.equal(r.fresh, false)
  assert.ok(r.error)
  assert.equal(db.listProduk().length, 1, 'data cache lama tetap ada')
  db.close()
})

test('gagal ICS menahan percobaan berikutnya selama masa tunggu', async () => {
  const db = openDb(join(dir, 'sessions', 'shop5.sqlite'))
  db.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  resetCatalogCache(db.path)
  let clock = 1_000_000
  const now = () => clock

  failNext = true
  const r1 = await ensureFreshCatalog(db, { ttlMs: 0, now })
  assert.equal(r1.synced, false)

  failNext = false
  mockProducts = [{ code: 'WAIT1', name: 'Tunggu', price: 1000, type: 'xda', status: 'available', stock: 1 }]
  fetchCalls = 0
  // masih dalam 5 dtk: tidak menembak ICS lagi
  const r2 = await ensureFreshCatalog(db, { ttlMs: 0, now })
  assert.equal(fetchCalls, 0)
  assert.equal(r2.synced, false)

  clock += 6_000
  const r3 = await ensureFreshCatalog(db, { ttlMs: 0, now })
  assert.equal(fetchCalls, 1)
  assert.equal(r3.synced, true)
  db.close()
})

test('syncAllSessions (cron) melewati sesi tanpa apikey dan sync sesi ber-apikey', async () => {
  const ownerDb = openDb(join(dir, 'sessions', 'owner.sqlite'))
  ownerDb.close()
  const tokoDb = openDb(join(dir, 'sessions', 'toko_cron.sqlite'))
  tokoDb.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  tokoDb.close()

  fetchCalls = 0
  failNext = false
  mockProducts = [{ code: 'CRON1', name: 'Cron Produk', price: 3000, type: 'xda', status: 'available', stock: 2 }]

  const logs = []
  const mockLogger = {
    info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
  }

  const res = await syncAllSessions(mockLogger, ['owner', 'toko_cron', 'nonexistent'], { staggerMs: 0 })
  assert.equal(fetchCalls, 1)
  assert.equal(res.length, 1)
  assert.equal(res[0].sessionId, 'toko_cron')
  assert.equal(res[0].total, 1)
  assert.equal(logs.length, 1)
  assert.match(logs[0].msg, /\[cron-sync\] toko_cron: 1 produk \(1 online, 0 removed\)/)
  assert.equal(logs[0].meta.sessionId, 'toko_cron')
})

test('ttlMs 0 memaksa sync (dipakai sebelum order), stok/markup/removed konsisten', async () => {
  const db = openDb(join(dir, 'sessions', 'shop5.sqlite'))
  db.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
  db.upsertProdukIcs({ code: 'P1', name: 'P1', price: 1000, type: 'xda', status: 'available', stock: 5 })
  db.upsertProdukIcs({ code: 'P2', name: 'P2', price: 2000, type: 'xda', status: 'available', stock: 5 })
  db.setProdukMarkup('P1', 250)
  resetCatalogCache(db.path)
  failNext = false
  mockProducts = [
    { code: 'P1', name: 'P1', price: 1000, type: 'xda', status: 'empty', stock: 0 },
    { code: 'P2', name: 'P2', price: 2000, type: 'xda', status: 'available', stock: 7 },
    { code: 'CNDNEW', name: 'Token', price: 500, type: 'cnd', status: 'available', stock: 9 },
  ]

  const r = await ensureFreshCatalog(db, { ttlMs: 0 })
  assert.equal(r.synced, true)
  assert.equal(r.total, 2, 'CND tidak disimpan')
  assert.equal(r.restored, 1, 'markup per produk dipulihkan setelah upsert')
  const p1 = db.effectivePrice(1, 'P1')
  assert.equal(p1.status_supplier, 'empty', 'status kosong langsung terlihat')
  assert.equal(p1.markup, 250)
  assert.equal(p1.hargaEfektif, 1250)
  assert.equal(db.effectivePrice(1, 'P2').stok, 7)
  assert.equal(db.listProduk().some((p) => p.kode === 'CNDNEW'), false)

  // waktu sync disimpan di DB: proses restart tidak menganggap cache basi
  assert.ok(Number(db.getSetting('catalog_synced_at')) > 0)
  resetCatalogCache(db.path)
  fetchCalls = 0
  const r2 = await ensureFreshCatalog(db, { ttlMs: 60_000 })
  assert.equal(r2.synced, false, 'masih dalam TTL menurut DB')
  assert.equal(fetchCalls, 0)
  db.close()
})

after(() => {
  globalThis.fetch = origFetch
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore Windows temp lock
  }
})
