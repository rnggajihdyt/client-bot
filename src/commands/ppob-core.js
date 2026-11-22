import { register } from './registry.js'
import { verifyPin, hashPin } from '../auth.js'
import { formatRupiah, parseNumber } from '../money.js'
import { parseRange } from '../report.js'
import { normalizeNohp } from '../utils.js'
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
    const text = isAdmin
      ? `Yth. Admin ${mitra.nama} ID: ${mitra.kode}\n` +
        `Saldo: ${formatRupiah(mitra.saldo)} Limit: 0\n` +
        `Dalam proses: ${formatRupiah(st.proses)} Terpakai hari ini: ${formatRupiah(st.hariIni)}\n\n` +
        `Ketik LAP utk lihat laporan profit`
      : `Yth. Mitra ${mitra.nama} ID: ${mitra.kode}\n` +
        `Saldo: ${formatRupiah(mitra.saldo)} Limit: 0\n` +
        `Dalam proses: ${formatRupiah(st.proses)} Terpakai hari ini: ${formatRupiah(st.hariIni)} Komisi: ${formatRupiah(mitra.komisi)}\n\n` +
        `Ketik TUKAR utk ambil komisi` +
        (deactivated
          ? `\n\n*Akun Anda sedang DINONAKTIFKAN.* Tidak dapat bertransaksi sampai diaktifkan kembali oleh uplink.`
          : '')
    await client.message.send(event.key.remoteJid, text)
  },
})

// ---- CH ----
const CH_PAGE_SIZE = 15

function produkStatusLabel(p) {
  if (p.aktif && p.status_supplier === 'available') return 'Tersedia'
  if (p.status_supplier === 'empty') return 'Kosong'
  return `Gangguan (${p.status_supplier || 'nonaktif'})`
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
    const hasPageArg = args.length >= 2

    // Exact code match when no page number is requested (e.g. CH.XDA40).
    if (!hasPageArg) {
      const exact = db.effectivePrice(mitra.id, query)
      if (exact) {
        await client.message.send(
          event.key.remoteJid,
          `*${exact.nama}* (${exact.kode})\nHarga: ${formatRupiah(exact.hargaEfektif)}\nStatus: ${produkStatusLabel(exact)}`
        )
        return
      }
    }

    // Prefix / category search with pagination (e.g. CH.XDA, CH.XDA.1, CH.PROMO.2).
    let page = 1
    if (hasPageArg) {
      if (!/^\d+$/.test(args[1]) || Number(args[1]) < 1) {
        await client.message.send(event.key.remoteJid, `Nomor halaman tidak valid. Contoh: CH.${query}.1`)
        return
      }
      page = Number(args[1])
    }

    const rows = db.searchEffectivePrices(mitra.id, query)
    if (!rows.length) {
      await client.message.send(event.key.remoteJid, 'Produk tidak ditemukan')
      return
    }

    const totalPages = Math.ceil(rows.length / CH_PAGE_SIZE)
    if (page > totalPages) {
      await client.message.send(
        event.key.remoteJid,
        `Halaman ${page} tidak tersedia (maks ${totalPages}). Coba: CH.${query}.${totalPages}`
      )
      return
    }

    const slice = rows.slice((page - 1) * CH_PAGE_SIZE, page * CH_PAGE_SIZE)
    const lines = slice.map(
      (p) => `• *${p.kode}* — ${formatRupiah(p.hargaEfektif)} (${produkStatusLabel(p)})\n  ${p.nama}`
    )
    const nav =
      page < totalPages
        ? `\n\nHalaman berikutnya: CH.${query}.${page + 1}`
        : totalPages > 1
          ? `\n\nHalaman sebelumnya: CH.${query}.${page - 1}`
          : ''

    await client.message.send(
      event.key.remoteJid,
      `*Harga ${query}* (Hal ${page}/${totalPages} — ${rows.length} produk)\n${lines.join('\n')}${nav}`
    )
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
      `Mitra baru: ${nama} (${created.kode}) ${nohpD} berhasil ditambahkan sebagai ${isUplink ? 'uplink' : 'downline'} Anda.`
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
  async handler({ client, event, mitra, db }) {
    const dl = db.downlines(mitra.id)
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
    `Ketik INFO untuk mengetahui format-format transaksi.`
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
      await client.message.send(`${target.nohp}@s.whatsapp.net`, downlineNotice(target, active))
    } catch (err) {
      log?.warn({ err, nohp: target.nohp }, 'status notice failed')
    }
  }
}
register({ name: 'na', description: 'Nonaktifkan downline', handler: statusHandler('NA', 'dinonaktifkan') })
register({ name: 'aktif', description: 'Aktifkan downline', handler: statusHandler('AKTIF', 'diaktifkan') })
register({ name: 'hapus', description: 'Hapus downline', handler: statusHandler('HAPUS', 'dihapus') })

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
register({
  name: 'cs',
  description: 'Hubungi admin: CS.PESAN',
  async handler({ client, event, mitra, args, log, db }) {
    const pesan = args.join(' ')
    if (!pesan) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: CS.PESAN')
      return
    }
    // Per-session admin is the recipient, not the global OWNERS list.
    const root = db.root()
    if (!root) {
      await client.message.send(event.key.remoteJid, 'Admin session belum terdaftar')
      return
    }
    try {
      await client.message.send(
        `${root.nohp}@s.whatsapp.net`,
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
    await client.message.send(event.key.remoteJid, `Nomor ${nohpD} ditambahkan ke akun Anda.`)
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
    await client.message.send(event.key.remoteJid, `Nomor ${nohpD} dihapus.`)
  },
})

register({
  name: 'lno',
  description: 'Cek daftar nomor',
  async handler({ client, event, mitra, db }) {
    const all = [mitra.nohp, ...db.nomorOf(mitra.id)]
    await client.message.send(event.key.remoteJid, `*Nomor Anda:*\n${all.join('\n')}`)
  },
})

// ---- BELI moved to commands/supplier.js (two-phase ICS flow) ----

// ---- LAP ----
// Admin = whole session. Any mitra with downlines = its own network. Leaf mitra = itself.
register({
  name: 'lap',
  description: 'Laporan: LAP[HARI|BULAN|YYYY-MM-DD]',
  async handler({ client, event, mitra, args, isAdmin, db }) {
    const { from, to, label } = parseRange(args[0])

    if (isAdmin) {
      const sum = db.profitSummary({ from, to })
      const list = db.recentTransaksi({ from, to, limit: 10 })
      const head =
        `*Laporan Sesi* (${label})\n` +
        `Trx: ${sum.trx} Omzet: ${formatRupiah(sum.omzet)}\n` +
        `Modal: ${formatRupiah(sum.modal)} Komisi Jaringan: ${formatRupiah(sum.komisi)}\n` +
        `Profit: ${formatRupiah(sum.profit)}`
      const lines = list.map(
        (t) => `• ${t.id_trx} ${t.agen_kode ?? '-'} ${t.produk_kode} → ${t.tujuan} ${formatRupiah(t.harga_efektif)}`
      )
      await client.message.send(event.key.remoteJid, lines.length ? `${head}\n\n${lines.join('\n')}` : head)
      return
    }

    // Any uplink/reseller at any depth who has downlines gets the whole network report.
    const desc = db.descendants(mitra.id)
    if (desc.length > 0) {
      const ids = [mitra.id, ...desc]
      const sum = db.profitSummary({ agenIds: ids, from, to })
      const komisi = db.commissionEarned(mitra.id, from, to)
      await client.message.send(
        event.key.remoteJid,
        `*Laporan Jaringan* (${label})\n` +
          `Trx: ${sum.trx} Omzet: ${formatRupiah(sum.omzet)}\n` +
          `Komisi Anda: ${formatRupiah(komisi)}`
      )
      return
    }

    const sum = db.profitSummary({ agenIds: [mitra.id], from, to })
    const komisi = db.commissionEarned(mitra.id, from, to)
    await client.message.send(
      event.key.remoteJid,
      `*Laporan Anda* (${label})\n` +
        `Trx: ${sum.trx} Omzet: ${formatRupiah(sum.omzet)}\n` +
        `Komisi Anda: ${formatRupiah(komisi)}`
    )
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
    await client.message.send(event.key.remoteJid, `Mitra dengan nomor ${nohp} tidak ditemukan`)
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
      `${isAdd ? 'Tambah' : 'Kurang'} saldo oleh ${mitra.kode}`
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
    `Saldo ${target.nama} (${target.kode} / ${target.nohp}) ${verb} ${formatRupiah(nominal)}. Saldo sekarang: ${formatRupiah(saldoAkhir)}.`
  )

  if (target.id !== mitra.id) {
    try {
      await client.message.send(
        `${target.nohp}@s.whatsapp.net`,
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

// ---- stubs for not-yet-built features ----
const STUBS = { tiket: 'Tiket Deposit' }
for (const [name, label] of Object.entries(STUBS)) {
  register({
    name,
    description: label,
    handler({ client, event }) {
      return client.message.send(event.key.remoteJid, 'Fitur belum tersedia')
    },
  })
}
