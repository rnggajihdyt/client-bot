import { register } from './registry.js'
import { verifyPin, hashPin } from '../auth.js'
import {
  findAgenByNohp,
  findAgenById,
  findAgenByKode,
  downlines,
  countDownlines,
  createAgen,
  updateAgen,
  setSaldoKomisi,
  deleteAgen,
  addNomor,
  removeNomor,
  nomorOf,
  nomorTaken,
  effectivePrice,
  transaksiStats,
  addMutasi,
  tx,
} from '../db.js'
import { formatRupiah, parseNumber } from '../money.js'

const NOT_DOWNLINE = 'Bukan downline Anda'
const PIN_SALAH = 'PIN salah'

function requirePin(ctx) {
  const pin = ctx.args[ctx.args.length - 1]
  if (!verifyPin(pin, ctx.mitra.pin_hash)) return null
  return pin
}

function requireDownline(ctx, kode) {
  const target = findAgenByKode(String(kode).toUpperCase())
  if (!target || target.senior_id !== ctx.mitra.id) return null
  return target
}

// ---- SAL ----
register({
  name: 'sal',
  description: 'Cek saldo',
  async handler({ client, event, mitra }) {
    const st = transaksiStats(mitra.id)
    const text =
      `Yth. Mitra ${mitra.nama} ID: ${mitra.kode}\n` +
      `Saldo: ${formatRupiah(mitra.saldo)} Limit: 0\n` +
      `Dalam proses: ${formatRupiah(st.proses)} Terpakai hari ini: ${formatRupiah(st.hariIni)} Komisi: ${formatRupiah(mitra.komisi)}\n\n` +
      `Ketik TUKAR utk ambil komisi`
    await client.message.send(event.key.remoteJid, text)
  },
})

// ---- CH ----
register({
  name: 'ch',
  description: 'Cek harga produk, e.g. CH.PULSA10',
  async handler({ client, event, mitra, args }) {
    const kode = args[0]
    if (!kode) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: CH.KODE')
      return
    }
    const p = effectivePrice(mitra.id, kode.toUpperCase())
    if (!p) {
      await client.message.send(event.key.remoteJid, 'Produk tidak ditemukan')
      return
    }
    await client.message.send(
      event.key.remoteJid,
      `*${p.nama}* (${p.kode})\nHarga: ${formatRupiah(p.hargaEfektif)}`
    )
  },
})

// ---- DAFTAR ----
register({
  name: 'daftar',
  description: 'Tambah downline: DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN',
  async handler({ client, event, mitra, args, log }) {
    if (args.length < 5) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN')
      return
    }
    const pin = args[args.length - 1]
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const [nama, kota, nohp, markupRaw] = args.slice(0, 4)
    const nohpD = String(nohp).replace(/\D/g, '')
    if (!nohpD) {
      await client.message.send(event.key.remoteJid, 'Nomor HP tidak valid')
      return
    }
    if (nomorTaken(nohpD)) {
      await client.message.send(event.key.remoteJid, 'Nomor sudah terdaftar')
      return
    }
    const markup = parseNumber(markupRaw)
    if (!Number.isInteger(markup) || markup < 0) {
      await client.message.send(event.key.remoteJid, 'Markup harus bilangan bulat >= 0')
      return
    }
    let created
    try {
      created = createAgen({ nama, kota, nohp: nohpD, seniorId: mitra.id, markup, pin: '1234' })
    } catch (e) {
      await client.message.send(event.key.remoteJid, 'Gagal menyimpan, coba lagi')
      return
    }

    await client.message.send(
      event.key.remoteJid,
      `Mitra baru: ${nama} (${created.kode}) ${nohpD} berhasil ditambahkan sebagai downline Anda.`
    )

    // Welcome the new downline directly. Best-effort: a failed send must not
    // undo the registration.
    try {
      await client.message.send(
        `${nohpD}@s.whatsapp.net`,
        `Yth. ${nama}, Selamat bergabung! Kode Agen anda adalah ${created.kode}, PIN: 1234, Saldo sekarang 0. Ketik INFO untuk mengetahui format-format transaksi.`
      )
    } catch (err) {
      log?.warn({ err, nohp: nohpD }, 'welcome downline failed')
    }
  },
})

// ---- LDL ----
register({
  name: 'ldl',
  description: 'List downline langsung',
  async handler({ client, event, mitra }) {
    const dl = downlines(mitra.id)
    if (!dl.length) {
      await client.message.send(event.key.remoteJid, 'Belum ada downline')
      return
    }
    const lines = dl.map((d) => `• ${d.kode} — ${d.nama} (${d.kota}) | markup ${formatRupiah(d.markup)} | ${d.aktif ? 'aktif' : 'nonaktif'}`)
    await client.message.send(event.key.remoteJid, `*Downline Anda:*\n${lines.join('\n')}`)
  },
})

// ---- MP ----
register({
  name: 'mp',
  description: 'Ubah markup downline: MP.KODE.MARKUP.PIN',
  async handler({ client, event, mitra, args }) {
    if (args.length < 3) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: MP.KODE.MARKUP.PIN')
      return
    }
    const [kode, markupRaw, pin] = args
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const target = requireDownline({ mitra }, kode)
    if (!target) {
      await client.message.send(event.key.remoteJid, NOT_DOWNLINE)
      return
    }
    const markup = parseNumber(markupRaw)
    if (!Number.isInteger(markup) || markup < 0) {
      await client.message.send(event.key.remoteJid, 'Markup harus bilangan bulat >= 0')
      return
    }
    updateAgen(target.id, { markup })
    await client.message.send(event.key.remoteJid, `Markup ${target.kode} diubah menjadi ${formatRupiah(markup)}.`)
  },
})

// ---- NA / AKTIF / HAPUS ----
function statusHandler(action, text) {
  return async function handler({ client, event, mitra, args }) {
    const kode = args[0]
    if (!kode) {
      await client.message.send(event.key.remoteJid, `Gunakan format: ${action}.KODE.PIN`)
      return
    }
    if (!requirePin({ mitra, args })) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const target = requireDownline({ mitra }, kode)
    if (!target) {
      await client.message.send(event.key.remoteJid, NOT_DOWNLINE)
      return
    }
    if (action === 'HAPUS') {
      if (countDownlines(target.id) > 0) {
        await client.message.send(event.key.remoteJid, 'Tidak bisa dihapus: masih memiliki downline')
        return
      }
      deleteAgen(target.id)
      await client.message.send(event.key.remoteJid, `${target.kode} dihapus.`)
      return
    }
    updateAgen(target.id, { aktif: action === 'AKTIF' ? 1 : 0 })
    await client.message.send(event.key.remoteJid, `${target.kode} ${text}.`)
  }
}
register({ name: 'na', description: 'Nonaktifkan downline', handler: statusHandler('NA', 'dinonaktifkan') })
register({ name: 'aktif', description: 'Aktifkan downline', handler: statusHandler('AKTIF', 'diaktifkan') })
register({ name: 'hapus', description: 'Hapus downline', handler: statusHandler('HAPUS', 'dihapus') })

// ---- TUKAR ----
register({
  name: 'tukar',
  description: 'Tukar komisi ke saldo',
  async handler({ client, event, mitra }) {
    if (mitra.komisi <= 0) {
      await client.message.send(event.key.remoteJid, 'Komisi Anda 0')
      return
    }
    tx(() => {
      const newSaldo = mitra.saldo + mitra.komisi
      addMutasi(mitra.id, 'komisi_masuk', -mitra.komisi, mitra.saldo, 'TUKAR komisi')
      addMutasi(mitra.id, 'kredit', mitra.komisi, newSaldo, 'TUKAR komisi ke saldo')
      setSaldoKomisi(mitra.id, newSaldo, 0)
    })
    await client.message.send(event.key.remoteJid, `Sejumlah ${formatRupiah(mitra.komisi)} telah ditambahkan ke saldo Anda.`)
  },
})

// ---- CS ----
register({
  name: 'cs',
  description: 'Hubungi admin: CS.PESAN',
  async handler({ client, event, mitra, args, owners, log }) {
    const pesan = args.join(' ')
    if (!pesan) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: CS.PESAN')
      return
    }
    for (const o of owners) {
      try {
        await client.message.send(`${o}@s.whatsapp.net`, `*CS dari Mitra*\nID: ${mitra.kode}\nNama: ${mitra.nama}\nPesan: "${pesan}"`)
      } catch (e) {
        log.error({ err: e, owner: o }, 'cs forward failed')
      }
    }
    await client.message.send(
      event.key.remoteJid,
      `Pesan Anda telah kami teruskan ke Admin/CS.\n\nID: ${mitra.kode}\nPesan: "${pesan}"\n\nMohon tunggu tanggapan dari tim kami.`
    )
  },
})

// ---- GP / UN ----
register({
  name: 'gp',
  description: 'Ganti PIN: GP.PINBARU.PINLAMA',
  async handler({ client, event, mitra, args }) {
    const [pinBaru, pinLama] = args
    if (!verifyPin(pinLama, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    if (!/^\d{4,}$/.test(pinBaru || '')) {
      await client.message.send(event.key.remoteJid, 'PIN baru minimal 4 digit angka')
      return
    }
    const { hashPin } = await import('../auth.js')
    updateAgen(mitra.id, { pin_hash: hashPin(pinBaru) })
    await client.message.send(event.key.remoteJid, 'PIN berhasil diganti.')
  },
})

register({
  name: 'un',
  description: 'Ubah nama: UN.NAMA.PIN',
  async handler({ client, event, mitra, args }) {
    if (args.length < 2) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: UN.NAMA.PIN')
      return
    }
    const pin = args[args.length - 1]
    const nama = args.slice(0, -1).join(' ')
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    updateAgen(mitra.id, { nama })
    await client.message.send(event.key.remoteJid, `Nama diubah menjadi "${nama}".`)
  },
})

// ---- TNO / HNO / LNO ----
register({
  name: 'tno',
  description: 'Tambah nomor paralel: TNO.NOHP.PIN',
  async handler({ client, event, mitra, args }) {
    if (!requirePin({ mitra, args })) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const nohp = args[0]
    if (!nohp) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: TNO.NOHP.PIN')
      return
    }
    const nohpD = String(nohp).replace(/\D/g, '')
    if (!nohpD || nomorTaken(nohpD)) {
      await client.message.send(event.key.remoteJid, 'Nomor tidak valid atau sudah terdaftar')
      return
    }
    addNomor(mitra.id, nohpD)
    await client.message.send(event.key.remoteJid, `Nomor ${nohpD} ditambahkan ke akun Anda.`)
  },
})

register({
  name: 'hno',
  description: 'Hapus nomor paralel: HNO.NOHP.PIN',
  async handler({ client, event, mitra, args }) {
    if (!requirePin({ mitra, args })) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const nohp = args[0]
    if (!nohp) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: HNO.NOHP.PIN')
      return
    }
    const nohpD = String(nohp).replace(/\D/g, '')
    if (!nohpD || nohpD === mitra.nohp) {
      await client.message.send(event.key.remoteJid, 'Nomor utama tidak bisa dihapus')
      return
    }
    if (!removeNomor(mitra.id, nohpD)) {
      await client.message.send(event.key.remoteJid, 'Nomor paralel tidak ditemukan')
      return
    }
    await client.message.send(event.key.remoteJid, `Nomor ${nohpD} dihapus.`)
  },
})

register({
  name: 'lno',
  description: 'Cek daftar nomor',
  async handler({ client, event, mitra }) {
    const extra = nomorOf(mitra.id)
    const all = [mitra.nohp, ...extra]
    await client.message.send(event.key.remoteJid, `*Nomor Anda:*\n${all.join('\n')}`)
  },
})

// ---- stubs for not-yet-built features ----
const STUBS = { beli: 'Beli', tiket: 'Tiket Deposit', lap: 'Laporan', rek: 'Mutasi', cek: 'Cek Trx', btl: 'Batal Trx' }
for (const [name, label] of Object.entries(STUBS)) {
  register({
    name,
    description: label,
    handler({ client, event }) {
      return client.message.send(event.key.remoteJid, 'Fitur belum tersedia')
    },
  })
}
