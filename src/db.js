import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { hashPin } from './auth.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  kota TEXT NOT NULL DEFAULT '',
  nohp TEXT UNIQUE NOT NULL,
  senior_id INTEGER REFERENCES agen(id),
  markup INTEGER NOT NULL DEFAULT 0,
  saldo INTEGER NOT NULL DEFAULT 0,
  komisi INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT NOT NULL,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agen_senior ON agen(senior_id);

CREATE TABLE IF NOT EXISTS agen_nomor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agen_id INTEGER NOT NULL REFERENCES agen(id),
  nohp TEXT UNIQUE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agen_nomor_nohp ON agen_nomor(nohp);

CREATE TABLE IF NOT EXISTS produk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  harga_modal INTEGER NOT NULL,
  kategori TEXT NOT NULL DEFAULT '',
  aktif INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_trx TEXT UNIQUE NOT NULL,
  agen_id INTEGER NOT NULL REFERENCES agen(id),
  produk_id INTEGER REFERENCES produk(id),
  produk_kode TEXT NOT NULL DEFAULT '',
  tujuan TEXT NOT NULL DEFAULT '',
  harga_modal INTEGER NOT NULL DEFAULT 0,
  markup_total INTEGER NOT NULL DEFAULT 0,
  harga_efektif INTEGER NOT NULL DEFAULT 0,
  komisi_dibagikan TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transaksi_agen ON transaksi(agen_id);
CREATE INDEX IF NOT EXISTS idx_transaksi_status ON transaksi(status);

CREATE TABLE IF NOT EXISTS mutasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agen_id INTEGER NOT NULL REFERENCES agen(id),
  tipe TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  saldo_akhir INTEGER NOT NULL,
  keterangan TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutasi_agen ON mutasi(agen_id);
`

let db = null

// Additive migrations for DBs created before a column existed. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so check pragma first.
function migrate(database) {
  const cols = database.prepare(`PRAGMA table_info(transaksi)`).all().map((c) => c.name)
  const add = {
    produk_kode: `ALTER TABLE transaksi ADD COLUMN produk_kode TEXT NOT NULL DEFAULT ''`,
    harga_modal: `ALTER TABLE transaksi ADD COLUMN harga_modal INTEGER NOT NULL DEFAULT 0`,
    markup_total: `ALTER TABLE transaksi ADD COLUMN markup_total INTEGER NOT NULL DEFAULT 0`,
  }
  for (const [name, sql] of Object.entries(add)) {
    if (!cols.includes(name)) database.exec(sql)
  }
}

export function initDb(path) {
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec(SCHEMA)
  migrate(db)
  return db
}

export function getDb() {
  if (!db) throw new Error('db not initialized')
  return db
}

export function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ---- kode generator ----
// type: 'OWN' (2 digit) | 'RS' (5 digit)
export function nextKode(type) {
  const prefix = type === 'OWN' ? 'OWN' : 'RS'
  const width = type === 'OWN' ? 2 : 5
  const row = db
    .prepare(`SELECT kode FROM agen WHERE kode LIKE ? ORDER BY kode DESC LIMIT 1`)
    .get(prefix + '%')
  let n = 0
  if (row) {
    const m = row.kode.match(new RegExp(`^${prefix}(\\d+)$`))
    if (m) n = parseInt(m[1], 10)
  }
  return prefix + String(n + 1).padStart(width, '0')
}

export function createAgen({ nama, kota, nohp, seniorId, markup, pin }) {
  const kode = nextKode(seniorId == null ? 'OWN' : 'RS')
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO agen (kode, nama, kota, nohp, senior_id, markup, pin_hash, aktif, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(kode, nama, kota, nohp, seniorId, markup, hashPin(pin), new Date().toISOString())
  return { id: lastInsertRowid, kode }
}

// ---- lookup ----
export function findAgenByNohp(nohp) {
  const d = String(nohp).split('@')[0].split(':')[0].replace(/\D/g, '')
  if (!d) return undefined
  let row = db.prepare(`SELECT * FROM agen WHERE nohp = ?`).get(d)
  if (row) return row
  row = db
    .prepare(`SELECT a.* FROM agen_nomor n JOIN agen a ON a.id = n.agen_id WHERE n.nohp = ?`)
    .get(d)
  return row
}

export function findAgenById(id) {
  return db.prepare(`SELECT * FROM agen WHERE id = ?`).get(id)
}

export function findAgenByKode(kode) {
  return db.prepare(`SELECT * FROM agen WHERE kode = ?`).get(kode)
}

export function downlines(agenId) {
  return db
    .prepare(`SELECT * FROM agen WHERE senior_id = ? ORDER BY kode`)
    .all(agenId)
}

export function countDownlines(agenId) {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM agen WHERE senior_id = ?`).get(agenId)
  return r.c
}

// Markup total on the path root -> agen (includes own markup).
export function markupTotal(agenId) {
  const r = db
    .prepare(
      `WITH RECURSIVE anc(id, senior_id, markup) AS (
         SELECT id, senior_id, markup FROM agen WHERE id = ?
         UNION ALL
         SELECT a.id, a.senior_id, a.markup
         FROM agen a JOIN anc ON a.id = anc.senior_id
       )
       SELECT COALESCE(SUM(markup), 0) AS total FROM anc`
    )
    .get(agenId)
  return r.total
}

// Effective price = product base + markup total of the mitra.
export function effectivePrice(agenId, kodeProduk) {
  const p = db.prepare(`SELECT * FROM produk WHERE kode = ? AND aktif = 1`).get(kodeProduk)
  if (!p) return undefined
  return { ...p, hargaEfektif: p.harga_modal + markupTotal(agenId) }
}

// ---- mutasi ----
export function addMutasi(agenId, tipe, nominal, saldoAkhir, keterangan = '') {
  db.prepare(`INSERT INTO mutasi (agen_id, tipe, nominal, saldo_akhir, keterangan, created_at) VALUES (?,?,?,?,?,?)`)
    .run(agenId, tipe, nominal, saldoAkhir, keterangan, new Date().toISOString())
}

export function mutasiOf(agenId, limit = 20) {
  return db.prepare(`SELECT * FROM mutasi WHERE agen_id = ? ORDER BY id DESC LIMIT ?`).all(agenId, limit)
}

// ---- mitra mutations ----
const ALLOWED_FIELDS = ['nama', 'kota', 'markup', 'aktif', 'pin_hash']

export function updateAgen(id, fields) {
  const entries = Object.entries(fields).filter(([k]) => ALLOWED_FIELDS.includes(k))
  if (!entries.length) return
  const set = entries.map(([k]) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE agen SET ${set} WHERE id = ?`).run(...entries.map(([, v]) => v), id)
}

export function setSaldoKomisi(id, saldo, komisi) {
  db.prepare(`UPDATE agen SET saldo = ?, komisi = ? WHERE id = ?`).run(saldo, komisi, id)
}

// Atomic increments — avoids read-modify-write races.
export function addSaldo(id, delta) {
  db.prepare(`UPDATE agen SET saldo = saldo + ? WHERE id = ?`).run(delta, id)
}

export function addKomisi(id, delta) {
  db.prepare(`UPDATE agen SET komisi = komisi + ? WHERE id = ?`).run(delta, id)
}

// Every ancestor of `agenId` (excluding itself), nearest first, with saldo.
export function ancestors(agenId) {
  return db
    .prepare(
      `WITH RECURSIVE anc(id, senior_id, kode, markup, saldo) AS (
         SELECT id, senior_id, kode, markup, saldo FROM agen WHERE id = ?
         UNION ALL
         SELECT a.id, a.senior_id, a.kode, a.markup, a.saldo
         FROM agen a JOIN anc ON a.id = anc.senior_id
       )
       SELECT * FROM anc WHERE id != ?`
    )
    .all(agenId, agenId)
}

export function insertTransaksi({
  idTrx,
  agenId,
  produkId,
  produkKode,
  tujuan,
  hargaModal,
  markupTotal,
  hargaEfektif,
  komisiDibagikan,
  status,
}) {
  db.prepare(
    `INSERT INTO transaksi (id_trx, agen_id, produk_id, produk_kode, tujuan, harga_modal, markup_total, harga_efektif, komisi_dibagikan, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    idTrx,
    agenId,
    produkId,
    produkKode,
    tujuan,
    hargaModal,
    markupTotal,
    hargaEfektif,
    JSON.stringify(komisiDibagikan),
    status,
    new Date().toISOString()
  )
}

// Profit = sum of markup over successful transactions in [from, to) ISO dates.
// `agenId` scopes to a mitra, null = whole network (admin view).
export function profitSummary({ agenId = null, from, to }) {
  const scope = agenId ? 'AND agen_id = ?' : ''
  const params = agenId ? [from, to, agenId] : [from, to]
  const r = db
    .prepare(
      `SELECT COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif), 0) AS omzet,
              COALESCE(SUM(harga_modal), 0) AS modal,
              COALESCE(SUM(markup_total), 0) AS markup
       FROM transaksi
       WHERE status = 'sukses' AND created_at >= ? AND created_at < ? ${scope}`
    )
    .get(...params)
  return r
}

export function deleteAgen(id) {
  db.prepare(`DELETE FROM agen_nomor WHERE agen_id = ?`).run(id)
  db.prepare(`DELETE FROM agen WHERE id = ?`).run(id)
}

export function addNomor(agenId, nohp) {
  db.prepare(`INSERT INTO agen_nomor (agen_id, nohp) VALUES (?, ?)`).run(agenId, nohp)
}

export function removeNomor(agenId, nohp) {
  return db.prepare(`DELETE FROM agen_nomor WHERE agen_id = ? AND nohp = ?`).run(agenId, nohp).changes
}

export function nomorOf(agenId) {
  return db.prepare(`SELECT nohp FROM agen_nomor WHERE agen_id = ? ORDER BY id`).all(agenId).map((r) => r.nohp)
}

export function nomorTaken(nohp) {
  const inAgen = db.prepare(`SELECT 1 FROM agen WHERE nohp = ?`).get(nohp)
  const inNomor = db.prepare(`SELECT 1 FROM agen_nomor WHERE nohp = ?`).get(nohp)
  return Boolean(inAgen || inNomor)
}

// ---- transaksi stats ----
export function transaksiStats(agenId) {
  const today = new Date().toISOString().slice(0, 10)
  const proses = db.prepare(`SELECT COUNT(*) AS c FROM transaksi WHERE agen_id = ? AND status = 'proses'`).get(agenId).c
  const hariIni = db
    .prepare(`SELECT COALESCE(SUM(harga_efektif), 0) AS s FROM transaksi WHERE agen_id = ? AND created_at >= ? AND status IN ('sukses','proses')`)
    .get(agenId, today).s
  return { proses, hariIni }
}
