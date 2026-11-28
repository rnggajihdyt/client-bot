import { openDb } from './db.js'
import { sessionPath } from './config.js'
import { getSession } from './registry.js'
import { toJid, normalizeNohp } from './utils.js'
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
export function apiKeyPrompt() {
  return `*API Key ICS belum diisi*\nKirim: APIKEY.KEY`
}

// Sent once when the session first becomes ready with a valid API key.
// Mode transaksi memakai CEK/poll status, jadi webhook tidak perlu disebut.
export function sessionReadyText(sessionId, { total, available }) {
  return (
    `*Sesi ${sessionId} siap.*\n` +
    `Produk: ${total} tersimpan (${available} online)\n\n` +
    `Status transaksi dicek otomatis; cek manual dengan CEK.`
  )
}

// The admin's own number must differ from the bot's: the same phone cannot be
// the bot and its customer, and such a session could never be operated.
export function sameNumberProblem(adminNohp, pairingPhone) {
  const a = normalizeNohp(adminNohp)
  const p = normalizeNohp(pairingPhone)
  return Boolean(a && p && a === p)
}

// Runs the gate for a session that just connected. No API key → prompt the
// admin; if already keyed and never notified yet → send the one-time ready
// message with product counts. Reconnects stay silent once ready.
export async function runOnboarding(logger, sessionId, notify) {
  const db = openDb(sessionPath(sessionId))
  let to, key, alreadyReady, total, available
  try {
    const session = getSession(sessionId)
    to = session?.admin_nohp ?? ''
    if (!to || sameNumberProblem(to, session?.pairing_phone)) return
    key = db.getSetting('ics_apikey')
    alreadyReady = db.getSetting('ready_notified') === '1'
    if (key && !alreadyReady) {
      const produk = db.listProduk()
      total = produk.length
      available = produk.filter((p) => p.aktif && p.status_supplier === 'available').length
    }
  } finally {
    db.close()
  }
  const send = (text) => notify?.(toJid(to), text)

  if (!key) {
    logger.info({ sessionId, to }, 'onboarding: menunggu apikey ICS')
    await send(apiKeyPrompt())
    return
  }
  if (alreadyReady) return

  await send(sessionReadyText(sessionId, { total, available }))
  const db2 = openDb(sessionPath(sessionId))
  try {
    db2.setSetting('ready_notified', '1')
  } finally {
    db2.close()
  }
}
