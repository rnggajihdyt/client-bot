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
const { openRegistry } = await import('../src/registry.js')
const { attachHandlers } = await import('../src/handler.js')
await import('../src/commands/demo.js')
await import('../src/commands/ppob.js')
await import('../src/commands/ppob-core.js')
await import('../src/commands/supplier.js')
await import('../src/commands/owner.js')
const { finalize } = await import('../src/orders.js')
openRegistry(join(dir, 'registry.sqlite'))

const dbPath = join(dir, 'sessions', 'default.sqlite')
const db = openDb(dbPath)
db.createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
db.upsertProdukIcs({ code: 'PULSA10', name: 'Pulsa 10', price: 9500, status: 'available', stock: 10 })
db.setSetting('ics_apikey', 'ICS_sk_testok')

// Fake ICS: order always accepted, status stays pending until a test resolves it.
let icsOrders = []
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {}
  const u = String(url)
  // Any key not ending in "ok" is rejected, like a real 401.
  if (!/Bearer .*ok$/.test(opts.headers?.Authorization ?? '')) {
    return { ok: false, status: 401, text: async () => JSON.stringify({ success: false, message: 'API key tidak valid' }) }
  }
  if (u.includes('/api/reseller/products')) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: [{ code: 'PULSA10', name: 'Pulsa 10', price: 9500, category: 'Pulsa', status: 'available', stock: 10 }],
        }),
    }
  }
  icsOrders.push({ url: u, body })
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, data: { refid: body.ref_id_custom, status: 'pending' } }),
  }
}

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

const runtimeCalls = []
const fakeRuntime = {
  startSession: async (id, opts) => {
    runtimeCalls.push({ id, opts })
    await opts?.notify?.(`KODE PAIRING ${id}`)
  },
  stopSession: async (id) => {
    runtimeCalls.push({ id, stop: true })
  },
  clients: new Map(),
}
globalThis.__waRuntime = fakeRuntime

attachHandlers(client, 'default', logger, fakeRuntime)

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
  const r = await say('628111', 'format1')
  assert.match(r, /FORMAT 1 \(TRANSAKSI & CEK SALDO\)/)
})

test('info admin & super admin dapat section khusus', async () => {
  // 628111 = admin session DAN super admin (OWNERS)
  const r = await say('628111', 'info')
  assert.match(r, /PANDUAN TRANSAKSI/)
  assert.match(r, /KHUSUS ADMIN/)
  assert.match(r, /APIKEY\.ICS_sk_xxx/)
  assert.match(r, /KHUSUS SUPER ADMIN/)
  assert.match(r, /SESIBUAT\.ID\.NOMORADMIN/)

  // dump semua format juga dapat section
  const all = await say('628111', 'all')
  assert.match(all, /KHUSUS ADMIN/)
  assert.match(all, /LAPTRX\.ID/)
})

test('info uplink/mitra tanpa section admin', async () => {
  // DAFTAR admin → uplink RS00001 + welcome ke downline (butuh 628222 jadi mitra)
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

  // uplink biasa: tidak ada section admin/super admin, tapi ada CEK/REK/BTL
  const up = await say('628222', 'all')
  assert.match(up, /FORMAT 4/)
  assert.doesNotMatch(up, /KHUSUS ADMIN/)
  assert.doesNotMatch(up, /KHUSUS SUPER ADMIN/)
  assert.match(up, /Cek Trx : CEK\[\.IDTRX\]/)
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
  assert.match(beli, /Transaksi diproses/)
  assert.match(beli, /Harga: 11\.000/)
  const idTrx = beli.match(/ID: (T\d+)/)[1]
  assert.equal(icsOrders.at(-1).body.ref_id_custom, idTrx)

  // saldo ditahan dulu, komisi belum dibayar selama masih proses
  const b0 = db.raw.prepare(`SELECT saldo FROM agen WHERE nohp = '628444'`).get()
  assert.equal(b0.saldo, 39000)
  assert.equal(db.raw.prepare(`SELECT komisi FROM agen WHERE nohp = '628222'`).get().komisi, 0)

  // supplier settle -> komisi A masuk walau nonaktif (markup A = 1000)
  finalize(db, idTrx, { status: 'sukses', sn: 'SN123' })
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
  const r = await say('628444', 'BELI.PULSA10.08123')
  assert.match(r, /Transaksi diproses/)
  const idTrx = r.match(/ID: (T\d+)/)[1]
  finalize(db, idTrx, { status: 'sukses' })

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

test('PRDK dihapus: SYNC menggantikan', async () => {
  const before = db.listProduk().length
  assert.equal(await say('628111', 'PRDK.X.X.100'), undefined) // prefix kosong: diabaikan
  assert.equal(db.listProduk().length, before)
  const r = await say('628111', 'SYNC')
  assert.match(r, /Sync selesai\. 1 produk diterima, 1 tersedia\./)
})

test('SYNC ditolak untuk mitra', async () => {
  assert.equal(await say('628222', 'SYNC'), 'Khusus admin')
})

test('MKP per produk menimpa general', async () => {
  // general markup = root markup (0). PULSA10 = 9500 + Ani 1000 = 10500
  assert.match(await say('628111', 'MKP.PULSA10.2000'), /Markup produk PULSA10 diubah/)
  const c = await say('628222', 'CH.PULSA10')
  assert.match(c, /12\.500/) // 9500 + admin 2000 + Ani 1000
})

test('MKP general (tanpa kode)', async () => {
  // hapus override per produk supaya general markup berlaku
  db.raw.prepare(`UPDATE produk SET markup = NULL WHERE kode = 'PULSA10'`).run()
  assert.match(await say('628111', 'MKP.500'), /Markup general/)
  const c = await say('628222', 'CH.PULSA10')
  // PULSA10 tanpa override per produk -> 9500 + admin 500 + Ani 1000
  assert.match(c, /11\.000/)
  assert.match(await say('628111', 'MKP.0'), /Markup general/)
})

test('LPRDK list produk', async () => {
  const r = await say('628111', 'LPRDK')
  assert.match(r, /PULSA10/)
  assert.match(r, /available/)
})

test('BELI produk: harga pakai general markup, profit masuk ke markup_admin', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628222'`).run()
  assert.match(await say('628111', 'MKP.2000'), /Markup general/)
  const r = await say('628222', 'BELI.PULSA10.0811999')
  assert.match(r, /Harga: 12\.500/) // 9500 + admin 2000 + Ani 1000
  const idTrx = r.match(/ID: (T\d+)/)[1]
  finalize(db, idTrx, { status: 'sukses' })
})

test('LAP admin: seluruh session', async () => {
  const r = await say('628111', 'LAP.BULAN')
  assert.match(r, /\*Laporan Sesi\*/)
  // 3 trx sukses: markup_admin 2000 x 1 + 0 x 2
  assert.match(r, /Profit: 2\.000/)
  assert.match(await say('628111', 'MKP.0'), /Markup general/)
})

test('LAP uplink: jaringannya sendiri', async () => {
  const r = await say('628222', 'LAP.BULAN')
  assert.match(r, /\*Laporan Jaringan\*/)
  assert.match(r, /Komisi Anda: 1\.000/)
})

test('CEK/REK/BTL: transaksi pending, refund batal, webhook telat diabaikan', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628222'`).run()
  const r = await say('628222', 'BELI.PULSA10.0811777')
  const idTrx = r.match(/ID: (T\d+)/)[1]

  assert.match(await say('628222', 'CEK'), new RegExp(`${idTrx} — PULSA10`))
  assert.match(await say('628222', `CEK.${idTrx}`), /Status: proses/)
  assert.match(await say('628222', 'REK'), /Beli PULSA10/)

  assert.match(await say('628222', `BTL.${idTrx}.1234`), /dibatalkan/)
  const saldo = db.raw.prepare(`SELECT saldo FROM agen WHERE nohp = '628222'`).get().saldo
  assert.equal(saldo, 50000)

  // webhook sukses telat tidak boleh mengubah batal
  assert.equal(finalize(db, idTrx, { status: 'sukses' }), null)
  assert.equal(db.getTransaksi(idTrx).status, 'batal')
})

test('super admin: SESIBUAT + SESI + LAPTRX lintas session', async () => {
  await say('628111', 'SESIBUAT.toko2.628555.62856429274736.Toko Dua')
  const mk = sent.find((s) => /terdaftar/.test(s.text))?.text ?? ''
  assert.match(mk, /Session \*toko2\* terdaftar/)
  assert.match(mk, /Menyambungkan/)
  // pairing code diumumkan balik ke chat super admin via notify
  assert.ok(runtimeCalls.some((c) => c.id === 'toko2'), 'runtime.startSession dipanggil')

  const list = await say('628111', 'SESI')
  assert.match(list, /toko2/)
  assert.match(list, /62856429274736/)

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

test('super admin: SESIBUAT wajib NOMORWA + admin beda dengan nomor bot', async () => {
  const noWa = await say('628111', 'SESIBUAT.toko4.628555')
  assert.match(noWa, /SESIBUAT\.ID\.NOMORADMIN\.NOMORWA/)

  const same = await say('628111', 'SESIBUAT.toko4.628555123.628555123')
  assert.match(same, /tidak boleh sama/)
  assert.ok(!(await say('628111', 'SESI')).includes('toko4'), 'session tidak terdaftar')
})

test('onboarding: prompt apikey dikirim ke nomor admin, bukan nomor bot', async () => {
  const { runOnboarding } = await import('../src/apikey.js')
  const pushed = []
  const notify = (jid, text) => pushed.push({ jid, text })

  await say('628111', 'SESIBUAT.toko9.628997.6289980000.Toko Sembilan')
  await runOnboarding(logger, 'toko9', notify)
  assert.equal(pushed[0].jid, '628997@s.whatsapp.net')
  assert.match(pushed[0].text, /Setup Supplier ICS/)
  // bot's own number never receives the prompt
  assert.ok(!pushed.some((p) => p.jid.startsWith('6289980000')))
})

test('gate apikey: admin tanpa key di-prompt terus, key salah ditolak, key benar tersimpan', async () => {
  // session baru: admin 628777 (bukan OWNERS) -> kena gate onboarding
  await say('628111', 'SESIBUAT.toko3.628777.628777888.Toko Tiga')
  const sdb = openDb(join(dir, 'sessions', 'toko3.sqlite'))
  const shopHandlers = {}
  const shopClient = {
    on: (ev, fn) => (shopHandlers[ev] = fn),
    message: { send: async (jid, text) => (sent.push({ jid, text }), { id: 'y' }) },
  }
  attachHandlers(shopClient, 'toko3', logger, fakeRuntime)
  const sayShop = async (text) => {
    sent.length = 0
    await shopHandlers.message({
      key: { remoteJid: '628777@s.whatsapp.net', fromMe: false },
      message: { conversation: text },
    })
    return last()
  }

  // perintah uang diblokir, diganti prompt
  assert.match(await sayShop('SAL'), /Setup Supplier ICS/)
  assert.match(await sayShop('BELI.PULSA10.0812'), /Setup Supplier ICS/)
  // info/menu tetap boleh
  assert.doesNotMatch(await sayShop('info'), /Setup Supplier ICS/)

  // key salah format -> prompt lagi
  assert.match(await sayShop('APIKEY.salah'), /Setup Supplier ICS/)

  // key salah tapi format benar -> ditolak ICS, TIDAK tersimpan
  assert.match(await sayShop('APIKEY.ICS_sk_nope'), /belum benar/)
  assert.equal(sdb.getSetting('ics_apikey'), undefined)

  // key benar (mock menerima yang berakhiran "ok") -> tersimpan + sinkron produk
  assert.match(await sayShop('ICS_sk_baikok'), /API key tersimpan\. 1 produk tersinkron/)
  assert.equal(sdb.getSetting('ics_apikey'), 'ICS_sk_baikok')
  assert.equal(sdb.listProduk().length, 1)

  // setelah ada key, SAL tidak lagi di-prompt
  assert.doesNotMatch(await sayShop('SAL'), /Setup Supplier ICS/)
  sdb.close()
})

test('utilitas owner: STATUS / CMD / ENV', async () => {
  const st = await say('628111', 'STATUS')
  assert.match(st, /\*Status Server\*/)
  assert.match(st, /Uptime proses:/)
  assert.match(st, /Node: v\d+/)

  const cmd = await say('628111', 'CMD')
  assert.match(cmd, /• status — Owner: status proses & server/)
  assert.match(cmd, /• beli — /)
  assert.match(cmd, /• restart — /)

  const env = await say('628111', 'ENV')
  assert.match(env, /\*Config\*/)
  assert.match(env, /Owners: 6281\*\*\*/) // masked
  assert.doesNotMatch(env, /628111/)
})

test('utilitas owner: SESSIONS + RESTART memakai runtime', async () => {
  fakeRuntime.clients.set('toko2', {})
  const s = await say('628111', 'SESSIONS')
  assert.match(s, /\*Sessions:\*/)
  assert.match(s, /• toko2 — 🟢 live/)
  assert.match(s, /admin 628555/)

  runtimeCalls.length = 0
  const r = await say('628111', 'RESTART.toko2')
  assert.match(r, /di-restart/)
  assert.ok(runtimeCalls.some((c) => c.id === 'toko2' && c.stop), 'stopSession dipanggil')
  assert.ok(runtimeCalls.some((c) => c.id === 'toko2' && !c.stop), 'startSession dipanggil')
})

test('utilitas owner ditolak untuk mitra', async () => {
  assert.equal(await say('628222', 'STATUS'), 'Khusus owner')
  assert.equal(await say('628222', 'ENV'), 'Khusus owner')
  assert.equal(await say('628222', 'RESTART.toko2'), 'Khusus owner')
})

after(() => {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows keeps temp DB handles briefly; the dir is disposable.
  }
})
