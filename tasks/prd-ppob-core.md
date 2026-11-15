# PRD: PPOB Bot Core (Mitra, Downline, Markup Beranak, Komisi)

## Introduction

Bot WhatsApp bergaya agen PPOB: mitra terdaftar bisa bertransaksi, mendaftarkan downline, mengatur markup, dan mencairkan komisi — semuanya lewat chat tanpa prefix command.

Tahap **ini (full inti)**: lapisan data (SQLite), seed admin/root, gerbang autentikasi mitra, dan seluruh command pengelolaan akun & jaringan. **Transaksi pembelian nyata dan tiket deposit belum** — command-nya tetap ada tapi hanya stub/placeholder.

Konteks bisnis inti:

- Admin = owner tunggal (env `OWNERS`), dapat stok dari supplier, untung langsung dari markup. **Tidak** ikut sistem komisi.
- Mitra/reseller = semua baris `agen` non-root. Boleh punya downline tanpa batas, dan downline boleh punya downline lagi (rekursif).
- **Markup beranak**: markup tiap mitra relatif terhadap uplink-nya. Harga efektif = harga modal + jumlah seluruh markup di jalur root→mitra.
- Komisi tiap transaksi downline dibagikan naik: setiap leluhur menerima markup miliknya sendiri.
- `TUKAR` memindahkan saldo komisi ke saldo utama.
- Nomor tidak terdaftar → `"Anda bukan mitra kami"`, tanpa memproses perintah apa pun.

## Goals

- Skema DB SQLite yang mendukung pohon mitra kedalaman tak terbatas
- Satu sumber kebenaran untuk mitra + nomor paralel
- Harga efektif & distribusi komisi dihitung dari satu query rekursif, tidak diduplikasi di kode
- Gerbang auth berjalan sebelum dispatch command
- Semua command FORMAT1–4 (kecuali transaksi/deposit nyata) berfungsi
- PIN tersimpan sebagai hash, tidak pernah plaintext
- Admin/root ter-seed otomatis sekali, idempoten

## User Stories

### US-001: Skema database
**Description:** Sebagai developer, saya perlu skema SQLite agar data mitra, produk, dan mutasi persist.

**Acceptance Criteria:**
- [ ] Tabel `agen`, `agen_nomor`, `produk`, `transaksi`, `mutasi` dibuat saat start (idempoten, `IF NOT EXISTS`)
- [ ] `agen.kode` UNIQUE, `agen.nohp` UNIQUE, `agen_nomor.nohp` UNIQUE
- [ ] `agen.senior_id` FK ke `agen.id`, NULL untuk root
- [ ] Indeks pada `agen.senior_id` dan `agen_nomor.nohp`
- [ ] File DB di `.data/ppob.sqlite` (dibuat otomatis, masuk `.gitignore`)
- [ ] `node --check` semua file lolos

### US-002: Seed admin/root
**Description:** Sebagai operator, saya ingin root otomatis dibuat dari env agar `DAFTAR` bisa dipakai tanpa setup manual.

**Acceptance Criteria:**
- [ ] Saat start, setiap nomor di `OWNERS` dipastikan punya baris `agen` dengan `senior_id = NULL`
- [ ] Kode dibuat `OWN01`, `OWN02`, … (2 digit, `padStart`)
- [ ] Menjalankan ulang tidak membuat duplikat (idempoten)
- [ ] Root tidak dapat komisi dari distribusi markup
- [ ] `node --check` lolos

### US-003: Gerbang auth mitra
**Description:** Sebagai sistem, saya harus menolak nomor asing agar bot tidak dipakai publik.

**Acceptance Criteria:**
- [ ] Nomor pengirim dicari di `agen.nohp` lalu `agen_nomor.nohp` (normalisasi digit)
- [ ] Tidak ditemukan → balas tepat `"Anda bukan mitra kami"` dan berhenti (tidak memproses command)
- [ ] Nomor paralel dianggap mitra yang sama (`agen_id` sama)
- [ ] Mitra `aktif = 0` dikenali tapi perintah transaksi ditolak dengan pesan jelas
- [ ] Nomor admin (`OWNERS`) selalu lolos
- [ ] `node test/utils.test.js` lolos (tambah kasus normalisasi nomor)

### US-004: SAL (cek saldo)
**Description:** Sebagai mitra, saya ingin melihat ringkasan saldo setelah menyapa bot.

**Acceptance Criteria:**
- [ ] Format balasan persis:
  ```
  Yth. Mitra <nama> ID: <kode>
  Saldo: <saldo> Limit: <limit>
  Dalam proses: <jumlah trx proses> Terpakai hari ini: <total hari ini> Komisi: <komisi>
  Ketik TUKAR utk ambil komisi
  ```
- [ ] `Dalam proses` = COUNT transaksi status `proses` milik mitra
- [ ] `Terpakai hari ini` = SUM nominal transaksi sukses/proses hari ini (tanggal lokal)
- [ ] Angka diformat ribuan (`10.700`)
- [ ] `node --check` lolos

### US-005: CH.KODE (cek harga)
**Description:** Sebagai mitra, saya ingin tahu harga produk setelah markup rantai.

**Acceptance Criteria:**
- [ ] `CH.<kode>` mengembalikan nama produk + harga efektif
- [ ] Harga efektif = `produk.harga_modal` + Σ `markup` seluruh node di jalur root→mitra
- [ ] Produk tidak ada / nonaktif → pesan `Produk tidak ditemukan`
- [ ] Perhitungan memakai satu query `WITH RECURSIVE` (tidak loop di JS)
- [ ] Self-check: rantai 3 level (markup 1000 + 500) menghasilkan modal+1500
- [ ] `node --check` lolos

### US-006: DAFTAR (tambah downline)
**Description:** Sebagai mitra, saya ingin mendaftarkan downline baru.

**Acceptance Criteria:**
- [ ] Format `DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN` diterima (pemisah `.`, juga toleran spasi)
- [ ] PIN penambah diverifikasi terhadap hash; salah → `PIN salah`
- [ ] Kode otomatis `RS` + 5 digit berurutan (`RS00001`)
- [ ] `senior_id` = id penambah; `saldo`/`komisi` mulai 0
- [ ] Nomor sudah terdaftar → ditolak dengan pesan jelas
- [ ] Balasan berisi kode & nama mitra baru
- [ ] `node --check` lolos

### US-007: LDL (list downline langsung)
**Description:** Sebagai mitra, saya ingin melihat downline langsung saya.

**Acceptance Criteria:**
- [ ] Menampilkan hanya `senior_id = id_mitra` (bukan seluruh keturunan)
- [ ] Tiap baris: kode, nama, kota, markup, status aktif
- [ ] Kosong → `Belum ada downline`
- [ ] `node --check` lolos

### US-008: MP (ubah markup downline)
**Description:** Sebagai mitra, saya ingin mengatur markup downline saya.

**Acceptance Criteria:**
- [ ] Format `MP.<KODE>.<MARKUP>.<PIN>`
- [ ] Hanya boleh mengubah downline **langsung** miliknya; selain itu `Bukan downline Anda`
- [ ] PIN hash diverifikasi
- [ ] Markup harus bilangan bulat ≥ 0
- [ ] Perubahan langsung memengaruhi harga efektif anak tersebut (dibuktikan lewat test `CH`)
- [ ] `node --check` lolos

### US-009: NA / AKTIF / HAPUS
**Description:** Sebagai mitra, saya ingin menonaktifkan, mengaktifkan, atau menghapus downline langsung.

**Acceptance Criteria:**
- [ ] `NA.<KODE>.<PIN>` → `aktif = 0`
- [ ] `AKTIF.<KODE>.<PIN>` → `aktif = 1`
- [ ] `HAPUS.<KODE>.<PIN>` → ditolak jika downline masih punya downline sendiri
- [ ] Semua hanya untuk downline langsung, PIN diverifikasi
- [ ] `node --check` lolos

### US-010: TUKAR (cairkan komisi)
**Description:** Sebagai mitra, saya ingin memindahkan komisi ke saldo.

**Acceptance Criteria:**
- [ ] `TUKAR` memindahkan seluruh `komisi` → `saldo`, lalu `komisi = 0`
- [ ] Dicatat 2 baris `mutasi`: `komisi_masuk` (negatif) dan `kredit` (positif), dengan `saldo_akhir`
- [ ] Komisi 0 → `Komisi Anda 0`
- [ ] Operasi dalam satu transaksi DB (atomic)
- [ ] `node --check` lolos

### US-011: CS.PESAN
**Description:** Sebagai mitra, saya ingin menghubungi admin.

**Acceptance Criteria:**
- [ ] `CS.<pesan>` diteruskan ke nomor admin (`OWNERS`) lewat WhatsApp, berisi kode + nama mitra + isi pesan
- [ ] Ke mitra dibalas persis:
  ```
  Pesan Anda telah kami teruskan ke Admin/CS.

  ID: <kode>
  Pesan: "<pesan>"

  Mohon tunggu tanggapan dari tim kami.
  ```
- [ ] Pesan kosong → panduan singkat pemakaian
- [ ] `node --check` lolos

### US-012: GP / UN (ganti PIN & nama)
**Description:** Sebagai mitra, saya ingin mengubah PIN dan nama tampilan.

**Acceptance Criteria:**
- [ ] `GP.<PINBARU>.<PINLAMA>` sukses hanya jika PIN lama cocok
- [ ] PIN baru minimal 4 digit angka; selain itu ditolak
- [ ] `UN.<NAMA>.<PIN>` mengubah nama (PIN diverifikasi)
- [ ] PIN disimpan sebagai hash `scrypt` + salt acak, tidak pernah plaintext/log
- [ ] `node --check` lolos

### US-013: TNO / HNO / LNO (nomor paralel)
**Description:** Sebagai mitra, saya ingin menambah nomor WhatsApp lain ke akun yang sama.

**Acceptance Criteria:**
- [ ] `TNO.<NOHP>.<PIN>` menambah baris `agen_nomor`
- [ ] `HNO.<NOHP>.<PIN>` menghapus nomor paralel (nomor utama tidak bisa dihapus)
- [ ] `LNO` menampilkan nomor utama + semua nomor paralel
- [ ] Nomor sudah dipakai mitra lain → ditolak
- [ ] Nomor paralel lolos gerbang auth sebagai mitra yang sama
- [ ] `node --check` lolos

### US-014: Integrasi menu
**Description:** Sebagai mitra, saya ingin menu yang sudah ada tetap konsisten.

**Acceptance Criteria:**
- [ ] `info`, `format1`–`format4` tetap membalas teks persis seperti sekarang
- [ ] Menu tampil tanpa prefix (`COMMAND_PREFIX=` kosong)
- [ ] Teks tak dikenal diabaikan (tidak balas "unknown command")
- [ ] `node --check` lolos

## Functional Requirements

- FR-1: Buka DB SQLite di `.data/ppob.sqlite`; jalankan DDL `IF NOT EXISTS` setiap start.
- FR-2: Tabel `agen(id, kode UNIQUE, nama, kota, nohp UNIQUE, senior_id NULL FK, markup DEFAULT 0, saldo DEFAULT 0, komisi DEFAULT 0, pin_hash, aktif DEFAULT 1, created_at)`.
- FR-3: Tabel `agen_nomor(id, agen_id FK, nohp UNIQUE)`.
- FR-4: Tabel `produk(id, kode UNIQUE, nama, harga_modal, kategori, aktif DEFAULT 1)`.
- FR-5: Tabel `transaksi(id, id_trx UNIQUE, agen_id FK, produk_id FK NULL, tujuan, harga_efektif, komisi_dibagikan TEXT, status, created_at)`.
- FR-6: Tabel `mutasi(id, agen_id FK, tipe, nominal, saldo_akhir, keterangan, created_at)`; `tipe` ∈ `debit|kredit|komisi_masuk|tukar`.
- FR-7: Seed root dari `OWNERS`; kode `OWN` + 2 digit; idempoten.
- FR-8: Generator kode mitra `RS` + 5 digit, increment dari kode terbesar yang ada, retry bila UNIQUE bentrok.
- FR-9: Gerbang auth: normalisasi nomor (buang non-digit, buang `:device`), lookup `agen.nohp` → `agen_nomor.nohp`; gagal → `"Anda bukan mitra kami"` dan stop.
- FR-10: Nomor admin lolos gerbang dan ditandai `isAdmin`.
- FR-11: Mitra `aktif = 0` boleh memakai perintah non-transaksi (SAL, LDL), transaksi ditolak.
- FR-12: Harga efektif dihitung `WITH RECURSIVE` dari mitra naik ke root, menjumlah `markup` seluruh node.
- FR-13: Distribusi komisi saat transaksi sukses: setiap leluhur (kecuali root) menerima `markup` miliknya; root tidak menerima komisi.
- FR-14: Semua perintah sensitif memverifikasi PIN dengan `crypto.scrypt` + `timingSafeEqual`.
- FR-15: PIN minimal 4 digit; hash disimpan format `scrypt$<salt-hex>$<hash-hex>`.
- FR-16: Perintah pengelolaan downline hanya berlaku untuk `senior_id = id_pemanggil`, kecuali admin.
- FR-17: `HAPUS` menolak jika target masih punya downline.
- FR-18: `TUKAR` atomic: pindahkan `komisi` → `saldo` + 2 baris `mutasi`.
- FR-19: Parser perintah mendukung pemisah `.` dan spasi, case-insensitive.
- FR-20: Nomor & nominal diformat Indonesia (`10.700`) pada output.
- FR-21: `CS.PESAN` mengirim ke semua nomor `OWNERS`; kegagalan kirim dicatat log, tidak menjatuhkan bot.
- FR-22: Semua command memakai client yang sama; tidak ada query SQL di file command (pakai modul `src/db/`).
- FR-23: Command `BELI`, `TIKET`, `LAP`, `REK`, `CEK`, `BTL` didaftarkan sebagai stub balasan `Fitur belum tersedia`.
- FR-24: Log startup menampilkan prefix aktif dan jumlah mitra ter-seed.

## Non-Goals

- Tidak ada transaksi pembelian nyata / integrasi supplier
- Tidak ada tiket deposit dan approval admin
- Tidak ada perhitungan komisi otomatis sebelum transaksi nyata aktif
- Tidak ada dashboard/web admin
- Tidak ada role CS terpisah (admin saja)
- Tidak ada rate limiting / anti-spam
- Tidak ada migrasi dari data lama (DB baru)
- Tidak ada limit kredit (kolom `limit` dibuang)

## Design Considerations

- Semua balasan teks WhatsApp mendukung `*bold*`; pertahankan format menu yang sudah ada apa adanya
- Pesan error singkat, satu baris, bahasa Indonesia
- Nama perintah uppercase di menu, tapi parsing case-insensitive

## Technical Considerations

- Runtime Node 22.13+ (memakai `node:sqlite` bawaan — tanpa dependency baru)
- DB aplikasi terpisah dari store zapo (`.auth/state.sqlite`)
- `src/db/schema.js` (DDL), `src/db/agen.js` (CRUD + query rekursif), `src/db/mutasi.js`
- `src/auth.js` (gate + PIN hash/verify), `src/money.js` (format & parse rupiah)
- Perintah tetap di registry `src/commands/`, tanpa SQL langsung
- Semua operasi multi-tabel dibungkus transaksi

## Success Metrics

- Nomor asing tidak pernah dapat respons selain `"Anda bukan mitra kami"`
- `CH` untuk rantai 3 level bernilai tepat `modal + Σ markup`, dibuktikan self-check
- `TUKAR` tidak pernah membuat saldo hilang/duplikat (atomic, diuji 2x berturut)
- Tambah perintah baru tetap satu file, tanpa sentuh core
- Startup idempoten: restart berulang tidak menggandakan root

## Open Questions

- Produk seed: pakai contoh (PULSA10/PLN20) atau kosong sampai admin isi?
- Bolehkah mitra mengubah markup **dirinya sendiri** (via admin), atau hanya downline?
- Format `CEK.TUJUAN` — cari transaksi terakhir berdasarkan nomor tujuan; perlu batas jumlah baris?
- Apakah `SAL` perlu tampil otomatis saat mitra pertama kali chat (tanpa perintah)?
