import { existsSync } from 'node:fs'
import { openDb, isCndCode } from './db.js'
import { ics } from './ics.js'
import { icsConfig } from './webhook.js'
import { config, sessionPath } from './config.js'

// Per-session catalog sync state (keyed by DB path so tests stay isolated).
const lastSynced = new Map() // dbPath -> epoch ms
const inflight = new Map() // dbPath -> Promise<{ total, available, removed }>
// Setelah ICS menolak ("tunggu 5 detik"), jangan langsung coba lagi: semua
// pemanggil berikutnya (CH/BELI per pesan) akan menghantam api yang sama.
const cooldownUntil = new Map() // dbPath -> epoch ms

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
    cooldownUntil.delete(dbPath)
    return
  }
  lastSynced.clear()
  inflight.clear()
  cooldownUntil.clear()
}

// Produk CND (paket ribuan/token) tidak masuk database: bot fokus akrab dulu.
// Deteksi lewat kategori atau kode yang berawalan CND.
export function isCnd(p) {
  const cat = String(p?.category ?? '').toUpperCase()
  const type = String(p?.type ?? '').toUpperCase()
  return cat.includes('CND') || type.includes('CND') || isCndCode(p?.code)
}

// Single-flight catalog sync against ICS. Concurrent callers for the same DB
// share one HTTP request instead of hammering the supplier API.
export async function syncCatalog(db, { apiKey, saveKey = false, now = () => Date.now(), afterSync } = {}) {
  const key = db.path
  const existing = inflight.get(key)
  if (existing && !saveKey) return existing

  const run = (async () => {
    const cfg = icsConfig(db)
    const token = apiKey ?? cfg.apiKey
    if (!token) throw new Error('API key supplier belum diatur')

    const res = await ics.products(cfg.baseUrl, token)
    const all = Array.isArray(res?.data) ? res.data : []
    // CND (produk ribuan) tidak disimpan: bot hanya melayani akrab dulu.
    const rows = all.filter((p) => !isCnd(p))

    let removed = 0
    let restored = 0
    let purged = 0
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
      // afterSync dijalankan di transaksi yang sama: upsert mengosongkan markup
      // dan baris CND lama ikut dibuang.
      restored = afterSync?.() ?? 0
      purged = db.pruneCndProduk()
    })

    const at = now()
    lastSynced.set(key, at)
    cooldownUntil.delete(db.path)
    try {
      db.setSetting('catalog_synced_at', String(at))
    } catch {
      // setting best-effort: sync tetap sukses walau DB read-only
    }
    return {
      total: rows.length,
      available: rows.filter((p) => p.status === 'available').length,
      removed,
      restored,
      purged,
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
  // `ttlMs` eksplisit berlaku apa adanya; 0 = selalu tarik dari ICS (dipakai
  // sebelum order supaya stok tidak basi). Default ikut config/env.
  const effectiveTtl = ttlMs !== undefined ? Math.max(0, Number(ttlMs) || 0) : resolveCatalogTtlMs()
  const cfg = icsConfig(db)
  if (!cfg.apiKey) return { synced: false, fresh: false }

  // Sedang masa tunggu ICS: pakai cache DB walau ttl sudah lewat.
  if ((cooldownUntil.get(db.path) ?? 0) > now()) return { synced: false, fresh: false }

  // Waktu sync terakhir ikut disimpan di DB: proses restart tidak boleh
  // menganggap cache masih segar (atau sebaliknya) dari memori kosong.
  const stored = Number(db.getSetting('catalog_synced_at') || 0)
  const last = Math.max(stored, lastSynced.get(db.path) ?? 0)
  if (last > 0 && now() - last < effectiveTtl) {
    return { synced: false, fresh: true }
  }

  try {
    const t0 = Date.now()
    // Upsert mengosongkan `markup` (kolom tidak ada di daftar UPDATE), jadi
    // markup per produk diambil dulu lalu dipulihkan dalam transaksi yang sama.
    const markups = db
      .listProduk()
      .filter((p) => p.markup != null)
      .map((p) => [p.kode, p.markup])
    const stats = await syncCatalog(db, {
      apiKey: cfg.apiKey,
      now,
      afterSync: () => {
        let n = 0
        for (const [kode, markup] of markups) n += db.setProdukMarkup(kode, markup)
        return n
      },
    })
    const durationMs = Date.now() - t0
    logger?.info?.(
      `[cache-sync] ${sessionId ?? db.path}: ${stats.total} produk (${stats.available} online, ${stats.removed} removed) dalam ${durationMs}ms`,
      { sessionId, total: stats.total, available: stats.available, removed: stats.removed, purged: stats.purged, durationMs }
    )
    return { synced: true, fresh: true, ...stats }
  } catch (err) {
    // Hormati permintaan supplier ("tunggu 5 detik") — default 5 dtk kalau pesan
    // tidak menyebut angka, supaya tidak menembak api berulang tiap pesan.
    const waitSec = Number(String(err?.message ?? '').match(/(\d+)\s*(detik|detik|second)/i)?.[1]) || 5
    cooldownUntil.set(db.path, now() + waitSec * 1000)
    logger?.warn?.(`[cache-sync] ${sessionId ?? db.path} gagal, pakai cache DB: ${err?.message}`, {
      sessionId,
      err: err?.message,
    })
    return { synced: false, fresh: false, error: err }
  }
}

// Syncs every active session that has an ICS API key, staggered gently so
// multiple shop sessions do not hit ICS in the same millisecond.
export async function syncAllSessions(logger, sessionIds, { staggerMs = 6_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
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

// Cron menyentuh semua sesi yang punya API key, termasuk yang socket WA-nya
// sedang down: stok di DB tidak boleh ikut beku saat sesi reconnect.
export function syncableSessions(sessionIds) {
  return sessionIds.filter((id) => {
    const path = sessionPath(id)
    if (!existsSync(path)) return false
    const db = openDb(path)
    try {
      return Boolean(db.getSetting('ics_apikey'))
    } finally {
      db.close()
    }
  })
}

export function startCatalogSyncCron(logger, getSessionIds, { intervalMs, staggerMs = 6_000 } = {}) {
  const everyMs = resolveSyncIntervalMs(intervalMs)
  if (everyMs <= 0) return { stop: () => {} }

  const intervalMin = Math.round(everyMs / 60_000)
  const ttlSec = Math.round(resolveCatalogTtlMs() / 1000)
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const ids = syncableSessions(getSessionIds())
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
