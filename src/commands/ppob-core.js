import { register } from './registry.js'
import { verifyPin, hashPin } from '../auth.js'
import { formatRupiah, parseNumber } from '../money.js'
import { parseRange } from '../report.js'
import { displayNohp, normalizeNohp, to62, toJid } from '../utils.js'
import { ensureFreshCatalog } from '../catalog.js'

const NOT_DOWNLINE = 'Bukan downline Anda'
const PIN_SALAH = 'PIN salah'
const ADMIN_ONLY = 'Khusus admin'

function requirePin(ctx) {
  const pin = ctx.args[ctx.args.length - 1]
  if (!verifyPin(pin, ctx.mitra?.pin_hash)) return null
  return pin
}

function requireDownline(ctx, kode) {
  const target = ctx.db.findAgenByKode(String(kode).toUpperCase())
  if (!target || target.senior_id !== ctx.mitra.id) return null
  return target
}

// ---- SAL ----
register({
  name: 'sal',
  description: 'Cek saldo',
  async handler({ client, event, mitra, isAdmin, deactivated, db }) {
    const st = db.transaksiStats(mitra.id)
    const text =
      `Yth. Kak ${mitra.nama}\n` +
      `ID Anda ${mitra.kode}\n` +
      `Saldo: ${formatRupiah(mitra.saldo)} Limit: 0\n` +
      `Dalam proses: ${formatRupiah(st.proses)} Terpakai hari ini: ${formatRupiah(st.hariIni)} Komisi: ${formatRupiah(mitra.komisi)}\n\n` +
      (isAdmin ? `Ketik LAP utk lihat laporan profit` : `Ketik TUKAR utk ambil komisi`) +
      (deactivated
        ? `\n\n*Akun Anda sedang DINONAKTIFKAN.* Tidak dapat bertransaksi sampai diaktifkan kembali oleh uplink.`
        : '')
    await client.message.send(event.key.remoteJid, text)
  },
})

// ---- CH ----
// Batas 1 pesan WA ~100 baris; daftar dipecah per 100 baris ke pesan berikutnya.
const CH_PER_MSG = 100
const LAP_PER_MSG = 100
const LAP_MAX_ROWS = 500

// Status produk di CH: tanpa penanda kalau tersedia; [K] kosong, [G] gangguan.
function produkFlag(p) {
  if (p.aktif && p.status_supplier === 'available') return ''
  if (p.status_supplier === 'empty') return '  [K]'
  return '  [G]'
}

// Baris CH: "XDA13 = 45.000 XL AXIS Data 13Gb Reguler + Lokal  [K]"
function produkLine(p) {
  return `${p.kode} = ${formatRupiah(p.hargaEfektif)} ${p.nama}${produkFlag(p)}`
}

// Pecah baris jadi pesan-pesan maksimal `perPesan` baris (batas 1 pesan WA).
function chunkLines(lines, perPesan) {
  const chunks = []
  for (let i = 0; i < lines.length; i += perPesan) chunks.push(lines.slice(i, i + perPesan))
  return chunks
}

register({
  name: 'ch',
  description: 'Cek harga produk/kategori: CH.KODE atau CH.PREFIX[.HAL]',
  async handler({ client, event, mitra, args, db, log, sessionId }) {
    await ensureFreshCatalog(db, { logger: log, sessionId })

    const rawQuery = args[0]
    if (!rawQuery) {
      const cats = db.listKategori()
      const hint = cats.length ? `\nKategori: ${cats.join(', ')}` : ''
      await client.message.send(
        event.key.remoteJid,
        `Gunakan format: CH.KODE atau CH.PREFIX.HAL (contoh: CH.XDA.1)${hint}`
      )
      return
    }

    const query = rawQuery.toUpperCase()

    // Exact code match (e.g. CH.XDA40) — satu produk, format sama seperti list.
    if (args.length < 2) {
      const exact = db.effectivePrice(mitra.id, query)
      if (exact) {
        await client.message.send(event.key.remoteJid, produkLine(exact))
        return
      }
    }

    // Kategori/prefix: maksimal CH_PER_MSG baris per pesan, sisa ke pesan berikutnya.
    const rows = db.searchEffectivePrices(mitra.id, query)
    if (!rows.length) {
      await client.message.send(event.key.remoteJid, 'Produk tidak ditemukan')
      return
    }

    const chunks = chunkLines(rows.map(produkLine), CH_PER_MSG)
    for (let i = 0; i < chunks.length; i++) {
      const head = i === 0 ? `Harga:` : ''
      const foot = i === chunks.length - 1 ? `\n*K=kosong, G=Gangguan` : ''
      await client.message.send(event.key.remoteJid, `${head}\n${chunks[i].join('\n')}${foot}`)
    }
  },
})

// ---- DAFTAR ----
// Issued by the session admin it creates an uplink (direct child of the root).
register({
  name: 'daftar',
  description: 'Tambah downline/uplink: DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN',
  async handler({ client, event, mitra, args, log, db }) {
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
    const nohpD = normalizeNohp(nohp)
    if (!nohpD) {
      await client.message.send(event.key.remoteJid, 'Nomor HP tidak valid')
      return
    }
    if (db.nomorTaken(nohpD)) {
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
      created = db.createAgen({ nama, kota, nohp: nohpD, seniorId: mitra.id, markup, pin: '1234' })
    } catch {
      await client.message.send(event.key.remoteJid, 'Gagal menyimpan, coba lagi')
      return
    }

    const isUplink = mitra.senior_id == null
    await client.message.send(
      event.key.remoteJid,
      `Mitra baru: ${nama} (${created.kode}) ${displayNohp(nohpD)} berhasil ditambahkan sebagai ${isUplink ? 'uplink' : 'downline'} Anda.`
    )

    // Welcome the new downline directly. Best-effort: a failed send must not
    // undo the registration.
    try {
      await client.message.send(
        toJid(nohpD),
        `Yth. Kak ${nama}, Selamat bergabung! Kode Agen anda adalah ${created.kode}, PIN: 1234, Saldo sekarang 0. Ketik FORMAT untuk mengetahui format-format transaksi.`
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
  async handler({ client, event, mitra, db }) {
    const dl = db.downlines(mitra.id)
    if (!dl.length) {
      await client.message.send(event.key.remoteJid, 'Belum ada downline')
      return
    }
    const lines = dl.map(
      (d) => `• ${d.kode} — ${d.nama} (${d.kota}) | ${displayNohp(d.nohp)} | markup ${formatRupiah(d.markup)} | ${d.aktif ? 'aktif' : 'nonaktif'}`
    )
    await client.message.send(event.key.remoteJid, `*Downline Anda:*\n${lines.join('\n')}`)
  },
})

// ---- MP ----
register({
  name: 'mp',
  description: 'Ubah markup downline: MP.KODE.MARKUP.PIN',
  async handler({ client, event, mitra, args, db }) {
    if (args.length < 3) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: MP.KODE.MARKUP.PIN')
      return
    }
    const [kode, markupRaw, pin] = args
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const target = requireDownline({ mitra, db }, kode)
    if (!target) {
      await client.message.send(event.key.remoteJid, NOT_DOWNLINE)
      return
    }
    const markup = parseNumber(markupRaw)
    if (!Number.isInteger(markup) || markup < 0) {
      await client.message.send(event.key.remoteJid, 'Markup harus bilangan bulat >= 0')
      return
    }
    db.updateAgen(target.id, { markup })
    await client.message.send(event.key.remoteJid, `Markup ${target.kode} diubah menjadi ${formatRupiah(markup)}.`)
  },
})

// ---- NA / AKTIF / HAPUS ----
function downlineNotice(target, active) {
  const state = active ? 'DIAKTIFKAN kembali' : 'DINONAKTIFKAN'
  return (
    `Yth. ${target.nama}, Akun anda dengan Kode Agen ${target.kode} telah ${state}. ` +
    `Saldo sekarang ${formatRupiah(target.saldo)}. ` +
    `Ketik FORMAT untuk mengetahui format-format transaksi.`
  )
}

function statusHandler(action, text) {
  return async function handler({ client, event, mitra, args, log, db }) {
    const kode = args[0]
    if (!kode) {
      await client.message.send(event.key.remoteJid, `Gunakan format: ${action}.KODE.PIN`)
      return
    }
    if (!requirePin({ mitra, args })) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const target = requireDownline({ mitra, db }, kode)
    if (!target) {
      await client.message.send(event.key.remoteJid, NOT_DOWNLINE)
      return
    }
    if (action === 'HAPUS') {
      if (db.countDownlines(target.id) > 0) {
        await client.message.send(event.key.remoteJid, 'Tidak bisa dihapus: masih memiliki downline')
        return
      }
      db.deleteAgen(target.id)
      await client.message.send(event.key.remoteJid, `${target.kode} dihapus.`)
      return
    }
    const active = action === 'AKTIF'
    db.updateAgen(target.id, { aktif: active ? 1 : 0 })
    await client.message.send(event.key.remoteJid, `${target.kode} ${text}.`)

    // Same style as the DAFTAR welcome. PIN is never included (it is hashed).
    try {
      await client.message.send(toJid(target.nohp), downlineNotice(target, active))
    } catch (err) {
      log?.warn({ err, nohp: target.nohp }, 'status notice failed')
    }
  }
}
register({ name: 'na', description: 'Nonaktifkan downline', handler: statusHandler('NA', 'dinonaktifkan') })
register({ name: 'aktif', description: 'Aktifkan downline', handler: statusHandler('AKTIF', 'diaktifkan') })
register({ name: 'hapus', description: 'Hapus downline', handler: statusHandler('HAPUS', 'dihapus') })

// ---- GPN: reset PIN downline (mitra lupa PIN) ----
register({
  name: 'gpn',
  description: 'Reset PIN downline: GPN.KODE.PINBARU.PIN',
  async handler({ client, event, mitra, args, db, log }) {
    const jid = event.key.remoteJid
    if (args.length < 3) {
      await client.message.send(jid, 'Gunakan format: GPN.KODE.PINBARU.PIN')
      return
    }
    const [kode, pinBaru] = args
    if (!requirePin({ mitra, args })) {
      await client.message.send(jid, PIN_SALAH)
      return
    }
    const target = requireDownline({ mitra, db }, kode)
    if (!target) {
      await client.message.send(jid, NOT_DOWNLINE)
      return
    }
    if (!/^\d{4,}$/.test(pinBaru || '')) {
      await client.message.send(jid, 'PIN baru minimal 4 digit angka')
      return
    }
    db.updateAgen(target.id, { pin_hash: hashPin(pinBaru) })
    await client.message.send(jid, `PIN ${target.kode} direset.`)
    try {
      await client.message.send(
        toJid(target.nohp),
        `PIN akun ${target.kode} Anda telah direset oleh admin menjadi ${pinBaru}. Segera ganti dengan GP.PINBARU.PINLAMA.`
      )
    } catch (err) {
      log?.warn({ err, nohp: target.nohp }, 'reset pin notice failed')
    }
  },
})

// ---- TUKAR ----
register({
  name: 'tukar',
  description: 'Tukar komisi ke saldo',
  async handler({ client, event, mitra, isAdmin, db }) {
    if (isAdmin) {
      await client.message.send(event.key.remoteJid, 'Akun admin tidak memakai sistem komisi. Cek profit lewat LAP.')
      return
    }
    if (mitra.komisi <= 0) {
      await client.message.send(event.key.remoteJid, 'Komisi Anda 0')
      return
    }
    db.tx(() => {
      const newSaldo = mitra.saldo + mitra.komisi
      db.addMutasi(mitra.id, 'komisi_tukar', -mitra.komisi, mitra.saldo, 'TUKAR komisi')
      db.addMutasi(mitra.id, 'kredit', mitra.komisi, newSaldo, 'TUKAR komisi ke saldo')
      db.setSaldoKomisi(mitra.id, newSaldo, 0)
    })
    await client.message.send(event.key.remoteJid, `Sejumlah ${formatRupiah(mitra.komisi)} telah ditambahkan ke saldo Anda.`)
  },
})

// ---- CS ----
// Any CS message that carries a deposit id (D0001 … D9999) is treated as a
// transfer confirmation; the id must exist and belong to the sender. The admin
// receives it with the transfer proof (image) if one was attached.
const DEPOSIT_ID_RE = /\bD\d{4}\b/i

register({
  name: 'cs',
  description: 'Hubungi admin: CS.PESAN (kosong = nomor CS admin sesi)',
  async handler({ client, event, mitra, args, log, db }) {
    const pesan = args.join(' ')
    const idDeposit = pesan.match(DEPOSIT_ID_RE)?.[0]?.toUpperCase()
    // Per-session admin is the recipient, not the global OWNERS list.
    const root = db.root()
    if (!root) {
      await client.message.send(event.key.remoteJid, 'Admin session belum terdaftar')
      return
    }

    // Tanpa pesan: cukup kirim nomor CS admin sesi ini.
    if (!pesan) {
      await client.message.send(event.key.remoteJid, `Silahkan hubungi CS kami di WhatsApp ${displayNohp(root.nohp)}`)
      return
    }

    const adminJid = toJid(root.nohp)
    if (idDeposit) {
      // Konfirmasi transfer kini otomatis (TDEP), bukti tf tidak lagi diminta:
      // id tiket hanya diteruskan sebagai konteks, lampiran gambar diabaikan.
      const dep = db.getDeposit(idDeposit)
      const status = !dep
        ? 'tiket tidak ditemukan'
        : dep.agen_id !== mitra.id
          ? 'tiket milik mitra lain'
          : `${dep.status} — Rp. ${formatRupiah(dep.total)} (nominal ${formatRupiah(dep.nominal)} + kode ${dep.kode_unik})`
      await client.message
        .send(
          adminJid,
          `*Konfirmasi Transfer*\nID: ${idDeposit} (${status})\nMitra: ${mitra.kode} ${mitra.nama} ${displayNohp(mitra.nohp)}\nPesan: "${pesan}"`
        )
        .catch((e) => log?.error?.({ err: e, admin: root.nohp }, 'cs konfirmasi transfer failed'))
      await client.message.send(
        event.key.remoteJid,
        `Konfirmasi tiket ${idDeposit} sudah diteruskan ke Admin/CS.\n\nID: ${mitra.kode}\nMohon tunggu, saldo akan ditambahkan setelah dicek.`
      )
      return
    }

    try {
      await client.message.send(
        adminJid,
        `*CS dari Mitra*\nID: ${mitra.kode}\nNama: ${mitra.nama}\nPesan: "${pesan}"`
      )
    } catch (e) {
      log.error({ err: e, admin: root.nohp }, 'cs forward failed')
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
  async handler({ client, event, mitra, args, db }) {
    const [pinBaru, pinLama] = args
    if (!verifyPin(pinLama, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    if (!/^\d{4,}$/.test(pinBaru || '')) {
      await client.message.send(event.key.remoteJid, 'PIN baru minimal 4 digit angka')
      return
    }
    db.updateAgen(mitra.id, { pin_hash: hashPin(pinBaru) })
    await client.message.send(event.key.remoteJid, 'PIN berhasil diganti.')
  },
})

register({
  name: 'un',
  description: 'Ubah nama: UN.NAMA.PIN',
  async handler({ client, event, mitra, args, db }) {
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
    db.updateAgen(mitra.id, { nama })
    await client.message.send(event.key.remoteJid, `Nama diubah menjadi "${nama}".`)
  },
})

// ---- TNO / HNO / LNO ----
register({
  name: 'tno',
  description: 'Tambah nomor paralel: TNO.NOHP.PIN',
  async handler({ client, event, mitra, args, db }) {
    if (!requirePin({ mitra, args })) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const nohp = args[0]
    if (!nohp) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: TNO.NOHP.PIN')
      return
    }
    const nohpD = normalizeNohp(nohp)
    if (!nohpD || db.nomorTaken(nohpD)) {
      await client.message.send(event.key.remoteJid, 'Nomor tidak valid atau sudah terdaftar')
      return
    }
    db.addNomor(mitra.id, nohpD)
    await client.message.send(event.key.remoteJid, `Nomor ${displayNohp(nohpD)} ditambahkan ke akun Anda.`)
  },
})

register({
  name: 'hno',
  description: 'Hapus nomor paralel: HNO.NOHP.PIN',
  async handler({ client, event, mitra, args, db }) {
    if (!requirePin({ mitra, args })) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const nohp = args[0]
    if (!nohp) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: HNO.NOHP.PIN')
      return
    }
    const nohpD = normalizeNohp(nohp)
    if (!nohpD || nohpD === mitra.nohp) {
      await client.message.send(event.key.remoteJid, 'Nomor utama tidak bisa dihapus')
      return
    }
    if (!db.removeNomor(mitra.id, nohpD)) {
      await client.message.send(event.key.remoteJid, 'Nomor paralel tidak ditemukan')
      return
    }
    await client.message.send(event.key.remoteJid, `Nomor ${displayNohp(nohpD)} dihapus.`)
  },
})

register({
  name: 'lno',
  description: 'Cek daftar nomor',
  async handler({ client, event, mitra, db }) {
    const all = [mitra.nohp, ...db.nomorOf(mitra.id)].map(displayNohp)
    await client.message.send(event.key.remoteJid, `*Nomor Anda:*\n${all.join('\n')}`)
  },
})

// ---- BELI moved to commands/supplier.js (two-phase ICS flow) ----

// ---- LAP ----
// Baris transaksi: "XDA55.085953800035 Rp.70.000 @25/11 08:09:23 =Sukses"
function transaksiLine(t) {
  const d = new Date(t.created_at)
  const p = (n) => String(n).padStart(2, '0')
  const when = `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const status = t.status === 'sukses' ? 'Sukses' : 'Gagal'
  return `${t.produk_kode}.${displayNohp(t.tujuan)} Rp.${formatRupiah(t.harga_efektif)} @${when} =${status}`
}

// LAP[.id] — default sukses + gagal, default hari ini.
// LAP.T25/11  -> semua transaksi id hari itu (id diawali T<epoch ms>)
// LAP.sukses  -> hanya yang sukses
register({
  name: 'lap',
  description: 'Laporan: LAP[HARI|MINGGU|BULAN|YYYY-MM-DD|DD|DD-MM-YYYY|YYYY-MM]',
  async handler({ client, event, mitra, args, isAdmin, db }) {
    const jid = event.key.remoteJid
    const a0 = String(args[0] ?? '').toLowerCase()
    const a1 = String(args[1] ?? '').toLowerCase()
    // Gagal ikut tampil secara default; LAP.sukses membatasi ke sukses saja.
    const status = a0 === 'sukses' || a1 === 'sukses' ? 'sukses' : 'semua'
    const idTrx = /^t\d{1,2}\/\d{1,2}$/.test(a0) ? a0 : /^t\d{1,2}\/\d{1,2}$/.test(a1) ? a1 : ''
    const rangeArg = /^(sukses|t\d{1,2}\/\d{1,2})$/.test(a0) ? args[1] : args[0]
    const { from, to, label } = parseRange(rangeArg)

    // Admin = whole session. Any mitra with downlines = its own network. Leaf mitra = itself.
    const desc = isAdmin ? [] : db.descendants(mitra.id)
    const agenIds = isAdmin ? null : desc.length ? [mitra.id, ...desc] : [mitra.id]

    const rows = db.listTransaksi({ agenIds, from, to, status, idTrx, limit: LAP_MAX_ROWS })
    if (!rows.length) {
      await client.message.send(jid, `Tidak ada transaksi (${label})`)
      return
    }

    // Ringkasan singkat hanya untuk admin (mitra fokus ke daftar).
    const sum = db.profitSummary({ agenIds, from, to })
    const head = isAdmin
      ? `Trx: ${sum.trx} Omzet: ${formatRupiah(sum.omzet)} Modal: ${formatRupiah(sum.modal)} ` +
        `Komisi Jaringan: ${formatRupiah(sum.komisi)} Profit: ${formatRupiah(sum.profit)}`
      : ''

    const chunks = chunkLines(rows.map(transaksiLine), LAP_PER_MSG)
    for (let i = 0; i < chunks.length; i++) {
      const parts = []
      if (i === 0 && head) parts.push(head)
      parts.push(chunks[i].join('\n'))
      if (i === chunks.length - 1 && rows.length >= LAP_MAX_ROWS) parts.push(`(maks ${LAP_MAX_ROWS} baris)`)
      await client.message.send(jid, parts.join('\n\n'))
    }
  },
})

// ---- admin: produk & markup ----
// Manual product entry (PRDK) removed: the catalog comes from SYNC (ICS).

register({
  name: 'lprdk',
  description: 'Admin: list produk',
  async handler({ client, event, isAdmin, db }) {
    if (!isAdmin) {
      await client.message.send(event.key.remoteJid, ADMIN_ONLY)
      return
    }
    const rows = db.listProduk()
    if (!rows.length) {
      await client.message.send(event.key.remoteJid, 'Belum ada produk')
      return
    }
    const lines = rows.map(
      (p) =>
        `• ${p.kode} — ${p.nama} | modal ${formatRupiah(p.harga_modal)} | markup ${p.markup == null ? 'general' : formatRupiah(p.markup)} | ${p.status_supplier}`
    )
    await client.message.send(event.key.remoteJid, `*Produk:*\n${lines.join('\n')}`)
  },
})

// General markup = root agen markup (fallback). Per-product markup overrides it.
register({
  name: 'mkp',
  description: 'Admin: MKP.NOMINAL (general) | MKP.KODE.NOMINAL (per produk)',
  async handler({ client, event, args, isAdmin, db }) {
    if (!isAdmin) {
      await client.message.send(event.key.remoteJid, ADMIN_ONLY)
      return
    }
    const [a, b] = args
    if (!a) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: MKP.NOMINAL atau MKP.KODE.NOMINAL')
      return
    }
    if (b === undefined) {
      const markup = parseNumber(a)
      if (!Number.isInteger(markup) || markup < 0) {
        await client.message.send(event.key.remoteJid, 'Markup harus bilangan bulat >= 0')
        return
      }
      const root = db.root()
      if (!root) {
        await client.message.send(event.key.remoteJid, 'Admin session belum terdaftar')
        return
      }
      db.updateAgen(root.id, { markup })
      await client.message.send(event.key.remoteJid, `Markup general diubah menjadi ${formatRupiah(markup)}.`)
      return
    }
    const markup = parseNumber(b)
    if (!Number.isInteger(markup) || markup < 0) {
      await client.message.send(event.key.remoteJid, 'Markup harus bilangan bulat >= 0')
      return
    }
    if (!db.setProdukMarkup(a.toUpperCase(), markup)) {
      await client.message.send(event.key.remoteJid, 'Produk tidak ditemukan')
      return
    }
    await client.message.send(
      event.key.remoteJid,
      `Markup produk ${a.toUpperCase()} diubah menjadi ${formatRupiah(markup)}.`
    )
  },
})

// ---- TSAL / KSAL (admin: tambah/kurang saldo mitra berdasarkan nomor HP) ----
async function adjustSaldo({ client, event, mitra, args, isAdmin, db, log }, direction) {
  const isAdd = direction > 0
  const cmdName = isAdd ? 'TSAL' : 'KSAL'
  if (!isAdmin) {
    await client.message.send(event.key.remoteJid, ADMIN_ONLY)
    return
  }
  const [nohpRaw, nominalRaw, pin] = args
  if (!nohpRaw || !nominalRaw || !pin) {
    await client.message.send(event.key.remoteJid, `Gunakan format: ${cmdName}.NOHP.NOMINAL.PIN`)
    return
  }
  if (!verifyPin(pin, mitra.pin_hash)) {
    await client.message.send(event.key.remoteJid, PIN_SALAH)
    return
  }
  const nohp = normalizeNohp(nohpRaw)
  if (!nohp) {
    await client.message.send(event.key.remoteJid, 'Nomor HP tidak valid')
    return
  }
  const nominal = /^-/.test(String(nominalRaw).trim()) ? NaN : parseNumber(nominalRaw)
  if (!Number.isInteger(nominal) || nominal <= 0) {
    await client.message.send(event.key.remoteJid, 'Nominal harus bilangan bulat > 0')
    return
  }
  const target = db.findAgenByNohp(nohp)
  if (!target) {
    await client.message.send(event.key.remoteJid, `Mitra dengan nomor ${displayNohp(nohp)} tidak ditemukan`)
    return
  }

  let saldoAkhir = 0
  let insufficient = false
  let currentSaldo = 0
  db.tx(() => {
    const fresh = db.findAgenById(target.id)
    currentSaldo = fresh.saldo
    if (!isAdd && fresh.saldo < nominal) {
      insufficient = true
      return
    }
    db.addSaldo(target.id, direction * nominal)
    saldoAkhir = db.findAgenById(target.id).saldo
    db.addMutasi(
      target.id,
      isAdd ? 'kredit' : 'debit',
      nominal,
      saldoAkhir,
      `${isAdd ? 'Tambah' : 'Kurang'} saldo oleh Admin`
    )
  })

  if (insufficient) {
    await client.message.send(
      event.key.remoteJid,
      `Saldo ${target.nama} (${target.kode}) tidak cukup. Saldo saat ini: ${formatRupiah(currentSaldo)}.`
    )
    return
  }

  const verb = isAdd ? 'ditambah' : 'dikurangi'
  await client.message.send(
    event.key.remoteJid,
    `Saldo ${target.nama} (${target.kode} / ${displayNohp(target.nohp)}) ${verb} ${formatRupiah(nominal)}. Saldo sekarang: ${formatRupiah(saldoAkhir)}.`
  )

  if (target.id !== mitra.id) {
    try {
      await client.message.send(
        toJid(target.nohp),
        `Saldo Anda ${isAdd ? 'telah ditambah' : 'dikurangi'} ${formatRupiah(nominal)} oleh Admin. Saldo sekarang: ${formatRupiah(saldoAkhir)}.`
      )
    } catch (err) {
      log?.warn({ err: err?.message, nohp: target.nohp }, `notifikasi ${cmdName.toLowerCase()} gagal`)
    }
  }
}

register({
  name: 'tsal',
  description: 'Admin: TSAL.NOHP.NOMINAL.PIN — tambah saldo mitra via nomor HP',
  handler: (ctx) => adjustSaldo(ctx, 1),
})

register({
  name: 'ksal',
  description: 'Admin: KSAL.NOHP.NOMINAL.PIN — kurang saldo mitra via nomor HP',
  handler: (ctx) => adjustSaldo(ctx, -1),
})

// ---- end of ppob-core ----

