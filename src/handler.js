import { rmSync } from 'node:fs'
import { config } from './config.js'
import { parseCommand, extractText, markRead, senderNumbers } from './utils.js'
import { getCommand, unknownCommandText } from './commands/registry.js'
import { getPrefix } from './settings.js'
import { parsePpob } from './parse.js'
import { openDb } from './db.js'
import { formatRupiah } from './money.js'
import { parseRange } from './report.js'

const commandPrefix = config.commandPrefix
const owners = (process.env.OWNERS ?? '')
  .split(',')
  .map((s) => s.replace(/\D/g, ''))
  .filter(Boolean)

const NOT_MITRA = 'Anda bukan mitra kami'
const INACTIVE = 'Akun Anda nonaktif'
const SESSION_DIR = config.sessionDir
const sessionPath = (id) => `${SESSION_DIR}/${id}.sqlite`

// Super admin (OWNERS) commands — handled before the mitra command table.
const SUPER_COMMANDS = new Set(['sesi', 'sesibuat', 'sesion', 'sesioff', 'sesihapus', 'laptrx'])

// A deactivated mitra may still read its own status and the menus.
const ALLOWED_WHEN_INACTIVE = new Set(['sal', 'info', 'all', 'menu', 'help'])

// Incoming button/list replies arrive as ordinary `message` events with a
// buttonsResponseMessage / listResponseMessage payload — not a separate event.
function extractSelectedId(message) {
  return (
    message?.buttonsResponseMessage?.selectedButtonId ??
    message?.templateButtonReplyMessage?.selectedId ??
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ??
    undefined
  )
}

// `send` that never throws: a failed publish must not crash the process.
async function safeSend(client, jid, text, opts, log) {
  try {
    return await client.message.send(jid, text, opts)
  } catch (err) {
    log?.warn({ err, jid }, 'send failed')
    return undefined
  }
}

// Session directory lives in the default session's DB so the super admin has
// one place to manage every session.
function sessionDb() {
  return openDb(sessionPath(config.sessionId))
}

function readSessions(raw) {
  raw.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    admin_nohp TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'off'
  )`)
  return raw.prepare(`SELECT * FROM sessions ORDER BY id`).all()
}

export function attachHandlers(client, sessionId, logger) {
  const log = logger.child({ sessionId })
  const prefixFor = () => getPrefix(sessionId, commandPrefix)
  const db = openDb(sessionPath(sessionId))
  const isDefaultSession = sessionId === config.sessionId

  log.info(
    { prefix: prefixFor(), effective: prefixFor() === '' ? 'none' : prefixFor() },
    'command prefix resolved'
  )

  client.on('message', async (event) => {
    try {
      await handleMessage(event)
    } catch (err) {
      // Last-resort guard: never let one bad message crash the bot.
      log.error({ err, remoteJid: event.key?.remoteJid }, 'unhandled message error')
    }
  })

  async function handleMessage(event) {
    if (event.key.fromMe) return
    if (!event.key.remoteJid) return

    const selectedId = extractSelectedId(event.message)
    const text = selectedId ?? extractText(event.message)
    if (!text) return

    if (config.autoRead) await markRead(client, event)

    // -- auth gate --
    // Try every candidate number: in groups the chat JID is a group address,
    // so the sender's number may only appear on the *Alt field.
    const numbers = senderNumbers(event)
    let mitra
    for (const n of numbers) {
      mitra = db.findAgenByNohp(n)
      if (mitra) break
    }
    const isSuper = owners.some((o) => numbers.includes(o))
    const isAdmin = Boolean(mitra && mitra.senior_id == null)
    if (!mitra && !isSuper) {
      await safeSend(client, event.key.remoteJid, NOT_MITRA, undefined, log)
      return
    }

    const prefix = prefixFor()

    let parsed
    if (selectedId) parsed = { cmd: selectedId.toLowerCase(), args: [] }
    else if (prefix && text.trim().startsWith(prefix)) parsed = parseCommand(text, prefix)
    else parsed = parsePpob(text)
    if (!parsed) return

    // Super admin (OWNERS): session management + cross-session reports, whether
    // or not it also happens to be a root admin in this session.
    if (isSuper && SUPER_COMMANDS.has(parsed.cmd)) {
      await handleSuper(event, parsed)
      return
    }
    if (!mitra) {
      await handleSuper(event, { cmd: '', args: [] }) // prints the super menu
      return
    }

    // Deactivated mitra: only read-only status/menu commands get through.
    const deactivated = Boolean(mitra && !mitra.aktif && !isAdmin)

    if (deactivated && !ALLOWED_WHEN_INACTIVE.has(parsed.cmd)) {
      await safeSend(client, event.key.remoteJid, INACTIVE, undefined, log)
      return
    }

    const command = getCommand(parsed.cmd)
    if (!command) {
      if (!prefix) return
      await safeSend(client, event.key.remoteJid, unknownCommandText(prefix), { quote: event }, log)
      return
    }

    const ctx = {
      client,
      event,
      args: parsed.args,
      log,
      sessionId,
      owners,
      prefix,
      mitra,
      isAdmin,
      isSuper,
      deactivated,
      db,
    }
    try {
      await command.handler(ctx)
    } catch (err) {
      log.error({ err, cmd: parsed.cmd }, 'command failed')
      await safeSend(client, event.key.remoteJid, `Command failed: ${prefix}${parsed.cmd}`, { quote: event }, log)
    }
  }

  // ---- super admin (OWNERS) ----
  async function handleSuper(event, parsed) {
    const jid = event.key.remoteJid
    const reply = (msg) => safeSend(client, jid, msg, undefined, log)
    const commands = {
      sesi: () => listSessions(reply),
      sesibuat: () => registerSession(reply, parsed.args),
      sesion: () => setSessionStatus(reply, parsed.args, 'on'),
      sesioff: () => setSessionStatus(reply, parsed.args, 'off'),
      sesihapus: () => deleteSession(reply, parsed.args),
      laptrx: () => lapTrx(reply, parsed.args),
    }
    const fn = commands[parsed.cmd]
    if (!fn) {
      await reply('*Super admin*\n• SESI — daftar session\n• SESIBUAT.ID.NOMORADMIN[LABEL]\n• SESION.ID / SESIOFF.ID\n• SESIHAPUS.ID\n• LAPTRX.ID[HARI|BULAN|YYYY-MM-DD]')
      return
    }
    try {
      await fn()
    } catch (err) {
      log.error({ err, cmd: parsed.cmd }, 'super command failed')
      await reply(`Command failed: ${parsed.cmd}`)
    }
  }

  async function listSessions(reply) {
    if (!isDefaultSession) {
      await reply(`Kelola session dari session utama (${config.sessionId}).`)
      return
    }
    const meta = sessionDb()
    try {
      const rows = readSessions(meta.raw)
      if (!rows.length) {
        await reply('Belum ada session. Buat: SESIBUAT.ID.NOMORADMIN')
        return
      }
      const lines = rows.map((s) => `• ${s.id} — admin ${s.admin_nohp || '-'} — ${s.status}`)
      await reply(`*Sessions:*\n${lines.join('\n')}\n\nLaporan: LAPTRX.ID`)
    } finally {
      meta.close()
    }
  }

  async function registerSession(reply, args) {
    if (!isDefaultSession) {
      await reply(`Kelola session dari session utama (${config.sessionId}).`)
      return
    }
    const [id, adminNohp, ...rest] = args
    if (!id || !adminNohp) {
      await reply('Gunakan format: SESIBUAT.ID.NOMORADMIN[LABEL]')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(id)) {
      await reply('ID hanya huruf/angka/-/_')
      return
    }
    const nohp = String(adminNohp).replace(/\D/g, '')
    if (!nohp) {
      await reply('Nomor admin tidak valid')
      return
    }
    const meta = sessionDb()
    try {
      readSessions(meta.raw)
      try {
        meta.raw
          .prepare(`INSERT INTO sessions (id, label, admin_nohp, status) VALUES (?, ?, ?, 'off')`)
          .run(id, rest.join(' '), nohp)
      } catch {
        await reply(`Session ${id} sudah ada`)
        return
      }
    } finally {
      meta.close()
    }
    // Seed the new session with its admin (root) so DAFTAR/CH work immediately.
    const sdb = openDb(sessionPath(id))
    try {
      if (!sdb.findAgenByNohp(nohp)) {
        sdb.createAgen({ nama: 'Admin', kota: '', nohp, seniorId: null, markup: 0, pin: config.ownerPin })
      }
    } finally {
      sdb.close()
    }
    await reply(
      `Session *${id}* terdaftar (admin ${nohp}), status off.\n` +
        `Tambahkan ${id} ke env SESSIONS lalu restart bot untuk menyambungkan WhatsApp.`
    )
  }

  async function setSessionStatus(reply, args, status) {
    const id = args[0]
    if (!id) {
      await reply(`Gunakan format: ${status === 'on' ? 'SESION' : 'SESIOFF'}.ID`)
      return
    }
    const meta = sessionDb()
    try {
      readSessions(meta.raw)
      const r = meta.raw.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id)
      if (!r.changes) {
        await reply('Session tidak ditemukan')
        return
      }
    } finally {
      meta.close()
    }
    await reply(`Session ${id} ${status === 'on' ? 'ON' : 'OFF'}.`)
  }

  async function deleteSession(reply, args) {
    const id = args[0]
    if (!id) {
      await reply('Gunakan format: SESIHAPUS.ID')
      return
    }
    const meta = sessionDb()
    try {
      readSessions(meta.raw)
      const r = meta.raw.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
      if (!r.changes) {
        await reply('Session tidak ditemukan')
        return
      }
    } finally {
      meta.close()
    }
    // Irreversible: the session DB is wiped.
    try {
      rmSync(sessionPath(id), { force: true })
    } catch (err) {
      log.warn({ err, id }, 'session db remove failed')
    }
    await reply(`Session ${id} dihapus beserta DB-nya.`)
  }

  // Read-only: any session's transactions, no mitra row needed.
  async function lapTrx(reply, args) {
    const id = args[0]
    if (!id) {
      await reply('Gunakan format: LAPTRX.ID[HARI|BULAN|YYYY-MM-DD]')
      return
    }
    const meta = sessionDb()
    let known
    try {
      known = readSessions(meta.raw).some((s) => s.id === id)
    } finally {
      meta.close()
    }
    if (!known) {
      await reply('Session tidak ditemukan')
      return
    }
    const { from, to, label } = parseRange(args[1])
    const sdb = openDb(sessionPath(id))
    try {
      const sum = sdb.profitSummary({ from, to })
      const list = sdb.recentTransaksi({ from, to, limit: 10 })
      const lines = list.map(
        (t) =>
          `• ${t.id_trx} ${t.agen_kode ?? '-'} ${t.produk_kode} → ${t.tujuan} ${formatRupiah(t.harga_efektif)}`
      )
      const head =
        `*Transaksi ${id}* (${label})\n` +
        `Trx: ${sum.trx} Omzet: ${formatRupiah(sum.omzet)}\n` +
        `Modal: ${formatRupiah(sum.modal)} Profit: ${formatRupiah(sum.profit)}`
      await reply(lines.length ? `${head}\n\n${lines.join('\n')}` : `${head}\n\nBelum ada transaksi`)
    } finally {
      sdb.close()
    }
  }

  return { db }
}
