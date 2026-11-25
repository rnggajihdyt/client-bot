# bot_client

Bot PPOB WhatsApp multi-session production-ready, dibangun di atas [`zapo-js`](https://zapo.to). Satu proses Node memegang banyak nomor WhatsApp: satu **bot pusat** (owner/super admin) dan banyak **bot admin** (satu per toko/session). Semua state di SQLite — kredensial WhatsApp, agen, produk, transaksi — sehingga restart tidak pernah meminta pairing ulang.

**Arsitektur singkat**

```
                    ┌────────────────────────── satu proses Node ──────────────────────────┐
                    │                                                                      │
  Nomor pusat  ◄────┤  WaClient "pusat"   ── DB .data/sessions/pusat.sqlite                 │
  (OWNERS)          │        ▲                                                             │
                    │        │  SESIBUAT / SESION / SESIHAPUS / LAPTRX / STATUS / RESTART   │
  Nomor toko A ◄────┤  WaClient "tokoku"  ── DB .data/sessions/tokoku.sqlite  ── admin toko │
  Nomor toko B ◄────┤  WaClient "toko2"   ── DB .data/sessions/toko2.sqlite   ── admin      │
                    │                                                                      │
                    │  webhook server :8080  ◄── ICS callback (sukses/gagal + SN)           │
                    │  poller 60s          ─── jaring pengaman transaksi pending           │
                    └──────────────────────────────────────────────────────────────────────┘
```

- Multi-session: satu proses, banyak akun WA, DB terpisah per session.
- Penyimpanan SQLite (kredensial auth + state signal + data PPOB persisten).
- Pairing via QR (terminal) **atau** kode 8 karakter (dikirim ke chat owner).
- Reconnect otomatis dengan backoff eksponensial + watchdog anti-flap.
- Registry perintah + parser (`CMD.args`), menu PPOB verbatim.
- Logging Pino (pretty di console).
- Supervisor opsional: restart saat crash + cycle restart tiap N jam.

## Persyaratan

- Node.js **22.13+** (`node:sqlite` bawaan, tanpa native addon).

## Instalasi

```bash
npm install
```

## Konfigurasi (env / `.env`)

| Var | Default | Keterangan |
|---|---|---|
| `OWNERS` | *(kosong)* | Nomor HP (digit, tanpa `+`) dipisah koma = **super admin**. Wajib diisi. Contoh: `OWNERS=6285642927473` |
| `DEFAULT_SESSION` | `owner` | Id sesi bootstrap (bot pusat / owner) saat registry masih kosong |
| `SESSIONS` | `DEFAULT_SESSION` | Daftar id sesi bootstrap (dipakai hanya saat registry kosong) |
| `COMMAND_PREFIX` | *(kosong)* | Prefix perintah. Kosong = tanpa prefix (semua teks = perintah, gaya bot-menu) |
| `PAIRING_PHONE` | *(kosong)* | Nomor WA default kalau session tidak punya nomor sendiri (fallback kode pairing) |
| `PAIRING_MODE` | `both` | `qr` \| `code` \| `both` (runtime: kode pairing per session; QR hanya fallback bootstrap) |
| `STORE_PATH` | `.auth/state.sqlite` | File SQLite kredensial WhatsApp **semua** session |
| `SESSION_DIR` | `.data/sessions` | DB PPOB per session: `<SESSION_DIR>/<sessionId>.sqlite` + `_registry.sqlite` |
| `SETTINGS_PATH` | `.auth/settings.json` | Setelan runtime per session (mis. prefix) |
| `AUTOREAD` | `false` | `true` = tandai pesan masuk sudah dibaca (centang biru) setelah jeda baca singkat |
| `HUMAN_MODE` | `normal` | Perilaku natural: `normal` (<500ms total baca+ketik, idle offline 2-5m, warm-up 2-5s, jitter reconnect) \| `fast` \| `off` (otomatis `off` di test) |
| `UNKNOWN_SENDER_MODE` | `always` | Nomor asing non-mitra (chat pribadi): `always` (balas "Anda bukan mitra kami") \| `once` (1x/24 jam) \| `ignore` (diam) |
| `IGNORE_GROUPS` | `true` | `true` = abaikan pesan grup (`@g.us`) secara diam-diam |
| `OWNER_PIN` | `1234` | PIN awal admin yang di-seed `SESIBUAT` (segera ganti via `GP`) |
| `LOG_LEVEL` | `info` | Level Pino |
| `WEBHOOK_BASE_URL` | *(kosong)* | Base URL publik bot, mis. `https://bot.example.com` — menyusun URL webhook yang diberikan ke ICS |
| `WEBHOOK_PORT` | `8080` | Port lokal server webhook (`POST /webhook/<token>/<sessionId>`) |
| `ICS_BASE_URL` | `https://api.ics-store.my.id` | Base URL API supplier ICS |
| `ICS_API_KEY` | *(kosong)* | Fallback API key ICS kalau session belum punya key sendiri |
| `PRODUCT_CACHE_TTL_SEC` | `60` | Cache TTL (detik) status & harga produk ICS untuk `CH`/`BELI` (single-flight refresh saat basi) |
| `SYNC_INTERVAL_MIN` | `15` | Interval cron auto-sync katalog produk ICS (menit); `0` = matikan cron |
| `REPORT_PORT` | `8090` | Port web report (read-only dashboard per session) |
| `REPORT_HOST` | `127.0.0.1` | Bind host web report |
| `REPORT_TOKEN` | *(kosong)* | Token query `?token=...` untuk web report. Kosong = hanya localhost. Wajib di-set kalau dibuka dari luar |
| `REPORT_BASE_URL` | *(kosong)* | Base URL publik untuk link report per user, mis. `https://report.example.com`. Kosong = `http://localhost:REPORT_PORT` (link hanya jalan di mesin bot) |
| `OWNER_REPORT_SESSION` | `owner` | Id session owner untuk link owner `/<KODE>/report` (tampilan admin penuh). Default `owner` |
| `CYCLE_HOURS` | `10` | (supervisor) restart proses tiap N jam; `0` = tanpa cycle restart |
| `WATCH_CHANGES` | `true` | (supervisor) auto-restart child saat `index.js`, `src/**`, atau `.env` berubah tanpa mereset uptime |

## Menjalankan

```bash
npm start              # langsung
npm run dev            # dev: restart saat file berubah
npm run start:safe     # produksi: lewat supervisor (auto-restart + cycle)
npm test               # seluruh test
```

## Uptime / auto-restart

`supervisor.js` menjalankan `index.js` sebagai child process:

- **Restart saat crash** — child mati → start ulang. Backoff 1s → 2s → 4s … maks 60s, kembali ke 1s kalau run terakhir sehat > 5 menit.
- **Auto-restart saat file berubah** — memantau `index.js`, `src/**`, dan `.env` (debounced 500ms, mengabaikan `.auth/`, `.data/`, `logs/`, `*.sqlite*`). Child dimatikan rapi lewat IPC agar koneksi & handle SQLite tertutup bersih lalu langsung di-start ulang tanpa backoff (`WATCH_CHANGES=false` untuk mematikan).
- **Uptime kontinu** — proses supervisor tetap hidup terus dan meneruskan `SUPERVISOR_STARTED_AT` ke child, sehingga `Uptime proses` di perintah `STATUS` tetap berjalan terus-menerus walau `index.js` mengalami reload/restart.
- **Cycle restart** — child di-restart tiap `CYCLE_HOURS` jam (default 10) agar memori/koneksi tidak menumpuk. Kredensial tersimpan, jadi tidak pairing ulang.
- **Log supervisor** — `logs/supervisor.log` selain console.
- `SIGINT`/`SIGTERM` diteruskan ke child supaya `disconnect()` sempat jalan rapi.

Supaya tetap hidup setelah terminal/SSH ditutup, jalankan sebagai service:

```bash
# Linux (systemd)
sudo tee /etc/systemd/system/wa-bot.service >/dev/null <<'EOF'
[Unit]
Description=WA PPOB bot
After=network-online.target

[Service]
WorkingDirectory=/opt/bot_client
ExecStart=/usr/bin/node supervisor.js
Restart=always
RestartSec=5
User=bot

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now wa-bot
```

Windows (PowerShell, [nssm](https://nssm.cc)):

```powershell
nssm install WABot "C:\Program Files\nodejs\node.exe" "supervisor.js"
nssm set WABot AppDirectory D:\code\bot_client
nssm start WABot
```

Di dalam proses juga ada pengaman tambahan:

- **Reconnect policy** — reconnect tanpa batas untuk sebab transien (`stream_error_*`, keepalive timeout, dsb.).
- **FATAL (tidak reconnect)** — `stream_error_replaced`, `stream_error_device_removed`, `stream_error_force_logout`, `failure_not_authorized`, `failure_banned`, `failure_locked`, `failure_bad_user_agent`, `primary_identity_key_change`. `stream_error_force_login` (515) **bukan** fatal.
- **Watchdog** — client yang tidak pernah stabil 3 menit sejak start di-rebuild dari nol; flap yang cepat tetap terakumulasi dan kena rebuild.

## Menyiapkan sesi dari nol

### 1) Bot pusat (owner) — pairing QR

Sesi pusat adalah sesi pertama dan tidak bisa dibuat lewat `SESIBUAT` (perintah itu butuh bot yang sudah hidup untuk menerima perintah). Bootstrap-nya lewat env:

1. Kosongkan data lama (hanya saat memulai benar-benar bersih):
   ```powershell
   Remove-Item -Recurse -Force .data\sessions      # DB PPOB + registry
   Remove-Item -Force .auth\state.sqlite*          # kredensial WA semua nomor
   ```
2. `.env`:
   ```
   OWNERS=6285642927473
   DEFAULT_SESSION=pusat
   ```
3. `npm run start:safe` → **QR muncul di terminal** → scan dari WhatsApp pusat: *Perangkat tertaut → Tautkan perangkat*.
4. Saat `auth_paired`, sesi otomatis terdaftar di registry sebagai sesi **owner** (label `Owner (QR)`, nomor WA bot tercatat dari `meJid`, tanpa admin toko) → start berikutnya resume kredensial, tanpa scan ulang.

Selama dipakai sebagai bot utama, sesi pusat tidak punya admin sendiri: perintah uang (`SAL`, `BELI`, …) dijawab menu/gate. Perintah owner (`STATUS`, `SESI`, `SESIBUAT`, `RESTART`, …) tetap jalan tanpa perlu baris agen di DB sesi.

### 2) Bot admin (per toko) — pairing kode

Dari nomor owner, chat **bot pusat**:

```
SESIBUAT.tokoku.628895560325.62856429274736[Toko Rangga]
```

- Format: `SESIBUAT.ID.NOMORADMIN.NOMORBOT[LABEL]`
- `ID` — huruf/angka/-/`_`, jadi nama DB + nama sesi.
- `NOMORADMIN` — WA admin toko; **wajib** dan **tidak boleh sama** dengan nomor bot. Prompt APIKEY & pesan onboarding dikirim ke nomor ini.
- `NOMORBOT` — WA yang akan dipairing sebagai bot toko; **wajib**, beda dari admin.
- Runtime langsung connect dan minta **kode 8 karakter**, dikirim balik ke chat owner:

  ```
  *Pairing tokoku*
  Nomor: 62856429274736
  Kode: ABCD-EFGH

  Buka WhatsApp di nomor itu → Perangkat tertaut → Tautkan dengan nomor telepon, lalu masukkan kode.
  ```

- Masukkan kode di WhatsApp nomor bot (kedaluwarsa ± beberapa menit; kalau mati, `RESTART.tokoku` memicu kode baru).
- Sesudah tertaut: DB sesi di-seed admin (kode `OWN01`, PIN `OWNER_PIN`), onboarding APIKEY otomatis dikirim ke nomor admin (lihat di bawah).

### 3) Adopsi sesi bootstrap lewat `SESIBUAT`

Baris registry `Bootstrap (QR)` (admin & nomor bot kosong) **diadopsi**, bukan ditolak: `SESIBUAT.pusat.6285642927473.6281230999[Pusat]` mengisi admin + nomor bot tanpa menyentuh kredensial — sesi tetap hidup, tidak pairing ulang. Berguna untuk menaikkan sesi pusat jadi sesi yang punya admin.

### 4) Onboarding supplier (APIKEY ICS)

Begitu sesi pertama kali connect — sesi baru maupun resume — bot mengirim prompt ke **nomor admin**:

1. Selama belum ada key valid: setiap pesan admin dijawab prompt API key (tanpa batas waktu). Hanya `format`/`all`/`menu`/`help`/`CS` yang dilayani; perintah uang terkunci.
2. Admin kirim `APIKEY.<KEY>` (atau paste key hex 64 karakter langsung). Key **diuji dulu** ke `GET /api/reseller/products` — kalau ICS menolak, key tidak disimpan dan prompt diulang.
3. Key valid → tersimpan di DB sesi (`settings.ics_apikey`) + produk langsung tersinkron; bot mengirim **URL webhook** sesi.
4. Salin URL itu ke dashboard ICS → Webhook. Katalog produk selanjutnya otomatis tersinkron lewat cache TTL (`CH`/`BELI`) dan cron berkala (`SYNC_INTERVAL_MIN`).

> `WEBHOOK_BASE_URL` wajib bisa diakses publik oleh ICS (port → `WEBHOOK_PORT`). Token webhook acak 24 byte per sesi, stabil, disimpan di DB sesi.

## Perintah

Semua perintah case-insensitive, argumen dipisah `.` atau spasi. Tanpa `COMMAND_PREFIX`, teks apa pun dianggap perintah; teks tak dikenal diabaikan untuk mitra, dan dibalas menu super admin untuk owner.

### Mitra & uplink

| Perintah | Format | Keterangan |
|---|---|---|
| `SAL` | `SAL` | Saldo, komisi, dalam proses, terpakai hari ini |
| `CH` | `CH.KODE` / `CH.PREFIX.HAL` | Harga produk tunggal atau daftar harga per prefix kode/kategori dengan paginasi (contoh: `CH.XDA.1`) |
| `BELI` / langsung | `KODE.TUJUAN[.PIN]` / `TUJUAN.KODE` / multi baris / `BELI.KODE.TUJUAN[.PIN]` | Order ke ICS (bisa tanpa `BELI`, tanpa PIN, bolak-balik, multi baris/nomor); saldo ditahan, status `proses` sampai webhook/cron |
| `CEK` | `CEK` / `CEK.TUJUAN` | Daftar pending sendiri / detail transaksi paling terakhir untuk nomor tujuan tsb (juga dukung `CEK.IDTRX`) |
| `REK` | `REK` | 15 mutasi saldo & komisi terakhir |
| `TUKAR` | `TUKAR` | Pindahkan komisi ke saldo |
| `TIKET` | `TIKET.NOMINAL.PIN` / `TIKET.IDDEPOSIT` | Buat tiket deposit + kode unik 3 digit, ID pendek `D0001`. `TIKET` tanpa arg = tampilkan ulang tiket pending; `TIKET.D0001` = status tiket itu (pending/sukses/batal) |
| `BTL` | `BTL.IDDEPOSIT.PIN` | Batalkan tiket deposit sendiri yang masih `pending` |
| `DAFTAR` | `DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN` | Tambah downline (senior = pengirim) |
| `LDL` | `LDL` | Daftar downline langsung |
| `MP` | `MP.KODE.MARKUP.PIN` | Ubah markup downline |
| `NA` / `AKTIF` / `HAPUS` | `NA.KODE.PIN` dst | Nonaktifkan / aktifkan / hapus downline |
| `GPN` | `GPN.KODE.PINBARU.PIN` | Reset PIN downline (mitra lupa PIN) — PIN baru dikirim ke WA downline |
| `TNO` / `HNO` / `LNO` | `TNO.NOHP.PIN` dst | Kelola nomor paralel (beberapa WA satu akun) |
| `GP` | `GP.PINBARU.PINLAMA` | Ganti PIN |
| `UN` | `UN.NAMA.PIN` | Ubah nama |
| `CS` | `CS.PESAN` / `CS.<IDDEPOSIT>` | Teruskan pesan ke admin session (bisa dengan gambar). Pesan apa pun yang memuat ID tiket (`D0001`) dianggap konfirmasi transfer: admin dapat status tiket + bukti gambar |
| `LAP` | `LAP[HARI\|MINGGU\|BULAN\|YYYY-MM-DD\|DD\|DD-MM-YYYY\|YYYY-MM\|MM-YYYY]` | Admin: seluruh session. Uplink: jaringannya. Mitra: dirinya. `LAP.22` = tgl 22 bulan ini, `LAP.2026-03` = Maret penuh |

### Admin session

| Perintah | Format | Keterangan |
|---|---|---|
| `APIKEY` | `APIKEY.KEY` | Simpan API key ICS (validasi dulu), balas URL webhook |
| `TSAL` | `TSAL.NOHP.NOMINAL.PIN` | Tambah saldo mitra berdasarkan nomor HP (termasuk nomor paralel) + catat mutasi & kirim notifikasi |
| `KSAL` | `KSAL.NOHP.NOMINAL.PIN` | Kurangi saldo mitra berdasarkan nomor HP (cek saldo cukup, tidak boleh minus) + catat mutasi & kirim notifikasi |
| `LPRDK` | `LPRDK` | Daftar produk + modal + markup + status supplier |
| `MKP` | `MKP.NOMINAL` / `MKP.KODE.NOMINAL` | Markup general (fallback) / per produk (menimpa general) |
| `TPAY` | `TPAY.BANK.NO.A/N` | Tambah/ubah rekening deposit (banyak bank = baris berbeda di tiket) |
| `HPAY` | `HPAY.BANK` | Hapus rekening deposit |
| `TDEP` | `TDEP.IDDEPOSIT.PIN` | Konfirmasi tiket deposit lunas → saldo mitra bertambah + notifikasi |
| `TLIST` | `TLIST` | Daftar semua tiket deposit pending (kode, mitra, nominal, kode unik, rekening, waktu) untuk dicocokkan dengan mutasi |

### Super admin (OWNERS)

| Perintah | Format | Fungsi |
|---|---|---|
| `SESI` | `SESI` | Daftar session terdaftar + nomor WA + status |
| `SESIBUAT` | `SESIBUAT.ID.NOMORADMIN.NOMORWA[LABEL]` | Daftarkan session, seed admin, **langsung connect + minta kode pairing**; mengadopsi baris bootstrap |
| `SESION` / `SESIOFF` | `SESION.ID` | Nyala/matikan session (connect/disconnect tanpa restart proses). Sesi utama (owner) tidak boleh dinonaktifkan |
| `SESIHAPUS` | `SESIHAPUS.ID` | **Permanen**: stop + hapus baris registry + DB sesi + kredensial WA. Sesi utama (owner) dilindungi dan tidak boleh dihapus |
| `LAPTRX` | `LAPTRX.ID[HARI\|BULAN\|YYYY-MM-DD]` | Transaksi session mana pun |
| `STATUS` | `STATUS` | Uptime proses & OS, RSS/heap, RAM sistem, versi Node |
| `SESSIONS` | `SESSIONS` | Daftar session + status live (🟢 live / 🟡 on / ⚪ off) |
| `RESTART` | `RESTART.ID` | Connect ulang session; kode pairing baru dikirim kalau perlu |
| `ENV` | `ENV` | Ringkasan config aktif (nilai sensitif dimasking) |
| `CMD` | `CMD` | Semua perintah terdaftar |

Perintah owner bekerja dari **semua** sesi yang hidup — tidak butuh baris agen di DB sesi tersebut.

### Menu

`format` / `all` menambahkan section sesuai peran: **KHUSUS ADMIN** untuk admin session, **KHUSUS SUPER ADMIN** untuk `OWNERS`, **TRANSAKSI** (`CEK`, `REK`, `BTL`) untuk mitra. `format1`–`format4` selalu verbatim. `PRDK` & `SYNC` dihapus — katalog otomatis sinkron dari ICS (cron + cache TTL).

## Alur transaksi (supplier ICS, async dua fase)

```
mitra: BELI.PULSA10.0812xxxx
  │
  ├─ 1. Saldo dipotong, trx disimpan status='proses',
  │     snapshot komisi tiap uplink disimpan di komisi_dibagikan
  ├─ 2. POST {ICS_BASE_URL}/api/reseller/trx  (product_code, dest_number, ref_id_custom = idTrx)
  │     ditolak langsung → status 'gagal', refund penuh, mitra diberi tahu
  │
  ├─ 3a. Webhook ICS → POST {WEBHOOK_BASE_URL}/webhook/<token>/<sessionId>
  │      { refid, status, kode_produk, nomor_tujuan, supplier_trxid, note }
  └─ 3b. Cron 60 dtk: pending > 60 dtk dicek GET /api/reseller/trx/:refid  (jaring pengaman)
         │
         ├─ success → status 'sukses', SN disimpan, komisi dibayar, mitra dinotifikasi
         └─ failed  → status 'gagal', harga_efektif direfund penuh
```

- Penyelesaian **selalu** lewat `src/orders.js:finalize()` — idempoten: `sukses` kedua diabaikan, baris terminal (`sukses`/`gagal`/`batal`) mengabaikan webhook telat.
- **Deposit via tiket** (`src/commands/deposit.js`): mitra `TIKET.NOMINAL.PIN` → tiket dengan **ID pendek `D0001`** dan **kode unik 3 digit** (total transfer = nominal + kode unik, pembeda antar transfer). Rekening tujuan diatur admin via `TPAY.BANK.NO.A/N` (tambah, bisa banyak bank) dan dihapus via `HPAY.BANK`. Mitra membatalkan dengan `BTL.IDDEPOSIT.PIN`; admin mengonfirmasi lunas dengan `TDEP.IDDEPOSIT.PIN` → saldo bertambah, mutasi tercatat, notifikasi ke mitra. Satu tiket pending per mitra. Tiket menyertakan instruksi konfirmasi — mitra kirim pesan `CS` yang memuat ID tiket (mis. `CS D0001 sudah transfer`, boleh disertai gambar bukti), bot meneruskan ke admin beserta status tiket dan gambar buktinya.
- **Tidak ada pembatalan order**: order yang sudah `proses` hanya berakhir lewat webhook/poller (`sukses`/`gagal`). `BTL` hanya untuk tiket deposit, bukan order.
- **Anti order ganda per tujuan**: selama masih ada transaksi `proses` ke nomor tujuan yang sama (dinormalisasi `08…`/`628…`), order berikutnya ditolak lokal (`GAGAL. Tujuan masih diproses (ID)`) — tidak ada potong saldo, tidak ada POST ke supplier. Ini menahan retry transport WhatsApp maupun tap ganda. Tujuan lain tetap jalan.
- Komisi dibayar **hanya** saat `sukses`, sesuai snapshot saat order (markup diubah belakangan tidak memengaruhi trx lama). Admin **tidak memakai sistem komisi**: seluruh margin admin (`MKP` general/per-produk + markup yang dipasang admin pada reseller langsungnya) langsung masuk ke **Profit Admin** (`markup_admin`), sedangkan tiap markup pada level di bawahnya masuk sebagai **komisi** uplink masing-masing tanpa batas kedalaman (`Omzet = Modal + Profit Admin + Komisi Jaringan`).
- Harga efektif mitra = `produk.harga_modal` (harga ICS) + markup admin (`MKP` per produk jika ada, else general) + total markup sepanjang jalur uplink→mitra (`WITH RECURSIVE`).
- Buyer dinotifikasi via nomor tersimpan di `agen`; client offline hanya di-log — state tetap benar, `SAL`/`CEK` menunjukkan kebenarannya.
- **Format balasan seragam**: Respon transaksi (awal, batch, maupun webhook/poller) mengikuti format standar:
  `<Nama Produk> <KODE>.<TUJUAN> <STATUS>. <Keterangan/SN> Sal <saldo> @HH:MM`
  *(contoh: `XL AXIS Data 38Gb Reguler + Lokal XDA38.085731409131 GAGAL. Nomor tujuan salah. Sal 1.911.411 @14:19`)*
- **Sanitasi error supplier**: Pesan error teknis supplier (seperti kata "ICS" atau saldo operasional supplier habis) otomatis disanitasi menjadi pesan netral yang ramah untuk downline/uplink. Bila saldo supplier habis, sistem otomatis mengirimkan peringatan darurat ke nomor WhatsApp admin toko.

## Peran & data

| Peran | Siapa | Hak |
|---|---|---|
| **Super admin** | nomor di `OWNERS` | Kelola session, lihat transaksi semua session, status server. Tidak butuh jadi mitra. |
| **Admin session** | root di DB sesi (`senior_id IS NULL`), didaftarkan via `SESIBUAT` | Markup (general + per produk), produk, downline, `LAP` seluruh session-nya, menerima `CS` |
| **Uplink** | anak langsung admin | Transaksi + `LAP` jaringannya sendiri |
| **Mitra** | downline | Transaksi, kelola downline-nya sendiri |

- **DB terpisah per session** (`.data/sessions/<id>.sqlite`): tabel `agen`, `agen_nomor`, `produk`, `transaksi`, `mutasi`, `deposit`, `settings`. Tidak ada data yang bocor antar admin.
- **Registry** `.data/sessions/_registry.sqlite`: id, label, admin, nomor WA, status. Semua sesi di registry otomatis di-connect saat start.
- **Kredensial WA** `.auth/state.sqlite` satu file untuk semua session, dipisah per `sessionId`.
- Nomor paralel (`TNO`) membuat beberapa JID diakui sebagai mitra yang sama.
- Mitra nonaktif hanya bisa `SAL`/`format`/`all`/`menu`/`help` sampai diaktifkan ulang uplink.

## Penyesuaian

### Custom prefix saat runtime

```
!setprefix #
```

- Hanya `OWNERS` yang bisa; persist ke `SETTINGS_PATH`, bertahan restart; maks 3 karakter tanpa spasi.
- `COMMAND_PREFIX` kosong = tanpa prefix (default).

### Menambah perintah

Buat file di `src/commands/`, misal `src/commands/mycmd.js`:

```js
import { register } from './registry.js'

register({
  name: 'mycmd',
  description: 'What it does',
  async handler({ client, event, args }) {
    await client.message.send(event.key.remoteJid, `You said: ${args.join(' ')}`)
  },
})
```

Lalu import di `index.js`:

```js
import './src/commands/mycmd.js'
```

Selesai — tanpa mengubah core. Handler menerima `{ client, event, args, log, sessionId, mitra, isAdmin, isSuper, deactivated, db, prefix, owners }`.

### Helpers

- `src/helpers.js` — `sendButtons(client, jid, { text, footer, buttons })`, `sendMedia(client, jid, { type, media, mimetype, caption })`
- `src/utils.js` — `extractText`, `parseCommand`, `senderNumbers`, `normalizeNohp`, `markRead`

> Catatan: media tanpa processor ter-upload tapi bisa tanpa preview/dimensi. Pasang `@zapo-js/media-utils` + `ffmpeg` bila perlu media proper.

## Alat bantu (scripts)

| Script | Fungsi |
|---|---|
| `node scripts/inspect-store.mjs` | Lihat session id mana saja yang punya kredensial di `.auth/state.sqlite` |
| `node scripts/wipe-session-store.mjs <id>` | Hapus kredensial WA satu session (bot harus stop; file store terkunci) |
| `node scripts/fix-nohp.mjs` | Perbaikan satu kali nomor HP lama di DB |

## Web report

Dashboard read-only per session (sama seperti `LAP`, tapi lengkap): KPI omzet/profit/modal/komisi/deposit, grafik omzet harian, produk terlaris, uplink & komisi jaringan, tabel agen (saldo & performa), transaksi (filter status + pencarian + paging), deposit, dan mutasi.

**Siapa lihat apa** (scope = viewer + semua downline, kedalaman berapa pun):

- **Owner / super admin**: daftar semua sesi toko (sesi owner sendiri tidak muncul karena tidak punya agen). Pilih sesi → default viewer = admin root sesi itu; bisa ganti "Lihat sebagai" ke agen mana pun di sesi tersebut.
- **Admin toko** (agen root sesi): seluruh jaringan di bawahnya — omzet, profit, modal, komisi jaringan, uplink, tabel agen, transaksi/deposit/mutasi semua agen.
- **Mitra / downline (level mana pun, termasuk yang punya downline sendiri)**: **hanya dirinya sendiri**. Omzet & jumlah transaksi miliknya, deposit & mutasi saldonya, tanpa profit admin, modal, komisi jaringan, maupun uplink. Ini ditegakkan di server (bukan cuma disembunyikan di UI): angka profit/modal/komisi di-nol-kan dan daftar transaksi di-scope ke dirinya.

Parameter: `session`, `viewer` (kode agen), `from`, `to`, `token`.

**Link per user** (`SAL`/`LAP` menyertakan URL): `<REPORT_BASE_URL>/<KODE>/report` — kode 8 karakter, hash stabil dari kombinasi session + kode agen, jadi tidak ada `?session=`/`?viewer=` yang bisa melebarkan scope. Kode itu sendiri adalah kredensial: siapa pun yang pegang link melihat jaringan agen itu saja. Set `REPORT_BASE_URL` agar link bisa dibuka dari HP (mis. lewat tunnel/nginx yang meneruskan ke `REPORT_PORT`).

**Link owner** (`WEBREPORT` dari nomor owner mengirim URL ini): `<REPORT_BASE_URL>/<KODE>/report` dengan kode dari `reportCode(OWNER_REPORT_SESSION ?? 'owner', '')`. Dashboard-nya menampilkan sidebar berisi semua session toko (session `owner` tidak pernah muncul) dan membuka session terpilih dalam tampilan admin penuh — sama seperti admin toko itu melihat laporannya. Cukup set `REPORT_BASE_URL`; session `owner` dipakai otomatis (override lewat `OWNER_REPORT_SESSION`).

**Jalan dengan PM2**: `pm2 start ecosystem.config.json` (isi `.env` dibaca lewat `--env-file-if-exists=.env`). Lihat `pm2 logs bot-client`, `pm2 restart bot-client`, dan `pm2 save && pm2 startup` agar hidup lagi setelah reboot.

- Buka `http://127.0.0.1:8090` (default). `REPORT_PORT`/`REPORT_HOST` untuk ubah.
- Akses dari luar: set `REPORT_TOKEN`, lalu buka `http://host:8090/?token=<token>` (+ `&session=...&viewer=...` untuk scope tertentu).
- Owner: ketik `WEBREPORT` dari nomor owner → balasan berisi link `/<KODE>/report`. Link itu membuka dashboard dengan sidebar berisi **semua session toko** (session `owner` tidak pernah muncul); memilih satu session menampilkan laporannya persis seperti admin toko itu melihatnya. Butuh `REPORT_BASE_URL`.
- Multi owner: isi `OWNERS=628111,628222` — setiap nomor dapat **link sendiri** dari `WEBREPORT` (slot = nomornya). Mencabut satu owner cukup dengan menghapus nomornya dari `OWNERS`: link owner itu langsung mati, link owner lain tetap jalan.
- DB dibuka **read-only** — report tidak pernah mengubah/memigrasi data bot, aman jalan berdampingan dengan bot.
- API JSON: `/api/sessions`, `/api/viewers?session=`, `/api/report`, `/api/transaksi`, `/api/deposit`, `/api/mutasi` (semua terima `session`, `viewer`, `from`, `to`).
- UI: `web/report.html` (tanpa build step, tanpa dependency tambahan).

## Struktur

```
index.js                    entry: registry-only startup, webhook server, poller, graceful shutdown
supervisor.js               auto-restart + cycle restart + continuous uptime (npm run start:safe)
src/config.js               env config
src/store.js                store zapo bersama (SQLite) untuk semua session
src/registry.js             daftar session (id, admin, nomor WA, status) — _registry.sqlite
src/runtime.js              start/stop/rebuild session, pairing kode & QR, reconnect, watchdog
src/human.js                layer perilaku human-like (<500ms delay, typing, presence, jitter)
src/db.js                   per-session SQLite (agen/produk/transaksi/mutasi/settings) + openDb()
src/handler.js              pesan → auth gate → dispatch + perintah super admin
src/apikey.js               gate onboarding: validasi + simpan apikey ICS, prompt ke admin
src/ics.js                  client API ICS (products / trx / status)
src/orders.js               finalize transaksi: sukses (komisi) / gagal (refund), idempoten
src/webhook.js              server webhook ICS + cron poller pending
src/reportweb.js            server web report read-only (API /api/*) + agregasi laporan
src/reportcode.js           kode 8 karakter + URL report per user (SAL/LAP)
web/report.html             UI dashboard report (tanpa build step)
src/commands/registry.js    command map
src/commands/demo.js        ping / menu / help
src/commands/ppob.js        menu format/format1-4 verbatim + section per peran
src/commands/ppob-core.js   SAL/CH/DAFTAR/LDL/MP/TUKAR/dll
src/commands/deposit.js      TIKET/TPAY/HPAY/TDEP/TLIST/BTL — tiket deposit + id pendek + kode unik + konfirmasi admin
src/commands/supplier.js    BELI/CEK/REK/APIKEY
src/catalog.js              cache TTL + single-flight refresh (CH/BELI) + cron auto-sync ICS
src/commands/owner.js       STATUS/SESSIONS/RESTART/ENV/CMD (owner only)
src/commands/prefix.js      setprefix (owner only)
src/report.js               parseRange (HARI/BULAN/tanggal) untuk LAP/LAPTRX
src/auth.js                 hash/verify PIN
src/money.js                format/parse rupiah
src/parse.js                parser perintah PPOB (prefixless)
src/settings.js             setelan runtime per session (prefix)
src/helpers.js              send helpers (buttons/media)
src/utils.js                text/parse/format helpers
test/catalog.test.js        cache TTL, single-flight refresh, auto-sync cron
test/human.test.js          human-like behavior, delay budget <500ms, typing/presence
test/integration.test.js    end-to-end handler: gate, markup, transaksi, peran, sesi
test/pairing-flow.test.js   state machine pairing (auth_qr/re-arm)
test/ppob.test.js           parser & harga efektif
test/runtime-reconnect.test.js  keputusan reconnect per close reason + watchdog
test/supervisor.test.js     supervisor file watcher & continuous uptime
test/utils.test.js          utilitas + self-check
test/webhook.test.js        webhook/token/finalize idempoten
```

## Pemecahan masalah

| Gejala | Sebab & langkah |
|---|---|
| Kode pairing tidak muncul ke chat owner | Sesi startup memang mencetak ke **log**, bukan chat (chat owner belum ada saat bootstrap). Cek log `Pairing <id> nomor ...` |
| Kode pairing salah/kedaluwarsa | `RESTART.ID` → kode baru. `auth_pairing_required` dengan `forceManual` otomatis minta ulang |
| Sesi terhapus masih membalas pesan | Kredensial lama nyangkut di store: `node scripts/wipe-session-store.mjs <id>` (bot stop dulu) |
| `session db remove failed` saat `SESIHAPUS` | File DB terkunci proses lain (Windows). Stop proses pemakai file, hapus manual |
| Sesi tidak hidup setelah restart | Cek `_registry.sqlite` (`node scripts/inspect-store.mjs` untuk kredensial). Startup hanya connect isi registry; env hanya dipakai saat registry kosong |
| Webhook ICS tidak sampai | `WEBHOOK_BASE_URL` harus publik; cek token & id di URL; cron poller tetap menyelesaikan pending ≤ 60 dtk kemudian |
| Bot admin = nomor admin sendiri | Ditolak sejak `SESIBUAT`. Sesi lama yang salah konfigurasi membalas peringatan salah konfigurasi di setiap pesan |
| `API key belum benar` berulang | Key memang ditolak ICS (uji nyata ke endpoint produk). Key salah tidak pernah tersimpan |

## Tests

```bash
npm test        # seluruh test (node:test)
```

75 test cases (9 suites) lulus 100%:
Cakupan: gate apikey & onboarding push, markup multi-level berjenjang tanpa batas kedalaman (profit admin vs komisi uplink), mutasi saldo TSAL/KSAL, transaksi async + refund + idempoten webhook/poller cron, format respon seragam, sanitasi error supplier, peran admin/uplink/mitra/super, SESIBUAT wajib NOMORWA & admin ≠ bot, adopsi sesi bootstrap, keputusan reconnect & watchdog, perilaku human-like (<500ms), cache katalog TTL & single-flight refresh, serta supervisor uptime kontinu.
