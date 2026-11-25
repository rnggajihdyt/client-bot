import { test, after } from 'node:test'
import assert from 'node:assert'
import { verifyPin } from '../src/auth.js'
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
await import('../src/commands/deposit.js')
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
    downloadBytes: async () => new Uint8Array([1, 2, 3]),
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

test('nomor asing chat pribadi dibalas ditolak, pesan grup (@g.us) diabaikan diam-diam', async () => {
  // Default UNKNOWN_SENDER_MODE=always: chat pribadi non-mitra dibalas "Anda bukan mitra kami"
  assert.equal(await say('629999', 'SAL'), 'Anda bukan mitra kami')

  // Default IGNORE_GROUPS=true: pesan grup (@g.us) diabaikan diam-diam (baik non-mitra maupun owner)
  sent.length = 0
  await handlers.message({
    key: { remoteJid: '12036300000@g.us', participant: '629999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'SAL' },
  })
  await handlers.message({
    key: { remoteJid: '12036300000@g.us', participant: '628111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'SAL' },
  })
  assert.equal(sent.length, 0)

  // Mode once: balas sekali saja untuk nomor asing
  process.env.UNKNOWN_SENDER_MODE = 'once'
  assert.equal(await say('629998', 'SAL'), 'Anda bukan mitra kami')
  assert.equal(await say('629998', 'SAL'), undefined)

  // Mode ignore: abaikan diam-diam
  process.env.UNKNOWN_SENDER_MODE = 'ignore'
  assert.equal(await say('629997', 'SAL'), undefined)
  delete process.env.UNKNOWN_SENDER_MODE
})

test('SAL format (admin tanpa komisi/TUKAR)', async () => {
  const r = await say('628111', 'SAL')
  assert.match(r, /^Yth\. Admin Admin ID: OWN01/)
  assert.match(r, /Saldo: 0 Limit: 0/)
  assert.doesNotMatch(r, /Komisi:|TUKAR/)
  assert.match(r, /Ketik LAP utk lihat laporan profit/)
  assert.match(await say('628111', 'TUKAR'), /tidak memakai sistem komisi/)
})

test('menu info tetap jalan', async () => {
  const r = await say('628111', 'format1')
  assert.match(r, /FORMAT 1 \(TRANSAKSI & CEK SALDO\)/)
})

test('info admin & super admin dapat section khusus', async () => {
  // 628111 = admin session DAN super admin (OWNERS)
  const r = await say('628111', 'format')
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
    'Yth. Ani, Selamat bergabung! Kode Agen anda adalah RS00001, PIN: 1234, Saldo sekarang 0. Ketik FORMAT untuk mengetahui format-format transaksi.'
  )

  // LDL memuat nomor WA downline
  const ldl = await say('628111', 'LDL')
  assert.match(ldl, /RS00001 — Ani \(Bandung\) \| 628222 \|/)

  // uplink biasa: tidak ada section admin/super admin
  const up = await say('628222', 'all')
  assert.match(up, /FORMAT 4/)
  assert.doesNotMatch(up, /KHUSUS ADMIN/)
  assert.doesNotMatch(up, /KHUSUS SUPER ADMIN/)
  assert.doesNotMatch(up, /\*TRANSAKSI\*/)

  // FORMAT = panduan + section role (mitra: tanpa section admin)
  const fmt = await say('628222', 'format')
  assert.match(fmt, /PANDUAN TRANSAKSI/)
  assert.doesNotMatch(fmt, /\*TRANSAKSI\*/)
  assert.doesNotMatch(fmt, /KHUSUS ADMIN/)
  // CEK/REK/BTL pindah ke FORMAT1
  assert.match(await say('628222', 'format1'), /Cek Trx : CEK\[\.TUJUAN\]/)
  // INFO sudah tidak ada: tidak dibalas apa pun (mitra tanpa prefix diabaikan)
  assert.equal(await say('628222', 'info'), undefined)
})

test('CH untuk downline: modal + markup', async () => {
  const r = await say('628222', 'CH.PULSA10')
  assert.match(r, /^PULSA10 = 10\.000 /) // 9500 + 500
  assert.doesNotMatch(r, /\[K\]|\[G\]/)

  // produk kosong/empty tetap tampil di CH dengan penanda [K], dan ditolak di BELI sebagai tidak tersedia
  db.upsertProdukIcs({ code: 'XDA40', name: 'XL AXIS Data 40Gb', price: 76000, type: 'xda', category: 'BEST', status: 'empty', stock: 0 })
  const chEmpty = await say('628222', 'CH.XDA40')
  assert.match(chEmpty, /^XDA40 = 76\.500 XL AXIS Data 40Gb  \[K\]$/)
  const beliEmpty = await say('628222', 'BELI.XDA40.08123456')
  assert.match(beliEmpty, /gangguan\/tidak tersedia/)

  // daftar kategori: satu baris per produk, penanda hanya untuk kosong/gangguan
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

  const list = await say('628222', 'CH.XDA')
  assert.match(list, /^Harga:\n/)
  assert.match(list, /\nXDA01 = 11\.500 XL Data 1GB\n/)
  assert.match(list, /\nXDA40 = 76\.500 XL AXIS Data 40Gb  \[K\]/)
  assert.match(list, /\*K=kosong, G=Gangguan$/)
  assert.doesNotMatch(list, /Halaman berikutnya/)

  // exact kategori `AX` tidak tercampur `AXP`, dan `SM` menemukan kode yang tidak berawalan SM (`M19`)
  const axOnly = await say('628222', 'CH.AX')
  assert.match(axOnly, /\nAXLK9 = /)
  assert.doesNotMatch(axOnly, /AXP14/)

  const smList = await say('628222', 'CH.SM')
  assert.match(smList, /\nM19 = /)
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
  assert.match(await say('628222', 'format'), /PANDUAN TRANSAKSI/)
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
  assert.match(beli, /^#T\d+ PULSA10\.081234567 akan diproses @\d\d:\d\d\. Sisa Saldo 50\.000 - 11\.000 = 39\.000$/)
  const idTrx = beli.match(/^#(T\d+) /)[1]
  assert.equal(icsOrders.at(-1).body.ref_id_custom, idTrx)

  // saldo ditahan dulu, komisi belum dibayar selama masih proses
  const b0 = db.raw.prepare(`SELECT saldo FROM agen WHERE nohp = '628444'`).get()
  assert.equal(b0.saldo, 39000)
  assert.equal(db.raw.prepare(`SELECT komisi FROM agen WHERE nohp = '628222'`).get().komisi, 0)

  // supplier settle -> komisi A masuk walau nonaktif (markup yg A set pada B = 500;
  // sedangkan markup A = 1000 yg diset Admin masuk profit admin, bukan komisi!)
  finalize(db, idTrx, { status: 'sukses', sn: 'SN123' })
  const a = db.raw.prepare(`SELECT komisi FROM agen WHERE nohp = '628222'`).get()
  assert.equal(a.komisi, 500)
  assert.equal(db.findAgenByNohp('628111').komisi, 0, 'admin tidak menerima komisi')

  // A tidak bisa mencairkan komisi
  assert.equal(await say('628222', 'TUKAR'), 'Akun Anda nonaktif')

  // aktifkan lagi -> komisi bisa dicairkan
  assert.match(await say('628111', 'AKTIF.RS00001.1234'), /DIAKTIFKAN/)
  const tukar = await say('628222', 'TUKAR')
  assert.match(tukar, /500/)
  const a2 = db.raw.prepare(`SELECT komisi, saldo FROM agen WHERE nohp = '628222'`).get()
  assert.equal(a2.komisi, 0)
  assert.equal(a2.saldo, 500)
})

test('BELI ditolak saat saldo kurang', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 100 WHERE nohp = '628444'`).run()
  assert.match(await say('628444', 'BELI.PULSA10.0812'), /^Pulsa 10 PULSA10\.0812 GAGAL\. Saldo tidak cukup\. Sal 100 @\d\d:\d\d$/)
})

test('transaksi menyimpan harga modal & markup admin saat itu', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628444'`).run()
  const r = await say('628444', 'BELI.PULSA10.08123')
  assert.match(r, /PULSA10\.08123 akan diproses @\d\d:\d\d\./)
  const idTrx = r.match(/^#(T\d+) /)[1]
  finalize(db, idTrx, { status: 'sukses' })

  const trx = db.raw.prepare(`SELECT * FROM transaksi WHERE tujuan = '08123' ORDER BY id DESC`).get()
  assert.equal(trx.produk_kode, 'PULSA10')
  assert.equal(trx.harga_modal, 9500)
  assert.equal(trx.markup_admin, 1000) // MKP 0 + markup A (1000) yg diset Admin
  assert.equal(trx.harga_efektif, 11000)
  assert.equal(trx.markup_total, 1500)

  // ubah harga modal produk — transaksi lama tidak boleh berubah
  db.raw.prepare(`UPDATE produk SET harga_modal = 12000 WHERE kode = 'PULSA10'`).run()
  const after = db.raw.prepare(`SELECT * FROM transaksi WHERE id = ?`).get(trx.id)
  assert.equal(after.harga_modal, 9500)

  const sum = db.profitSummary({ from: '2000-01-01', to: '2100-01-01' })
  assert.equal(sum.trx, 2)
  assert.equal(sum.modal, 19000) // 9500 x 2
  assert.equal(sum.profit, 2000) // 1000 x 2
  assert.equal(sum.komisi, 1000) // 500 x 2
  assert.equal(sum.markup, 3000) // 1500 x 2
  assert.equal(sum.omzet, sum.modal + sum.profit + sum.komisi)

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

test('TSAL: admin tambah saldo mitra via nomor HP + mutasi + notifikasi', async () => {
  const target = db.findAgenByNohp('628222')
  const saldoAwal = target.saldo

  // mitra biasa ditolak
  assert.equal(await say('628222', 'TSAL.628222.10000.1234'), 'Khusus admin')
  // PIN salah & nominal invalid ditolak
  assert.equal(await say('628111', 'TSAL.628222.10000.9999'), 'PIN salah')
  assert.match(await say('628111', 'TSAL.628222.0.1234'), /Nominal harus bilangan bulat > 0/)
  assert.match(await say('628111', 'TSAL.628222.-5000.1234'), /Nominal harus bilangan bulat > 0/)
  assert.match(await say('628111', 'TSAL.628999999.10000.1234'), /tidak ditemukan/)

  // admin isi saldo memakai format 08... (normalisasi ke 628...)
  await say('628111', 'TSAL.08222.25000.1234')
  assert.equal(db.findAgenById(target.id).saldo, saldoAwal + 25000)
  // admin dapat konfirmasi & user tujuan dapat notifikasi
  assert.ok(
    sent.some((m) => m.jid === '628111@s.whatsapp.net' && /ditambah 25\.000/.test(m.text)),
    'konfirmasi ke admin'
  )
  assert.ok(
    sent.some((m) => m.jid === '628222@s.whatsapp.net' && /Saldo Anda telah ditambah 25\.000/.test(m.text)),
    'notifikasi ke user tujuan'
  )
  // tercatat di mutasi (REK)
  const rek = await say('628222', 'REK')
  assert.match(rek, / 25\.000 Tambah saldo oleh OWN01/)
  assert.match(rek, /Saldo akhir Rp\. /)

  // admin isi saldo sendiri: saldo bertambah tanpa notifikasi ganda
  const adminAwal = db.findAgenByNohp('628111').saldo
  await say('628111', 'TSAL.628111.10000.1234')
  assert.equal(db.findAgenByNohp('628111').saldo, adminAwal + 10000)
  assert.equal(sent.length, 1, 'isi saldo sendiri tidak kirim pesan ganda')
})

test('KSAL: admin kurang saldo mitra via nomor HP + guard saldo cukup + mutasi', async () => {
  const target = db.findAgenByNohp('628222')
  const saldoAwal = target.saldo

  // mitra biasa & PIN salah ditolak
  assert.equal(await say('628222', 'KSAL.628222.5000.1234'), 'Khusus admin')
  assert.equal(await say('628111', 'KSAL.628222.5000.9999'), 'PIN salah')

  // nominal melebihi saldo ditolak (tidak boleh minus)
  const over = await say('628111', `KSAL.08222.${saldoAwal + 1000}.1234`)
  assert.match(over, /tidak cukup/)
  assert.equal(db.findAgenById(target.id).saldo, saldoAwal)

  // kurangi saldo via format 08...
  await say('628111', 'KSAL.08222.10000.1234')
  assert.equal(db.findAgenById(target.id).saldo, saldoAwal - 10000)
  assert.ok(
    sent.some((m) => m.jid === '628111@s.whatsapp.net' && /dikurangi 10\.000/.test(m.text)),
    'konfirmasi ke admin'
  )
  assert.ok(
    sent.some((m) => m.jid === '628222@s.whatsapp.net' && /Saldo Anda dikurangi 10\.000/.test(m.text)),
    'notifikasi ke user tujuan'
  )
  const rek = await say('628222', 'REK')
  assert.match(rek, / -10\.000 Kurang saldo oleh OWN01/)
  assert.match(rek, /Saldo akhir Rp\. /)

  // admin kurangi saldo sendiri tanpa notifikasi ganda
  const adminAwal = db.findAgenByNohp('628111').saldo
  await say('628111', 'KSAL.628111.5000.1234')
  assert.equal(db.findAgenByNohp('628111').saldo, adminAwal - 5000)
  assert.equal(sent.length, 1)
})

test('BELI produk: harga pakai general markup, profit masuk ke markup_admin', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628222'`).run()
  assert.match(await say('628111', 'MKP.2000'), /Markup general/)
  const r = await say('628222', 'BELI.PULSA10.0811999')
  assert.match(r, /Sisa Saldo 50\.000 - 12\.500 = 37\.500$/) // 9500 + admin 2000 + Ani 1000
  const idTrx = r.match(/^#(T\d+) /)[1]
  finalize(db, idTrx, { status: 'sukses' })
})

test('tujuan masih proses: order kedua ke nomor sama ditolak, tidak kirim ke supplier', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628222'`).run()
  const first = await say('628222', 'BELI.PULSA10.0813001')
  assert.match(first, /akan diproses/)
  const saldoSetelahPertama = db.findAgenByNohp('628222').saldo

  const second = await say('628222', 'BELI.PULSA10.0813001')
  assert.match(second, /Tujuan masih diproses/)
  assert.equal(db.findAgenByNohp('628222').saldo, saldoSetelahPertama, 'saldo tidak terpotong lagi')

  const other = await say('628222', 'BELI.PULSA10.0813002')
  assert.match(other, /akan diproses/, 'nomor tujuan lain tetap bisa')

  finalize(db, first.match(/^#(T\d+) /)[1], { status: 'gagal' })
  finalize(db, other.match(/^#(T\d+) /)[1], { status: 'gagal' })
  db.raw.prepare(`DELETE FROM transaksi WHERE tujuan IN ('0813001','0813002')`).run()
})

test('LAP admin: seluruh session (Omzet = Modal + Komisi Jaringan + Profit)', async () => {
  const r = await say('628111', 'LAP.BULAN')
  assert.match(r, /^Trx: /)
  // 3 trx sukses:
  // - 2x oleh B: profit admin 1000 (MKP 0 + A.markup 1000), komisi A 500
  // - 1x oleh A: profit admin 3000 (MKP 2000 + A.markup 1000), komisi 0
  assert.match(r, /Omzet: 34\.500/)
  assert.match(r, /Modal: 28\.500/)
  assert.match(r, /Komisi Jaringan: 1\.000/)
  assert.match(r, /Profit: 5\.000/)
  // daftar baris: KODE.TUJUAN Rp.harga @dd/mm hh:mm:ss =Sukses
  assert.match(r, /\nPULSA10\.0811999 Rp\.12\.500 @\d\d\/\d\d \d\d:\d\d:\d\d =Sukses/)
  assert.match(await say('628111', 'MKP.0'), /Markup general/)
})

test('LAP uplink: jaringannya sendiri & TUKAR tidak menghapus histori komisi di LAP', async () => {
  const r = await say('628222', 'LAP.BULAN')
  assert.doesNotMatch(r, /Trx: /) // mitra: langsung daftar transaksi
  assert.match(r, /PULSA10\.081234567 Rp\.11\.000 @\d\d\/\d\d \d\d:\d\d:\d\d =Sukses/)
})

test('berjenjang tak terbatas: Admin -> A -> B -> C (profit admin, komisi tiap level, LAP jaringan B)', async () => {
  // B (628444, markup 500 dari A) mendaftarkan C (6285551) dengan markup 300
  assert.match(await say('628444', 'DAFTAR.Citra.Depok.6285551.300.1234'), /RS00003/)
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '6285551'`).run()
  // Set MKP general = 200; A.markup = 1000 (dr admin), B.markup = 500 (dr A), C.markup = 300 (dr B)
  assert.match(await say('628111', 'MKP.200'), /Markup general/)

  const komABefore = db.findAgenByNohp('628222').komisi
  const komBBefore = db.findAgenByNohp('628444').komisi

  // C beli PULSA10 (modal 9500): bayar 9500 + 200 + 1000 + 500 + 300 = 11.500
  const beliC = await say('6285551', 'PULSA10.08991234')
  assert.match(beliC, / Sisa Saldo [\d.]+ - 11\.500 = [\d.]+$/)
  const idTrx = beliC.match(/^#(T\d+) /)[1]
  finalize(db, idTrx, { status: 'sukses', sn: 'SN-C' })

  const trx = db.getTransaksi(idTrx)
  assert.equal(trx.harga_modal, 9500)
  assert.equal(trx.markup_admin, 1200) // MKP 200 + A.markup 1000
  assert.equal(trx.markup_total, 2000) // 200 + 1000 + 500 + 300
  assert.equal(trx.harga_efektif, 11500)

  // Admin: komisi tetap 0 (masuk Profit), A dapat B.markup (500), B dapat C.markup (300)
  assert.equal(db.findAgenByNohp('628111').komisi, 0)
  assert.equal(db.findAgenByNohp('628222').komisi, komABefore + 500)
  assert.equal(db.findAgenByNohp('628444').komisi, komBBefore + 300)

  // Level B yang punya downline C: LAP memuat transaksi jaringan (termasuk milik C)
  const lapB = await say('628444', 'LAP.BULAN')
  assert.match(lapB, /PULSA10\.08991234 Rp\.11\.500 @\d\d\/\d\d \d\d:\d\d:\d\d =Sukses/)

  // Uji juga saat A.markup = 0 (admin tanpa markup per-reseller): A TETAP dapat komisi 500 dari B!
  assert.match(await say('628111', 'MP.RS00001.0.1234'), /Markup RS00001 diubah menjadi 0/)
  const beliC2 = await say('6285551', 'PULSA10.08991235')
  assert.match(beliC2, /- 10\.500 =/) // 9500 + 200 + 0 + 500 + 300
  const idTrx2 = beliC2.match(/^#(T\d+) /)[1]
  finalize(db, idTrx2, { status: 'sukses', sn: 'SN-C2' })
  assert.equal(db.findAgenByNohp('628222').komisi, komABefore + 1000, 'A tetap dapat 500 meski A.markup = 0')
  assert.equal(db.findAgenByNohp('628444').komisi, komBBefore + 600, 'B tetap dapat 300')
  assert.equal(db.findAgenByNohp('628111').komisi, 0)

  // Kembalikan state untuk test selanjutnya
  assert.match(await say('628111', 'MP.RS00001.1000.1234'), /1\.000/)
  assert.match(await say('628111', 'MKP.0'), /Markup general/)
})

test('TIKET deposit: tiket dengan kode unik, BTL batalkan, TDEP konfirmasi saldo, TPAY atur rekening', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 0 WHERE nohp = '628222'`).run()
  // admin atur rekening + jam
  assert.match(await say('628111', 'TPAY.BCA.2390922089.Muhammad.Tasin'), /BCA 2390922089/)

  const t1 = await say('628222', 'TIKET.1700000.1234')
  assert.match(t1, /Tiket dibuat pada Tanggal \d\d\/\d\d \d\d:\d\d:\d\d WIB/)
  assert.match(t1, /Silahkan Transfer Rp\. 1\.700\.\d{3}/) // nominal + kode unik 3 digit
  assert.match(t1, /BCA 2390922089/)
  assert.match(t1, /A\.N Muhammad Tasin/)
  assert.match(t1, /Ketik CS/)
  const depRow = db.pendingDepositOf(db.findAgenByNohp('628222').id)
  assert.ok(depRow, 'tiket pending tersimpan')
  assert.match(depRow.id_deposit, /^D\d{4}$/, 'id deposit pendek')
  assert.match(t1, new RegExp(`mengetik CS dan menyertakan ID tiket ${depRow.id_deposit}`))
  assert.equal(depRow.nominal, 1700000)
  assert.equal(depRow.total, 1700000 + depRow.kode_unik)

  // tiket kedua diblokir selama pending
  assert.match(await say('628222', 'TIKET.50000.1234'), /Masih ada tiket/)

  // BTL milik orang lain ditolak; milik sendiri dibatalkan
  assert.match(await say('628111', `BTL.${depRow.id_deposit}.1234`), /Tiket tidak ditemukan/)
  assert.match(await say('628222', `BTL.${depRow.id_deposit}.1234`), /dibatalkan/)
  assert.equal(db.getDeposit(depRow.id_deposit).status, 'batal')

  // buat tiket baru lagi, lalu TDEP oleh admin (id lowercase + kredit penuh termasuk kode unik)
  const t2 = await say('628222', 'TIKET.1700000.1234')
  assert.match(t2, /Silahkan Transfer/)
  const dep2 = db.pendingDepositOf(db.findAgenByNohp('628222').id)
  assert.match(await say('628222', `TDEP.${dep2.id_deposit}.1234`), /Khusus admin/)
  await say('628111', `TDEP.${dep2.id_deposit.toLowerCase()}.1234`)
  assert.ok(
    sent.some((s) => s.jid === '628111@s.whatsapp.net' && /lunas/.test(s.text)),
    'admin dapat konfirmasi lunas'
  )
  // saldo = total (nominal + kode unik), bukan nominal saja
  assert.equal(db.findAgenByNohp('628222').saldo, dep2.total)
  assert.equal(db.findAgenByNohp('628222').saldo, 1700000 + dep2.kode_unik)
  // mitra dapat notifikasi
  assert.ok(
    sent.some((s) => s.jid === '628222@s.whatsapp.net' && /Saldo Anda ditambahkan Rp\. 1\.700\./.test(s.text)),
    'notifikasi deposit ke mitra'
  )
  // TDEP kedua kali ditolak
  assert.match(await say('628111', `TDEP.${dep2.id_deposit}.1234`), /sudah sukses/)

  // Pesan CS apa pun yang memuat ID deposit = konfirmasi (bukti gambar ikut)
  const t3 = await say('628222', 'TIKET.50000.1234')
  const dep3 = db.pendingDepositOf(db.findAgenByNohp('628222').id)
  assert.match(t3, new RegExp(`mengetik CS dan menyertakan ID tiket ${dep3.id_deposit}`))

  sent.length = 0
  await handlers.message({
    key: { remoteJid: '628222@s.whatsapp.net', fromMe: false },
    message: {
      imageMessage: { caption: `CS.${dep3.id_deposit} sudah saya transfer`, mimetype: 'image/jpeg' },
    },
    pushName: 'tester',
  })
  const toAdmin = sent.find((s) => s.jid === '628111@s.whatsapp.net')
  assert.ok(toAdmin, 'konfirmasi diteruskan ke admin')
  assert.equal(toAdmin.text.type, 'image', 'bukti diunggah ulang sebagai gambar')
  assert.equal(toAdmin.text.mimetype, 'image/jpeg')
  assert.match(toAdmin.text.caption, /Konfirmasi Transfer/)
  assert.match(toAdmin.text.caption, /pending/)
  assert.match(sent[sent.length - 1].text, /sudah diteruskan ke Admin\/CS/)

  // tanpa kata "konfirmasi" tetap terdeteksi; ID tidak ada tetap diteruskan
  sent.length = 0
  await handlers.message({
    key: { remoteJid: '628222@s.whatsapp.net', fromMe: false },
    message: { conversation: 'CS transfer d9999 cek ya' },
    pushName: 'tester',
  })
  assert.match(sent.find((s) => s.jid === '628111@s.whatsapp.net').text, /tiket tidak ditemukan/)

  // CS biasa (tanpa ID) tetap jadi pesan CS
  sent.length = 0
  await say('628222', 'CS.tolong cek harga paket')
  assert.match(sent.find((s) => s.jid === '628111@s.whatsapp.net').text, /CS dari Mitra/)

  // HPAY hapus rekening
  assert.match(await say('628111', 'HPAY.BCA'), /dihapus/)
  assert.equal(db.depositSettings().channels.length, 0)

  // TIKET.ID — cek status tiket (pending maupun sukses)
  assert.match(await say('628222', `TIKET.${dep3.id_deposit}`), /Status: pending/)
  assert.match(await say('628222', `TIKET.${dep2.id_deposit}`), /Status: sukses/)
  assert.match(await say('628222', 'TIKET.D9999'), /PIN salah|Tiket tidak ditemukan/)

  // TLIST — admin lihat tiket pending; mitra ditolak
  assert.match(await say('628222', 'TLIST'), /Khusus admin/)
  const tlist = await say('628111', 'TLIST')
  assert.match(tlist, new RegExp(`${dep3.id_deposit} — RS00001`))
  assert.match(tlist, /50\.000 \+ \d{3}/)

  // GPN — admin reset PIN downline
  assert.match(await say('628222', 'GPN.RS00001'), /GPN\.KODE/)
  assert.match(await say('628111', 'GPN.RS00001.5678.9999'), /PIN salah/)
  sent.length = 0
  await say('628111', 'GPN.RS00001.5678.1234')
  assert.ok(sent.some((s) => s.jid === '628111@s.whatsapp.net' && /PIN RS00001 direset/.test(s.text)))
  assert.ok(verifyPin('5678', db.findAgenByNohp('628222').pin_hash))
  const notice = sent.find((s) => s.jid === '628222@s.whatsapp.net')
  assert.match(notice.text, /direset oleh admin menjadi 5678/)
  // balikkan PIN ke 1234 untuk tes berikutnya
  sent.length = 0
  await say('628222', 'GP.1234.5678')
  assert.ok(verifyPin('1234', db.findAgenByNohp('628222').pin_hash), 'PIN kembali 1234')
})

test('CEK/REK: transaksi pending tampil & mutasi tercatat; BTL kini stub deposit', async () => {
  db.raw.prepare(`UPDATE agen SET saldo = 50000 WHERE nohp = '628222'`).run()
  const r = await say('628222', 'BELI.PULSA10.0811777')
  const idTrx = r.match(/^#(T\d+) /)[1]

  assert.match(await say('628222', 'CEK'), new RegExp(`${idTrx} — PULSA10`))
  assert.match(await say('628222', `CEK.${idTrx}`), /Status: proses/)
  assert.match(await say('628222', 'REK'), /Beli PULSA10/)

  // BTL kini untuk tiket deposit; transaksi order tidak bisa dibatalkan
  assert.match(await say('628222', `BTL.${idTrx}.1234`), /Tiket tidak ditemukan/)
  assert.equal(db.getTransaksi(idTrx).status, 'proses')

  finalize(db, idTrx, { status: 'gagal' })
  assert.equal(db.getTransaksi(idTrx).status, 'gagal')
  assert.equal(db.raw.prepare(`SELECT saldo FROM agen WHERE nohp = '628222'`).get().saldo, 50000)
  // webhook telat untuk baris terminal diabaikan
  assert.equal(finalize(db, idTrx, { status: 'sukses' }), null)
})

test('beli singkat tanpa BELI/PIN, bolak-balik, multi baris, multi nomor & CEK.TUJUAN (ambil terakhir)', async () => {
  db.upsertProdukIcs({ code: 'XDA13', name: 'XL Data 13GB', price: 20000, type: 'xda', status: 'available', stock: 10 })
  db.upsertProdukIcs({ code: 'XDA40', name: 'XL Data 40GB', price: 30000, type: 'xda', status: 'available', stock: 10 })
  db.raw.prepare(`UPDATE agen SET saldo = 200000 WHERE nohp = '628222'`).run()

  // 1) Beli singkat tunggal tanpa BELI dan tanpa PIN: KODE.TUJUAN
  icsOrders.length = 0
  const r1 = await say('628222', 'xda13.08777777')
  assert.match(r1, /^#T\d+ XDA13\.08777777 akan diproses @\d\d:\d\d\. Sisa Saldo [\d.]+ - 21\.000 = 179\.000$/)
  assert.match(icsOrders[0]?.url ?? '', /\/api\/reseller\/trx$/)
  const id1 = r1.match(/^#(T\d+) /)[1]
  finalize(db, id1, { status: 'sukses', sn: 'SN-PERTAMA' })

  // 2) Format bolak-balik tunggal: TUJUAN.KODE
  const r2 = await say('628222', '08777777.xda40')
  assert.match(r2, /^#T\d+ XDA40\.08777777 akan diproses @\d\d:\d\d\. Sisa Saldo 179\.000 - 31\.000 = 148\.000$/)
  const id2 = r2.match(/^#(T\d+) /)[1]
  finalize(db, id2, { status: 'sukses', sn: 'SN-TERAKHIR' })

  // 3) CEK.TUJUAN memilih transaksi paling terakhir (id2, bukan id1) + dukung 628 <-> 08
  const cek1 = await say('628222', 'CEK.08777777')
  assert.match(cek1, new RegExp(`ID: ${id2}`))
  assert.match(cek1, /Produk: XDA40/)
  assert.match(cek1, /SN: SN-TERAKHIR/)
  const cekAlt = await say('628222', 'CEK.628777777')
  assert.match(cekAlt, new RegExp(`ID: ${id2}`))

  // 4) Multi baris campuran (normal, bolak-balik, dan kode tidak ada)
  const batch = await say(
    '628222',
    'xda13.08777777\nxda999.087878767\n0887878.xda40'
  )
  const batchLines = batch.split('\n')
  assert.equal(batchLines.length, 3)
  assert.match(batchLines[0], /^#T\d+ XDA13\.08777777 akan diproses @\d\d:\d\d\./)
  assert.match(batchLines[1], /^XDA999\.087878767 GAGAL\. Produk tidak ditemukan\. Sal /)
  assert.match(batchLines[2], /^#T\d+ XDA40\.0887878 akan diproses @\d\d:\d\d\./)

  // 5) Multi nomor dipisah koma dalam 1 baris
  const multiComma = await say('628222', 'xda13.08111111,08222222')
  const commaLines = multiComma.split('\n')
  assert.equal(commaLines.length, 2)
  assert.match(commaLines[0], /^#T\d+ XDA13\.08111111 akan diproses @\d\d:\d\d\./)
  assert.match(commaLines[1], /^#T\d+ XDA13\.08222222 akan diproses @\d\d:\d\d\./)

  // 6) Teks acak bukan produk tetap diabaikan untuk mitra (tidak spam)
  assert.equal(await say('628222', 'kamar.1234567'), undefined)
})

test('sensor error supplier ICS & saldo operasional habis untuk downline/uplink (+ alert ke admin)', async () => {
  const origFetch = globalThis.fetch
  db.upsertProdukIcs({
    code: 'XDA38',
    name: 'XL AXIS Data 38Gb Reguler + Lokal (XDA38)',
    price: 61000,
    type: 'xda',
    status: 'available',
    stock: 10,
  })
  db.raw.prepare(`UPDATE agen SET saldo = 1911411 WHERE nohp = '628222'`).run()
  db.raw.prepare(`UPDATE agen SET saldo = 100000 WHERE nohp = '628111'`).run()

  try {
    // 1) Saldo operasional ICS habis: downline/uplink TIDAK boleh melihat kata "ICS" maupun saldo admin
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          success: false,
          message: 'Saldo operasional tidak cukup. Saldo Anda: Rp 0, Dibutuhkan: Rp 100',
        }),
    })
    await say('628222', 'xda13.08555999')
    const mitraMsg = sent.find((m) => m.jid === '628222@s.whatsapp.net')?.text ?? ''
    assert.match(mitraMsg, /^XL Data 13GB XDA13\.08555999 GAGAL\. Sistem sedang gangguan sementara.*Sal 1\.911\.411 @\d\d:\d\d$/)
    assert.doesNotMatch(mitraMsg, /ICS/i)
    assert.doesNotMatch(mitraMsg, /Saldo operasional|Saldo Anda|Dibutuhkan|Rp 0|Rp 100/i)
    // saldo mitra tetap penuh (refunded)
    assert.equal(db.findAgenByNohp('628222').saldo, 1911411)
    // admin menerima peringatan saldo supplier habis
    const adminAlert = sent.find((m) => m.jid === '628111@s.whatsapp.net')?.text ?? ''
    assert.match(adminAlert, /Peringatan Saldo Supplier/)
    assert.match(adminAlert, /Saldo operasional tidak cukup/)

    // Admin sendiri yang transaksi tetap melihat detail aslinya
    const adminReply = await say('628111', 'xda13.08777777')
    assert.match(adminReply, /Saldo operasional tidak cukup/)

    // 2) Format persis seperti contoh user: "<Nama> XDA38.085731409131 GAGAL. Nomor tujuan salah. Sal 1.911.411 @HH:MM"
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ success: false, message: 'Nomor tujuan salah' }),
    })
    const errExact = await say('628222', 'XDA38.085731409131')
    assert.match(
      errExact,
      /^XL AXIS Data 38Gb Reguler \+ Lokal XDA38\.085731409131 GAGAL\. Nomor tujuan salah\. Sal 1\.911\.411 @\d\d:\d\d$/
    )
    assert.doesNotMatch(errExact, /ICS/i)

    // 3) Error bisnis biasa yang menyebut ICS tetap disensor untuk downline/uplink
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ success: false, message: 'Nomor tujuan tidak valid di ICS Store' }),
    })
    const errMitra = await say('628222', 'xda13.08555997')
    assert.match(errMitra, /Nomor tujuan tidak valid/)
    assert.doesNotMatch(errMitra, /ICS/i)
  } finally {
    globalThis.fetch = origFetch
  }
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
  assert.doesNotMatch(await sayShop('format'), /API Key ICS belum diisi/)

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
  assert.match(readyMsg, /Status transaksi dicek otomatis; cek manual dengan CEK\./)
  assert.doesNotMatch(readyMsg, /Webhook/)
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
  await h.message({ key: { remoteJid: '628111@s.whatsapp.net', fromMe: false }, message: { conversation: 'format' } })
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
