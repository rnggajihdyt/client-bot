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

## Run

```bash
npm start
```

For auto-restart on file changes (dev):

```bash
npm run dev
```

First run: the QR or pairing code prints to the terminal. Scan from **WhatsApp → Linked devices**. Subsequent runs reuse stored credentials — no re-pair.

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
| `BELI` | `BELI.KODE.TUJUAN[.PIN]` | Beli produk (potong saldo + distribusi komisi) |
| `LAP` | `LAP[HARI\|BULAN\|YYYY-MM-DD]` | Admin: seluruh session. Uplink: jaringan sendiri. Mitra: dirinya |
| `PRDK` | `PRDK.KODE.NAMA.MODAL` | Admin: tambah/ubah produk (nama boleh berspasi) |
| `LPRDK` | `LPRDK` | Admin: list produk + modal + markup |
| `MKP` | `MKP.NOMINAL` / `MKP.KODE.NOMINAL` | Admin: markup general (fallback) / markup per produk (menimpa general) |
| `CS` | `CS.PESAN` | Hubungi admin |
| `GP` | `GP.PINBARU.PINLAMA` | Ganti PIN |
| `UN` | `UN.NAMA.PIN` | Ubah nama |
| `TNO` / `HNO` / `LNO` | `TNO.NOHP.PIN` dst | Kelola nomor paralel |

`TIKET`, `REK`, `CEK`, `BTL` = stub (`Fitur belum tersedia`).

Harga efektif mitra = `produk.harga_modal` + markup admin (per produk jika ada, jika tidak: markup root/general) + total markup sepanjang jalur uplink→mitra (`WITH RECURSIVE`).

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
| `SESIBUAT` | `SESIBUAT.ID.NOMORADMIN[.NOMORWA][LABEL]` | Daftarkan session, seed admin, **langsung connect + minta kode pairing** |
| `SESION` / `SESIOFF` | `SESION.ID` | Nyala/matikan session (langsung connect/disconnect, tanpa restart) |
| `SESIHAPUS` | `SESIHAPUS.ID` | Hapus session + DB-nya (permanen) |
| `LAPTRX` | `LAPTRX.ID[HARI\|BULAN\|YYYY-MM-DD]` | Lihat transaksi session mana pun |

### Pairing kode

Setiap session baru memakai **kode pairing** (bukan QR): begitu `SESIBUAT` dijalankan, runtime langsung connect dan zapo memicu `auth_pairing_required` → bot minta kode 8 karakter ke WhatsApp lalu mengirimkannya balik ke chat super admin:

```
*Pairing toko2*
Nomor: 628555123456
Kode: ABCD-EFGH

Buka WhatsApp di nomor itu → Perangkat tertaut → Tautkan dengan nomor telepon, lalu masukkan kode.
```

- Nomor WA = token ke-3 (`SESIBUAT.toko2.628555.628555`), default nomor admin.
- Kode juga dicetak di console log (`Enter on phone ...`).
- QR di terminal hanya muncul kalau nomor WA tidak diketahui (fallback).
- Daftar session disimpan di `.data/sessions/_registry.sqlite`; semua session di registry otomatis di-connect saat start (kredensial tersimpan, jadi tidak pairing ulang).

## PPOB menu (demo)

Registered commands: `info`, `format1`–`format4`, `ping`, `menu`, `help`, `setprefix`.

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
src/config.js            env config
src/store.js             shared store (SQLite), one store for all sessions
src/registry.js          daftar session (id, admin, nomor WA) — .data/sessions/_registry.sqlite
src/runtime.js           connect/pairing kode/reconnect per session saat runtime
src/db.js                per-session SQLite (agen/produk/transaksi/mutasi) + openDb()
src/handler.js           message → auth gate → command dispatch + super admin
src/commands/registry.js command map
src/commands/demo.js     ping / menu / help
src/commands/ppob-core.js SAL/CH/DAFTAR/BELI/LAP/PRDK/MKP/dll
src/report.js            parseRange (HARI/BULAN/tanggal) untuk LAP
src/helpers.js           send helpers
src/utils.js             text/parse/format helpers
test/utils.test.js       parser + extract self-check
```

> Note: media without a processor uploads but may lack previews/dimensions. Install `@zapo-js/media-utils` + `ffmpeg` when you need proper media.
