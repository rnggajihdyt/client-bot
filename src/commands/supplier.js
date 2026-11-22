import { register } from './registry.js'
import { verifyPin } from '../auth.js'
import { formatRupiah } from '../money.js'
import { ics } from '../ics.js'
import { webhookUrl, icsConfig } from '../webhook.js'
import { finalize, snapshotCommission } from '../orders.js'
import { extractApiKey, setupApiKey } from '../apikey.js'
import { ensureFreshCatalog } from '../catalog.js'

const ADMIN_ONLY = 'Khusus admin'
const PIN_SALAH = 'PIN salah'

// ---- APIKEY ----
// The reseller (session admin) pastes the key ICS gave them; the webhook URL
// handed back is what they register on the ICS dashboard.
register({
  name: 'apikey',
  description: 'Admin: APIKEY.KEY — kredensial supplier ICS',
  async handler({ client, event, args, isAdmin, db, sessionId, log }) {
    if (!isAdmin) {
      await client.message.send(event.key.remoteJid, ADMIN_ONLY)
      return
    }
    const key = extractApiKey(args.join('.'))
    const url = webhookUrl(db, sessionId)
    if (!key) {
      const current = db.getSetting('ics_apikey')
      await client.message.send(
        event.key.remoteJid,
        `Gunakan format: APIKEY.KEY\n` +
          `API key saat ini: ${current ? `${current.slice(0, 10)}…` : '(belum diisi)'}\n` +
          `Webhook URL: ${url}`
      )
      return
    }
    try {
      const r = await setupApiKey(db, key)
      db.setSetting('ready_notified', '1')
      await client.message.send(
        event.key.remoteJid,
        `API key tersimpan. Produk: ${r.total} tersimpan (${r.available} online).\n` +
          `Webhook: ${url}`
      )
    } catch (err) {
      log?.warn({ err: err?.message }, 'apikey ditolak ICS')
      await client.message.send(event.key.remoteJid, `API key ditolak: ${err.message}`)
    }
  },
})

// ---- BELI (fleksibel: [BELI.]KODE.TUJUAN[.PIN], bolak-balik, multi baris/nomor) ----
const DEST_RE = /^\+?\d{4,20}(?:,\+?\d{4,20})*$/
const CODE_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

// Parse one line into one or more { kode, tujuan, pin } order items.
export function parseOrderLine(line, lookupProduct) {
  const tokens = String(line ?? '')
    .trim()
    .split(/[.\s]+/)
    .filter(Boolean)
  if (!tokens.length) return null
  const explicitBeli = tokens[0].toLowerCase() === 'beli'
  const rest = explicitBeli ? tokens.slice(1) : tokens
  if (rest.length < 2 || rest.length > 3) return null

  const [a, b, pin] = rest
  let kode = null
  let tujuanRaw = null
  let matchedDb = false

  const aProd = lookupProduct(a.toUpperCase())
  const bProd = lookupProduct(b.toUpperCase())

  if (aProd && !bProd) {
    kode = aProd.kode
    tujuanRaw = b
    matchedDb = true
  } else if (bProd && !aProd) {
    kode = bProd.kode
    tujuanRaw = a
    matchedDb = true
  } else if (aProd && bProd) {
    kode = aProd.kode
    tujuanRaw = b
    matchedDb = true
  } else if (CODE_RE.test(a) && DEST_RE.test(b)) {
    kode = a.toUpperCase()
    tujuanRaw = b
  } else if (DEST_RE.test(a) && CODE_RE.test(b)) {
    kode = b.toUpperCase()
    tujuanRaw = a
  } else if (explicitBeli) {
    kode = a.toUpperCase()
    tujuanRaw = b
  } else {
    return null
  }

  const destinations = String(tujuanRaw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!destinations.length) return null

  return {
    explicitBeli,
    matchedDb,
    items: destinations.map((tujuan) => ({ kode, tujuan, pin })),
  }
}

function parseOrderBatch(rawText, lookupProduct) {
  const lines = String(rawText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return null

  const items = []
  let anyExplicit = false
  let anyMatchedDb = false
  for (const line of lines) {
    const parsed = parseOrderLine(line, lookupProduct)
    if (!parsed) return null
    if (parsed.explicitBeli) anyExplicit = true
    if (parsed.matchedDb) anyMatchedDb = true
    items.push(...parsed.items)
  }
  return { items, anyExplicit, anyMatchedDb }
}

// Execute a single order item against DB + ICS. Re-reads mitra balance each time
// so multi-item batches deduct accurately in order.
async function executeOneOrder({ db, mitraId, cfg, item, log }) {
  const freshMitra = db.findAgenById(mitraId)
  if (!freshMitra) return { ok: false, item, error: 'Akun mitra tidak ditemukan' }
  if (item.pin && !verifyPin(item.pin, freshMitra.pin_hash)) {
    return { ok: false, item, error: PIN_SALAH }
  }
  const p = db.effectivePrice(freshMitra.id, String(item.kode).toUpperCase())
  if (!p) return { ok: false, item, error: 'Produk tidak ditemukan' }
  if (!p.aktif || p.status_supplier !== 'available') {
    return { ok: false, item, error: 'Produk sedang gangguan/tidak tersedia' }
  }
  if (freshMitra.saldo < p.hargaEfektif) {
    return { ok: false, item, error: 'Saldo tidak cukup' }
  }

  const idTrx = `T${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
  db.tx(() => {
    db.addSaldo(freshMitra.id, -p.hargaEfektif)
    db.addMutasi(freshMitra.id, 'debit', p.hargaEfektif, freshMitra.saldo - p.hargaEfektif, `Beli ${p.kode} (${idTrx})`)
    db.insertTransaksi({
      idTrx,
      agenId: freshMitra.id,
      produkId: p.id,
      produkKode: p.kode,
      tujuan: item.tujuan,
      hargaModal: p.harga_modal,
      markupAdmin: p.adminMarkup,
      markupTotal: p.markupTotal,
      hargaEfektif: p.hargaEfektif,
      komisiDibagikan: snapshotCommission(db, freshMitra.id),
      status: 'proses',
    })
  })

  try {
    await ics.order(cfg.baseUrl, cfg.apiKey, { productCode: p.kode, dest: item.tujuan, refId: idTrx })
  } catch (err) {
    log?.error({ err: err?.message, idTrx }, 'order ICS gagal')
    finalize(db, idTrx, { status: 'gagal' }) // supplier never took it: refund now
    return { ok: false, item, error: `Transaksi gagal: ${err.message}\nSaldo dikembalikan.`, refunded: true }
  }

  return { ok: true, item, idTrx, produk: p }
}

async function runOrderBatch(ctx, items) {
  const { client, event, mitra, db, log, sessionId } = ctx
  const cfg = icsConfig(db)
  if (!cfg.apiKey) {
    await client.message.send(event.key.remoteJid, 'Admin belum mengatur API key supplier')
    return
  }

  const results = []
  for (const item of items) {
    results.push(await executeOneOrder({ db, mitraId: mitra.id, cfg, item, log, sessionId }))
  }

  // Single-item order: keep the classic concise reply format.
  if (results.length === 1) {
    const r = results[0]
    if (!r.ok) {
      await client.message.send(event.key.remoteJid, r.error)
      return
    }
    await client.message.send(
      event.key.remoteJid,
      `Transaksi diproses\nID: ${r.idTrx}\nProduk: ${r.produk.nama}\nTujuan: ${r.item.tujuan}\nHarga: ${formatRupiah(r.produk.hargaEfektif)}\n\nStatus akhir dikirim otomatis ke nomor ini.`
    )
    return
  }

  // Multi-item batch: one combined summary reply.
  const lines = results.map((r, i) =>
    r.ok
      ? `${i + 1}. ${r.produk.kode} → ${r.item.tujuan}: Diproses (ID: ${r.idTrx}, Harga: ${formatRupiah(r.produk.hargaEfektif)})`
      : `${i + 1}. ${r.item.kode} → ${r.item.tujuan}: Gagal — ${r.error.replace(/\n+/g, ' ')}`
  )
  await client.message.send(
    event.key.remoteJid,
    `*Hasil Transaksi (${results.length} item):*\n${lines.join('\n')}\n\nStatus akhir dikirim otomatis ke nomor ini.`
  )
}

// Called by handler.js when text isn't a registered command: detects direct
// shorthand buys like "xda13.08777777", "0887878.xda40", or multi-line batches.
export async function tryDirectOrder(ctx) {
  const { mitra, db, log, sessionId, rawText } = ctx
  if (!mitra || !rawText) return false
  const lookup = (code) => db.effectivePrice(mitra.id, code)
  let batch = parseOrderBatch(rawText, lookup)
  if (!batch) return false

  // Refresh catalog once when cache is stale, then re-check product codes.
  await ensureFreshCatalog(db, { logger: log, sessionId })
  batch = parseOrderBatch(rawText, lookup)
  if (!batch || (!batch.anyExplicit && !batch.anyMatchedDb)) return false

  await runOrderBatch(ctx, batch.items)
  return true
}

// Two-phase: hold the balance + insert `proses` now, let the webhook/poller
// settle it (src/orders.js). Commission is credited only on sukses.
register({
  name: 'beli',
  description: 'Beli produk: [BELI.]KODE.TUJUAN[.PIN] (bisa bolak-balik & multi baris)',
  async handler(ctx) {
    const { client, event, mitra, args, db, log, sessionId, rawText } = ctx
    if (args.length < 2) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: BELI.KODE.TUJUAN.PIN')
      return
    }
    const cfg = icsConfig(db)
    if (!cfg.apiKey) {
      await client.message.send(event.key.remoteJid, 'Admin belum mengatur API key supplier')
      return
    }
    await ensureFreshCatalog(db, { logger: log, sessionId })
    const lookup = (code) => db.effectivePrice(mitra.id, code)
    const textToParse = rawText || ['BELI', ...args].join('.')
    const batch = parseOrderBatch(textToParse, lookup)
    if (!batch || !batch.items.length) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: BELI.KODE.TUJUAN.PIN')
      return
    }
    await runOrderBatch(ctx, batch.items)
  },
})

// ---- CEK ----
// CEK -> daftar transaksi pending sendiri.
// CEK.TUJUAN -> transaksi paling terakhir untuk tujuan tsb (juga tetap dukung CEK.IDTRX).
register({
  name: 'cek',
  description: 'Cek status transaksi: CEK / CEK.TUJUAN (ambil terakhir)',
  async handler({ client, event, mitra, args, db }) {
    const target = args[0]
    if (!target) {
      const pending = db.pendingTransaksiOf(mitra.id)
      const text = pending.length
        ? pending.map((t) => `• ${t.id_trx} — ${t.produk_kode} → ${t.tujuan} (proses)`).join('\n')
        : 'Tidak ada transaksi diproses.'
      await client.message.send(event.key.remoteJid, `*Transaksi diproses:*\n${text}`)
      return
    }
    const isAdmin = mitra.senior_id == null
    const allowedIds = isAdmin ? null : [mitra.id]

    // 1. Cek berdasarkan nomor tujuan (paling terakhir).
    let trx = db.getLatestTransaksiByTujuan(target, allowedIds)

    // 2. Fallback: cek berdasarkan IDTRX (tetap kompatibel).
    if (!trx) {
      const byId = db.getTransaksi(target)
      const allowed =
        byId && (byId.agen_id === mitra.id || (isAdmin && db.descendants(mitra.id).includes(byId.agen_id)))
      if (allowed) trx = byId
    }

    if (!trx) {
      await client.message.send(event.key.remoteJid, 'Transaksi tidak ditemukan')
      return
    }
    await client.message.send(
      event.key.remoteJid,
      `ID: ${trx.id_trx}\nProduk: ${trx.produk_kode}\nTujuan: ${trx.tujuan}\nStatus: ${trx.status}` +
        `${trx.sn ? `\nSN: ${trx.sn}` : ''}\nHarga: ${formatRupiah(trx.harga_efektif)}`
    )
  },
})

// ---- REK ----
register({
  name: 'rek',
  description: 'Mutasi saldo & komisi: REK',
  async handler({ client, event, mitra, db }) {
    const rows = db.mutasiOf(mitra.id, 15)
    if (!rows.length) {
      await client.message.send(event.key.remoteJid, 'Belum ada mutasi')
      return
    }
    const lines = rows.map(
      (m) =>
        `• ${m.created_at.slice(0, 16).replace('T', ' ')} ${m.tipe} ${formatRupiah(m.nominal)} → ${formatRupiah(m.saldo_akhir)}\n  ${m.keterangan}`
    )
    await client.message.send(event.key.remoteJid, `*Mutasi terakhir:*\n${lines.join('\n')}`)
  },
})

// ---- BTL ----
register({
  name: 'btl',
  description: 'Batalkan transaksi pending: BTL.IDTRX.PIN',
  async handler({ client, event, mitra, args, db }) {
    const [id, pin] = args
    if (!id || !pin) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: BTL.IDTRX.PIN')
      return
    }
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const trx = db.getTransaksi(id)
    if (!trx || trx.agen_id !== mitra.id) {
      await client.message.send(event.key.remoteJid, 'Transaksi tidak ditemukan')
      return
    }
    if (trx.status !== 'proses') {
      await client.message.send(event.key.remoteJid, `Transaksi sudah ${trx.status}, tidak bisa dibatalkan`)
      return
    }
    // Local cancel only: refund here, mark batal. A later webhook for the same
    // refid is ignored because batal is terminal in finalize().
    db.tx(() => {
      db.addSaldo(mitra.id, trx.harga_efektif)
      db.addMutasi(mitra.id, 'kredit', trx.harga_efektif, mitra.saldo + trx.harga_efektif, `Batal ${trx.produk_kode} (${id})`)
      db.setTransaksiStatus(id, 'batal')
    })
    await client.message.send(
      event.key.remoteJid,
      `Transaksi ${id} dibatalkan. Saldo ${formatRupiah(trx.harga_efektif)} dikembalikan.`
    )
  },
})
