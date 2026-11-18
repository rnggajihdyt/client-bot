import { test, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ppob-int-'))
process.env.OWNERS = '628111'
process.env.COMMAND_PREFIX = ''
process.env.SESSION_DIR = join(dir, 'sessions')

const { openDb } = await import('../src/db.js')
const { attachHandlers } = await import('../src/handler.js')
await import('../src/commands/demo.js')
await import('../src/commands/ppob.js')
await import('../src/commands/ppob-core.js')

const dbPath = join(dir, 'sessions', 'default.sqlite')
const db = openDb(dbPath)
db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
db.upsertProduk({ kode: 'PULSA10', nama: 'Pulsa 10', hargaModal: 9500 })

const sent = []
const handlers = {}
const client = {
  on: (ev, fn) => (handlers[ev] = fn),
  message: {
    send: async (jid, text) => {
      sent.push({ jid, text })
      return { id: 'x' }
    },
    sendReceipt: async () => {},
  },
}
const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
}

attachHandlers(client, 'default', logger)

const last = () => sent[sent.length - 1]?.text

async function say(nohp, text, extra = {}) {
  sent.length = 0
  await handlers.message({
    key: { remoteJid: `${nohp}@s.whatsapp.net`, fromMe: false, ...extra },
    message: { conversation: text },
    pushName: 'tester',
  })
  return last()
}

test('nomor asing ditolak', async () => {
  const r = await say('629999', 'SAL')
  assert.equal(r, 'Anda bukan mitra kami')
})

test('SAL format', async () => {
  const r = await say('628111', 'SAL')
  assert.match(r, /^Yth\. Mitra Admin ID: OWN01/)
  assert.match(r, /Saldo: 0 Limit: 0/)
  assert.match(r, /Ketik TUKAR utk ambil komisi/)
})

test('menu info tetap jalan', async () => {
  const r = await say('628111', 'info')
  assert.match(r, /PANDUAN TRANSAKSI/)
})

test('all: semua format dalam satu pesan', async () => {
  const r = await say('628111', 'all')
  assert.match(r, /PANDUAN TRANSAKSI/)
  assert.match(r, /FORMAT 1 \(TRANSAKSI & CEK SALDO\)/)
  assert.match(r, /FORMAT 2 \(DEPOSIT & TAMBAH AGEN\)/)
  assert.match(r, /FORMAT 3 \(KELOLA DOWNLINE & MARKUP\)/)
  assert.match(r, /FORMAT 4 \(PENGATURAN AKUN & PIN\)/)
  assert.equal(sent.length, 1) // one single message
})

test('DAFTAR admin -> uplink RS00001 + welcome ke downline', async () => {
  sent.length = 0
  await say('628111', 'DAFTAR.Ani.Bandung.628222.500.1234')
  const ack = sent.find((s) => s.jid === '628111@s.whatsapp.net')
  assert.match(ack.text, /sebagai uplink Anda/)
  assert.match(ack.text, /RS00001/)
  // welcome goes to the new downline's number, not the uplink
  const welcome = sent.find((s) => s.jid === '628222@s.whatsapp.net')
  assert.ok(welcome, 'welcome message sent to downline')
  assert.equal(
    welcome.text,
    'Yth. Ani, Selamat bergabung! Kode Agen anda adalah RS00001, PIN: 1234, Saldo sekarang 0. Ketik INFO untuk mengetahui format-format transaksi.'
  )
})

test('CH untuk downline: modal + markup', async () => {
  const r = await say('628222', 'CH.PULSA10')
  assert.match(r, /10\.000/) // 9500 + 500
})

test('MP ubah markup dan harga ikut berubah', async () => {
  const r = await say('628111', 'MP.RS00001.1000.1234')
  assert.match(r, /1\.000/)
  const h = await say('628222', 'CH.PULSA10')
  assert.match(h, /10\.500/) // 9500 + 1000
})

test('MP ditolak untuk bukan downline', async () => {
  const r = await say('628222', 'MP.OWN01.999.1234')
  assert.equal(r, 'Bukan downline Anda')
})

test('TUKAR dengan komisi 0', async () => {
  const r = await say('628222', 'TUKAR')
  assert.equal(r, 'Komisi Anda 0')
})

test('nomor paralel jadi mitra yang sama', async () => {
  const add = await say('628111', 'TNO.628333.1234')
  assert.match(add, /628333/)
  const r = await say('628333', 'SAL')
  assert.match(r, /ID: OWN01/)
})

test('PIN salah ditolak', async () => {
  const r = await say('628111', 'MP.RS00001.1.9999')
  assert.equal(r, 'PIN salah')
})

test('nonaktif: SAL & info boleh dengan keterangan, sisanya diblokir', async () => {
  await say('628111', 'NA.RS00001.1234') // naikkan: A nonaktif
  const sal = await say('628222', 'SAL')
  assert.match(sal, /^Yth\. Mitra Ani ID: RS00001/)
  assert.match(sal, /Akun Anda sedang DINONAKTIFKAN/)
  assert.match(await say('628222', 'info'), /PANDUAN TRANSAKSI/)
  assert.match(await say('628222', 'all'), /FORMAT 4/)
  assert.equal(await say('628222', 'LDL'), 'Akun Anda nonaktif')
  assert.equal(await say('628222', 'CH.PULSA10'), 'Akun Anda nonaktif')
  await say('628111', 'AKTIF.RS00001.1234') // pulihkan untuk test berikutnya
  assert.doesNotMatch(await say('628222', 'SAL'), /DINONAKTIFKAN/)
})

test('nonaktif A: B tetap transaksi, A dapat komisi, A tak bisa TUKAR', async () => {
  // A (RS00001 / 628222, markup 1000) mendaftarkan B
  const r = await say('628222', 'DAFTAR.Budi.Solo.628444.500.1234')
  assert.match(r, /RS00002/)

  // beri saldo B
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628444'`).run()

  // A dinonaktifkan oleh uplink (admin)
  assert.match(await say('628111', 'NA.RS00001.1234'), /DINONAKTIFKAN/)

  // A hanya bisa baca status, bukan transaksi
  assert.match(await say('628222', 'SAL'), /DINONAKTIFKAN/)

  // B tetap bisa transaksi dengan harga penuh (modal 9500 + 1000 + 500 = 11000)
  const beli = await say('628444', 'BELI.PULSA10.081234567')
  assert.match(beli, /Transaksi berhasil/)
  assert.match(beli, /Harga: 11\.000/)
  assert.match(beli, /Saldo: 39\.000/)

  // komisi A bertambah walau nonaktif (markup A = 1000)
  const a = db.raw.prepare(`SELECT komisi FROM agen WHERE nohp = '628222'`).get()
  assert.equal(a.komisi, 1000)

  // A tidak bisa mencairkan komisi
  assert.equal(await say('628222', 'TUKAR'), 'Akun Anda nonaktif')

  // aktifkan lagi -> komisi bisa dicairkan
  assert.match(await say('628111', 'AKTIF.RS00001.1234'), /DIAKTIFKAN/)
  const tukar = await say('628222', 'TUKAR')
  assert.match(tukar, /1\.000/)
  const a2 = db.raw.prepare(`SELECT komisi, saldo FROM agen WHERE nohp = '628222'`).get()
  assert.equal(a2.komisi, 0)
  assert.equal(a2.saldo, 1000)
})

test('BELI ditolak saat saldo kurang', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 100 WHERE nohp = '628444'`).run()
  assert.equal(await say('628444', 'BELI.PULSA10.0812'), 'Saldo tidak cukup')
})

test('transaksi menyimpan harga modal & markup admin saat itu', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628444'`).run()
  assert.match(await say('628444', 'BELI.PULSA10.08123'), /Transaksi berhasil/)

  const trx = db.raw.prepare(`SELECT * FROM transaksi WHERE tujuan = '08123' ORDER BY id DESC`).get()
  assert.equal(trx.produk_kode, 'PULSA10')
  assert.equal(trx.harga_modal, 9500)
  assert.equal(trx.markup_admin, 0)
  assert.equal(trx.harga_efektif, 11000)
  assert.equal(trx.markup_total, 1500)

  // ubah harga modal produk — transaksi lama tidak boleh berubah
  db.raw.prepare(`UPDATE produk SET harga_modal = 12000 WHERE kode = 'PULSA10'`).run()
  const after = db.raw.prepare(`SELECT * FROM transaksi WHERE id = ?`).get(trx.id)
  assert.equal(after.harga_modal, 9500)

  const sum = db.profitSummary({ from: '2000-01-01', to: '2100-01-01' })
  assert.equal(sum.trx, 2)
  assert.equal(sum.modal, 19000) // 9500 x 2
  assert.equal(sum.markup, 3000) // 1500 x 2

  db.raw.prepare(`UPDATE produk SET harga_modal = 9500 WHERE kode = 'PULSA10'`).run()
})

test('kirim gagal (nack 401) tidak menjatuhkan handler', async () => {
  const orig = client.message.send
  client.message.send = async () => {
    const e = new Error('publish ack error=401')
    e.name = 'MessagePublishNackError'
    throw e
  }
  try {
    await say('628444', 'SAL') // must not throw
  } finally {
    client.message.send = orig
  }
})

// ---- multi-session: admin role, per-product markup, LAP, super admin ----

test('PRDK tambah/ubah produk (admin)', async () => {
  const r = await say('628111', 'PRDK.DATA5.GB-Data-5.15000')
  assert.match(r, /DATA5 disimpan \(modal 15\.000\)/)
  const c = await say('628222', 'CH.DATA5')
  assert.match(c, /16\.000/) // 15000 + general 0 + Ani 1000
})

test('PRDK ditolak untuk mitra', async () => {
  assert.equal(await say('628222', 'PRDK.X.X.100'), 'Khusus admin')
})

test('MKP per produk menimpa general', async () => {
  // general markup = root markup (0). DATA5 = 15000 + Ani 1000 = 16000
  assert.match(await say('628111', 'MKP.DATA5.2000'), /Markup produk DATA5 diubah/)
  const c = await say('628222', 'CH.DATA5')
  assert.match(c, /18\.000/) // 15000 + admin 2000 + Ani 1000
})

test('MKP general (tanpa kode)', async () => {
  assert.match(await say('628111', 'MKP.500'), /Markup general/)
  const c = await say('628222', 'CH.PULSA10')
  // PULSA10 tanpa override per produk -> 9500 + admin 500 + Ani 1000
  assert.match(c, /11\.000/)
  assert.match(await say('628111', 'MKP.0'), /Markup general/)
})

test('LPRDK list produk', async () => {
  const r = await say('628111', 'LPRDK')
  assert.match(r, /DATA5/)
  assert.match(r, /markup 2\.000/)
})

test('BELI produk ber-markup admin: profit masuk ke markup_admin', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628222'`).run()
  const r = await say('628222', 'BELI.DATA5.0811999')
  assert.match(r, /Harga: 18\.000/) // 15000 + admin 2000 + Ani 1000
})

test('LAP admin: seluruh session', async () => {
  const r = await say('628111', 'LAP.BULAN')
  assert.match(r, /\*Laporan Sesi\*/)
  assert.match(r, /Trx: 3/)
  assert.match(r, /Profit: 2\.000/) // markup_admin DATA5 2000 (2 trx)
})

test('LAP uplink: jaringannya sendiri', async () => {
  const r = await say('628222', 'LAP.BULAN')
  assert.match(r, /\*Laporan Jaringan\*/)
  assert.match(r, /Komisi Anda: 1\.000/)
})

test('super admin: SESIBUAT + SESI + LAPTRX lintas session', async () => {
  const mk = await say('628111', 'SESIBUAT.toko2.628555.Toko Dua')
  assert.match(mk, /Session \*toko2\* terdaftar/)

  const list = await say('628111', 'SESI')
  assert.match(list, /toko2/)
  assert.match(list, /628555/)

  // seed a transaction in toko2 directly through its DB
  const sdb = openDb(join(dir, 'sessions', 'toko2.sqlite'))
  const admin = sdb.findAgenByNohp('628555')
  assert.ok(admin, 'admin toko2 di-seed')
  sdb.upsertProduk({ kode: 'KUOTA', nama: 'Kuota', hargaModal: 10000 })
  sdb.createAgen({ nama: 'M', kota: '', nohp: '628666', seniorId: admin.id, markup: 500, pin: '1234' })
  sdb.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628666'`).run()
  sdb.tx(() => {
    const p = sdb.effectivePrice(sdb.findAgenByNohp('628666').id, 'KUOTA')
    sdb.addSaldo(sdb.findAgenByNohp('628666').id, -p.hargaEfektif)
    sdb.insertTransaksi({
      idTrx: 'TTEST1',
      agenId: sdb.findAgenByNohp('628666').id,
      produkId: p.id,
      produkKode: p.kode,
      tujuan: '0812',
      hargaModal: p.harga_modal,
      markupAdmin: p.adminMarkup,
      markupTotal: p.markupTotal,
      hargaEfektif: p.hargaEfektif,
      komisiDibagikan: [],
      status: 'sukses',
    })
  })
  sdb.close()

  const lap = await say('628111', 'LAPTRX.toko2.BULAN')
  assert.match(lap, /\*Transaksi toko2\*/)
  assert.match(lap, /Trx: 1/)
  assert.match(lap, /KUOTA/)
})

test('super admin nomor asing tetap ditolak', async () => {
  const r = await say('628999', 'SESI')
  assert.equal(r, 'Anda bukan mitra kami')
})

after(() => {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows keeps temp DB handles briefly; the dir is disposable.
  }
})
