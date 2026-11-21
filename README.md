# bot_client

Production-ready WhatsApp bot base built on [`zapo-js`](https://zapo.to).

- Multi-session (one process, many accounts)
- SQLite storage (auth + signal state persisted across restarts)
- Pairing via QR **or** 8-character code (configurable)
- Auto-reconnect with exponential backoff
- Command registry + parser (`!cmd args`), demo commands
- Helpers: buttons, media send
- Pino logging

## Requirements

- Node.js 22.13+ (`node:sqlite` built-in, no native addon needed)

## Install

```bash
npm install
```

## Config (env)

| Var | Default | Description |
|---|---|---|
| `DEFAULT_SESSION` | `default` | Session id for the single-session mode |
| `SESSIONS` | `DEFAULT_SESSION` | Comma-separated session ids for multi-session |
| `COMMAND_PREFIX` | *(empty)* | Command prefix. Empty = no prefix (every text is a command, bot-menu style) |
| `OWNERS` | (empty) | Comma-separated phone numbers (digits) = **super admin**: kelola session + lihat transaksi semua session |
| `SETTINGS_PATH` | `.auth/settings.json` | Where per-session runtime settings live |
| `PAIRING_MODE` | `both` | `qr` \| `code` \| `both` (runtime: kode pairing per session, QR hanya fallback) |
| `PAIRING_PHONE` | (empty) | Nomor WA default kalau session tidak punya nomor sendiri |
| `LOG_LEVEL` | `info` | Pino level |
| `AUTOREAD` | `false` | `true` = mark incoming messages read (blue ticks) |
| `STORE_PATH` | `.auth/state.sqlite` | SQLite file location |
| `SESSION_DIR` | `.data/sessions` | Satu file DB PPOB per session: `<SESSION_DIR>/<sessionId>.sqlite` |
| `OWNER_PIN` | `1234` | PIN awal admin session yang di-seed oleh `SESIBUAT` |
| `CYCLE_HOURS` | `10` | (supervisor) restart otomatis tiap N jam; `0` = tanpa cycle restart |
| `WEBHOOK_BASE_URL` | (empty) | Base URL publik bot, mis. `https://bot.example.com` — dipakai menyusun URL webhook yang diberikan ke ICS |
| `WEBHOOK_PORT` | `8080` | Port lokal server webhook (`POST /webhook/<token>/<sessionId>`) |
| `ICS_BASE_URL` | `https://api.ics-store.my.id` | Base URL API supplier ICS |
| `ICS_API_KEY` | (empty) | Fallback API key ICS kalau admin session belum set `APIKEY.ICS_sk_xxx` |

## Run

```bash
npm start
```

For auto-restart on file changes (dev):

```bash
npm run dev
```

## Uptime / auto-restart

```bash
npm run start:safe
```

`supervisor.js` menjalankan `index.js` sebagai child process dan:

- **Restart saat crash** — child mati (exit non-zero) → start ulang. Backoff 1s → 2s → 4s … maksimum 60s, dan balik ke 1s kalau run terakhir sehat >5 menit.
- **Cycle restart** — child di-restart sendiri setiap `CYCLE_HOURS` jam (default 10) supaya proses tidak menumpuk memori koneksi. Kredensial tersimpan di `STORE_PATH`, jadi tidak pairing ulang.
- **Log supervisor** — `logs/supervisor.log` (rotasi manual / pakai logrotate), selain output console.
- `SIGINT`/`SIGTERM` diteruskan ke child supaya `disconnect()` sempat jalan.

Supaya hidup setelah terminal/SSH ditutup, jalankan sebagai service:

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

Windows (PowerShell, auto-start saat login):

```powershell
# jalankan sekali; service akan restart sendiri kalau proses mati
nssm install WABot "C:\Program Files\nodejs\node.exe" "supervisor.js"
nssm set WABot AppDirectory D:\code\bot_client
nssm start WABot
```

First run: the QR or pairing code prints to the terminal. Scan from **WhatsApp → Linked devices**. Subsequent runs reuse stored credentials — no re-pair.

> Sesi pusat pertama **tidak bisa** dibuat lewat `SESIBUAT` (nomor bot wajib diisi, jadi selalu pairing code). Cara bootstrap-nya: hapus registry + kredensial session itu, lalu set `DEFAULT_SESSION` ke id-nya dan jalankan bot — tanpa `pairing_phone` runtime menampilkan QR di terminal.

## Custom prefix at runtime

Default prefix comes from `COMMAND_PREFIX`. To change it per session at runtime, an owner sends:

```
!setprefix #
```

- `OWNERS` env must list the owner's phone number(s) without `@s.whatsapp.net` (e.g. `OWNERS=628123456,6287654321`)
- Prefix persisted to `SETTINGS_PATH` (`.auth/settings.json`), survives restart
- Max 3 chars, no whitespace. Empty/absent `OWNERS` → nobody can change it.

## PPOB core commands

Active (non-stub) commands:

| Command | Format | Keterangan |
|---|---|---|
| `SAL` | `SAL` | Cek saldo, komisi, dalam proses |
| `CH` | `CH.KODE` | Cek harga produk (modal + markup rantai) |
| `DAFTAR` | `DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN` | Tambah downline |
| `LDL` | `LDL` | List downline langsung |
| `MP` | `MP.KODE.MARKUP.PIN` | Ubah markup downline |
| `NA` / `AKTIF` / `HAPUS` | `NA.KODE.PIN` dst | Nonaktifkan / aktifkan / hapus downline |
| `TUKAR` | `TUKAR` | Pindahkan komisi ke saldo |
| `BELI` | `BELI.KODE.TUJUAN[.PIN]` | Kirim order ke supplier ICS (saldo ditahan dulu, status `proses`) |
| `CEK` | `CEK` / `CEK.IDTRX` | List transaksi pending / detail satu transaksi |
| `REK` | `REK` | 15 mutasi saldo & komisi terakhir |
| `BTL` | `BTL.IDTRX.PIN` | Batalkan transaksi yang masih `proses` + refund lokal |
| `LAP` | `LAP[HARI\|BULAN\|YYYY-MM-DD]` | Admin: seluruh session. Uplink: jaringan sendiri. Mitra: dirinya |
| `APIKEY` | `APIKEY.ICS_sk_xxx` | Admin: simpan API key ICS, bot balas webhook URL |
| `SYNC` | `SYNC` | Admin: tarik ulang produk dari ICS |
| `LPRDK` | `LPRDK` | Admin: list produk + modal + markup + status supplier |
| `MKP` | `MKP.NOMINAL` / `MKP.KODE.NOMINAL` | Admin: markup general (fallback) / markup per produk (menimpa general) |
| `CS` | `CS.PESAN` | Hubungi admin |
| `GP` | `GP.PINBARU.PINLAMA` | Ganti PIN |
| `UN` | `UN.NAMA.PIN` | Ubah nama |
| `TNO` / `HNO` / `LNO` | `TNO.NOHP.PIN` dst | Kelola nomor paralel |

`TIKET` = stub (`Fitur belum tersedia`). `PRDK` dihapus — katalog produk hanya dari `SYNC`.

Harga efektif mitra = `produk.harga_modal` (harga ICS) + markup admin (per produk jika ada, jika tidak: markup root/general) + total markup sepanjang jalur uplink→mitra (`WITH RECURSIVE`).

## Supplier ICS (order async)

Alur `BELI` dua fase supaya bot tetap responsif dan saldo tidak pernah "hilang":

1. Saldo mitra dipotong, transaksi disimpan `status='proses'`, snapshot komisi tiap uplink disimpan di `komisi_dibagikan`.
2. Bot `POST {ICS_BASE_URL}/trx` (`product_code`, `dest_number`, `ref_id_custom` = `idTrx`).
   Kalau supplier langsung menolak → transaksi `gagal`, saldo direfund, mitra diberi tahu.
3. Penyelesaian (`sukses` / `gagal`) **selalu** lewat `src/orders.js:finalize()`:
   - **Webhook** `POST {WEBHOOK_BASE_URL}/webhook/<token>/<sessionId>` dari ICS (`refid`, `status`, `kode_produk`, `nomor_tujuan`, `supplier_trxid`, `note`).
   - **Cron** tiap 60 detik: transaksi `proses` > 60 detik dicek `GET /reseller/trx/:refid` (jaring pengaman kalau webhook tidak sampai).
   `sukses` → SN disimpan, komisi uplink dibayarkan. `gagal` → `harga_efektif` direfund penuh. `batal` (via `BTL`) mengabaikan webhook berikutnya.

Setup per session (dari nomor admin session):

1. Pastikan `WEBHOOK_BASE_URL` (dan port publik → `WEBHOOK_PORT`) bisa diakses ICS.
2. **Gate onboarding**: selama session belum punya API key, setiap pesan dari admin session dijawab dengan pertanyaan API key (tanpa batas waktu). Hanya `info`/`all`/`menu`/`help`/`CS` yang tetap dilayani; perintah lain (termasuk `SAL`/`BELI`) dibalas prompt.
3. Admin kirim `APIKEY.ICS_sk_xxxx` (atau langsung paste key-nya). Key **diuji dulu** ke `GET /api/reseller/products`: kalau ICS menolak, key tidak disimpan dan bot minta ulang.
4. Key valid → tersimpan di DB session (`settings.ics_apikey`) + produk langsung tersinkron, bot membalas URL webhook. Salin URL itu ke dashboard ICS → Webhook.
5. `SYNC` kapan saja untuk tarik ulang produk.

## Multi-session PPOB

- Satu proses, banyak nomor WhatsApp (`SESSIONS=a,b,c`).
- **DB terpisah per session**: `.data/sessions/<sessionId>.sqlite`. Tidak ada data yang bocor antar admin.
- **Admin session** = root di DB session itu (`senior_id IS NULL`), nomornya didaftarkan super admin via `SESIBUAT`. Kelola markup (general + per produk), produk, downline, dan lihat `LAP` seluruh session-nya.
- **Admin mendaftarkan uplink langsung** dengan `DAFTAR.NAMA.KOTA.NOHP.MARKUP.PIN` — senior otomatis admin session.
- **Uplink** (anak langsung admin) bisa transaksi seperti mitra + `LAP` jaringannya sendiri.
- **Super admin** (`OWNERS`, tanpa perlu jadi mitra):

| Command | Format | Fungsi |
|---|---|---|
| `SESI` | `SESI` | Daftar session terdaftar + nomor WA + status |
| `SESIBUAT` | `SESIBUAT.ID.NOMORADMIN.NOMORWA[LABEL]` | Daftarkan session, seed admin, **langsung connect + minta kode pairing** |
| `SESION` / `SESIOFF` | `SESION.ID` | Nyala/matikan session (langsung connect/disconnect, tanpa restart) |
| `SESIHAPUS` | `SESIHAPUS.ID` | Hapus session + DB-nya (permanen) |
| `LAPTRX` | `LAPTRX.ID[HARI\|BULAN\|YYYY-MM-DD]` | Lihat transaksi session mana pun |
| `STATUS` | `STATUS` | Status proses & server: uptime, RSS/heap, RAM, Node |
| `SESSIONS` | `SESSIONS` | Daftar session + status live (🟢 live / 🟡 on / ⚪ off) |
| `RESTART` | `RESTART.ID` | Connect ulang session (pairing kode dikirim ulang kalau perlu) |
| `ENV` | `ENV` | Ringkasan config aktif (nilai sensitif dimasking) |
| `CMD` | `CMD` | Daftar semua command terdaftar |

### Pairing kode & QR
Session dengan nomor WA terdaftar memakai **kode pairing**: begitu `SESIBUAT` dijalankan, runtime langsung connect dan minta kode 8 karakter ke WhatsApp lalu mengirimkannya balik ke chat super admin:

```
*Pairing toko2*
Nomor: 628555123456
Kode: ABCD-EFGH

Buka WhatsApp di nomor itu → Perangkat tertaut → Tautkan dengan nomor telepon, lalu masukkan kode.
```

- Nomor admin (token ke-2) dan nomor bot (token ke-3) **wajib** dan **tidak boleh sama** (`SESIBUAT.toko2.628555.628111`).
- Kode juga dicetak di console log (`Enter on phone ...`).
- QR di terminal dipakai kalau nomor WA tidak diketahui (fallback) — mis. session bootstrap pertama dari `DEFAULT_SESSION` sebelum ada session di registry.
- Session startup (tanpa `notify`) mencetak kode pairing / hasil pairing ke log, bukan dibuang.
- Daftar session disimpan di `.data/sessions/_registry.sqlite`; semua session di registry otomatis di-connect saat start (kredensial tersimpan, jadi tidak pairing ulang).

### Onboarding supplier
Begitu session pertama kali connect, bot otomatis mengirim prompt API key ICS ke **nomor admin** (bukan nomor bot). Sampai `APIKEY.ICS_sk_xxx` valid tersimpan, semua perintah uang (`SAL`, `BELI`, `SYNC`, dll) diblokir dan dijawab prompt ulang — tanpa timeout. Key divalidasi ke ICS dulu; key salah tidak disimpan. Setelah tersimpan, bot mengirim URL webhook session itu untuk disalin ke dashboard ICS.

## PPOB menu (demo)

Registered commands: `info`, `format1`–`format4`, `ping`, `menu`, `help`, `setprefix`.

`info` dan `all` menambahkan section **KHUSUS ADMIN** (`LAP`, `APIKEY`, `SYNC`, `LPRDK`, `MKP`) kalau pengirim adalah admin session, dan **KHUSUS SUPER ADMIN** (`SESI`, `SESIBUAT`, `SESION`, `SESIOFF`, `SESIHAPUS`, `LAPTRX`, `STATUS`, `SESSIONS`, `RESTART`, `ENV`, `CMD`) kalau pengirim ada di `OWNERS`. Mitra/uplink biasa melihat panduan standar + section **TRANSAKSI** (`CEK`, `REK`, `BTL`). `format1`–`format4` tetap verbatim.

With `COMMAND_PREFIX=` (empty), no prefix is needed — typing `info` or `format2` directly replies with the menu. Unknown text is ignored (no noisy "unknown command" reply).

## Adding a command

Create a file in `src/commands/`, e.g. `src/commands/mycmd.js`:

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

Then import it in `index.js` next to the demo commands:

```js
import './src/commands/mycmd.js'
```

That's it — no core changes. Handler receives `{ client, event, args, log }`.

## Helpers

- `src/helpers.js` — `sendButtons(client, jid, { text, footer, buttons })`, `sendMedia(client, jid, { type, media, mimetype, caption })`
- `src/utils.js` — `extractText`, `parseCommand`, `splitArgs`, `formatLatency`, `mentionFromJid`

## Tests

```bash
node test/utils.test.js
```

## Structure

```
index.js                 entry: sessions, pairing, reconnect, shutdown
supervisor.js            auto-restart + cycle restart (npm run start:safe)
src/config.js            env config
src/store.js             shared store (SQLite), one store for all sessions
src/registry.js          daftar session (id, admin, nomor WA) — .data/sessions/_registry.sqlite
src/runtime.js           connect/pairing kode/reconnect per session saat runtime
src/db.js                per-session SQLite (agen/produk/transaksi/mutasi/settings) + openDb()
src/handler.js           message → auth gate → command dispatch + super admin
src/commands/registry.js command map
src/commands/demo.js     ping / menu / help
src/commands/ppob-core.js SAL/CH/DAFTAR/TUKAR/LAP/MKP/dll
src/commands/supplier.js BELI/CEK/REK/BTL/APIKEY/SYNC (supplier ICS)
src/commands/owner.js    STATUS/SESSIONS/RESTART/ENV/CMD (owner only)
src/ics.js               client API supplier ICS (products / order / status)
src/apikey.js            gate onboarding admin: validasi + simpan apikey ICS
src/orders.js            finalize transaksi: sukses (komisi) / gagal (refund)
src/webhook.js           server webhook ICS + cron poller pending
src/report.js            parseRange (HARI/BULAN/tanggal) untuk LAP
src/helpers.js           send helpers
src/utils.js             text/parse/format helpers
test/utils.test.js       parser + extract self-check
test/webhook.test.js     webhook/token/finalize idempoten
```

> Note: media without a processor uploads but may lack previews/dimensions. Install `@zapo-js/media-utils` + `ffmpeg` when you need proper media.
