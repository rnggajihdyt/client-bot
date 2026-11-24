import { createHash } from 'node:crypto'
import { config } from './config.js'

const OWNER_KODE = ''

// Short, stable code per (session, agen kode). 8 base36 chars = 40 bits: enough
// to be unguessable in practice, short enough to paste in WhatsApp.
export function reportCode(sessionId, kode) {
  const hash = createHash('sha256').update(`${sessionId}:${String(kode).toLowerCase()}`).digest('hex')
  return BigInt(`0x${hash.slice(0, 10)}`).toString(36).padStart(8, '0')
}

// Owner link: the owner has no agen row, so its code is minted from the session
// alone (empty kode). Renders the session admin view.
export function ownerReportCode(sessionId) {
  return reportCode(sessionId, OWNER_KODE)
}

export function ownerReportUrl() {
  const base = String(config.reportBaseUrl || `http://localhost:${config.reportPort}`).replace(/\/+$/, '')
  return `${base}/${ownerReportCode(config.ownerReportSession || '')}/report`
}

export function reportUrl(sessionId, kode) {
  const base = String(config.reportBaseUrl || `http://localhost:${config.reportPort}`).replace(/\/+$/, '')
  return `${base}/${reportCode(sessionId, kode)}/report`
}
