// Inspect the shared zapo auth store: which sessionIds have credentials left.
import { DatabaseSync } from 'node:sqlite'
const d = new DatabaseSync('.auth/state.sqlite', { readOnly: true })
const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name)
console.log('tables:', tables.join(', '))
for (const t of tables) {
  const cols = d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  if (!cols.includes('sessionId') && !cols.includes('session_id')) continue
  const col = cols.includes('sessionId') ? 'sessionId' : 'session_id'
  const rows = d.prepare(`SELECT DISTINCT ${col} AS s FROM ${t}`).all()
  console.log(t, '->', rows.map((r) => r.s).join(', '))
}
d.close()
