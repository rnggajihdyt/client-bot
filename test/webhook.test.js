import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SESSION_DIR = join(mkdtempSync(join(tmpdir(), 'wh-')), 'sessions')
process.env.WEBHOOK_BASE_URL = 'https://bot.example.com/'

const { openDb } = await import('../src/db.js')
const { webhookToken, webhookUrl, handleWebhook, icsConfig } = await import('../src/webhook.js')
const { sessionPath } = await import('../src/config.js')
const { finalize } = await import('../src/orders.js')

const logger = { child: () => logger, info: () => {}, warn: () => {}, error: () => {} }

let seq = 0
function seed() {
  const sessionId = `toko${++seq}`
  const db = openDb(sessionPath(sessionId))
  const root = db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 1000, pin: '1234' })
  const uplink = db.createAgen({ nama: 'Uplink', kota: '', nohp: '628222', seniorId: root.id, markup: 500, pin: '1234' })
  const m = db.createAgen({ nama: 'Mitra', kota: '', nohp: '628333', seniorId: uplink.id, markup: 700, pin: '1234' })
  db.upsertProdukIcs({ code: 'PULSA10', name: 'Pulsa 10', price: 9500, status: 'available' })
  db.raw.prepare(`UPDATE agen SET saldo = 20000 WHERE id = ?`).run(m.id)
  const p = db.effectivePrice(m.id, 'PULSA10')
  db.tx(() => {
    db.addSaldo(m.id, -p.hargaEfektif)
    db.insertTransaksi({
      idTrx: 'T1',
      agenId: m.id,
      produkId: p.id,
      produkKode: p.kode,
      tujuan: '0812',
      hargaModal: p.harga_modal,
      markupAdmin: p.adminMarkup,
      markupTotal: p.markupTotal,
      hargaEfektif: p.hargaEfektif,
      komisiDibagikan: [{ agen_id: uplink.id, kode: uplink.kode, nominal: 700 }],
      status: 'proses',
    })
  })
  return { db, sessionId, token: webhookToken(db) }
}

test('webhook URL memakai base env + token stabil', () => {
  const { db, sessionId } = seed()
  const a = webhookUrl(db, sessionId)
  assert.equal(a, `https://bot.example.com/webhook/${db.getSetting('webhook_token')}/${sessionId}`)
  assert.equal(webhookUrl(db, sessionId), a)
  db.close()
})

test('webhook token salah / session asing ditolak tanpa buat file', () => {
  const { sessionId, token } = seed()
  assert.throws(() => handleWebhook(logger, { sessionId, token: 'salah', raw: '{}' }), /tidak dikenal/)
  assert.throws(() => handleWebhook(logger, { sessionId: 'hantu', token, raw: '{}' }), /tidak dikenal/)
  assert.equal(existsSync(sessionPath('hantu')), false)
})

test('webhook sukses: status + SN tersimpan, komisi dibayar sekali (admin tidak dapat komisi)', () => {
  const { db, sessionId, token } = seed()
  const raw = JSON.stringify({ refid: 'T1', status: 'success', kode_produk: 'PULSA10', nomor_tujuan: '0812', supplier_trxid: 'S1', note: 'SN123' })
  handleWebhook(logger, { sessionId, token, raw })
  const t = db.getTransaksi('T1')
  assert.equal(t.status, 'sukses')
  assert.equal(t.sn, 'SN123')
  assert.equal(db.findAgenByNohp('628111').komisi, 0, 'admin tidak pernah dapat komisi')
  assert.equal(db.findAgenByNohp('628222').komisi, 700)

  handleWebhook(logger, { sessionId, token, raw }) // duplikat
  assert.equal(db.findAgenByNohp('628222').komisi, 700)
  db.close()
})

test('webhook gagal: saldo penuh dikembalikan', () => {
  const { db, sessionId, token } = seed()
  const before = db.findAgenByNohp('628333').saldo
  handleWebhook(logger, {
    sessionId,
    token,
    raw: JSON.stringify({ refid: 'T1', status: 'failed', note: 'gangguan' }),
  })
  const t = db.getTransaksi('T1')
  assert.equal(t.status, 'gagal')
  assert.equal(db.findAgenByNohp('628333').saldo, before + t.harga_efektif)
  db.close()
})

test('finalize idempoten: pending -> sukses, sukses kedua diabaikan', () => {
  const { db } = seed()
  assert.ok(finalize(db, 'T1', { status: 'sukses' }))
  assert.equal(finalize(db, 'T1', { status: 'gagal' }), null)
  assert.equal(db.getTransaksi('T1').status, 'sukses')
  db.close()
})

test('icsConfig: apikey session menimpa env', () => {
  const { db } = seed()
  assert.equal(icsConfig(db).apiKey, '')
  db.setSetting('ics_apikey', 'ICS_sk_x')
  assert.equal(icsConfig(db).apiKey, 'ICS_sk_x')
  db.close()
})
