import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { config, sessionPath } from './config.js'
import { listSessions } from './registry.js'
import { ownerReportCode, reportCode } from './reportcode.js'

// Read-only report API. Opens each session DB read-only: the bot's own process
// owns writes, and a report request must never migrate or lock a live DB.
const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'report.html')

const DAY_MS = 86400000
const iso = (d) => d.toISOString().slice(0, 10)

function dayRange(from, to) {
  const end = new Date(`${to}T00:00:00.000Z`)
  return { from: `${from}T00:00:00.000Z`, toExclusive: new Date(end.getTime() + DAY_MS).toISOString() }
}

function defaultRange() {
  const now = new Date()
  const from = new Date(now.getTime() - 6 * DAY_MS)
  return { from: iso(from), to: iso(now) }
}

function openSession(sessionId) {
  // Reject anything that could walk the filesystem.
  if (!/^[a-z0-9_-]+$/i.test(String(sessionId ?? ''))) return null
  const path = sessionPath(sessionId)
  if (!existsSync(path)) return null
  return new DatabaseSync(path, { readOnly: true })
}

function inList(ids) {
  return ids.map(() => '?').join(',')
}

// db helpers live on openDb() instances; these DBs are opened raw (read-only).
const descendantsRaw = (db, agenId) =>
  db
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

const scopeIds = (db, viewer) => (viewer ? [viewer.id, ...descendantsRaw(db, viewer.id)] : [0])

// `ids` = agen rows in scope. `selfOnly` = viewer is a mitra/downline: they see
// only their own numbers — never modal, admin profit, komisi jaringan, uplink.
function report(db, range, ids, selfOnly = false) {
  const { from, toExclusive } = range
  const scope = [from, toExclusive, ...ids]
  const tScope = `AND agen_id IN (${inList(ids)})`

  const kpi = db
    .prepare(
      `SELECT COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif),0) AS omzet,
              COALESCE(SUM(harga_modal),0) AS modal,
              COALESCE(SUM(markup_admin),0) AS profit,
              COALESCE(SUM(markup_total - markup_admin),0) AS komisi
         FROM transaksi
        WHERE status = 'sukses' AND created_at >= ? AND created_at < ? ${tScope}`
    )
    .get(...scope)
  if (selfOnly) {
    // The admin's markup on this mitra's purchases is the admin's business.
    kpi.modal = 0
    kpi.profit = 0
    kpi.komisi = 0
  }
  kpi.margin = kpi.omzet && !selfOnly ? Math.round((kpi.profit / kpi.omzet) * 1000) / 10 : 0

  const status = Object.fromEntries(
    db
      .prepare(`SELECT status, COUNT(*) AS n FROM transaksi WHERE created_at >= ? AND created_at < ? ${tScope} GROUP BY status`)
      .all(...scope)
      .map((r) => [r.status, r.n])
  )

  const daily = db
    .prepare(
      `SELECT substr(created_at,1,10) AS day, COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif),0) AS omzet,
              COALESCE(SUM(markup_admin),0) AS profit
         FROM transaksi
        WHERE status = 'sukses' AND created_at >= ? AND created_at < ? ${tScope}
        GROUP BY day ORDER BY day`
    )
    .all(...scope)
  if (selfOnly) for (const d of daily) d.profit = 0

  const topProducts = db
    .prepare(
      `SELECT produk_kode AS kode, COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif),0) AS omzet,
              COALESCE(SUM(markup_admin),0) AS profit
         FROM transaksi
        WHERE status = 'sukses' AND created_at >= ? AND created_at < ? ${tScope}
        GROUP BY produk_kode ORDER BY trx DESC, omzet DESC LIMIT 8`
    )
    .all(...scope)
  if (selfOnly) for (const p of topProducts) p.profit = 0

  // Only downlines are listed: the admin row itself carries no transactions
  // (every order belongs to a mitra) and its "profit" is the KPI above.
  const agen = db
    .prepare(
      `SELECT a.id, a.kode, a.nama, a.kota, a.saldo, a.komisi, a.aktif, a.senior_id,
              COUNT(t.id) AS trx,
              COALESCE(SUM(t.harga_efektif),0) AS omzet,
              COALESCE(SUM(t.markup_admin),0) AS profit
         FROM agen a
         LEFT JOIN transaksi t ON t.agen_id = a.id
              AND t.status = 'sukses' AND t.created_at >= ? AND t.created_at < ?
        WHERE a.id IN (${inList(ids)}) AND a.senior_id IS NOT NULL
        GROUP BY a.id ORDER BY profit DESC, omzet DESC`
    )
    .all(from, toExclusive, ...ids)
  if (selfOnly) for (const a of agen) a.profit = 0

  const deposits = db
    .prepare(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM deposit
        WHERE created_at >= ? AND created_at < ? ${tScope} GROUP BY status`
    )
    .all(...scope)

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM transaksi WHERE status = 'proses' ${tScope}`)
    .get(...ids).n
  const unconfirmed = db
    .prepare(`SELECT COUNT(*) AS n FROM deposit WHERE status = 'pending' ${tScope}`)
    .get(...ids).n

  return { kpi, status, daily, topProducts, agen, deposits, pending, unconfirmed }
}

// Uplink chain above the viewer (empty for the session admin) + komisi that
// already flowed up to each of them from this viewer's network.
function network(db, viewer, ids, range) {
  if (!viewer) return { uplinks: [], komisiDiterima: 0, komisiTrx: 0 }
  const chain = db
    .prepare(
      `WITH RECURSIVE anc(id, senior_id, kode, nama, markup, saldo, komisi, depth) AS (
         SELECT id, senior_id, kode, nama, markup, saldo, komisi, 0 FROM agen WHERE id = ?
         UNION ALL
         SELECT a.id, a.senior_id, a.kode, a.nama, a.markup, a.saldo, a.komisi, anc.depth + 1
           FROM agen a JOIN anc ON a.id = anc.senior_id
       )
       SELECT * FROM anc WHERE depth > 0 ORDER BY depth`
    )
    .all(viewer.id)

  const komisiRows = db
    .prepare(
      `SELECT agen_id, COUNT(*) AS n, COALESCE(SUM(nominal),0) AS total FROM mutasi
        WHERE tipe = 'komisi_masuk' AND created_at >= ? AND created_at < ?
          AND agen_id IN (${inList(ids)})
        GROUP BY agen_id`
    )
    .all(range.from, range.toExclusive, ...ids)
  const byId = new Map(komisiRows.map((r) => [r.agen_id, r]))

  const chainWith = chain.map((a) => ({
    ...a,
    komisiMasuk: byId.get(a.id)?.total ?? 0,
    komisiTrx: byId.get(a.id)?.n ?? 0,
  }))

  // Komisi the viewer itself has received (from its own downlines).
  const selfKomisi = db
    .prepare(
      `SELECT COALESCE(SUM(nominal),0) AS total, COUNT(*) AS n FROM mutasi
        WHERE agen_id = ? AND tipe = 'komisi_masuk' AND created_at >= ? AND created_at < ?`
    )
    .get(viewer.id, range.from, range.toExclusive)

  return { uplinks: chainWith, komisiDiterima: selfKomisi.total, komisiTrx: selfKomisi.n }
}

function viewerFrom(db, url) {
  const kode = url.searchParams.get('viewer') || url.searchParams.get('admin') || ''
  const byKode = db.prepare(`SELECT * FROM agen WHERE kode = ?`).get(String(kode).toUpperCase())
  if (byKode) return byKode
  return db.prepare(`SELECT * FROM agen WHERE senior_id IS NULL ORDER BY id LIMIT 1`).get()
}

// Resolve a per-user report code back to (session, viewer). Codes are derived
// from the agen list, so a code cannot be minted for an agen that never existed.
export function resolveReportCode(code) {
  const want = String(code ?? '').toLowerCase()
  if (!/^[a-z0-9]{6,16}$/.test(want)) return null
  // Owner link: OWNER_REPORT_SESSION, else the session whose id is literally
  // "owner" (its registry row carries no admin_nohp). pin_owner=true keeps the
  // client from pinning a viewer: it renders the session admin view instead.
  const ownerIds = [config.ownerReportSession, 'owner'].filter(Boolean)
  const ownerId = ownerIds.find((x) => ownerReportCode(x) === want)
  if (ownerId) return { session: ownerId, owner: true, pin_owner: true }
  for (const s of listSessions()) {
    const db = openSession(s.id)
    if (!db) continue
    try {
      for (const a of db.prepare(`SELECT id, kode FROM agen`).all()) {
        if (reportCode(s.id, a.kode) === want) return { session: s.id, kode: a.kode }
      }
    } finally {
      db.close()
    }
  }
  return null
}

function query(req, res, url, forced = null) {
  const session = forced ? forced.session : url.searchParams.get('session')
  const db = openSession(session)
  if (!db) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'session tidak ditemukan' }))
    return
  }
  try {
    const route = url.pathname
    if (!/^\/api\/(report|transaksi|mutasi|deposit)$/.test(route)) {
      res.writeHead(404).end()
      return
    }
    // A per-user link pins the viewer: ?viewer= cannot widen the scope.
    // An owner link pins nothing: it falls back to the session admin.
    // A session without any agen (the owner session) has no agen row at all:
    // an owner link still renders, with an empty report.
    const ownerLink = Boolean(forced?.owner)
    const viewer = forced && !ownerLink
      ? db.prepare(`SELECT * FROM agen WHERE kode = ?`).get(forced.kode)
      : viewerFrom(db, url)
    if (!viewer && !ownerLink) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'agen tidak ditemukan di session ini' }))
      return
    }
    const ids = scopeIds(db, viewer)
    // Only the session admin (root agen) may see the whole network and its
    // margins. Every mitra — even one with its own downlines — sees itself only.
    // No agen row at all = the owner session: whole session, admin view.
    const admin = !viewer || !viewer.senior_id
    const selfOnly = Boolean(viewer) && !admin
    const own = viewer ? (selfOnly ? [viewer.id] : ids) : [0]
    const def = defaultRange()
    const from = url.searchParams.get('from') || def.from
    const to = url.searchParams.get('to') || def.to
    const range = dayRange(from, to)
    const out = {
      session,
      viewer: viewer
        ? { kode: viewer.kode, nama: viewer.nama, saldo: viewer.saldo, komisi: viewer.komisi }
        : { kode: 'OWNER', nama: session, saldo: 0, komisi: 0 },
      admin,
      owner: Boolean(forced?.owner),
      from,
      to,
    }

    if (route === '/api/report') {
      Object.assign(out, report(db, range, own, selfOnly))
      // Uplink/komisi jaringan is admin-only information.
      if (admin) out.network = network(db, viewer, ids, range)
    }

    if (route === '/api/transaksi') {
      const status = url.searchParams.get('status')
      const q = (url.searchParams.get('q') || '').trim()
      const agenKode = url.searchParams.get('agen')
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)))
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
      const where = ['t.created_at >= ?', 't.created_at < ?', `t.agen_id IN (${inList(own)})`]
      const params = [range.from, range.toExclusive, ...own]
      if (status) {
        where.push('t.status = ?')
        params.push(status)
      }
      if (agenKode) {
        where.push('a.kode = ?')
        params.push(agenKode.toUpperCase())
      }
      if (q) {
        where.push('(t.id_trx LIKE ? OR t.tujuan LIKE ? OR t.produk_kode LIKE ? OR a.kode LIKE ?)')
        const like = `%${q}%`
        params.push(like, like, like, like)
      }
      const w = `WHERE ${where.join(' AND ')}`
      out.total = db
        .prepare(`SELECT COUNT(*) AS n FROM transaksi t LEFT JOIN agen a ON a.id = t.agen_id ${w}`)
        .get(...params).n
      out.rows = db
        .prepare(
          `SELECT t.*, a.kode AS agen_kode, a.nama AS agen_nama
             FROM transaksi t LEFT JOIN agen a ON a.id = t.agen_id
             ${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset)
      // A mitra never sees the admin's markup or modal cost on its own purchases.
      if (selfOnly) for (const t of out.rows) { t.harga_modal = 0; t.markup_admin = 0; t.markup_total = 0 }
      out.limit = limit
      out.offset = offset
    }

    if (route === '/api/mutasi') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)))
      out.rows = db
        .prepare(
          `SELECT m.*, a.kode AS agen_kode, a.nama AS agen_nama
             FROM mutasi m LEFT JOIN agen a ON a.id = m.agen_id
            WHERE m.created_at >= ? AND m.created_at < ? AND m.agen_id IN (${inList(own)})
            ORDER BY m.id DESC LIMIT ?`
        )
        .all(range.from, range.toExclusive, ...own, limit)
    }

    if (route === '/api/deposit') {
      const status = url.searchParams.get('status')
      const where = ['d.created_at >= ?', 'd.created_at < ?', `d.agen_id IN (${inList(own)})`]
      const params = [range.from, range.toExclusive, ...own]
      if (status) {
        where.push('d.status = ?')
        params.push(status)
      }
      out.rows = db
        .prepare(
          `SELECT d.*, a.kode AS agen_kode, a.nama AS agen_nama
             FROM deposit d LEFT JOIN agen a ON a.id = d.agen_id
            WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 300`
        )
        .all(...params)
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err?.message }))
  } finally {
    db.close()
  }
}

function allowed(req, url) {
  const token = config.reportToken
  if (token) return url.searchParams.get('token') === token
  // No token configured: only the loopback interface may read the reports.
  const ip = req.socket.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

// Owner (super admin) sees every session, never its own. Everyone else is
// resolved inside their session and only sees their own network.
// Sessions with an admin (= toko). The owner's own session has none, so it is
// never listed: the owner sees every admin session but has no report of its own.
function sessionsFor() {
  return listSessions()
    .filter((s) => String(s.admin_nohp || '') !== '')
    .map((s) => ({ id: s.id, label: s.label, admin_nohp: s.admin_nohp, wa_nohp: s.wa_nohp, status: s.status }))
}

export function startReportServer(logger) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    // Per-user link: /<kode>/report. The code itself is the credential (it is
    // scoped to one agen), so the dashboard is served and its API calls use the
    // code's own session + viewer — the generic token check does not apply.
    const userLink = url.pathname.match(/^\/([a-z0-9]{6,16})\/report\/?$/i)
    if (userLink) {
      const resolved = resolveReportCode(userLink[1])
      if (!resolved) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('kode report tidak dikenal')
        return
      }
      if (url.searchParams.get('api')) {
        const apiUrl = new URL(url)
        apiUrl.pathname = `/api/${url.searchParams.get('api')}`
        return query(req, res, apiUrl, resolved)
      }
      try {
        const html = readFileSync(HTML_PATH, 'utf8').replace(
          '<title>',
          `<script>window.__REPORT_PIN=${JSON.stringify(resolved).replaceAll('<', '\\u003c')};</script><title>`
        )
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
      } catch {
        res.writeHead(500).end('web/report.html tidak ditemukan')
      }
      return
    }
    if (!allowed(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized: set REPORT_TOKEN atau akses dari localhost')
      return
    }
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(sessionsFor()))
      return
    }
    if (url.pathname === '/api/viewers') {
      const session = url.searchParams.get('session')
      const db = openSession(session)
      if (!db) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'session tidak ditemukan' }))
        return
      }
      try {
        const rows = db
          .prepare(
            `SELECT id, kode, nama, kota, senior_id, aktif FROM agen
              ORDER BY CASE WHEN senior_id IS NULL THEN 0 ELSE 1 END, kode`
          )
          .all()
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(rows))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err?.message }))
      } finally {
        db.close()
      }
      return
    }
    if (url.pathname.startsWith('/api/')) return query(req, res, url)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(readFileSync(HTML_PATH))
      } catch {
        res.writeHead(500).end('web/report.html tidak ditemukan')
      }
      return
    }
    res.writeHead(404).end()
  })
  server.on('error', (err) => logger.error({ err: err?.message, port: config.reportPort }, 'report server error'))
  server.listen(config.reportPort, config.reportHost, () => {
    logger.info({ port: config.reportPort, host: config.reportHost, token: Boolean(config.reportToken) }, 'report server listening')
  })
  return server
}

// Kept for tests: same aggregation without going through HTTP.
export function sessionReport(sessionId, { from, to, viewer } = {}) {
  const db = openSession(sessionId)
  if (!db) return null
  try {
    const def = defaultRange()
    const v = viewer
      ? db.prepare(`SELECT * FROM agen WHERE kode = ?`).get(String(viewer).toUpperCase())
      : db.prepare(`SELECT * FROM agen WHERE senior_id IS NULL ORDER BY id LIMIT 1`).get()
    if (!v) return null
    const ids = scopeIds(db, v)
    const admin = !v.senior_id
    const range = dayRange(from || def.from, to || def.to)
    const body = report(db, range, admin ? ids : [v.id], !admin)
    return {
      ...body,
      ...(admin ? { network: network(db, v, ids, range) } : {}),
      admin,
      viewer: { kode: v.kode, nama: v.nama },
    }
  } finally {
    db.close()
  }
}
