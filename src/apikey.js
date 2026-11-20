import { openDb } from './db.js'
import { sessionPath } from './config.js'
import { getSession } from './registry.js'
import { webhookUrl, icsConfig } from './webhook.js'
import { ics } from './ics.js'

// A session without a valid supplier key cannot sell anything, so the key is
// checked against ICS *before* it is stored. A typo fails here, loudly, instead
// of surfacing at the first BELI with a customer's money on the line.
export async function setupApiKey(db, key) {
  const cfg = icsConfig(db)
  const res = await ics.products(cfg.baseUrl, key)
  const rows = Array.isArray(res?.data) ? res.data : []
  db.tx(() => {
    for (const p of rows) {
      db.upsertProdukIcs({
        code: p.code,
        name: p.name,
        price: p.price,
        category: p.category,
        status: p.status,
        stock: p.stock,
      })
    }
    db.setSetting('ics_apikey', key)
  })
  return { total: rows.length, available: rows.filter((p) => p.status === 'available').length }
}

// Candidate key in a free-text reply, with or without the APIKEY. prefix.
export function extractApiKey(text) {
  return String(text ?? '')
    .trim()
    .match(/^(?:APIKEY\.)?(ICS_[A-Za-z0-9_-]+)$/i)?.[1]
}

// Repeated on every message until a key is stored: no timeout, no way past it.
export function apiKeyPrompt(url) {
  return (
    `*Setup Supplier ICS*\n\n` +
    `Sesi ini belum punya API key supplier, jadi transaksi masih terkunci.\n` +
    `Kirim API key dari dashboard ICS:\n\nAPIKEY.ICS_sk_xxxx\n\n` +
    `Setelah tersimpan, salin URL webhook ini ke dashboard ICS:\n${url}`
  )
}

// The admin's own number must differ from the bot's: the same phone cannot be
// the bot and its customer, and such a session could never be operated.
export function sameNumberProblem(adminNohp, pairingPhone) {
  return Boolean(adminNohp && pairingPhone && adminNohp === pairingPhone)
}

// Runs the gate for a session that just connected. No API key → prompt the
// admin; as soon as the key is valid, tell the admin the webhook URL so it can
// be registered on the ICS dashboard. Both messages go to the admin's number
// (the bot's own number is a different phone by rule), chat JID as fallback.
export async function runOnboarding(logger, sessionId, notify) {
  const db = openDb(sessionPath(sessionId))
  let to, key, url
  try {
    to = getSession(sessionId)?.admin_nohp ?? ''
    if (!to) return
    key = db.getSetting('ics_apikey')
    url = webhookUrl(db, sessionId)
  } finally {
    db.close()
  }
  const send = (text) => notify?.(`${to}@s.whatsapp.net`, text)

  if (!key) {
    logger.info({ sessionId, to }, 'onboarding: menunggu apikey ICS')
    await send(apiKeyPrompt(url))
    return
  }
  await send(`*Sesi ${sessionId} siap.*\n\nWebhook URL:\n${url}\n\nSalin URL itu ke dashboard ICS → Webhook.`)
}
