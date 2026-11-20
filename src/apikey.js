import { ics } from './ics.js'
import { icsConfig } from './webhook.js'

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
