import { test, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ppob-int-'))
process.env.OWNERS = '628111'
process.env.COMMAND_PREFIX = ''
process.env.PPOB_DB_PATH = join(dir, 'int.sqlite')

const { initDb, closeDb, createAgen } = await import('../src/db.js')
const { attachHandlers } = await import('../src/handler.js')
await import('../src/commands/demo.js')
await import('../src/commands/ppob.js')
await import('../src/commands/ppob-core.js')

const db = initDb(process.env.PPOB_DB_PATH)
createAgen({ nama: 'Admin', kota: '', nohp: '628111', seniorId: null, markup: 0, pin: '1234' })
db.prepare(`INSERT INTO produk (kode, nama, harga_modal, kategori) VALUES ('PULSA10','Pulsa 10',9500,'pulsa')`).run()

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

const last = () => sent[sent.length - 1].text

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

test('DAFTAR bikin downline RS00001 + kirim welcome ke downline', async () => {
  const r = await say('628111', 'DAFTAR.Ani.Bandung.628222.500.1234')
  assert.match(r, /RS00001/)
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

test('downline nonaktif diblokir total', async () => {
  const off = await say('628111', 'NA.RS00001.1234')
  assert.match(off, /dinonaktifkan/)

  // even menu / sal blocked
  assert.equal(await say('628222', 'SAL'), 'Akun Anda nonaktif')
  assert.equal(await say('628222', 'info'), 'Akun Anda nonaktif')
  assert.equal(await say('628222', 'all'), 'Akun Anda nonaktif')

  const on = await say('628111', 'AKTIF.RS00001.1234')
  assert.match(on, /diaktifkan/)
  // back to normal
  assert.match(await say('628222', 'SAL'), /^Yth\. Mitra Ani ID: RS00001/)
})

test('kirim gagal (nack 401) tidak menjatuhkan handler', async () => {
  const orig = client.message.send
  client.message.send = async () => {
    throw new Error('negative publish ack: error=401')
  }
  // nomor asing: handler harus menelan error & diam, bukan throw
  sent.length = 0
  await handlers.message({
    key: { remoteJid: '629999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'SAL' },
  })
  assert.equal(sent.length, 0) // nothing pushed (send swallowed)

  // command valid: juga tidak boleh throw
  await assert.doesNotReject(
    handlers.message({
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false },
      message: { conversation: 'SAL' },
    })
  )
  client.message.send = orig
})

after(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})
