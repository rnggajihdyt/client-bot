import { formatRupiah } from './money.js'

// Transaction finalisation + unified PPOB order reply formatting.
// A BELI is created as `proses` with the balance already deducted; only here
// does it become `sukses` (commission credited) or `gagal` (balance refunded).
// Both the webhook and the cron poll land here, so the rules live in one place.

const UPSTREAM_BALANCE_RE =
  /saldo\s*(?:operasional|reseller|anda)?.*(?:tidak\s*cukup|habis|kurang)|insufficient\s*balance|dibutuhkan\s*:\s*rp/i
const INTERNAL_ERR_RE =
  /respons\s*bukan\s*json|http\s*[45]\d\d|invalid\s*token|api\s*key|unauthorized|forbidden|timeout|timed\s*out|aborted|fetch\s*failed|econn|enotfound/i

export function isUpstreamBalanceError(msg) {
  return UPSTREAM_BALANCE_RE.test(String(msg ?? ''))
}

// Sensor nama supplier (ICS) & detail internal (seperti saldo operasional admin)
// agar tidak bocor ke downline/uplink.
export function sanitizeOrderErrorForMitra(rawMsg) {
  const s = String(rawMsg ?? '').trim()
  if (!s || isUpstreamBalanceError(s)) {
    return 'Sistem sedang gangguan sementara, silakan coba lagi nanti atau hubungi admin'
  }
  if (INTERNAL_ERR_RE.test(s)) {
    return 'Layanan sedang gangguan sementara, silakan coba lagi nanti'
  }
  const cleaned = s
    .replace(/^\s*ICS(?:\s*Store)?\s*[:\-–—]\s*/i, '')
    .replace(/\bICS\s*Store\b/gi, 'server')
    .replace(/\bICS\b/gi, 'server')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:.\-–—]+/, '')
    .replace(/\.+$/, '')
    .trim()
  return cleaned || 'Layanan sedang gangguan sementara, silakan coba lagi nanti'
}

export function cleanProductName(nama, kode) {
  const s = String(nama ?? '').trim()
  if (!s) return ''
  if (!kode) return s
  const esc = String(kode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return s.replace(new RegExp(`\\s*\\(${esc}\\)\\s*$`, 'i'), '').trim()
}

export function formatOrderTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function ensurePeriod(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  return /[.!?]$/.test(s) ? s : `${s}.`
}

// Unified single-line PPOB order status format:
//   "<Nama> <KODE>.<TUJUAN> GAGAL. Nomor tujuan salah. Sal 1.911.411 @14:19"
//   "<Nama> <KODE>.<TUJUAN> DIPROSES. ID: T... Hrg 11.000 Sal 1.900.411 @14:19"
//   "<Nama> <KODE>.<TUJUAN> BERHASIL. SN: 12345. Hrg 11.000 Sal 1.900.411 @14:19"
export function formatOrderStatus({ nama, kode, tujuan, status, detail = '', harga, idTrx, sn = '', saldo = 0, at } = {}) {
  const cleanNama = cleanProductName(nama, kode)
  const head = cleanNama ? `${cleanNama} ${kode}.${tujuan}` : `${kode}.${tujuan}`
  const sal = `Sal ${formatRupiah(saldo)}`
  const time = `@${formatOrderTime(at)}`

  if (status === 'proses') {
    const idPart = idTrx ? ` ID: ${idTrx}` : ''
    const hrgPart = harga != null ? ` Hrg ${formatRupiah(harga)}` : ''
    return `${head} DIPROSES.${idPart}${hrgPart} ${sal} ${time}`
  }
  if (status === 'sukses') {
    const snPart = sn ? ` SN: ${sn}.` : ''
    const hrgPart = harga != null ? ` Hrg ${formatRupiah(harga)}` : ''
    return `${head} BERHASIL.${snPart}${hrgPart} ${sal} ${time}`
  }
  const reasonPart = detail ? ` ${ensurePeriod(detail)}` : ''
  return `${head} GAGAL.${reasonPart} ${sal} ${time}`
}

// Commission snapshot taken when the order was placed (so later MP changes do
// not retroactively move money). Stored in transaksi.komisi_dibagikan.
// Walks every (child -> parent) edge in `db.chain(mitraId)` at arbitrary depth:
// - If parent is Admin (senior_id == null): child.markup is Admin profit
//   (included in transaksi.markup_admin), NEVER commission.
// - If parent is a mitra/uplink (senior_id != null): parent earns child.markup.
export function snapshotCommission(db, mitraId) {
  const nodes = db.chain(mitraId)
  const shares = []
  for (let i = 0; i < nodes.length - 1; i++) {
    const child = nodes[i]
    const parent = nodes[i + 1]
    if (parent.senior_id != null && child.markup > 0) {
      shares.push({ agen_id: parent.id, kode: parent.kode, nominal: child.markup })
    }
  }
  return shares
}

// Returns the settled row + status + updated saldo so the caller can notify the
// buyer, or null when the row was already terminal (webhook and cron can race).
export function finalize(db, idTrx, { status, sn = '', supplierTrxId = '', reason = '' } = {}) {
  if (status !== 'sukses' && status !== 'gagal') return null
  const trx = db.getTransaksi(idTrx)
  if (!trx) return null
  if (trx.status === 'sukses' || trx.status === 'gagal' || trx.status === 'batal') return null
  const now = new Date().toISOString()

  let saldoAkhir = 0
  db.tx(() => {
    if (status === 'sukses') {
      const shares = JSON.parse(trx.komisi_dibagikan || '[]')
      for (const s of shares) {
        const a = db.findAgenById(s.agen_id)
        if (!a || a.senior_id == null || !(s.nominal > 0)) continue
        const saldo = a.saldo
        db.addKomisi(a.id, s.nominal)
        db.addMutasi(a.id, 'komisi_masuk', s.nominal, saldo, `Komisi ${trx.produk_kode} dari ${trx.agen_kode}`)
      }
      saldoAkhir = db.findAgenById(trx.agen_id)?.saldo ?? 0
    } else {
      const a = db.findAgenById(trx.agen_id)
      if (a) {
        db.addSaldo(a.id, trx.harga_efektif)
        saldoAkhir = a.saldo + trx.harga_efektif
        db.addMutasi(a.id, 'kredit', trx.harga_efektif, saldoAkhir, `Refund ${trx.produk_kode} (${idTrx})`)
      }
    }
    db.setTransaksiStatus(idTrx, status)
    db.setTransaksiSupplier(idTrx, { supplierTrxId, sn, selesaiAt: now })
  })

  return { trx, status, sn, reason, saldoAkhir }
}

// Message the buyer receives once the supplier settles the order.
export function settledText({ trx, status, sn = '', reason = '', saldoAkhir = 0, at } = {}) {
  const isAdmin = trx.agen_senior_id == null
  const detail =
    status === 'gagal'
      ? reason
        ? isAdmin
          ? reason
          : sanitizeOrderErrorForMitra(reason)
        : 'Saldo dikembalikan'
      : ''
  return formatOrderStatus({
    nama: trx.produk_nama,
    kode: trx.produk_kode,
    tujuan: trx.tujuan,
    status,
    detail,
    harga: trx.harga_efektif,
    sn,
    saldo: saldoAkhir,
    at,
  })
}
