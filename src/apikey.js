import { openDb } from './db.js'
import { sessionPath } from './config.js'
import { getSession } from './registry.js'
import { webhookUrl } from './webhook.js'
import { syncCatalog } from './catalog.js'

// A session without a valid supplier key cannot sell anything, so the key is
// checked against ICS *before* it is stored. A typo fails here, loudly, instead
// of surfacing at the first BELI with a customer's money on the line.
export async function setupApiKey(db, key) {
  return syncCatalog(db, { apiKey: key, saveKey: true })
}

// Candidate key in a free-text reply, with or without the APIKEY. prefix.
// ICS API keys are hex strings (e.g. 64-char hex), without any fixed prefix.
export function extractApiKey(text) {
  const s = String(text ?? '').trim()
  const prefixed = s.match(/^APIKEY[.\s]+([A-Za-z0-9_-]{16,})$/i)
  if (prefixed) return prefixed[1]
  const bare = s.match(/^(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}$/)
  return bare?.[0]
}

// Repeated on every message until a key is stored: no timeout, no way past it.
export function apiKeyPrompt(url) {
  return `*API Key ICS belum diisi*\nKirim: APIKEY.KEY\nWebhook: ${url}`
}

// Sent once when the session first becomes ready with a valid API key.
export function sessionReadyText(sessionId, { total, available, url }) {
  return (
    `*Sesi ${sessionId} siap.*\n` +
    `Produk: ${total} tersimpan (${available} online)\n` +
    `Webhook: ${url}\n\n` +
    `Salin URL webhook ke dashboard ICS → Webhook.`
  )
}

// The admin's own number must differ from the bot's: the same phone cannot be
// the bot and its customer, and such a session could never be operated.
export function sameNumberProblem(adminNohp, pairingPhone) {
  return Boolean(adminNohp && pairingPhone && adminNohp === pairingPhone)
}

// Runs the gate for a session that just connected. No API key → prompt the
// admin; if already keyed and never notified yet → send the one-time ready
// message with product counts + webhook URL. Reconnects stay silent once ready.
export async function runOnboarding(logger, sessionId, notify) {
  const db = openDb(sessionPath(sessionId))
  let to, key, url, alreadyReady, total, available
  try {
    const session = getSession(sessionId)
    to = session?.admin_nohp ?? ''
    if (!to || sameNumberProblem(to, session?.pairing_phone)) return
    key = db.getSetting('ics_apikey')
    alreadyReady = db.getSetting('ready_notified') === '1'
    url = webhookUrl(db, sessionId)
    if (key && !alreadyReady) {
      const produk = db.listProduk()
      total = produk.length
      available = produk.filter((p) => p.aktif && p.status_supplier === 'available').length
    }
  } finally {
    db.close()
  }
  const send = (text) => notify?.(`${to}@s.whatsapp.net`, text)

  if (!key) {
    logger.info({ sessionId, to }, 'onboarding: menunggu apikey ICS')
    await send(apiKeyPrompt(url))
    return
  }
  if (alreadyReady) return

  await send(sessionReadyText(sessionId, { total, available, url }))
  const db2 = openDb(sessionPath(sessionId))
  try {
    db2.setSetting('ready_notified', '1')
  } finally {
    db2.close()
  }
}
