// One-off repair: agen rows may hold mixed "62..."/"08..."/"8..." numbers.
// Semua dinormalkan ke bentuk lokal "08...". Usage: node scripts/fix-nohp.mjs [--dry]
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { normalizeNohp } from '../src/utils.js'

const dry = process.argv.includes('--dry')
const dir = '.data/sessions'
const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && !f.startsWith('_'))

for (const f of files) {
  const db = openDb(join(dir, f))
  const rows = db.raw.prepare('SELECT id, kode, nama, nohp FROM agen').all()
  for (const r of rows) {
    const next = normalizeNohp(r.nohp)
    if (!next || next === r.nohp) continue
    console.log(`${f}: ${r.kode} ${r.nama} ${r.nohp} -> ${next}`)
    if (dry) continue
    db.raw.prepare('UPDATE agen SET nohp = ? WHERE id = ?').run(next, r.id)
  }
  const nomor = db.raw.prepare('SELECT rowid, nohp FROM agen_nomor').all()
  for (const n of nomor) {
    const next = normalizeNohp(n.nohp)
    if (!next || next === n.nohp) continue
    console.log(`${f}: nomor paralel ${n.nohp} -> ${next}`)
    if (dry) continue
    db.raw.prepare('UPDATE agen_nomor SET nohp = ? WHERE rowid = ?').run(next, n.rowid)
  }
  db.close()
}
console.log(dry ? 'dry run — tidak ada yang diubah' : 'selesai')
