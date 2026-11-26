import { register } from './registry.js'

// Menu text kept verbatim from the reference bot. Content-only for now —
// transactions, balance and downline logic land later.
const OVERVIEW = `*PANDUAN TRANSAKSI*
• FORMAT1 : Transaksi & Cek Saldo
• FORMAT2 : Deposit & Tambah Agen
• FORMAT3 : Kelola Downline & Markup
• FORMAT4 : Pengaturan Akun & PIN`

const FORMATS = {
  format1: `*FORMAT 1 (TRANSAKSI & CEK SALDO)*
• Beli : KODE.TUJUAN.PIN
• Cek Saldo : SAL
• Cek Harga : CH.KODE
• Cek Trx : CEK[.TUJUAN]
• Laporan : LAP
• Mutasi : REK
• Batal Deposit : BTL.IDDEPOSIT.PIN

*(Bisa tanpa PIN, spasi, bolak-balik & multi nomor)*`,
  format2: `*FORMAT 2 (DEPOSIT & TAMBAH AGEN)*
• Tiket Deposit : TIKET.NOMINAL.PIN
• Deposit QRIS : QRIS.NOMINAL.PIN
• Cek Tiket : TIKET.IDDEPOSIT
• Tambah Agen : DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN
• Hubungi Admin : CS.PESAN`,
  format3: `*FORMAT 3 (KELOLA DOWNLINE & MARKUP)*
• List Downline : LDL
• Ubah Markup : MP.ID.MARKUP.PIN
• Nonaktifkan : NA.ID.PIN
• Aktifkan : AKTIF.ID.PIN
• Hapus Agen : HAPUS.ID.PIN
• Reset PIN : GPN.ID.PINBARU.PIN`,
  format4: `*FORMAT 4 (PENGATURAN AKUN & PIN)*
• Ganti PIN : GP.PINBARU.PINLAMA
• Ubah Nama : UN.NAMA.PIN
• Tambah No Paralel : TNO.NOHP.PIN
• Hapus No Paralel : HNO.NOHP.PIN
• Cek Daftar Nomor : LNO
• Tukar Komisi : TUKAR`,
}

// FORMAT1..4 stay verbatim (reference bot text). The overview is served as
// FORMAT and gets the role-specific admin sections appended.
for (const [name, text] of Object.entries(FORMATS)) {
  register({
    name,
    description: `Menu ${name.toUpperCase()}`,
    handler({ client, event }) {
      return client.message.send(event.key.remoteJid, text)
    },
  })
}

// Role-specific sections appended to INFO/ALL. Admin commands are meaningless
// to a mitra, so only show them to admins and the super admin.
const ADMIN_EXTRA = `*KHUSUS ADMIN*
• Laporan Sesi : LAP[HARI|BULAN|YYYY-MM-DD]
• API Key Supplier : APIKEY.KEY
• Tambah Saldo : TSAL.NOHP.NOMINAL.PIN
• Kurang Saldo : KSAL.NOHP.NOMINAL.PIN
• List Produk : LPRDK
• Markup General : MKP.NOMINAL
• Markup per Produk : MKP.KODE.NOMINAL
• Rekening Deposit : TPAY.BANK.NO.A/N
• Hapus Rekening : HPAY.BANK
• Simpan QRIS : TQRIS + gambar
• Hapus QRIS : HQRIS
• Daftar Tiket Pending : TLIST
• Konfirmasi Deposit : TDEP.IDDEPOSIT.PIN`

const SUPER_EXTRA = `*KHUSUS SUPER ADMIN*
• Daftar Session : SESI
• Buat Session : SESIBUAT.ID.NOMORADMIN.NOMORWA[LABEL]
• Nyalakan/Matikan : SESION.ID / SESIOFF.ID
• Hapus Session : SESIHAPUS.ID
• Transaksi Session : LAPTRX.ID[HARI|BULAN|YYYY-MM-DD]
• Status Server : STATUS
• Session Live : SESSIONS
• Restart Session : RESTART.ID
• Config Aktif : ENV
• Semua Command : CMD`

function extrasFor({ isAdmin, isSuper }) {
  return [isAdmin && ADMIN_EXTRA, isSuper && SUPER_EXTRA].filter(Boolean).join('\n\n')
}

function withExtras(text, ctx) {
  const extra = extrasFor(ctx)
  return extra ? `${text}\n\n${extra}` : text
}

// "format" = panduan + command khusus sesuai role.
register({
  name: 'format',
  description: 'Panduan transaksi (+ command admin/owner bila berhak)',
  handler({ client, event, ...ctx }) {
    return client.message.send(event.key.remoteJid, withExtras(OVERVIEW, ctx))
  },
})

// "all" dumps every menu in one message.
register({
  name: 'all',
  description: 'Kirim semua format sekaligus',
  handler({ client, event, ...ctx }) {
    return client.message.send(event.key.remoteJid, withExtras(Object.values(FORMATS).join('\n\n'), ctx))
  },
})
