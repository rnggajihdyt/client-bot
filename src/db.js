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

CREATE TABLE IF NOT EXISTS deposit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_deposit TEXT UNIQUE NOT NULL,
  agen_id INTEGER NOT NULL REFERENCES agen(id),
  nominal INTEGER NOT NULL,
  kode_unik INTEGER NOT NULL,
  total INTEGER NOT NULL,
  bank TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  selesai_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deposit_agen ON deposit(agen_id);
CREATE INDEX IF NOT EXISTS idx_deposit_status ON deposit(status);
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
  deposit: {
    bank: `ALTER TABLE deposit ADD COLUMN bank TEXT NOT NULL DEFAULT ''`,
    selesai_at: `ALTER TABLE deposit ADD COLUMN selesai_at TEXT NOT NULL DEFAULT ''`,
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

  function priceWithNodes(p, nodes) {
    const root = nodes[nodes.length - 1]
    const baseAdminMarkup = p.markup != null ? p.markup : root ? root.markup : 0
    // Markup on Admin's direct child (A in [C, B, A, Admin]) was set by Admin
    // via DAFTAR/MP, so it belongs to Admin's profit — never commission.
    const directChild = root && root.senior_id == null && nodes.length >= 2 ? nodes[nodes.length - 2] : null
    const resellerMarkup = directChild ? directChild.markup : 0
    const adminMarkup = baseAdminMarkup + resellerMarkup
    const chainMarkup = nodes.slice(0, -1).reduce((s, a) => s + a.markup, 0)
    const markupTotal = baseAdminMarkup + chainMarkup
    const networkMarkup = markupTotal - adminMarkup
    return {
      ...p,
      baseAdminMarkup,
      resellerMarkup,
      adminMarkup,
      networkMarkup,
      markupTotal,
      hargaEfektif: p.harga_modal + markupTotal,
    }
  }

  // Effective price = modal + admin markup (per-product override, else general)
  // + sum of markup along the non-root path. Includes inactive/empty products
  // so CH can show their price + status and BELI can report "gangguan/kosong"
  // instead of "tidak ditemukan".
  db.effectivePrice = (agenId, kodeProduk) => {
    const p = raw.prepare(`SELECT * FROM produk WHERE UPPER(kode) = UPPER(?)`).get(kodeProduk)
    if (!p) return undefined
    return priceWithNodes(p, db.chain(agenId))
  }

  // Search products: exact category match (from ICS `type`) takes priority so
  // e.g. CH.AX.1 returns only `AX` (not `AXP`), then falls back to prefix match
  // on `kode` or `kategori` (e.g. CH.CNDPLN.1, CH.AXLK.1).
  db.searchEffectivePrices = (agenId, query) => {
    const q = String(query ?? '').trim().toUpperCase()
    if (!q) return []
    let rows = raw
      .prepare(`SELECT * FROM produk WHERE UPPER(kategori) = ? ORDER BY harga_modal ASC, kode ASC`)
      .all(q)
    if (!rows.length) {
      const escaped = q.replace(/[\\%_]/g, '\\$&')
      const prefix = `${escaped}%`
      rows = raw
        .prepare(
          `SELECT * FROM produk
           WHERE UPPER(kode) LIKE ? ESCAPE '\\' OR UPPER(kategori) LIKE ? ESCAPE '\\'
           ORDER BY harga_modal ASC, kode ASC`
        )
        .all(prefix, prefix)
    }
    if (!rows.length) return []
    const nodes = db.chain(agenId)
    return rows.map((p) => priceWithNodes(p, nodes))
  }

  db.listKategori = () =>
    raw
      .prepare(`SELECT DISTINCT kategori FROM produk WHERE kategori != '' ORDER BY kategori`)
      .all()
      .map((r) => r.kategori)

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

  // Upsert from a supplier sync: price/status/stock follow ICS, kategori follows
  // ICS `type` (uppercase, fallback to `category`), markup stays untouched.
  db.upsertProdukIcs = ({ code, name, price, type, category, status, stock }) => {
    const kat = String(type || category || '')
      .trim()
      .toUpperCase()
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
      .run(code, name, price, kat, status === 'available' ? 1 : 0, stock ?? 0, status ?? 'available', new Date().toISOString())
  }

  // Mark products that vanished from ICS as inactive/removed without deleting
  // rows so historical transaksi foreign keys remain intact.
  db.markRemovedProduk = (activeCodes) => {
    const now = new Date().toISOString()
    const rows = raw.prepare(`SELECT kode, aktif, status_supplier FROM produk`).all()
    const upd = raw.prepare(`UPDATE produk SET aktif = 0, stok = 0, status_supplier = 'removed', updated_at = ? WHERE kode = ?`)
    let count = 0
    for (const r of rows) {
      if (!activeCodes.has(r.kode) && (r.aktif !== 0 || r.status_supplier !== 'removed')) {
        upd.run(now, r.kode)
        count += 1
      }
    }
    return count
  }

  // ---- per-session settings (ICS apikey, webhook token) ----
  db.getSetting = (key) => raw.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value
  db.setSetting = (key, value) =>
    raw
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, String(value))

  // ---- deposit tickets (TIKET / TPAY / BTL) ----
  db.insertDeposit = ({ idDeposit, agenId, nominal, kodeUnik, total, bank = '', status = 'pending' }) => {
    const { lastInsertRowid } = raw
      .prepare(
        `INSERT INTO deposit (id_deposit, agen_id, nominal, kode_unik, total, bank, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(idDeposit, agenId, nominal, kodeUnik, total, bank, status, new Date().toISOString())
    return lastInsertRowid
  }

  db.getDeposit = (idDeposit) => raw.prepare(`SELECT d.*, a.nohp AS agen_nohp, a.kode AS agen_kode FROM deposit d JOIN agen a ON a.id = d.agen_id WHERE d.id_deposit = ?`).get(idDeposit)

  // The mitra's still-open ticket (at most one at a time).
  db.pendingDepositOf = (agenId) =>
    raw.prepare(`SELECT * FROM deposit WHERE agen_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(agenId)

  // All open tickets in the session — admin's matching list.
  db.pendingDeposits = () =>
    raw
      .prepare(
        `SELECT d.*, a.kode AS agen_kode, a.nohp AS agen_nohp, a.nama AS agen_nama
           FROM deposit d JOIN agen a ON a.id = d.agen_id
          WHERE d.status = 'pending' ORDER BY d.id`
      )
      .all()

  db.setDepositStatus = (idDeposit, status) =>
    raw
      .prepare(`UPDATE deposit SET status = ?, selesai_at = ? WHERE id_deposit = ?`)
      .run(status, new Date().toISOString(), idDeposit).changes

  db.depositSettings = () => ({
    // Admin-configurable payment channels: "BCA|2390922089|Muhammad Tasin, BRI|011...|..."
    channels: (db.getSetting('deposit_channels') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [bank = '', no = '', an = ''] = s.split('|').map((x) => x.trim())
        return { bank, no, an }
      })
      .filter((c) => c.bank && c.no),
  })

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
                COALESCE(SUM(markup_total - markup_admin), 0) AS komisi,
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
        `SELECT t.*, a.nohp AS agen_nohp, a.kode AS agen_kode, a.senior_id AS agen_senior_id, p.nama AS produk_nama
         FROM transaksi t
         LEFT JOIN agen a ON a.id = t.agen_id
         LEFT JOIN produk p ON p.id = t.produk_id
         WHERE t.id_trx = ?`
      )
      .get(idTrx)

  // Latest transaction matching a destination number (with 08 <-> 628 fallback).
  // `agenIds` null = whole session (for admin); array = scoped to those agents.
  db.getLatestTransaksiByTujuan = (tujuan, agenIds = null) => {
    const rawTujuan = String(tujuan ?? '').trim()
    if (!rawTujuan) return undefined
    const ids = agenIds?.length ? agenIds : null
    const scope = ids ? `AND t.agen_id IN (${ids.map(() => '?').join(',')})` : ''
    const queryBy = (val) => {
      const params = ids ? [val, ...ids] : [val]
      return raw
        .prepare(
          `SELECT t.*, a.nohp AS agen_nohp, a.kode AS agen_kode
           FROM transaksi t LEFT JOIN agen a ON a.id = t.agen_id
           WHERE t.tujuan = ? ${scope}
           ORDER BY t.id DESC LIMIT 1`
        )
        .get(...params)
    }
    const exact = queryBy(rawTujuan)
    if (exact) return exact
    const digits = rawTujuan.replace(/\D/g, '')
    if (!digits) return undefined
    if (digits !== rawTujuan) {
      const byDigits = queryBy(digits)
      if (byDigits) return byDigits
    }
    const alt = digits.startsWith('0') ? '62' + digits.slice(1) : digits.startsWith('62') ? '0' + digits.slice(2) : ''
    return alt ? queryBy(alt) : undefined
  }

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
