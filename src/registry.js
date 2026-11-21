import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Session directory: which WhatsApp accounts exist, who their admin is, and
// which phone pairs them. Kept in its own DB so it is readable before any
// session connects.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  admin_nohp TEXT NOT NULL DEFAULT '',
  pairing_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'off',
  created_at TEXT NOT NULL
);
`

let db = null

// The env bootstrap session (DEFAULT_SESSION / SESSIONS) is the pusat/owner bot:
// it connects at startup, before any admin session exists or can be commanded.
// Its id is allowed as a bot number in SESIBUAT, so that session can serve admins.
function bootstrapIds() {
  const raw = (process.env.SESSIONS ?? process.env.DEFAULT_SESSION ?? 'default').split(',')
  return raw.map((s) => s.trim()).filter(Boolean)
}

export function isBootstrapSession(id) {
  return bootstrapIds().includes(String(id))
}

export function openRegistry(path) {
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec(SCHEMA)
  // Older registry DBs (created inside the session DB) may lack pairing_phone.
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name)
  if (!cols.includes('pairing_phone')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN pairing_phone TEXT NOT NULL DEFAULT ''`)
  }
  return db
}

function ensure() {
  if (!db) throw new Error('registry not initialized')
  return db
}

export function listSessions() {
  return ensure().prepare(`SELECT * FROM sessions ORDER BY id`).all()
}

export function getSession(id) {
  return ensure().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id)
}

export function createSession({ id, label = '', adminNohp, pairingPhone = '', status = 'off' }) {
  const d = ensure()
  if (d.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(id)) return null
  d.prepare(
    `INSERT INTO sessions (id, label, admin_nohp, pairing_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, label, adminNohp, pairingPhone, status, new Date().toISOString())
  return getSession(id)
}

export function setSessionStatus(id, status) {
  return ensure().prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id).changes
}

export function setPairingPhone(id, phone) {
  return ensure().prepare(`UPDATE sessions SET pairing_phone = ? WHERE id = ?`).run(phone, id).changes
}

export function updateSessionAdmin(id, { label, adminNohp, pairingPhone }) {
  return ensure()
    .prepare(`UPDATE sessions SET label = ?, admin_nohp = ?, pairing_phone = ? WHERE id = ?`)
    .run(label ?? '', adminNohp, pairingPhone, id).changes
}

export function removeSession(id) {
  return ensure().prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes
}

export function closeRegistry() {
  if (db) {
    db.close()
    db = null
  }
}
