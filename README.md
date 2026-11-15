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
| `COMMAND_PREFIX` | `!` | Command prefix |
| `PAIRING_MODE` | `both` | `qr` \| `code` \| `both` |
| `PAIRING_PHONE` | (empty) | Phone number (digits, w/ country code) for the code flow |
| `LOG_LEVEL` | `info` | Pino level |
| `STORE_PATH` | `.auth/state.sqlite` | SQLite file location |

## Run

```bash
npm start
```

First run: the QR or pairing code prints to the terminal. Scan from **WhatsApp → Linked devices**. Subsequent runs reuse stored credentials — no re-pair.

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
