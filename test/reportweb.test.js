import { test, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config.js reads env at import time, so set it before the dynamic imports below.
const dir = mkdtempSync(join(tmpdir(), 'reportweb-'))
process.env.SESSION_DIR = dir

const { openDb } = await import('../src/db.js')
const { sessionReport, resolveReportCode } = await import('../src/reportweb.js')
const { reportCode, ownerReportCode, ownerReportUrl, reportUrl } = await import('../src/reportcode.js')
const { openRegistry, createSession, closeRegistry } = await import('../src/registry.js')

const db = openDb(join(dir, 'toko1.sqlite'))
openRegistry(join(dir, 'registry.sqlite'))
createSession({ id: 'toko1', adminNohp: '628111' })
const admin = db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
const mitra = db.createAgen({ nama: 'Ani', kota: 'Solo', nohp: '628222', seniorId: admin.id, markup: 500, pin: '1234' })

const insert = (idTrx, { agenId = mitra.id, omzet = 10000, modal = 9000, admin2 = 1000, total = 1000, status = 'sukses' } = {}) =>
  db.insertTransaksi({
    idTrx,
    agenId,
    produkId: null,
    produkKode: idTrx === 'T4' ? 'PULSA5' : 'PULSA10',
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

test('sessionReport: mitra hanya melihat dirinya, tanpa profit/modal/uplink', () => {
  const today = new Date().toISOString().slice(0, 10)
  const r = sessionReport('toko1', { from: today, to: today, viewer: mitra.kode })
  assert.equal(r.kpi.trx, 2)
  assert.equal(r.kpi.omzet, 30000)
  assert.equal(r.viewer.kode, mitra.kode)
  assert.equal(r.admin, false)
  // Margins the admin controls are never exposed to a mitra.
  assert.equal(r.kpi.profit, 0)
  assert.equal(r.kpi.modal, 0)
  assert.equal(r.kpi.komisi, 0)
  assert.equal(r.kpi.margin, 0)
  assert.equal(r.network, undefined)
  assert.equal(r.daily[0].profit, 0)
  assert.equal(r.topProducts[0].profit, 0)
  // Agen table only ever holds the mitra itself — no admin row.
  assert.equal(r.agen.length, 1)
  assert.equal(r.agen[0].kode, mitra.kode)
  assert.equal(r.agen[0].profit, 0)

  const adminView = sessionReport('toko1', { from: today, to: today, viewer: admin.kode })
  assert.equal(adminView.admin, true)
  assert.equal(adminView.kpi.profit, 3000)
  assert.equal(adminView.network.uplinks.length, 0)
  // The admin row is never listed: it has no transactions of its own.
  assert.deepEqual(adminView.agen.map((a) => a.kode), [mitra.kode])
})

test('sessionReport: mitra yang punya downline tetap hanya lihat dirinya', () => {
  const reseller = db.createAgen({ nama: 'Budi', kota: 'Solo', nohp: '628333', seniorId: mitra.id, markup: 200, pin: '1234' })
  insert('T4', { agenId: reseller.id, omzet: 5000, modal: 4500, admin2: 500, total: 700 })
  const today = new Date().toISOString().slice(0, 10)
  const r = sessionReport('toko1', { from: today, to: today, viewer: mitra.kode })
  // Downline's omzet is not the mitra's business.
  assert.equal(r.kpi.trx, 2)
  assert.equal(r.kpi.omzet, 30000)
  assert.deepEqual(r.agen.map((a) => a.kode), [mitra.kode])
  // The admin still sees the whole network.
  const adminView = sessionReport('toko1', { from: today, to: today, viewer: admin.kode })
  assert.equal(adminView.kpi.trx, 3)
  assert.deepEqual(adminView.agen.map((a) => a.kode).sort(), [mitra.kode, reseller.kode].sort())
})

test('reportCode: 8 char, stabil, unik per session/agen; resolve balik', () => {
  const code = reportCode('toko1', mitra.kode)
  assert.match(code, /^[a-z0-9]{8}$/)
  assert.equal(reportCode('toko1', mitra.kode), code)
  assert.notEqual(reportCode('toko1', admin.kode), code)
  assert.notEqual(reportCode('toko2', mitra.kode), code)
  assert.deepEqual(resolveReportCode(code), { session: 'toko1', kode: mitra.kode })
  assert.equal(resolveReportCode('zzzzzzzz'), null)
  assert.equal(resolveReportCode('../../etc'), null)
  assert.match(reportUrl('toko1', mitra.kode), new RegExp(`/${code}/report$`))
})

test('sessionReport: session tidak dikenal / path traversal ditolak', () => {
  assert.equal(sessionReport('tidakada'), null)
  assert.equal(sessionReport('../toko1'), null)
  assert.equal(sessionReport('..\\toko1'), null)
})

test('owner link: kode dari session owner resolve ke mode admin', () => {
  const code = ownerReportCode('toko1')
  assert.match(code, /^[a-z0-9]{8}$/)
  // A session with a root agen is the owner session; its code pins the admin view.
  assert.deepEqual(resolveReportCode(code), { session: 'toko1', owner: true, pin_owner: true })
  // Never collides with a real mitra link in the same session.
  assert.notEqual(code, reportCode('toko1', admin.kode))
  assert.notEqual(code, reportCode('toko1', mitra.kode))
  assert.match(ownerReportUrl(), /\/[a-z0-9]{8}\/report$/)
})

after(() => {
  db.close()
  closeRegistry()
  rmSync(dir, { recursive: true, force: true })
})
