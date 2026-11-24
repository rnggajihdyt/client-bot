import { test, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config.js reads env at import time, so set it before the dynamic imports below.
const dir = mkdtempSync(join(tmpdir(), 'reportweb-'))
process.env.SESSION_DIR = dir

const { openDb } = await import('../src/db.js')
const { sessionReport } = await import('../src/reportweb.js')

const db = openDb(join(dir, 'toko1.sqlite'))
const admin = db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
const mitra = db.createAgen({ nama: 'Ani', kota: 'Solo', nohp: '628222', seniorId: admin.id, markup: 500, pin: '1234' })

const insert = (idTrx, { agenId = mitra.id, omzet = 10000, modal = 9000, admin2 = 1000, total = 1000, status = 'sukses' } = {}) =>
  db.insertTransaksi({
    idTrx,
    agenId,
    produkId: null,
    produkKode: 'PULSA10',
    tujuan: '0812',
    hargaModal: modal,
    markupAdmin: admin2,
    markupTotal: total,
    hargaEfektif: omzet,
    komisiDibagikan: [],
    status,
  })

insert('T1')
insert('T2', { omzet: 20000, modal: 18000, admin2: 2000, total: 2000 })
insert('T3', { status: 'gagal', omzet: 0, modal: 0, admin2: 0, total: 0 })
db.insertDeposit({ idDeposit: 'D0001', agenId: mitra.id, nominal: 50000, kodeUnik: 123, total: 50123, bank: 'BCA', status: 'sukses' })

test('sessionReport: KPI, harian, produk, agen, deposit', () => {
  const today = new Date().toISOString().slice(0, 10)
  const r = sessionReport('toko1', { from: today, to: today })
  assert.ok(r, 'report ada')
  assert.equal(r.kpi.trx, 2)
  assert.equal(r.kpi.omzet, 30000)
  assert.equal(r.kpi.modal, 27000)
  assert.equal(r.kpi.profit, 3000)
  assert.equal(r.kpi.komisi, 0)
  assert.equal(r.kpi.margin, 10)
  assert.equal(r.status.gagal, 1)
  assert.equal(r.daily.length, 1)
  assert.equal(r.daily[0].omzet, 30000)
  assert.equal(r.topProducts[0].kode, 'PULSA10')
  assert.equal(r.topProducts[0].trx, 2)
  const ani = r.agen.find((a) => a.kode === mitra.kode)
  assert.equal(ani.omzet, 30000)
  assert.equal(ani.profit, 3000)
  assert.equal(r.deposits.find((d) => d.status === 'sukses').total, 50123)
})

test('sessionReport: session tidak dikenal / path traversal ditolak', () => {
  assert.equal(sessionReport('tidakada'), null)
  assert.equal(sessionReport('../toko1'), null)
  assert.equal(sessionReport('..\\toko1'), null)
})

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
