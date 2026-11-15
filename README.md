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
| `OWNERS` | (empty) | Comma-separated phone numbers (digits) allowed to change the prefix |
| `SETTINGS_PATH` | `.auth/settings.json` | Where per-session runtime settings live |
| `PAIRING_MODE` | `both` | `qr` \| `code` \| `both` |
| `PAIRING_PHONE` | (empty) | Phone number (digits, w/ country code) for the code flow |
| `LOG_LEVEL` | `info` | Pino level |
| `AUTOREAD` | `false` | `true` = mark incoming messages read (blue ticks) |
| `STORE_PATH` | `.auth/state.sqlite` | SQLite file location |
| `PPOB_DB_PATH` | `.data/ppob.sqlite` | PPOB data DB (agen/produk/transaksi) |
| `OWNER_PIN` | `1234` | Initial PIN for the seeded owner/root mitra |

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
| `CS` | `CS.PESAN` | Hubungi admin |
| `GP` | `GP.PINBARU.PINLAMA` | Ganti PIN |
| `UN` | `UN.NAMA.PIN` | Ubah nama |
| `TNO` / `HNO` / `LNO` | `TNO.NOHP.PIN` dst | Kelola nomor paralel |

`BELI`, `TIKET`, `LAP`, `REK`, `CEK`, `BTL` = stub (`Fitur belum tersedia`).

Harga efektif mitra = `produk.harga_modal` + total markup sepanjang jalur root→mitra (query `WITH RECURSIVE`).

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
src/handler.js           message → command dispatch
src/commands/registry.js command map
src/commands/demo.js     ping / menu / help
src/helpers.js           send helpers
src/utils.js             text/parse/format helpers
test/utils.test.js       parser + extract self-check
```

> Note: media without a processor uploads but may lack previews/dimensions. Install `@zapo-js/media-utils` + `ffmpeg` when you need proper media.
