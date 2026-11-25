import { createHash } from 'node:crypto'
import { config } from './config.js'

const OWNER_KODE = ''
const OWNER_SESSION = 'owner'

// Short, stable code per (session, agen kode). 8 base36 chars = 40 bits: enough
// to be unguessable in practice, short enough to paste in WhatsApp.
export function reportCode(sessionId, kode) {
  const hash = createHash('sha256').update(`${sessionId}:${String(kode).toLowerCase()}`).digest('hex')
  return BigInt(`0x${hash.slice(0, 10)}`).toString(36).padStart(8, '0')
}

// Owner link: the owner has no agen row, so its code is minted from the session
// alone. `slot` keeps one link per owner number (OWNERS=a,b -> slot "a" / "b"),
// so a revoked owner's link can be replaced without touching the others.
export function ownerReportCode(sessionId, slot = '') {
  return reportCode(sessionId, `${OWNER_KODE}${slot}`)
}

// The single owner session id, shared by the link minting and its resolution so
// the two can never drift apart.
export function ownerSession() {
  return config.ownerReportSession || OWNER_SESSION
}

export function ownerReportUrl(slot = '') {
  const base = String(config.reportBaseUrl || `http://localhost:${config.reportPort}`).replace(/\/+$/, '')
  return `${base}/${ownerReportCode(ownerSession(), slot)}/report`
}

// Link for the owner whose number sent the message: its own slot in OWNERS,
// falling back to the shared link when the number is not listed.
export function ownerReportUrlFor(nohp) {
  const digits = String(nohp ?? '').replace(/\D/g, '')
  const slot = config.owners.find((o) => digits.endsWith(o) || o.endsWith(digits))
  return ownerReportUrl(slot ?? '')
}

export function reportUrl(sessionId, kode) {
  const base = String(config.reportBaseUrl || `http://localhost:${config.reportPort}`).replace(/\/+$/, '')
  return `${base}/${reportCode(sessionId, kode)}/report`
}
