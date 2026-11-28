import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { openDb } from './db.js'
import { finalize, settledText } from './orders.js'
import { ics } from './ics.js'
import { config, sessionPath } from './config.js'
import { expireTickets } from './commands/deposit.js'
import { formatRupiah } from './money.js'
import { toJid } from './utils.js'

// One random token per session, minted on first use and stable afterwards.
export function webhookToken(db) {
  const existing = db.getSetting('webhook_token')
  if (existing) return existing
  const t = randomBytes(24).toString('hex')
  db.setSetting('webhook_token', t)
  return t
}

export function webhookUrl(db, sessionId) {
  const base = String(config.webhookBaseUrl).replace(/\/+$/, '')
  return `${base}/webhook/${webhookToken(db)}/${encodeURIComponent(sessionId)}`
}

// Per-session supplier credentials. The admin sets the apikey; the base URL
// comes from env so a single deployment points at one supplier.
export function icsConfig(db) {
  return { baseUrl: config.icsBaseUrl, apiKey: db.getSetting('ics_apikey') || config.icsApiKey }
}

// Resolve a session from the webhook URL. Unknown or unpaired sessions fail
// closed — the token is compared before any DB work happens.
function sessionForWebhook(sessionId, token) {
  const path = sessionPath(decodeURIComponent(sessionId))
  // existsSync so a probe with a random session id cannot litter new DB files.
  if (!existsSync(path)) return null
  const db = openDb(path)
  const known = db.getSetting('webhook_token')
  if (!known || known !== token) {
    db.close()
    return null
  }
  return db
}

export function handleWebhook(logger, { sessionId, token, raw }) {
  const db = sessionForWebhook(sessionId, token)
  if (!db) throw new Error('session/token tidak dikenal')
  try {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error('body bukan JSON')
    }
    const { refid, status, note, message, supplier_trxid: stx } = payload ?? {}
    if (!refid || !status) throw new Error('refid/status wajib ada')

    logger.child({ sessionId }).info({ refid, status, kode: payload.kode_produk }, 'webhook received')
    const mapped = status === 'success' ? 'sukses' : status === 'failed' ? 'gagal' : null
    if (!mapped) return // pending/unknown: nothing to settle yet
    const r = finalize(db, refid, {
      status: mapped,
      sn: mapped === 'sukses' ? (note ?? '') : '',
      reason: mapped === 'gagal' ? (note || message || '') : '',
      supplierTrxId: stx ?? '',
    })
    if (r) notifyBuyer(logger, sessionId, r)
  } finally {
    db.close()
  }
}

// Push the settled result to the buyer. A closed socket just logs — the state
// is already persisted, and SAL/CEK show the truth.
function notifyBuyer(logger, sessionId, result) {
  const client = globalThis.__waRuntime?.clients?.get?.(sessionId)
  if (!client || !result.trx.agen_nohp) return
  // Waktu finalisasi ikut dikirim supaya baris sukses mencetak "Tanggal ..." saat settle.
  const text = settledText({ ...result, at: new Date() })
  client.message.send(toJid(result.trx.agen_nohp), text).catch((err) =>
    logger.child({ sessionId }).warn({ err: err?.message, idTrx: result.trx.id_trx }, 'buyer notify failed')
  )
}

export function startWebhookServer(logger) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method !== 'POST' || !url.pathname.startsWith('/webhook/')) {
      res.writeHead(404).end()
      return
    }
    const [, , token, sessionId] = url.pathname.split('/')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        handleWebhook(logger, { sessionId, token, raw: body })
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"success":true}')
      } catch (err) {
        logger.warn({ err: err?.message, sessionId }, 'webhook rejected')
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }))
      }
    })
  })
  server.on('error', (err) => logger.error({ err: err?.message, port: config.webhookPort }, 'webhook server error'))
  server.listen(config.webhookPort, () => {
    logger.info({ port: config.webhookPort, base: config.webhookBaseUrl || '(unset)' }, 'webhook server listening')
  })
  return server
}

// Safety net / mode utama: settle pendings. Tanpa webhook, poll ini satu-satunya
// jalur penyelesaian, jadi dijalankan tiap POLL_INTERVAL_MS.
export async function pollPending(logger, sessionId, minAgeMs = 10_000) {
  const db = openDb(sessionPath(sessionId))
  let rows = []
  let cfg
  try {
    cfg = icsConfig(db)
    if (!cfg.apiKey) return
    rows = db.pendingTransaksi(minAgeMs)
  } finally {
    db.close()
  }
  for (const trx of rows) {
    try {
      const r = await ics.status(cfg.baseUrl, cfg.apiKey, trx.id_trx)
      const d = r?.data ?? {}
      const mapped = d.status === 'success' ? 'sukses' : d.status === 'failed' ? 'gagal' : null
      if (!mapped) continue
      const db2 = openDb(sessionPath(sessionId))
      try {
        const done = finalize(db2, trx.id_trx, {
          status: mapped,
          sn: mapped === 'sukses' ? (d.sn ?? '') : '',
          reason: mapped === 'gagal' ? (d.message ?? d.note ?? '') : '',
          supplierTrxId: d.supplier_trxid ?? '',
        })
        if (done) notifyBuyer(logger, sessionId, done)
      } finally {
        db2.close()
      }
    } catch (err) {
      logger.child({ sessionId }).warn({ err: err?.message, idTrx: trx.id_trx }, 'poll failed')
    }
  }
}

// Tiket deposit yang lewat 12 jam ditutup di sini juga (satu timer untuk semua).
async function expireTicketsIn(logger, sessionId) {
  const db = openDb(sessionPath(sessionId))
  let expired = []
  try {
    expired = await expireTickets(db, {
      notify: (dep) => {
        const d = new Date(dep.created_at)
        const p = (n) => String(n).padStart(2, '0')
        const tgl = `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
        return (
          globalThis.__waRuntime?.clients
            ?.get(sessionId)
            ?.message.send(
              toJid(dep.agen_nohp),
              `Tiket Rp${formatRupiah(dep.nominal)} pada ${tgl} sudah dibatalkan (kadaluarsa).\nSilakan mengambil tiket lagi`
            ) ?? Promise.resolve()
        )
      },
    })
  } finally {
    db.close()
  }
  if (expired.length) logger.info({ sessionId, n: expired.length }, 'tiket deposit kedaluwarsa')
}

export const POLL_INTERVAL_MS = 15_000

export function startPoller(logger, sessions, everyMs = POLL_INTERVAL_MS) {
  const timer = setInterval(() => {
    for (const id of sessions()) {
      void pollPending(logger, id)
      void expireTicketsIn(logger, id).catch((err) => logger.warn({ err: err?.message }, 'expire tiket gagal'))
    }
  }, everyMs)
  timer.unref?.()
  return timer
}
