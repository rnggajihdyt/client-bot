import { test, after } from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { hashPin, verifyPin } from '../src/auth.js'
import { formatRupiah, parseNumber } from '../src/money.js'
import { parsePpob } from '../src/parse.js'
import { parseRange } from '../src/report.js'

const dir = mkdtempSync(join(tmpdir(), 'ppob-'))
const db = openDb(join(dir, 'test.sqlite'))

// root (ADM001) — admin session
const root = db.createAgen({ nama: 'Admin', kota: '', nohp: '6281000000001', seniorId: null, markup: 0, pin: '1234' })
// uplink (RS0001) directly under root
const r1 = db.createAgen({ nama: 'Reseller', kota: 'Jakarta', nohp: '6281000000002', seniorId: root.id, markup: 1000, pin: '1111' })
// doni under r1
const doni = db.createAgen({ nama: 'Doni', kota: 'Bogor', nohp: '6281000000003', seniorId: r1.id, markup: 500, pin: '2222' })

test('kode generator', () => {
  assert.equal(root.kode, 'ADM001')
  assert.equal(r1.kode, 'RS0001')
  assert.equal(doni.kode, 'RS0002')
})

test('lookup by nohp (main)', () => {
  assert.equal(db.findAgenByNohp('6281000000002').id, r1.id)
})

test('lookup by nohp via parallel number', () => {
  db.addNomor(r1.id, '6281000000009')
  assert.equal(db.findAgenByNohp('6281000000009').id, r1.id)
  assert.equal(db.removeNomor(r1.id, '6281000000009'), 1)
})

test('markup beranak (recursive, root excluded)', () => {
  assert.equal(db.markupTotal(doni.id), 1500) // r1 1000 + doni 500
  assert.equal(db.markupTotal(r1.id), 1000)
  assert.equal(db.markupTotal(root.id), 0)
})

test('effectivePrice: general markup fallback (+ markup reseller level 1 masuk profit admin)', () => {
  db.upsertProduk({ kode: 'PULSA10', nama: 'Pulsa 10', hargaModal: 9500 })
  const p = db.effectivePrice(doni.id, 'PULSA10')
  assert.equal(p.hargaEfektif, 9500 + 1500) // 11000
  assert.equal(p.baseAdminMarkup, 0)
  assert.equal(p.resellerMarkup, 1000) // r1 (anak langsung admin)
  assert.equal(p.adminMarkup, 1000) // profit admin = MKP 0 + r1 1000
  assert.equal(p.networkMarkup, 500) // jatah komisi r1 dari doni
  assert.equal(db.effectivePrice(doni.id, 'NOTHING'), undefined)
})

test('effectivePrice: per-product markup overrides general', () => {
  db.updateAgen(root.id, { markup: 300 })
  assert.equal(db.effectivePrice(r1.id, 'PULSA10').hargaEfektif, 9500 + 300 + 1000)

  db.upsertProduk({ kode: 'DATA5', nama: 'Data 5', hargaModal: 15000 })
  db.setProdukMarkup('DATA5', 2000)
  const d = db.effectivePrice(r1.id, 'DATA5')
  assert.equal(d.baseAdminMarkup, 2000) // override, not general 300
  assert.equal(d.adminMarkup, 2000 + 1000) // MKP produk 2000 + markup r1 1000
  assert.equal(d.networkMarkup, 0)
  assert.equal(d.hargaEfektif, 15000 + 2000 + 1000)
  db.updateAgen(root.id, { markup: 0 })
})

test('downlines direct only / descendants any depth', () => {
  const dl = db.downlines(r1.id)
  assert.equal(dl.length, 1)
  assert.equal(dl[0].id, doni.id)
  assert.deepEqual(db.descendants(r1.id), [doni.id])
  assert.deepEqual(db.descendants(root.id), [r1.id, doni.id])
})

test('TUKAR atomic transfer', () => {
  db.setSaldoKomisi(doni.id, 0, 2000)
  db.tx(() => {
    const d = db.findAgenById(doni.id)
    db.addMutasi(d.id, 'komisi_masuk', -d.komisi, d.saldo, 'TUKAR')
    db.addMutasi(d.id, 'kredit', d.komisi, d.saldo + d.komisi, 'TUKAR')
    db.setSaldoKomisi(d.id, d.saldo + d.komisi, 0)
  })
  const a = db.findAgenById(doni.id)
  assert.equal(a.saldo, 2000)
  assert.equal(a.komisi, 0)
})

test('transaksiStats', () => {
  db.raw
    .prepare(`INSERT INTO transaksi (id_trx, agen_id, harga_efektif, status, created_at) VALUES ('T1', ?, 5000, 'proses', ?)`)
    .run(doni.id, new Date().toISOString())
  const st = db.transaksiStats(doni.id)
  assert.equal(st.proses, 1)
  assert.equal(st.hariIni, 5000)
})

test('profitSummary scope by agenIds', () => {
  db.insertTransaksi({
    idTrx: 'T2',
    agenId: doni.id,
    produkId: 1,
    produkKode: 'PULSA10',
    tujuan: '0812',
    hargaModal: 9500,
    markupAdmin: 300,
    markupTotal: 1800,
    hargaEfektif: 11300,
    komisiDibagikan: [],
    status: 'sukses',
  })
  const all = db.profitSummary({ from: '2000-01-01', to: '2100-01-01' })
  assert.equal(all.trx, 1)
  assert.equal(all.profit, 300)
  assert.equal(all.markup, 1800)
  const none = db.profitSummary({ agenIds: [r1.id], from: '2000-01-01', to: '2100-01-01' })
  assert.equal(none.trx, 0)
})

test('migrasi: DB lama tanpa kolom deposit.bank tetap bisa TIKET', () => {
  // Simulates a session DB created before `bank` existed on the deposit table.
  const oldPath = join(dir, 'old-deposit.sqlite')
  const raw = new DatabaseSync(oldPath)
  raw.exec(`CREATE TABLE deposit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_deposit TEXT UNIQUE NOT NULL,
    agen_id INTEGER NOT NULL,
    nominal INTEGER NOT NULL,
    kode_unik INTEGER NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`)
  raw.close()

  const migrated = openDb(oldPath)
  const cols = migrated.raw.prepare(`PRAGMA table_info(deposit)`).all().map((c) => c.name)
  assert.ok(cols.includes('bank'), 'kolom bank ditambahkan')
  assert.ok(cols.includes('selesai_at'), 'kolom selesai_at ditambahkan')
  migrated.close()
})

test('parseRange', () => {
  const today = new Date().toISOString().slice(0, 10)
  const ym = today.slice(0, 7)
  assert.equal(parseRange().from, today)
  assert.equal(parseRange('bulan').from, `${ym}-01`)
  assert.equal(parseRange('2026-01-05').from, '2026-01-05')
  assert.equal(parseRange('2026-01-05').to, '2026-01-06')
  assert.equal(parseRange('ngawur').from, today)

  // DD = hari ini bulan ini
  const dd = parseRange('22')
  assert.equal(dd.from, `${ym}-22`)
  assert.equal(dd.to, `${ym}-23`)

  // DD-MM-YYYY & DD/MM/YYYY
  assert.equal(parseRange('05-01-2026').from, '2026-01-05')
  assert.equal(parseRange('05/01/2026').from, '2026-01-05')

  // YYYY-MM & MM-YYYY = sebulan penuh
  assert.deepEqual([parseRange('2026-03').from, parseRange('2026-03').to], ['2026-03-01', '2026-04-01'])
  assert.deepEqual([parseRange('03-2026').from, parseRange('03-2026').to], ['2026-03-01', '2026-04-01'])

  // minggu = 7 hari terakhir
  const w = parseRange('minggu')
  assert.equal(w.to, new Date(Date.now() + 86400000).toISOString().slice(0, 10))

  // tanggal tidak valid (31 Feb) jatuh ke default hari ini
  assert.equal(parseRange('31-02-2026').from, today)
})

test('pin hashing', () => {
  const h = hashPin('1234')
  assert.ok(h.startsWith('scrypt$'))
  assert.ok(verifyPin('1234', h))
  assert.ok(!verifyPin('9999', h))
})

test('money formatting', () => {
  assert.equal(formatRupiah(10700), '10.700')
  assert.equal(parseNumber('1.500'), 1500)
})

test('ppob parser', () => {
  assert.deepEqual(parsePpob('BELI.PULSA10.0812.1234'), { cmd: 'beli', args: ['PULSA10', '0812', '1234'] })
  assert.deepEqual(parsePpob('DAFTAR Ani Bandung 628123 500 1234'), { cmd: 'daftar', args: ['Ani', 'Bandung', '628123', '500', '1234'] })
  assert.equal(parsePpob(''), null)
})

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
