import { register } from './registry.js'
import { verifyPin } from '../auth.js'
import { formatRupiah, parseNumber } from '../money.js'

const ADMIN_ONLY = 'Khusus admin'
const PIN_SALAH = 'PIN salah'
const TICKET_MIN = 10_000

function wib(date = new Date()) {
  const d = new Date(date.getTime() + 7 * 60 * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return {
    tanggal: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`,
    jam: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  }
}

// 3-digit suffix so two transfers of the same nominal stay distinguishable.
function uniqueCode(db) {
  for (let i = 0; i < 50; i++) {
    const n = Math.floor(Math.random() * 900) + 100
    const clash = db.raw.prepare(`SELECT 1 FROM deposit WHERE status = 'pending' AND kode_unik = ?`).get(n)
    if (!clash) return n
  }
  return Math.floor(Math.random() * 900) + 100
}

// Short human-friendly ticket id: D + 4 digits. Wraps when the block is used up.
function nextDepositId(db) {
  // Only D + exactly 4 digits counts; legacy long ids are ignored.
  const row = db.raw
    .prepare(`SELECT MAX(CAST(SUBSTR(id_deposit, 2) AS INTEGER)) AS n FROM deposit WHERE id_deposit GLOB 'D[0-9][0-9][0-9][0-9]'`)
    .get()
  const exists = db.raw.prepare(`SELECT 1 FROM deposit WHERE id_deposit = ?`)
  let n = (row?.n ?? 0) % 9999
  do {
    n = (n % 9999) + 1
  } while (exists.get(`D${String(n).padStart(4, '0')}`))
  return `D${String(n).padStart(4, '0')}`
}

function ticketText(db, dep) {
  const { channels } = db.depositSettings()
  const { tanggal, jam } = wib(new Date(dep.created_at))
  if (!channels.length) {
    return `*Tiket ${dep.id_deposit}*\nNominal: ${formatRupiah(dep.nominal)}\n\nAdmin belum mengatur rekening tujuan transfer. Hubungi CS.`
  }
  const rek = channels.map((c) => `${c.bank.toUpperCase()} ${c.no}`).join('\n')
  const an = [...new Set(channels.map((c) => c.an).filter(Boolean))].join(', ')
  return (
    `Tiket dibuat pada Tanggal ${tanggal} ${jam} WIB\n` +
    `Silahkan Transfer Rp. ${formatRupiah(dep.total)}\n` +
    `${rek}\n` +
    (an ? `A.N ${an}\n` : '') +
    `\nKetik CS\n` +
    `\nJika sudah transfer, konfirmasi dengan mengetik CS.Konfirmasi transfer ${dep.id_deposit} (bisa disertai bukti transfer)`
  )
}

// ---- TIKET ----
register({
  name: 'tiket',
  description: 'Buat tiket deposit: TIKET.NOMINAL.PIN',
  async handler({ client, event, mitra, args, db }) {
    const jid = event.key.remoteJid
    const pending = db.pendingDepositOf(mitra.id)
    if (!args.length) {
      if (pending) {
        await client.message.send(jid, ticketText(db, pending))
        return
      }
      await client.message.send(jid, 'Gunakan format: TIKET.NOMINAL.PIN')
      return
    }

    const pin = args[args.length - 1]
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(jid, PIN_SALAH)
      return
    }
    const nominal = parseNumber(args[0])
    if (!Number.isInteger(nominal) || nominal < TICKET_MIN) {
      await client.message.send(jid, `Nominal minimal ${formatRupiah(TICKET_MIN)}`)
      return
    }
    if (pending) {
      await client.message.send(
        jid,
        `Masih ada tiket ${pending.id_deposit} yang belum dibayar.\n\n${ticketText(db, pending)}\n\nBatalkan dengan BTL.${pending.id_deposit}.PIN bila ingin membuat tiket baru.`
      )
      return
    }

    const { channels } = db.depositSettings()
    if (!channels.length) {
      await client.message.send(jid, 'Admin belum mengatur rekening deposit. Hubungi CS.')
      return
    }

    const kodeUnik = uniqueCode(db)
    const total = nominal + kodeUnik
    const idDeposit = nextDepositId(db)
    db.insertDeposit({ idDeposit, agenId: mitra.id, nominal, kodeUnik, total, bank: channels[0].bank })

    await client.message.send(jid, ticketText(db, db.getDeposit(idDeposit)))
  },
})

// ---- BTL: batalkan tiket deposit sendiri ----
register({
  name: 'btl',
  description: 'Batalkan tiket deposit: BTL.IDDEPOSIT.PIN',
  async handler({ client, event, mitra, args, db }) {
    const jid = event.key.remoteJid
    const [id, pin] = args
    if (!id || !pin) {
      await client.message.send(jid, 'Gunakan format: BTL.IDDEPOSIT.PIN')
      return
    }
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(jid, PIN_SALAH)
      return
    }
    const dep = db.getDeposit(id)
    if (!dep || dep.agen_id !== mitra.id) {
      await client.message.send(jid, 'Tiket tidak ditemukan')
      return
    }
    if (dep.status !== 'pending') {
      await client.message.send(jid, `Tiket sudah ${dep.status}, tidak bisa dibatalkan`)
      return
    }
    db.setDepositStatus(id, 'batal')
    await client.message.send(jid, `Tiket ${id} dibatalkan. Tidak ada saldo yang terpotong.`)
  },
})

// ---- TDEP: admin konfirmasi tiket sudah ditransfer ----
register({
  name: 'tdep',
  description: 'Admin: TDEP.IDDEPOSIT.PIN — tanda tiket lunas & saldo masuk',
  async handler({ client, event, args, mitra, isAdmin, db, log }) {
    const jid = event.key.remoteJid
    if (!isAdmin) {
      await client.message.send(jid, ADMIN_ONLY)
      return
    }
    const [id, pin] = args
    if (!id || !pin) {
      await client.message.send(jid, 'Gunakan format: TDEP.IDDEPOSIT.PIN')
      return
    }
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(jid, PIN_SALAH)
      return
    }
    const dep = db.getDeposit(id)
    if (!dep) {
      await client.message.send(jid, 'Tiket tidak ditemukan')
      return
    }
    if (dep.status !== 'pending') {
      await client.message.send(jid, `Tiket sudah ${dep.status}`)
      return
    }

    let saldoAkhir = 0
    db.tx(() => {
      db.addSaldo(dep.agen_id, dep.nominal)
      saldoAkhir = db.findAgenById(dep.agen_id).saldo
      db.addMutasi(dep.agen_id, 'kredit', dep.nominal, saldoAkhir, `Tiket deposit ${dep.bank || 'BANK'} (${id})`)
      db.setDepositStatus(id, 'sukses')
    })

    const saldoSebelum = saldoAkhir - dep.nominal
    await client.message.send(
      jid,
      `Tiket ${id} lunas. Saldo ${dep.agen_kode} ditambah ${formatRupiah(dep.nominal)} → ${formatRupiah(saldoAkhir)}`
    )
    try {
      const { tanggal, jam } = wib(new Date())
      await client.message.send(
        `${dep.agen_nohp}@s.whatsapp.net`,
        `Saldo Anda ditambahkan Rp. ${formatRupiah(dep.nominal)} (Tiket deposit ${dep.bank || 'BANK'}).\n` +
          `Total Saldo ${formatRupiah(saldoSebelum)} + ${formatRupiah(dep.nominal)} = ${formatRupiah(saldoAkhir)}.\n` +
          `${tanggal} ${jam}`
      )
    } catch (err) {
      log?.warn({ err: err?.message }, 'notifikasi deposit gagal')
    }
  },
})

// ---- TPAY: tambah rekening deposit ----
register({
  name: 'tpay',
  description: 'Admin: TPAY.BANK.NO.A/N — tambah rekening deposit',
  async handler({ client, event, args, isAdmin, db }) {
    const jid = event.key.remoteJid
    if (!isAdmin) {
      await client.message.send(jid, ADMIN_ONLY)
      return
    }
    const [sub, ...rest] = args
    if (!sub) {
      await client.message.send(jid, 'Gunakan format: TPAY.BANK.NO.A/N')
      return
    }

    const key = sub.toLowerCase()
    // TPAY.BANK.NO.A/N — A/N may contain spaces (tokens are split on dots)
    const [no, ...anParts] = rest
    const noDigits = String(no ?? '').replace(/\D/g, '')
    if (!noDigits) {
      await client.message.send(jid, 'Format: TPAY.BANK.NO.A/N')
      return
    }
    const an = anParts.join(' ').trim()
    const { channels } = db.depositSettings()
    const next = channels.filter((c) => c.bank.toLowerCase() !== key)
    next.push({ bank: sub, no: noDigits, an })
    db.setSetting('deposit_channels', next.map((c) => `${c.bank}|${c.no}|${c.an}`).join(','))
    await client.message.send(jid, `Rekening ${sub.toUpperCase()} ${noDigits}${an ? ` A.N ${an}` : ''} disimpan.\nTotal channel: ${next.length}`)
  },
})

// ---- HPAY: hapus rekening deposit ----
register({
  name: 'hpay',
  description: 'Admin: HPAY.BANK — hapus rekening deposit',
  async handler({ client, event, args, isAdmin, db }) {
    const jid = event.key.remoteJid
    if (!isAdmin) {
      await client.message.send(jid, ADMIN_ONLY)
      return
    }
    const bank = (args[0] ?? '').toLowerCase()
    if (!bank) {
      await client.message.send(jid, 'Gunakan format: HPAY.BANK')
      return
    }
    const { channels } = db.depositSettings()
    const next = channels.filter((c) => c.bank.toLowerCase() !== bank)
    if (next.length === channels.length) {
      await client.message.send(jid, `Rekening ${args[0]} tidak ada`)
      return
    }
    db.setSetting('deposit_channels', next.map((c) => `${c.bank}|${c.no}|${c.an}`).join(','))
    await client.message.send(jid, `Rekening ${args[0]} dihapus`)
  },
})
