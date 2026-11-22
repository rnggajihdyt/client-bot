import { register } from './registry.js'
import { verifyPin } from '../auth.js'
import { formatRupiah } from '../money.js'
import { ics } from '../ics.js'
import { webhookUrl, icsConfig } from '../webhook.js'
import {
  finalize,
  formatOrderStatus,
  isUpstreamBalanceError,
  sanitizeOrderErrorForMitra,
  snapshotCommission,
} from '../orders.js'
import { extractApiKey, setupApiKey } from '../apikey.js'
import { ensureFreshCatalog } from '../catalog.js'
import { normalizeNohp } from '../utils.js'

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
const BALANCE_ALERT_COOLDOWN_MS = 10 * 60 * 1000
const lastBalanceAlert = new Map() // dbPath -> epoch ms

export { isUpstreamBalanceError, sanitizeOrderErrorForMitra }

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
async function executeOneOrder({ client, db, mitraId, isAdmin, cfg, item, log }) {
  const freshMitra = db.findAgenById(mitraId)
  if (!freshMitra) {
    return {
      ok: false,
      line: formatOrderStatus({ kode: item.kode, tujuan: item.tujuan, status: 'gagal', detail: 'Akun mitra tidak ditemukan', saldo: 0 }),
    }
  }
  const p = db.effectivePrice(freshMitra.id, String(item.kode).toUpperCase())
  const kode = p?.kode ?? String(item.kode).toUpperCase()
  const nama = p?.nama ?? ''

  if (item.pin && !verifyPin(item.pin, freshMitra.pin_hash)) {
    return {
      ok: false,
      line: formatOrderStatus({ nama, kode, tujuan: item.tujuan, status: 'gagal', detail: PIN_SALAH, saldo: freshMitra.saldo }),
    }
  }
  if (!p) {
    return {
      ok: false,
      line: formatOrderStatus({ kode, tujuan: item.tujuan, status: 'gagal', detail: 'Produk tidak ditemukan', saldo: freshMitra.saldo }),
    }
  }
  if (!p.aktif || p.status_supplier !== 'available') {
    return {
      ok: false,
      line: formatOrderStatus({
        nama,
        kode,
        tujuan: item.tujuan,
        status: 'gagal',
        detail: 'Produk sedang gangguan/tidak tersedia',
        saldo: freshMitra.saldo,
      }),
    }
  }
  // Same destination still in flight = a retry/double tap, not a new sale.
  // Blocking it here stops the second POST (and its saldo deduction) before it
  // ever reaches the supplier.
  const dest = normalizeNohp(item.tujuan)
  const inFlight = db
    .pendingTransaksiOf(freshMitra.id, 200)
    .find((t) => normalizeNohp(t.tujuan) === dest)
  if (inFlight) {
    return {
      ok: false,
      line: formatOrderStatus({
        nama,
        kode,
        tujuan: item.tujuan,
        status: 'gagal',
        detail: `Tujuan masih diproses (${inFlight.id_trx})`,
        saldo: freshMitra.saldo,
      }),
    }
  }
  if (freshMitra.saldo < p.hargaEfektif) {
    return {
      ok: false,
      line: formatOrderStatus({ nama, kode, tujuan: item.tujuan, status: 'gagal', detail: 'Saldo tidak cukup', saldo: freshMitra.saldo }),
    }
  }

  const idTrx = `T${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
  const saldoSetelah = freshMitra.saldo - p.hargaEfektif
  db.tx(() => {
    db.addSaldo(freshMitra.id, -p.hargaEfektif)
    db.addMutasi(freshMitra.id, 'debit', p.hargaEfektif, saldoSetelah, `Beli ${p.kode} (${idTrx})`)
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
    const settled = finalize(db, idTrx, { status: 'gagal' }) // supplier never took it: refund now
    if (!isAdmin && isUpstreamBalanceError(err?.message)) {
      const root = db.root()
      const last = lastBalanceAlert.get(db.path) ?? 0
      if (root?.nohp && Date.now() - last >= BALANCE_ALERT_COOLDOWN_MS) {
        lastBalanceAlert.set(db.path, Date.now())
        void client.message
          .send(
            `${root.nohp}@s.whatsapp.net`,
            `*Peringatan Saldo Supplier*\nOrder ${p.kode} dari ${freshMitra.kode} gagal karena saldo ICS tidak cukup.\nDetail: ${err.message}`
          )
          .catch((e) => log?.warn({ err: e?.message }, 'alert saldo supplier ke admin gagal'))
      }
    }
    const reason = isAdmin ? err.message : sanitizeOrderErrorForMitra(err?.message)
    const saldoRefund = settled?.saldoAkhir ?? freshMitra.saldo
    return {
      ok: false,
      line: formatOrderStatus({ nama, kode, tujuan: item.tujuan, status: 'gagal', detail: reason, saldo: saldoRefund }),
    }
  }

  return {
    ok: true,
    line: formatOrderStatus({
      nama,
      kode,
      tujuan: item.tujuan,
      status: 'proses',
      idTrx,
      harga: p.hargaEfektif,
      saldo: saldoSetelah,
    }),
  }
}

async function runOrderBatch(ctx, items) {
  const { client, event, mitra, isAdmin, db, log, sessionId } = ctx
  const cfg = icsConfig(db)
  if (!cfg.apiKey) {
    await client.message.send(
      event.key.remoteJid,
      isAdmin ? 'Admin belum mengatur API key supplier' : 'Layanan transaksi sedang tidak aktif. Hubungi admin.'
    )
    return
  }

  const results = []
  for (const item of items) {
    results.push(await executeOneOrder({ client, db, mitraId: mitra.id, isAdmin, cfg, item, log, sessionId }))
  }

  await client.message.send(event.key.remoteJid, results.map((r) => r.line).join('\n'))
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
      await client.message.send(
        event.key.remoteJid,
        ctx.isAdmin ? 'Admin belum mengatur API key supplier' : 'Layanan transaksi sedang tidak aktif. Hubungi admin.'
      )
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
