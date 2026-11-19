// Transaction finalisation. A BELI is created as `proses` with the balance
// already deducted; only here does it become `sukses` (commission credited) or
// `gagal` (balance refunded). Both the webhook and the cron poll land here, so
// the rules live in exactly one place.

// Commission snapshot taken when the order was placed (so later MP changes do
// not retroactively move money). Stored in transaksi.komisi_dibagikan.
function snapshotCommission(db, mitraId) {
  return db
    .ancestors(mitraId)
    .filter((a) => a.senior_id != null && a.markup > 0)
    .map((a) => ({ agen_id: a.id, kode: a.kode, nominal: a.markup }))
}

export { snapshotCommission }

// Returns the settled row + status so the caller can notify the buyer, or null
// when the row was already terminal (webhook and cron can race on one refid).
export function finalize(db, idTrx, { status, sn = '', supplierTrxId = '' } = {}) {
  if (status !== 'sukses' && status !== 'gagal') return null
  const trx = db.getTransaksi(idTrx)
  if (!trx) return null
  if (trx.status === 'sukses' || trx.status === 'gagal' || trx.status === 'batal') return null
  const now = new Date().toISOString()

  db.tx(() => {
    if (status === 'sukses') {
      const shares = JSON.parse(trx.komisi_dibagikan || '[]')
      for (const s of shares) {
        const a = db.findAgenById(s.agen_id)
        if (!a) continue
        const saldo = a.saldo
        db.addKomisi(a.id, s.nominal)
        db.addMutasi(a.id, 'komisi_masuk', s.nominal, saldo, `Komisi ${trx.produk_kode} dari ${trx.agen_kode}`)
      }
    } else {
      const a = db.findAgenById(trx.agen_id)
      if (a) {
        db.addSaldo(a.id, trx.harga_efektif)
        db.addMutasi(a.id, 'kredit', trx.harga_efektif, a.saldo + trx.harga_efektif, `Refund ${trx.produk_kode} (${idTrx})`)
      }
    }
    db.setTransaksiStatus(idTrx, status)
    db.setTransaksiSupplier(idTrx, { supplierTrxId, sn, selesaiAt: now })
  })

  return { trx, status, sn }
}

// Message the buyer receives once the supplier settles the order.
export function settledText({ trx, status, sn }) {
  if (status === 'sukses') {
    return `Transaksi BERHASIL\nID: ${trx.id_trx}\nProduk: ${trx.produk_kode}\nTujuan: ${trx.tujuan}${sn ? `\nSN: ${sn}` : ''}`
  }
  return `Transaksi GAGAL\nID: ${trx.id_trx}\nProduk: ${trx.produk_kode}\nTujuan: ${trx.tujuan}\nSaldo ${trx.harga_efektif} dikembalikan.`
}
