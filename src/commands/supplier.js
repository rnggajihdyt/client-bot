import { register } from './registry.js'
import { verifyPin } from '../auth.js'
import { formatRupiah } from '../money.js'
import { ics } from '../ics.js'
import { webhookUrl, icsConfig } from '../webhook.js'
import { finalize, snapshotCommission } from '../orders.js'
import { extractApiKey, setupApiKey } from '../apikey.js'

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

// ---- SYNC ----
register({
  name: 'sync',
  description: 'Admin: tarik ulang produk dari supplier ICS',
  async handler({ client, event, isAdmin, db, log }) {
    if (!isAdmin) {
      await client.message.send(event.key.remoteJid, ADMIN_ONLY)
      return
    }
    try {
      const r = await setupApiKey(db, db.getSetting('ics_apikey'))
      await client.message.send(event.key.remoteJid, `Sync selesai. ${r.total} produk diterima, ${r.available} tersedia.`)
    } catch (err) {
      log?.error({ err: err?.message }, 'sync produk gagal')
      await client.message.send(event.key.remoteJid, `Gagal sync produk: ${err.message}`)
    }
  },
})

// ---- BELI ----
// Two-phase: hold the balance + insert `proses` now, let the webhook/poller
// settle it (src/orders.js). Commission is credited only on sukses.
register({
  name: 'beli',
  description: 'Beli produk: BELI.KODE.TUJUAN[.PIN]',
  async handler({ client, event, mitra, args, db, log }) {
    const [kode, tujuan, pin] = args
    if (!kode || !tujuan) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: BELI.KODE.TUJUAN.PIN')
      return
    }
    if (pin && !verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(event.key.remoteJid, PIN_SALAH)
      return
    }
    const cfg = icsConfig(db)
    if (!cfg.apiKey) {
      await client.message.send(event.key.remoteJid, 'Admin belum mengatur API key supplier')
      return
    }
    const p = db.effectivePrice(mitra.id, String(kode).toUpperCase())
    if (!p) {
      await client.message.send(event.key.remoteJid, 'Produk tidak ditemukan')
      return
    }
    if (!p.aktif || p.status_supplier !== 'available') {
      await client.message.send(event.key.remoteJid, 'Produk sedang gangguan/tidak tersedia')
      return
    }
    if (mitra.saldo < p.hargaEfektif) {
      await client.message.send(event.key.remoteJid, 'Saldo tidak cukup')
      return
    }

    const idTrx = `T${Date.now()}${Math.floor(Math.random() * 900 + 100)}`
    db.tx(() => {
      db.addSaldo(mitra.id, -p.hargaEfektif)
      db.addMutasi(mitra.id, 'debit', p.hargaEfektif, mitra.saldo - p.hargaEfektif, `Beli ${p.kode} (${idTrx})`)
      db.insertTransaksi({
        idTrx,
        agenId: mitra.id,
        produkId: p.id,
        produkKode: p.kode,
        tujuan,
        hargaModal: p.harga_modal,
        markupAdmin: p.adminMarkup,
        markupTotal: p.markupTotal,
        hargaEfektif: p.hargaEfektif,
        komisiDibagikan: snapshotCommission(db, mitra.id),
        status: 'proses',
      })
    })

    try {
      await ics.order(cfg.baseUrl, cfg.apiKey, { productCode: p.kode, dest: tujuan, refId: idTrx })
    } catch (err) {
      log?.error({ err: err?.message, idTrx }, 'order ICS gagal')
      finalize(db, idTrx, { status: 'gagal' }) // supplier never took it: refund now
      await client.message.send(event.key.remoteJid, `Transaksi gagal: ${err.message}\nSaldo dikembalikan.`)
      return
    }

    await client.message.send(
      event.key.remoteJid,
      `Transaksi diproses\nID: ${idTrx}\nProduk: ${p.nama}\nTujuan: ${tujuan}\nHarga: ${formatRupiah(p.hargaEfektif)}\n\nStatus akhir dikirim otomatis ke nomor ini.`
    )
  },
})

// ---- CEK ----
register({
  name: 'cek',
  description: 'Cek status transaksi: CEK[.IDTRX]',
  async handler({ client, event, mitra, args, db }) {
    const id = args[0]
    if (!id) {
      const pending = db.pendingTransaksiOf(mitra.id)
      const text = pending.length
        ? pending.map((t) => `• ${t.id_trx} — ${t.produk_kode} → ${t.tujuan} (proses)`).join('\n')
        : 'Tidak ada transaksi diproses.'
      await client.message.send(event.key.remoteJid, `*Transaksi diproses:*\n${text}`)
      return
    }
    const trx = db.getTransaksi(id)
    // Own row, or (uplink) any row inside its network.
    const allowed =
      trx && (trx.agen_id === mitra.id || (mitra.senior_id == null && db.descendants(mitra.id).includes(trx.agen_id)))
    if (!allowed) {
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
