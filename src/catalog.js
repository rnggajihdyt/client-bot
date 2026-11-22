import { existsSync } from 'node:fs'
import { openDb } from './db.js'
import { ics } from './ics.js'
import { icsConfig } from './webhook.js'
import { config, sessionPath } from './config.js'

// Per-session catalog sync state (keyed by DB path so tests stay isolated).
const lastSynced = new Map() // dbPath -> epoch ms
const inflight = new Map() // dbPath -> Promise<{ total, available, removed }>

export function resolveCatalogTtlMs(explicit) {
  if (explicit !== undefined) return Math.max(0, Number(explicit) || 0)
  if (process.env.PRODUCT_CACHE_TTL_SEC !== undefined && process.env.PRODUCT_CACHE_TTL_SEC !== '') {
    return Math.max(0, Number(process.env.PRODUCT_CACHE_TTL_SEC) * 1000)
  }
  const isTest = Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')
  if (isTest) return 0
  return Math.max(0, Number(config.productCacheTtlSec ?? 60) * 1000)
}

export function resolveSyncIntervalMs(explicit) {
  if (explicit !== undefined) return Math.max(0, Number(explicit) || 0)
  if (process.env.SYNC_INTERVAL_MIN !== undefined && process.env.SYNC_INTERVAL_MIN !== '') {
    return Math.max(0, Number(process.env.SYNC_INTERVAL_MIN) * 60_000)
  }
  return Math.max(0, Number(config.syncIntervalMin ?? 15) * 60_000)
}

export function getLastSyncAt(dbPath) {
  return lastSynced.get(dbPath) ?? 0
}

export function resetCatalogCache(dbPath) {
  if (dbPath) {
    lastSynced.delete(dbPath)
    inflight.delete(dbPath)
    return
  }
  lastSynced.clear()
  inflight.clear()
}

// Single-flight catalog sync against ICS. Concurrent callers for the same DB
// share one HTTP request instead of hammering the supplier API.
export async function syncCatalog(db, { apiKey, saveKey = false, now = () => Date.now() } = {}) {
  const key = db.path
  const existing = inflight.get(key)
  if (existing && !saveKey) return existing

  const run = (async () => {
    const cfg = icsConfig(db)
    const token = apiKey ?? cfg.apiKey
    if (!token) throw new Error('API key supplier belum diatur')

    const res = await ics.products(cfg.baseUrl, token)
    const rows = Array.isArray(res?.data) ? res.data : []

    let removed = 0
    db.tx(() => {
      const activeCodes = new Set()
      for (const p of rows) {
        if (!p?.code) continue
        activeCodes.add(String(p.code))
        db.upsertProdukIcs({
          code: p.code,
          name: p.name,
          price: p.price,
          type: p.type,
          category: p.category,
          status: p.status,
          stock: p.stock,
        })
      }
      if (activeCodes.size > 0) {
        removed = db.markRemovedProduk(activeCodes)
      }
      if (saveKey) db.setSetting('ics_apikey', token)
    })

    lastSynced.set(key, now())
    return {
      total: rows.length,
      available: rows.filter((p) => p.status === 'available').length,
      removed,
    }
  })()

  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

// Opsi A (wait-on-stale): if cache is fresh (< ttlMs), return immediately;
// if stale, await a single-flight sync from ICS. Transient ICS errors are
// logged and fall back to cached DB rows so CH/BELI stay resilient.
export async function ensureFreshCatalog(db, { ttlMs, logger, sessionId, now = () => Date.now() } = {}) {
  const effectiveTtl = resolveCatalogTtlMs(ttlMs)
  if (effectiveTtl <= 0) return { synced: false, fresh: true }

  const cfg = icsConfig(db)
  if (!cfg.apiKey) return { synced: false, fresh: false }

  const last = lastSynced.get(db.path) ?? 0
  if (last > 0 && now() - last < effectiveTtl) {
    return { synced: false, fresh: true }
  }

  try {
    const t0 = Date.now()
    const stats = await syncCatalog(db, { apiKey: cfg.apiKey, now })
    const durationMs = Date.now() - t0
    logger?.info?.(
      `[cache-sync] ${sessionId ?? db.path}: ${stats.total} produk (${stats.available} online, ${stats.removed} removed) dalam ${durationMs}ms`,
      { sessionId, total: stats.total, available: stats.available, removed: stats.removed, durationMs }
    )
    return { synced: true, fresh: true, ...stats }
  } catch (err) {
    logger?.warn?.(`[cache-sync] ${sessionId ?? db.path} gagal, pakai cache DB: ${err?.message}`, {
      sessionId,
      err: err?.message,
    })
    return { synced: false, fresh: false, error: err }
  }
}

// Syncs every active session that has an ICS API key, staggered gently so
// multiple shop sessions do not hit ICS in the same millisecond.
export async function syncAllSessions(logger, sessionIds, { staggerMs = 1_500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const results = []
  for (let i = 0; i < sessionIds.length; i++) {
    const id = sessionIds[i]
    const path = sessionPath(id)
    if (!existsSync(path)) continue
    const db = openDb(path)
    try {
      const key = db.getSetting('ics_apikey')
      if (!key) continue
      const t0 = Date.now()
      const stats = await syncCatalog(db, { apiKey: key })
      const durationMs = Date.now() - t0
      logger?.info?.(
        `[cron-sync] ${id}: ${stats.total} produk (${stats.available} online, ${stats.removed} removed) dalam ${durationMs}ms`,
        { sessionId: id, total: stats.total, available: stats.available, removed: stats.removed, durationMs }
      )
      results.push({ sessionId: id, ...stats })
    } catch (err) {
      logger?.warn?.(`[cron-sync] ${id} gagal: ${err?.message}`, { sessionId: id, err: err?.message })
      results.push({ sessionId: id, error: err?.message })
    } finally {
      db.close()
    }
    if (staggerMs > 0 && i < sessionIds.length - 1) await sleep(staggerMs)
  }
  return results
}

export function startCatalogSyncCron(logger, getSessionIds, { intervalMs, staggerMs = 1_500 } = {}) {
  const everyMs = resolveSyncIntervalMs(intervalMs)
  if (everyMs <= 0) return { stop: () => {} }

  const intervalMin = Math.round(everyMs / 60_000)
  const ttlSec = Math.round(resolveCatalogTtlMs() / 1000)
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const ids = getSessionIds()
      logger?.info?.(`[cron-sync] mulai cek ${ids.length} sesi`, { sessions: ids.length })
      await syncAllSessions(logger, ids, { staggerMs })
    } finally {
      running = false
    }
  }, everyMs)
  timer.unref?.()
  logger?.info?.(`[cron-sync] aktif (interval ${intervalMin} menit, cache TTL ${ttlSec} dtk)`, {
    intervalMin,
    ttlSec,
  })
  return { stop: () => clearInterval(timer) }
}
