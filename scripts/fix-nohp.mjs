// One-off repair: agen rows registered before normalizeNohp existed may hold a
// local "08..." number, which never matches the incoming 62... JID.
// Usage: node scripts/fix-nohp.mjs [--dry]
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from 'file:///D:/code/bot_client/src/db.js'

const dry = process.argv.includes('--dry')
const dir = 'D:/code/bot_client/.data/sessions'
const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && !f.startsWith('_'))

for (const f of files) {
  const db = openDb(join(dir, f))
  const rows = db.raw.prepare('SELECT id, kode, nama, nohp FROM agen').all()
  for (const r of rows) {
    const fixed = String(r.nohp ?? '').replace(/\D/g, '')
    const next = fixed.startsWith('0') ? `62${fixed.slice(1)}` : fixed
    if (!next || next === r.nohp) continue
    const clash = db.findAgenByNohp(next)
    console.log(`${f}: ${r.kode} ${r.nama} ${r.nohp} -> ${next}${clash ? ' (SKIP: sudah dipakai agen lain)' : ''}`)
    if (dry || clash) continue
    db.raw.prepare('UPDATE agen SET nohp = ? WHERE id = ?').run(next, r.id)
    // Parallel numbers live in their own table.
    try {
      db.raw.prepare('UPDATE agen_nomor SET nohp = ? WHERE nohp = ?').run(next, r.nohp)
    } catch {}
  }
  const nomor = db.raw.prepare('SELECT rowid, nohp FROM agen_nomor').all()
  for (const n of nomor) {
    const fixed = String(n.nohp ?? '').replace(/\D/g, '')
    const next = fixed.startsWith('0') ? `62${fixed.slice(1)}` : fixed
    if (!next || next === n.nohp) continue
    console.log(`${f}: nomor paralel ${n.nohp} -> ${next}`)
    if (dry) continue
    db.raw.prepare('UPDATE agen_nomor SET nohp = ? WHERE rowid = ?').run(next, n.rowid)
  }
  db.close()
}
console.log(dry ? 'dry run — tidak ada yang diubah' : 'selesai')
