import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { config, sessionPath } from './config.js'
import { listSessions } from './registry.js'

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

function report(db, range) {
  const { from, toExclusive } = range
  const w = `WHERE created_at >= ? AND created_at < ?`
  const scope = [from, toExclusive]

  const kpi = db
    .prepare(
      `SELECT COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif),0) AS omzet,
              COALESCE(SUM(harga_modal),0) AS modal,
              COALESCE(SUM(markup_admin),0) AS profit,
              COALESCE(SUM(markup_total - markup_admin),0) AS komisi
         FROM transaksi WHERE status = 'sukses' AND created_at >= ? AND created_at < ?`
    )
    .get(...scope)
  kpi.margin = kpi.omzet ? Math.round((kpi.profit / kpi.omzet) * 1000) / 10 : 0

  const status = Object.fromEntries(
    db.prepare(`SELECT status, COUNT(*) AS n FROM transaksi ${w} GROUP BY status`).all(...scope).map((r) => [r.status, r.n])
  )

  const daily = db
    .prepare(
      `SELECT substr(created_at,1,10) AS day, COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif),0) AS omzet,
              COALESCE(SUM(markup_admin),0) AS profit
         FROM transaksi WHERE status = 'sukses' AND created_at >= ? AND created_at < ?
         GROUP BY day ORDER BY day`
    )
    .all(...scope)

  const topProducts = db
    .prepare(
      `SELECT produk_kode AS kode, COUNT(*) AS trx,
              COALESCE(SUM(harga_efektif),0) AS omzet,
              COALESCE(SUM(markup_admin),0) AS profit
         FROM transaksi WHERE status = 'sukses' AND created_at >= ? AND created_at < ?
         GROUP BY produk_kode ORDER BY trx DESC, omzet DESC LIMIT 8`
    )
    .all(...scope)

  const agen = db
    .prepare(
      `SELECT a.id, a.kode, a.nama, a.kota, a.saldo, a.komisi, a.aktif, a.senior_id,
              COUNT(t.id) AS trx,
              COALESCE(SUM(t.harga_efektif),0) AS omzet,
              COALESCE(SUM(t.markup_admin),0) AS profit
         FROM agen a
         LEFT JOIN transaksi t ON t.agen_id = a.id
              AND t.status = 'sukses' AND t.created_at >= ? AND t.created_at < ?
         GROUP BY a.id ORDER BY profit DESC, omzet DESC`
    )
    .all(...scope)

  const deposits = db
    .prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM deposit WHERE created_at >= ? AND created_at < ? GROUP BY status`)
    .all(...scope)

  const pending = db.prepare(`SELECT COUNT(*) AS n FROM transaksi WHERE status = 'proses'`).get().n
  const unconfirmed = db.prepare(`SELECT COUNT(*) AS n FROM deposit WHERE status = 'pending'`).get().n

  return { kpi, status, daily, topProducts, agen, deposits, pending, unconfirmed }
}

function query(req, res, url) {
  const session = url.searchParams.get('session')
  const db = openSession(session)
  if (!db) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'session tidak ditemukan' }))
    return
  }
  try {
    const route = url.pathname
    const def = defaultRange()
    const from = url.searchParams.get('from') || def.from
    const to = url.searchParams.get('to') || def.to
    const range = dayRange(from, to)
    const out = { session, from, to }

    if (route === '/api/report') Object.assign(out, report(db, range))

    if (route === '/api/transaksi') {
      const status = url.searchParams.get('status')
      const q = (url.searchParams.get('q') || '').trim()
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)))
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
      const where = ['t.created_at >= ?', 't.created_at < ?']
      const params = [range.from, range.toExclusive]
      if (status) {
        where.push('t.status = ?')
        params.push(status)
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
      out.limit = limit
      out.offset = offset
    }

    if (route === '/api/mutasi') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)))
      out.rows = db
        .prepare(
          `SELECT m.*, a.kode AS agen_kode, a.nama AS agen_nama
             FROM mutasi m LEFT JOIN agen a ON a.id = m.agen_id
            WHERE m.created_at >= ? AND m.created_at < ?
            ORDER BY m.id DESC LIMIT ?`
        )
        .all(range.from, range.toExclusive, limit)
    }

    if (route === '/api/deposit') {
      const status = url.searchParams.get('status')
      const where = ['d.created_at >= ?', 'd.created_at < ?']
      const params = [range.from, range.toExclusive]
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
    if (!/^\/api\/(report|transaksi|mutasi|deposit)$/.test(route)) {
      res.writeHead(404).end()
      return
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

export function startReportServer(logger) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!allowed(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized: set REPORT_TOKEN atau akses dari localhost')
      return
    }
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(
        JSON.stringify(listSessions().map((s) => ({ id: s.id, label: s.label, admin_nohp: s.admin_nohp, wa_nohp: s.wa_nohp, status: s.status })))
      )
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
export function sessionReport(sessionId, { from, to } = {}) {
  const db = openSession(sessionId)
  if (!db) return null
  try {
    const def = defaultRange()
    return report(db, dayRange(from || def.from, to || def.to))
  } finally {
    db.close()
  }
}

