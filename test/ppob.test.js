import { test, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDb, closeDb, tx, createAgen, findAgenByNohp, findAgenById, findAgenByKode, downlines, markupTotal, effectivePrice, setSaldoKomisi, addMutasi, addNomor, removeNomor, nomorOf, transaksiStats } from '../src/db.js'
import { hashPin, verifyPin } from '../src/auth.js'
import { formatRupiah, parseNumber } from '../src/money.js'
import { parsePpob } from '../src/parse.js'

const dir = mkdtempSync(join(tmpdir(), 'ppob-'))
const db = initDb(join(dir, 'test.sqlite'))

// root (OWN01)
const root = createAgen({ nama: 'Admin', kota: '', nohp: '6281000000001', seniorId: null, markup: 0, pin: '1234' })
// reseller (RS00001) under root
const r1 = createAgen({ nama: 'Reseller', kota: 'Jakarta', nohp: '6281000000002', seniorId: root.id, markup: 1000, pin: '1111' })
// doni under r1
const doni = createAgen({ nama: 'Doni', kota: 'Bogor', nohp: '6281000000003', seniorId: r1.id, markup: 500, pin: '2222' })

test('kode generator', () => {
  assert.equal(root.kode, 'OWN01')
  assert.equal(r1.kode, 'RS00001')
  assert.equal(doni.kode, 'RS00002')
})

test('lookup by nohp (main)', () => {
  const a = findAgenByNohp('6281000000002')
  assert.equal(a.id, r1.id)
})

test('lookup by nohp via parallel number', () => {
  addNomor(r1.id, '6281000000009')
  const a = findAgenByNohp('6281000000009')
  assert.equal(a.id, r1.id)
  assert.equal(removeNomor(r1.id, '6281000000009'), 1)
})

test('markup beranak (recursive)', () => {
  // doni: root(0) + r1(1000) + doni(500) = 1500
  assert.equal(markupTotal(doni.id), 1500)
  assert.equal(markupTotal(r1.id), 1000)
  assert.equal(markupTotal(root.id), 0)
})

test('effectivePrice', () => {
  db.prepare(`INSERT INTO produk (kode, nama, harga_modal, kategori) VALUES ('PULSA10', 'Pulsa 10', 9500, 'pulsa')`).run()
  const p = effectivePrice(doni.id, 'PULSA10')
  assert.equal(p.hargaEfektif, 9500 + 1500) // 11000
  assert.equal(effectivePrice(doni.id, 'NOTHING'), undefined)
})

test('downlines direct only', () => {
  const dl = downlines(r1.id)
  assert.equal(dl.length, 1)
  assert.equal(dl[0].id, doni.id)
})

test('TUKAR atomic transfer', () => {
  setSaldoKomisi(doni.id, 0, 2000)
  tx(() => {
    const d = findAgenById(doni.id)
    addMutasi(d.id, 'komisi_masuk', -d.komisi, d.saldo, 'TUKAR')
    addMutasi(d.id, 'kredit', d.komisi, d.saldo + d.komisi, 'TUKAR')
    setSaldoKomisi(d.id, d.saldo + d.komisi, 0)
  })
  const after = findAgenById(doni.id)
  assert.equal(after.saldo, 2000)
  assert.equal(after.komisi, 0)
})

test('transaksiStats', () => {
  db.prepare(`INSERT INTO transaksi (id_trx, agen_id, harga_efektif, status, created_at) VALUES ('T1', ?, 5000, 'proses', ?)`).run(doni.id, new Date().toISOString())
  const st = transaksiStats(doni.id)
  assert.equal(st.proses, 1)
  assert.equal(st.hariIni, 5000)
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
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})
