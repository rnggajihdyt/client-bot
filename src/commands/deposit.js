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
    `\nJika 10 menit Saldo tidak bertambah silahkan lapor CS\n` +
    `Ketik CS\n` +
    `Tiket Open jam 08.00 - 23.00`
  )
}

// Dipakai TIKET tanpa argumen dan TIKET saat masih ada tiket pending.
function pendingTicketText(db, dep) {
  return (
    `Masih ada tiket Rp${formatRupiah(dep.total)} dengan id ${dep.id_deposit} yang belum di bayar.\n\n` +
    `${ticketText(db, dep)}\n\nBatalkan dengan BTL.${dep.id_deposit}.PIN bila ingin membuat tiket baru.`
  )
}

// Status ringkas satu tiket, dipakai TIKET.D0001 (mitra) dan TLIST (admin).
function depositStatusText(dep) {
  const { tanggal, jam } = wib(new Date(dep.created_at))
  const done = dep.selesai_at ? wib(new Date(dep.selesai_at)) : null
  return (
    `*Tiket ${dep.id_deposit}*\n` +
    `Status: ${dep.status}\n` +
    `Nominal: ${formatRupiah(dep.nominal)} + kode ${dep.kode_unik} = ${formatRupiah(dep.total)}\n` +
    `Rekening: ${dep.bank || 'BANK'}\n` +
    `Dibuat: ${tanggal} ${jam} WIB` +
    (done ? `\nSelesai: ${done.tanggal} ${done.jam} WIB` : '')
  )
}

// ---- TIKET ----
register({
  name: 'tiket',
  description: 'Buat tiket deposit: TIKET.NOMINAL.PIN',
  async handler({ client, event, mitra, args, db }) {
    const jid = event.key.remoteJid
    // TIKET.D0001 — status satu tiket (semua status, bukan cuma pending).
    if (/^d\d{4}$/i.test(args[0] ?? '')) {
      const dep = db.getDeposit(args[0].toUpperCase())
      if (!dep || dep.agen_id !== mitra.id) {
        await client.message.send(jid, 'Tiket tidak ditemukan')
        return
      }
      await client.message.send(jid, depositStatusText(dep))
      return
    }
    const pending = db.pendingDepositOf(mitra.id)
    if (!args.length) {
      if (pending) {
        await client.message.send(jid, pendingTicketText(db, pending))
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
      await client.message.send(jid, pendingTicketText(db, pending))
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
    const [rawId, pin] = args
    if (!rawId || !pin) {
      await client.message.send(jid, 'Gunakan format: BTL.IDDEPOSIT.PIN')
      return
    }
    const id = rawId.toUpperCase()
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
    const [rawId, pin] = args
    if (!rawId || !pin) {
      await client.message.send(jid, 'Gunakan format: TDEP.IDDEPOSIT.PIN')
      return
    }
    if (!verifyPin(pin, mitra.pin_hash)) {
      await client.message.send(jid, PIN_SALAH)
      return
    }
    // Ticket ids are stored uppercase (D0001); accept any case from the admin.
    const id = rawId.toUpperCase()
    const dep = db.getDeposit(id)
    if (!dep) {
      await client.message.send(jid, 'Tiket tidak ditemukan')
      return
    }
    if (dep.status !== 'pending') {
      await client.message.send(jid, `Tiket sudah ${dep.status}`)
      return
    }

    // The mitra transfers nominal + kode unik, so the full total is credited.
    const kredit = dep.total
    let saldoAkhir = 0
    db.tx(() => {
      db.addSaldo(dep.agen_id, kredit)
      saldoAkhir = db.findAgenById(dep.agen_id).saldo
      db.addMutasi(dep.agen_id, 'kredit', kredit, saldoAkhir, `Tiket deposit ${dep.bank || 'BANK'} (${id})`)
      db.setDepositStatus(id, 'sukses')
    })

    const saldoSebelum = saldoAkhir - kredit
    await client.message.send(
      jid,
      `Tiket ${id} lunas. Saldo ${dep.agen_kode} ditambah ${formatRupiah(kredit)} → ${formatRupiah(saldoAkhir)}`
    )
    try {
      const { tanggal, jam } = wib(new Date())
      await client.message.send(
        `${dep.agen_nohp}@s.whatsapp.net`,
        `Saldo Anda ditambahkan Rp. ${formatRupiah(kredit)} (Tiket deposit ${dep.bank || 'BANK'}).\n` +
          `Total Saldo ${formatRupiah(saldoSebelum)} + ${formatRupiah(kredit)} = ${formatRupiah(saldoAkhir)}.\n` +
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

// ---- TLIST: admin lihat semua tiket pending (buat cocokkan mutasi) ----
register({
  name: 'tlist',
  description: 'Admin: TLIST — daftar tiket deposit pending',
  async handler({ client, event, isAdmin, db }) {
    const jid = event.key.remoteJid
    if (!isAdmin) {
      await client.message.send(jid, ADMIN_ONLY)
      return
    }
    const rows = db.pendingDeposits()
    if (!rows.length) {
      await client.message.send(jid, 'Tidak ada tiket pending')
      return
    }
    const lines = rows.map((d) => {
      const { tanggal, jam } = wib(new Date(d.created_at))
      return `• ${d.id_deposit} — ${d.agen_kode} ${d.agen_nama} (${d.agen_nohp})\n  ${formatRupiah(d.total)} = ${formatRupiah(d.nominal)} + ${d.kode_unik} | ${d.bank || 'BANK'} | ${tanggal} ${jam}`
    })
    await client.message.send(jid, `*Tiket Pending (${rows.length}):*\n${lines.join('\n')}`)
  },
})
