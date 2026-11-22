import { test, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ppob-int-'))
process.env.OWNERS = '628111'
process.env.COMMAND_PREFIX = ''
process.env.SESSION_DIR = join(dir, 'sessions')
process.env.STORE_PATH = join(dir, 'state.sqlite')

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

test('nomor asing & pesan grup diabaikan diam-diam (default ignore), mode once/always tetap bekerja', async () => {
  // Default UNKNOWN_SENDER_MODE=ignore: tidak membalas nomor asing
  assert.equal(await say('629999', 'SAL'), undefined)
  assert.equal(sent.length, 0)

  // Default IGNORE_GROUPS=true: pesan grup (@g.us) diabaikan diam-diam meski dari owner
  sent.length = 0
  await handlers.message({
    key: { remoteJid: '12036300000@g.us', participant: '628111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'SAL' },
  })
  assert.equal(sent.length, 0)

  // Mode once: balas sekali saja untuk nomor asing
  process.env.UNKNOWN_SENDER_MODE = 'once'
  assert.equal(await say('629998', 'SAL'), 'Anda bukan mitra kami')
  assert.equal(await say('629998', 'SAL'), undefined)

  // Mode always: selalu balas
  process.env.UNKNOWN_SENDER_MODE = 'always'
  assert.equal(await say('629997', 'SAL'), 'Anda bukan mitra kami')
  delete process.env.UNKNOWN_SENDER_MODE
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
  assert.match(r, /APIKEY\.KEY/)
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
  assert.match(r, /Status: Tersedia/)

  // produk kosong/empty tetap tampil di CH dengan status Kosong, dan ditolak di BELI sebagai tidak tersedia
  db.upsertProdukIcs({ code: 'XDA40', name: 'XL AXIS Data 40Gb', price: 76000, type: 'xda', category: 'BEST', status: 'empty', stock: 0 })
  const chEmpty = await say('628222', 'CH.XDA40')
  assert.match(chEmpty, /76\.500/)
  assert.match(chEmpty, /Status: Kosong/)
  const beliEmpty = await say('628222', 'BELI.XDA40.08123456')
  assert.match(beliEmpty, /gangguan\/tidak tersedia/)

  // pengkategorian mengikuti field `type` ICS + paginasi (CH.XDA.1 / CH.XDA.2 / CH.AX.1 vs CH.AXP.1 / CH.SM.1)
  for (let i = 1; i <= 17; i++) {
    db.upsertProdukIcs({
      code: `XDA${String(i).padStart(2, '0')}`,
      name: `XL Data ${i}GB`,
      price: 10000 + i * 1000,
      type: 'xda',
      category: 'PROMO',
      status: 'available',
      stock: 10,
    })
  }
  db.upsertProdukIcs({ code: 'AXLK9', name: 'Axis Lite 9', price: 9000, type: 'ax', category: 'General', status: 'available', stock: 5 })
  db.upsertProdukIcs({ code: 'AXP14', name: 'Axis Pro 14', price: 14000, type: 'axp', category: 'General', status: 'available', stock: 5 })
  db.upsertProdukIcs({ code: 'M19', name: 'Smartfren 19', price: 19000, type: 'sm', category: 'General', status: 'available', stock: 5 })

  const page1 = await say('628222', 'CH.XDA.1')
  assert.match(page1, /\*Harga XDA\* \(Hal 1\/2 — 18 produk\)/)
  assert.match(page1, /• \*XDA01\* — 11\.500 \(Tersedia\)/)
  assert.match(page1, /Halaman berikutnya: CH\.XDA\.2/)

  const page2 = await say('628222', 'CH.XDA.2')
  assert.match(page2, /\*Harga XDA\* \(Hal 2\/2 — 18 produk\)/)
  assert.match(page2, /• \*XDA40\* — 76\.500 \(Kosong\)/)
  assert.match(page2, /Halaman sebelumnya: CH\.XDA\.1/)

  // halaman di luar batas & invalid
  assert.match(await say('628222', 'CH.XDA.9'), /tidak tersedia \(maks 2\)/)
  assert.match(await say('628222', 'CH.XDA.0'), /Nomor halaman tidak valid/)

  // exact kategori `AX` tidak tercampur `AXP`, dan `SM` menemukan kode yang tidak berawalan SM (`M19`)
  const axOnly = await say('628222', 'CH.AX.1')
  assert.match(axOnly, /\*Harga AX\* \(Hal 1\/1 — 1 produk\)/)
  assert.match(axOnly, /• \*AXLK9\*/)
  assert.doesNotMatch(axOnly, /AXP14/)

  const smList = await say('628222', 'CH.SM.1')
  assert.match(smList, /\*Harga SM\* \(Hal 1\/1 — 1 produk\)/)
  assert.match(smList, /• \*M19\*/)
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

test('PRDK & SYNC dihapus: katalog disinkron otomatis lewat cron + cache TTL', async () => {
  const before = db.listProduk().length
  assert.match(await say('628111', 'PRDK.X.X.100'), /\*Super admin\*/) // tak dikenal: menu owner
  assert.match(await say('628111', 'SYNC'), /\*Super admin\*/) // SYNC dihapus
  assert.equal(await say('628222', 'SYNC'), undefined) // mitra: teks tak dikenal diabaikan
  assert.equal(db.listProduk().length, before)
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
  // pairing code diumumkan balik ke chat super admin via notify(text)
  assert.ok(runtimeCalls.some((c) => c.id === 'toko2'), 'runtime.startSession dipanggil')
  assert.ok(
    sent.some((s) => s.jid === '628111@s.whatsapp.net' && s.text === 'KODE PAIRING toko2'),
    'pairing code harus terkirim ke chat owner dengan text valid'
  )

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

test('super admin nomor asing tetap diabaikan', async () => {
  const r = await say('628999', 'SESI')
  assert.equal(r, undefined)
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
  const { createSession } = await import('../src/registry.js')
  const pushed = []
  const notify = (jid, text) => pushed.push({ jid, text })

  await say('628111', 'SESIBUAT.toko9.628997.6289980000.Toko Sembilan')
  await runOnboarding(logger, 'toko9', notify)
  assert.equal(pushed[0].jid, '628997@s.whatsapp.net')
  assert.match(pushed[0].text, /API Key ICS belum diisi/)
  // bot's own number never receives the prompt
  assert.ok(!pushed.some((p) => p.jid.startsWith('6289980000')))

  // legacy misconfigured session (admin == bot): onboarding must not message itself
  pushed.length = 0
  createSession({ id: 'toko_bad', label: 'Bad', adminNohp: '6284440000', pairingPhone: '6284440000', status: 'on' })
  await runOnboarding(logger, 'toko_bad', notify)
  assert.equal(pushed.length, 0)

  // sesi yang sudah punya apikey & produk -> pesan siap (dengan jumlah tersimpan & online) hanya dikirim sekali
  const db9 = openDb(join(dir, 'sessions', 'toko9.sqlite'))
  db9.setSetting('ics_apikey', '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok')
  db9.upsertProdukIcs({ code: 'P1', name: 'P1', price: 1000, status: 'available', stock: 5 })
  db9.upsertProdukIcs({ code: 'P2', name: 'P2', price: 2000, status: 'unavailable', stock: 0 })
  db9.close()

  pushed.length = 0
  await runOnboarding(logger, 'toko9', notify)
  assert.equal(pushed.length, 1)
  assert.match(pushed[0].text, /\*Sesi toko9 siap\.\*/)
  assert.match(pushed[0].text, /Produk: 2 tersimpan \(1 online\)/)

  // panggilan berikutnya (reconnect/restart) tidak lagi mengirim pesan siap
  pushed.length = 0
  await runOnboarding(logger, 'toko9', notify)
  assert.equal(pushed.length, 0)
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

  // perintah uang diblokir, diganti prompt singkat
  assert.match(await sayShop('SAL'), /API Key ICS belum diisi/)
  assert.match(await sayShop('BELI.PULSA10.0812'), /API Key ICS belum diisi/)
  // info/menu tetap boleh
  assert.doesNotMatch(await sayShop('info'), /API Key ICS belum diisi/)

  // key salah format -> prompt lagi
  assert.match(await sayShop('APIKEY.salah'), /API Key ICS belum diisi/)

  // key format benar (hex 64-karakter) tapi ditolak ICS -> TIDAK tersimpan
  const badHex = '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0cc6'
  assert.match(await sayShop(`APIKEY.${badHex}`), /belum benar/)
  assert.equal(sdb.getSetting('ics_apikey'), undefined)

  // key benar (paste langsung hex 64-karakter, mock menerima yang berakhiran "ok") -> tersimpan + sinkron produk + pesan siap sekali
  const goodHex1 = '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0aok'
  const readyMsg = await sayShop(goodHex1)
  assert.match(readyMsg, /\*Sesi toko3 siap\.\*/)
  assert.match(readyMsg, /Produk: 1 tersimpan \(1 online\)/)
  assert.match(readyMsg, /Webhook: /)
  assert.equal(sdb.getSetting('ics_apikey'), goodHex1)
  assert.equal(sdb.getSetting('ready_notified'), '1')
  assert.equal(sdb.listProduk().length, 1)

  // reconnect / restart setelah siap -> runOnboarding TIDAK mengirim ulang pesan siap
  const { runOnboarding } = await import('../src/apikey.js')
  const pushedAgain = []
  await runOnboarding(logger, 'toko3', (jid, text) => pushedAgain.push({ jid, text }))
  assert.equal(pushedAgain.length, 0, 'pesan siap tidak boleh muncul ulang saat reconnect')

  // update key lewat command APIKEY.<hex>
  const goodHex2 = '816c461e02197c4650f8c4cf393753ab8195309628b2b94619c60f271d8e0bok'
  assert.match(await sayShop(`APIKEY.${goodHex2}`), /API key tersimpan\. Produk: 1 tersimpan \(1 online\)/)
  assert.equal(sdb.getSetting('ics_apikey'), goodHex2)

  // setelah ada key, SAL & LPRDK tidak lagi di-prompt
  assert.doesNotMatch(await sayShop('SAL'), /API Key ICS belum diisi/)
  assert.match(await sayShop('LPRDK'), /PULSA10/)
  sdb.close()
})

test('utilitas owner: STATUS / CMD / ENV', async () => {
  const prevStarted = process.env.SUPERVISOR_STARTED_AT
  process.env.SUPERVISOR_STARTED_AT = String(Date.now() - (2 * 3_600_000 + 15 * 60_000))
  const st = await say('628111', 'STATUS')
  if (prevStarted === undefined) delete process.env.SUPERVISOR_STARTED_AT
  else process.env.SUPERVISOR_STARTED_AT = prevStarted
  assert.match(st, /\*Status Server\*/)
  assert.match(st, /Uptime proses: 2j 15m/)
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

test('bootstrap QR: sesi owner tampil sebagai owner di SESI/SESSIONS dan bisa di-adopsi SESIBUAT', async () => {
  // Default bootstrap session adalah 'owner' saat env SESSIONS/DEFAULT_SESSION kosong.
  const { isBootstrapSession, isOwnerSession, createSession, getSession } = await import('../src/registry.js')
  const { store } = await import('../src/store.js')
  delete process.env.SESSIONS
  delete process.env.DEFAULT_SESSION
  assert.ok(isBootstrapSession('owner'), 'default bootstrap session adalah owner')

  // Simulasi bootstrap: baris registry dibuat saat auth_paired (sesi owner, tanpa admin toko).
  process.env.SESSIONS = 'pusat'
  assert.ok(isBootstrapSession('pusat'), 'pusat adalah bootstrap session')

  createSession({ id: 'pusat', label: 'Owner (QR)', adminNohp: '', pairingPhone: '', waNohp: '6281230999', status: 'on' })
  assert.ok(isOwnerSession(getSession('pusat')), 'sesi bootstrap tanpa admin adalah sesi owner')

  // Di SESI & SESSIONS, sesi bootstrap tampil sebagai owner (bukan admin)
  const sesiList = await say('628111', 'SESI')
  assert.match(sesiList, /• pusat — owner 628111 — WA 6281230999 — on — Owner \(QR\)/)
  const sessionsList = await say('628111', 'SESSIONS')
  assert.match(sessionsList, /• pusat — .* — owner 628111 — WA 6281230999 — Owner \(QR\)/)

  const k = new Uint8Array(32)
  await store.session('pusat').auth.save({
    noiseKeyPair: { pubKey: k, privKey: k },
    registrationInfo: { registrationId: 1, identityKeyPair: { pubKey: k, privKey: k } },
    signedPreKey: { keyId: 1, keyPair: { pubKey: k, privKey: k }, signature: new Uint8Array(64) },
    advSecretKey: k,
    meJid: '6281230999@s.whatsapp.net',
  })

  // owner adopt: admin = owner, WA = nomor bot pusat (beda dari admin)
  await say('628111', 'SESIBUAT.pusat.628111.6281230999.Pusat')
  const row = getSession('pusat')
  assert.equal(row.admin_nohp, '628111')
  assert.equal(row.pairing_phone, '6281230999')
  assert.ok(!isOwnerSession(row), 'setelah diadopsi jadi sesi admin, bukan lagi owner-only')
  assert.ok(runtimeCalls.some((c) => c.id === 'pusat'), 'connect dipanggil untuk sesi teradopsi')
  // kredensial bootstrap tidak boleh terhapus saat adopsi
  const creds = await store.session('pusat').auth.load()
  assert.equal(creds?.meJid, '6281230999@s.whatsapp.net')

  // guard: sesi utama tidak boleh dinonaktifkan atau dihapus
  runtimeCalls.length = 0
  assert.match(await say('628111', 'SESIOFF.pusat'), /tidak boleh dinonaktifkan/)
  assert.match(await say('628111', 'SESIHAPUS.pusat'), /tidak boleh dihapus/)
  assert.ok(!runtimeCalls.some((c) => c.id === 'pusat' && c.stop), 'stopSession tidak boleh dipanggil untuk sesi utama')
  assert.ok(getSession('pusat'), 'sesi utama tetap ada di registry')

  delete process.env.SESSIONS
})

test('utilitas owner jalan di session tanpa agen owner (nomor pusat)', async () => {
  // Mirip sesi pusat sebelum adopsi: OWNERS ada, tanpa baris agen di DB sesi.
  const h = {}
  const c = { on: (ev, fn) => (h[ev] = fn), message: { send: async (jid, text) => (sent.push({ jid, text }), { id: 'p' }) } }
  const { openDb: open } = await import('../src/db.js')
  open(join(dir, 'sessions', 'kosong.sqlite')).close()
  attachHandlers(c, 'kosong', logger, fakeRuntime)
  sent.length = 0
  await h.message({ key: { remoteJid: '628111@s.whatsapp.net', fromMe: false }, message: { conversation: 'STATUS' } })
  assert.match(last(), /\*Status Server\*/)

  sent.length = 0
  await h.message({ key: { remoteJid: '628111@s.whatsapp.net', fromMe: false }, message: { conversation: 'SESSIONS' } })
  assert.match(last(), /\*Sessions:\*/)

  sent.length = 0
  await h.message({ key: { remoteJid: '628111@s.whatsapp.net', fromMe: false }, message: { conversation: 'info' } })
  // session ini tak punya agen owner: perintah non-owner jatuh ke menu super admin
  assert.match(last(), /\*Super admin\*/)

  // perintah tak dikenal: tidak diam, menu super admin
  sent.length = 0
  await h.message({ key: { remoteJid: '628111@s.whatsapp.net', fromMe: false }, message: { conversation: 'apa ini' } })
  assert.match(last(), /\*Super admin\*/)
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
