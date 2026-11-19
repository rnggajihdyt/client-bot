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
  markup INTEGER,
  kategori TEXT NOT NULL DEFAULT '',
  aktif INTEGER NOT NULL DEFAULT 1,
  stok INTEGER NOT NULL DEFAULT 0,
  status_supplier TEXT NOT NULL DEFAULT 'available',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_trx TEXT UNIQUE NOT NULL,
  agen_id INTEGER NOT NULL REFERENCES agen(id),
  produk_id INTEGER REFERENCES produk(id),
  produk_kode TEXT NOT NULL DEFAULT '',
  tujuan TEXT NOT NULL DEFAULT '',
  harga_modal INTEGER NOT NULL DEFAULT 0,
  markup_admin INTEGER NOT NULL DEFAULT 0,
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

// Additive migrations: SQLite has no "ADD COLUMN IF NOT EXISTS".
const MIGRATIONS = {
  transaksi: {
    produk_kode: `ALTER TABLE transaksi ADD COLUMN produk_kode TEXT NOT NULL DEFAULT ''`,
    harga_modal: `ALTER TABLE transaksi ADD COLUMN harga_modal INTEGER NOT NULL DEFAULT 0`,
    markup_admin: `ALTER TABLE transaksi ADD COLUMN markup_admin INTEGER NOT NULL DEFAULT 0`,
    markup_total: `ALTER TABLE transaksi ADD COLUMN markup_total INTEGER NOT NULL DEFAULT 0`,
    sn: `ALTER TABLE transaksi ADD COLUMN sn TEXT NOT NULL DEFAULT ''`,
    supplier_trxid: `ALTER TABLE transaksi ADD COLUMN supplier_trxid TEXT NOT NULL DEFAULT ''`,
    selesai_at: `ALTER TABLE transaksi ADD COLUMN selesai_at TEXT NOT NULL DEFAULT ''`,
  },
  produk: {
    markup: `ALTER TABLE produk ADD COLUMN markup INTEGER`,
    stok: `ALTER TABLE produk ADD COLUMN stok INTEGER NOT NULL DEFAULT 0`,
    status_supplier: `ALTER TABLE produk ADD COLUMN status_supplier TEXT NOT NULL DEFAULT 'available'`,
    updated_at: `ALTER TABLE produk ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
  },
}

function migrate(raw) {
  for (const [table, cols] of Object.entries(MIGRATIONS)) {
    const have = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    for (const [name, sql] of Object.entries(cols)) {
      if (!have.includes(name)) raw.exec(sql)
    }
  }
}

// One DB handle per session (`.data/sessions/<id>.sqlite`). Nothing is shared
// between sessions, so a per-session filter can never be forgotten.
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true })
  const raw = new DatabaseSync(path)
  raw.exec(SCHEMA)
  migrate(raw)

  const db = { raw, path, close: () => raw.close() }

  db.tx = (fn) => {
    raw.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      raw.exec('COMMIT')
      return r
    } catch (e) {
      raw.exec('ROLLBACK')
      throw e
    }
  }

  // ---- kode generator: 'OWN' (root, 2 digit) | 'RS' (mitra, 5 digit) ----
  db.nextKode = (type) => {
    const prefix = type === 'OWN' ? 'OWN' : 'RS'
    const width = type === 'OWN' ? 2 : 5
    const row = raw
      .prepare(`SELECT kode FROM agen WHERE kode LIKE ? ORDER BY kode DESC LIMIT 1`)
      .get(prefix + '%')
    let n = 0
    if (row) {
      const m = row.kode.match(new RegExp(`^${prefix}(\\d+)$`))
      if (m) n = parseInt(m[1], 10)
    }
    return prefix + String(n + 1).padStart(width, '0')
  }

  db.createAgen = ({ nama, kota, nohp, seniorId, markup, pin }) => {
    const kode = db.nextKode(seniorId == null ? 'OWN' : 'RS')
    const { lastInsertRowid } = raw
      .prepare(
        `INSERT INTO agen (kode, nama, kota, nohp, senior_id, markup, pin_hash, aktif, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(kode, nama, kota, nohp, seniorId, markup, hashPin(pin), new Date().toISOString())
    return { id: lastInsertRowid, kode }
  }

  // ---- lookup ----
  db.findAgenByNohp = (nohp) => {
    const d = String(nohp).split('@')[0].split(':')[0].replace(/\D/g, '')
    if (!d) return undefined
    const row = raw.prepare(`SELECT * FROM agen WHERE nohp = ?`).get(d)
    if (row) return row
    return raw
      .prepare(`SELECT a.* FROM agen_nomor n JOIN agen a ON a.id = n.agen_id WHERE n.nohp = ?`)
      .get(d)
  }

  db.findAgenById = (id) => raw.prepare(`SELECT * FROM agen WHERE id = ?`).get(id)
  db.findAgenByKode = (kode) => raw.prepare(`SELECT * FROM agen WHERE kode = ?`).get(kode)

  db.downlines = (agenId) =>
    raw.prepare(`SELECT * FROM agen WHERE senior_id = ? ORDER BY kode`).all(agenId)

  db.countDownlines = (agenId) =>
    raw.prepare(`SELECT COUNT(*) AS c FROM agen WHERE senior_id = ?`).get(agenId).c

  // Self-first chain up to the root.
  db.chain = (agenId) =>
    raw
      .prepare(
        `WITH RECURSIVE anc(id, senior_id, kode, markup, saldo) AS (
           SELECT id, senior_id, kode, markup, saldo FROM agen WHERE id = ?
           UNION ALL
           SELECT a.id, a.senior_id, a.kode, a.markup, a.saldo
           FROM agen a JOIN anc ON a.id = anc.senior_id
         )
         SELECT * FROM anc`
      )
      .all(agenId)

  db.ancestors = (agenId) => db.chain(agenId).filter((a) => a.id !== agenId)

  // Every mitra below `agenId`, any depth.
  db.descendants = (agenId) =>
    raw
      .prepare(
        `WITH RECURSIVE d(id) AS (
           SELECT id FROM agen WHERE senior_id = ?
           UNION ALL
           SELECT a.id FROM agen a JOIN d ON a.senior_id = d.id
         )
         SELECT id FROM d`
      )
      .all(agenId)
      .map((r) => r.id)

  db.root = () => raw.prepare(`SELECT * FROM agen WHERE senior_id IS NULL ORDER BY id LIMIT 1`).get()

  // Total markup of the mitra (root excluded), per-product override first.
  db.markupTotal = (agenId) => {
    const nodes = db.chain(agenId)
    if (!nodes.length) return 0
    return nodes.slice(0, -1).reduce((s, a) => s + a.markup, 0)
  }

  // Effective price = modal + admin markup (per-product override, else general)
  // + sum of markup along the non-root path.
  db.effectivePrice = (agenId, kodeProduk) => {
    const p = raw.prepare(`SELECT * FROM produk WHERE kode = ? AND aktif = 1`).get(kodeProduk)
    if (!p) return undefined
    const nodes = db.chain(agenId)
    const root = nodes[nodes.length - 1]
    const adminMarkup = p.markup != null ? p.markup : root ? root.markup : 0
    const chainMarkup = nodes.slice(0, -1).reduce((s, a) => s + a.markup, 0)
    const markupTotal = adminMarkup + chainMarkup
    return { ...p, adminMarkup, markupTotal, hargaEfektif: p.harga_modal + markupTotal }
  }

  // ---- produk ----
  db.upsertProduk = ({ kode, nama, hargaModal, kategori = '' }) => {
    raw
      .prepare(
        `INSERT INTO produk (kode, nama, harga_modal, kategori) VALUES (?, ?, ?, ?)
         ON CONFLICT(kode) DO UPDATE SET nama = excluded.nama, harga_modal = excluded.harga_modal, kategori = excluded.kategori`
      )
      .run(kode, nama, hargaModal, kategori)
  }

  db.setProdukMarkup = (kode, markup) =>
    raw.prepare(`UPDATE produk SET markup = ? WHERE kode = ?`).run(markup, kode).changes

  db.listProduk = () => raw.prepare(`SELECT * FROM produk ORDER BY kategori, kode`).all()

  // Upsert from a supplier sync: price/status/stock follow ICS, markup stays.
  db.upsertProdukIcs = ({ code, name, price, category, status, stock }) => {
    raw
      .prepare(
        `INSERT INTO produk (kode, nama, harga_modal, kategori, aktif, stok, status_supplier, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kode) DO UPDATE SET
           nama = excluded.nama,
           harga_modal = excluded.harga_modal,
           kategori = excluded.kategori,
           aktif = excluded.aktif,
           stok = excluded.stok,
           status_supplier = excluded.status_supplier,
           updated_at = excluded.updated_at`
      )
      .run(code, name, price, category ?? '', status === 'available' ? 1 : 0, stock ?? 0, status ?? 'available', new Date().toISOString())
  }

  // ---- per-session settings (ICS apikey, webhook token) ----
  db.getSetting = (key) => raw.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value
  db.setSetting = (key, value) =>
    raw
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, String(value))

  // ---- mutasi ----
  db.addMutasi = (agenId, tipe, nominal, saldoAkhir, keterangan = '') =>
    raw
      .prepare(`INSERT INTO mutasi (agen_id, tipe, nominal, saldo_akhir, keterangan, created_at) VALUES (?,?,?,?,?,?)`)
      .run(agenId, tipe, nominal, saldoAkhir, keterangan, new Date().toISOString())

  db.mutasiOf = (agenId, limit = 20) =>
    raw.prepare(`SELECT * FROM mutasi WHERE agen_id = ? ORDER BY id DESC LIMIT ?`).all(agenId, limit)

  // ---- agen mutations ----
  const ALLOWED_FIELDS = ['nama', 'kota', 'markup', 'aktif', 'pin_hash']

  db.updateAgen = (id, fields) => {
    const entries = Object.entries(fields).filter(([k]) => ALLOWED_FIELDS.includes(k))
    if (!entries.length) return
    const set = entries.map(([k]) => `${k} = ?`).join(', ')
    raw.prepare(`UPDATE agen SET ${set} WHERE id = ?`).run(...entries.map(([, v]) => v), id)
  }

  db.setSaldoKomisi = (id, saldo, komisi) =>
    raw.prepare(`UPDATE agen SET saldo = ?, komisi = ? WHERE id = ?`).run(saldo, komisi, id)

  db.addSaldo = (id, delta) => raw.prepare(`UPDATE agen SET saldo = saldo + ? WHERE id = ?`).run(delta, id)
  db.addKomisi = (id, delta) => raw.prepare(`UPDATE agen SET komisi = komisi + ? WHERE id = ?`).run(delta, id)

  db.insertTransaksi = ({
    idTrx,
    agenId,
    produkId,
    produkKode,
    tujuan,
    hargaModal,
    markupAdmin,
    markupTotal,
    hargaEfektif,
    komisiDibagikan,
    status,
  }) =>
    raw
      .prepare(
        `INSERT INTO transaksi (id_trx, agen_id, produk_id, produk_kode, tujuan, harga_modal, markup_admin, markup_total, harga_efektif, komisi_dibagikan, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        idTrx,
        agenId,
        produkId,
        produkKode,
        tujuan,
        hargaModal,
        markupAdmin,
        markupTotal,
        hargaEfektif,
        JSON.stringify(komisiDibagikan),
        status,
        new Date().toISOString()
      )

  // Successful transactions in [from, to). `agenIds` null = whole session.
  db.profitSummary = ({ agenIds = null, from, to } = {}) => {
    const ids = agenIds?.length ? agenIds : null
    const scope = ids ? `AND agen_id IN (${ids.map(() => '?').join(',')})` : ''
    const params = ids ? [from, to, ...ids] : [from, to]
    return raw
      .prepare(
        `SELECT COUNT(*) AS trx,
                COALESCE(SUM(harga_efektif), 0) AS omzet,
                COALESCE(SUM(harga_modal), 0) AS modal,
                COALESCE(SUM(markup_admin), 0) AS profit,
                COALESCE(SUM(markup_total), 0) AS markup
         FROM transaksi
         WHERE status = 'sukses' AND created_at >= ? AND created_at < ? ${scope}`
      )
      .get(...params)
  }

  db.recentTransaksi = ({ agenIds = null, from, to, limit = 10 } = {}) => {
    const ids = agenIds?.length ? agenIds : null
    const scope = ids ? `AND t.agen_id IN (${ids.map(() => '?').join(',')})` : ''
    const params = ids ? [from, to, ...ids, limit] : [from, to, limit]
    return raw
      .prepare(
        `SELECT t.*, a.kode AS agen_kode FROM transaksi t
         LEFT JOIN agen a ON a.id = t.agen_id
         WHERE t.status = 'sukses' AND t.created_at >= ? AND t.created_at < ? ${scope}
         ORDER BY t.id DESC LIMIT ?`
      )
      .all(...params)
  }

  // Commission credited to one agen (used for uplink network reports).
  db.commissionEarned = (agenId, from, to) =>
    raw
      .prepare(
        `SELECT COALESCE(SUM(nominal), 0) AS s FROM mutasi
         WHERE agen_id = ? AND tipe = 'komisi_masuk' AND created_at >= ? AND created_at < ?`
      )
      .get(agenId, from, to).s

  db.deleteAgen = (id) => {
    raw.prepare(`DELETE FROM agen_nomor WHERE agen_id = ?`).run(id)
    raw.prepare(`DELETE FROM agen WHERE id = ?`).run(id)
  }

  db.addNomor = (agenId, nohp) =>
    raw.prepare(`INSERT INTO agen_nomor (agen_id, nohp) VALUES (?, ?)`).run(agenId, nohp)

  db.removeNomor = (agenId, nohp) =>
    raw.prepare(`DELETE FROM agen_nomor WHERE agen_id = ? AND nohp = ?`).run(agenId, nohp).changes

  db.nomorOf = (agenId) =>
    raw.prepare(`SELECT nohp FROM agen_nomor WHERE agen_id = ? ORDER BY id`).all(agenId).map((r) => r.nohp)

  db.nomorTaken = (nohp) =>
    Boolean(
      raw.prepare(`SELECT 1 FROM agen WHERE nohp = ?`).get(nohp) ||
        raw.prepare(`SELECT 1 FROM agen_nomor WHERE nohp = ?`).get(nohp)
    )

  db.transaksiStats = (agenId) => {
    const today = new Date().toISOString().slice(0, 10)
    const proses = raw.prepare(`SELECT COUNT(*) AS c FROM transaksi WHERE agen_id = ? AND status = 'proses'`).get(agenId).c
    const hariIni = raw
      .prepare(`SELECT COALESCE(SUM(harga_efektif), 0) AS s FROM transaksi WHERE agen_id = ? AND created_at >= ? AND status IN ('sukses','proses')`)
      .get(agenId, today).s
    return { proses, hariIni }
  }

  // ---- supplier transaction lifecycle ----
  db.getTransaksi = (idTrx) =>
    raw
      .prepare(
        `SELECT t.*, a.nohp AS agen_nohp, a.kode AS agen_kode
         FROM transaksi t LEFT JOIN agen a ON a.id = t.agen_id
         WHERE t.id_trx = ?`
      )
      .get(idTrx)

  db.setTransaksiStatus = (idTrx, status) =>
    raw.prepare(`UPDATE transaksi SET status = ? WHERE id_trx = ?`).run(status, idTrx).changes

  db.setTransaksiSupplier = (idTrx, { supplierTrxId = '', sn = '', selesaiAt = '' }) =>
    raw
      .prepare(
        `UPDATE transaksi SET supplier_trxid = ?, sn = ?, selesai_at = ? WHERE id_trx = ?`
      )
      .run(supplierTrxId, sn, selesaiAt, idTrx).changes

  // Pending rows the cron polls against ICS.
  db.pendingTransaksi = (olderThanMs = 60_000, limit = 25) => {
    const cut = new Date(Date.now() - olderThanMs).toISOString()
    return raw
      .prepare(`SELECT * FROM transaksi WHERE status = 'proses' AND created_at <= ? ORDER BY id LIMIT ?`)
      .all(cut, limit)
  }

  db.pendingTransaksiOf = (agenId, limit = 20) =>
    raw
      .prepare(`SELECT * FROM transaksi WHERE agen_id = ? AND status = 'proses' ORDER BY id DESC LIMIT ?`)
      .all(agenId, limit)

  return db
}
