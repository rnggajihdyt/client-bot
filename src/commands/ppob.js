import { register } from './registry.js'

// Menu text kept verbatim from the reference bot. Content-only for now —
// transactions, balance and downline logic land later.
const FORMATS = {
  info: `*PANDUAN TRANSAKSI*
• FORMAT1 : Transaksi & Cek Saldo
• FORMAT2 : Deposit & Tambah Agen
• FORMAT3 : Kelola Downline & Markup
• FORMAT4 : Pengaturan Akun & PIN`,
  format1: `*FORMAT 1 (TRANSAKSI & CEK SALDO)*
• Beli : KODE.TUJUAN.PIN
• Cek Saldo : SAL
• Cek Harga : CH.KODE
• Cek Trx : CEK.TUJUAN
• Laporan : LAP
• Mutasi : REK
• Batal Trx : BTL.IDTRX.PIN

*(Bisa tanpa PIN, spasi, bolak-balik & multi nomor)*`,
  format2: `*FORMAT 2 (DEPOSIT & TAMBAH AGEN)*
• Tiket Deposit : TIKET.NOMINAL.PIN
• Tambah Agen : DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN
• Hubungi Admin : CS.PESAN`,
  format3: `*FORMAT 3 (KELOLA DOWNLINE & MARKUP)*
• List Downline : LDL
• Ubah Markup : MP.ID.MARKUP.PIN
• Nonaktifkan : NA.ID.PIN
• Aktifkan : AKTIF.ID.PIN
• Hapus Agen : HAPUS.ID.PIN`,
  format4: `*FORMAT 4 (PENGATURAN AKUN & PIN)*
• Ganti PIN : GP.PINBARU.PINLAMA
• Ubah Nama : UN.NAMA.PIN
• Tambah No Paralel : TNO.NOHP.PIN
• Hapus No Paralel : HNO.NOHP.PIN
• Cek Daftar Nomor : LNO
• Tukar Komisi : TUKAR`,
}

for (const [name, text] of Object.entries(FORMATS)) {
  register({
    name,
    description: `Menu ${name.toUpperCase()}`,
    handler({ client, event }) {
      return client.message.send(event.key.remoteJid, text)
    },
  })
}
