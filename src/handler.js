import { rmSync } from 'node:fs'
import { config } from './config.js'
import { parseCommand, extractText, markRead, senderNumbers, normalizeNohp } from './utils.js'
import { getCommand, unknownCommandText } from './commands/registry.js'
import { getPrefix } from './settings.js'
import { parsePpob } from './parse.js'
import { openDb } from './db.js'
import * as registry from './registry.js'
import { wipeSessionStore } from './runtime.js'
import { formatRupiah } from './money.js'
import { parseRange } from './report.js'
import { webhookUrl, icsConfig } from './webhook.js'
import { apiKeyPrompt, extractApiKey, setupApiKey, sameNumberProblem } from './apikey.js'

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

// Owner-only utility commands: work for OWNERS even without an agen row here.
const SUPER_ONLY_COMMANDS = new Set(['status', 'sessions', 'cmd', 'env', 'restart'])

// A deactivated mitra may still read its own status and the menus.
const ALLOWED_WHEN_INACTIVE = new Set(['sal', 'info', 'all', 'menu', 'help'])

// While the session has no supplier key only these get through; the key itself
// is accepted from any reply (see the setup gate in handleMessage).
const ALLOWED_WITHOUT_APIKEY = new Set(['info', 'all', 'menu', 'help', 'cs'])

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

// Session directory lives in `.data/sessions/_registry.sqlite` so the super
// admin manages every session from any connected number. `runtime` lets a
// super admin connect a new session without restarting the process.
export function attachHandlers(client, sessionId, logger, runtime = null) {
  const log = logger.child({ sessionId })
  const prefixFor = () => getPrefix(sessionId, commandPrefix)
  const db = openDb(sessionPath(sessionId))
  let dbClosed = false
  const closeDb = () => {
    if (dbClosed) return
    dbClosed = true
    db.close()
  }

  log.info(
    { prefix: prefixFor(), effective: prefixFor() === '' ? 'none' : prefixFor() },
    'command prefix resolved'
  )

  client.on('message', async (event) => {
    // A deleted session's handler stays registered on its (dead) client; drop
    // the message instead of reopening a DB that was just wiped.
    if (dbClosed) return
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

    // Admin number = bot number: nothing to operate. The bot cannot be its own
    // admin, so every message gets a correction instead of a command result.
    const session = registry.getSession(sessionId)
    if (!isSuper && session && sameNumberProblem(session.admin_nohp, session.pairing_phone)) {
      await safeSend(
        client,
        event.key.remoteJid,
        `*Session ${sessionId} salah konfigurasi*\nNomor admin = nomor bot (${session.pairing_phone}).\n` +
          `Hapus dan buat ulang dari nomor owner:\nSESIHAPUS.${sessionId}\nSESIBUAT.${sessionId}.NOMORADMIN.NOMORBOT[LABEL]`,
        undefined,
        log
      )
      return
    }

    let parsed
    if (selectedId) parsed = { cmd: selectedId.toLowerCase(), args: [] }
    else if (prefix && text.trim().startsWith(prefix)) parsed = parseCommand(text, prefix)
    else parsed = parsePpob(text)
    if (!parsed) return

    // Super admin (OWNERS): session management + cross-session reports, whether
    // or not it also happens to be a root admin in this session. Owner-only
    // utilities must not depend on an agen row in *this* session's DB.
    const ownerUtility = isSuper && SUPER_ONLY_COMMANDS.has(parsed.cmd) && getCommand(parsed.cmd)
    if (!ownerUtility && isSuper && SUPER_COMMANDS.has(parsed.cmd)) {
      await handleSuper(event, parsed)
      return
    }
    if (!ownerUtility && !mitra) {
      await handleSuper(event, { cmd: '', args: [] }) // prints the super menu
      return
    }

    // Onboarding gate: a session admin without a supplier key can do nothing
    // that moves money. No timeout — every message re-prompts, and only a key
    // ICS actually accepts gets stored.
    if (isAdmin && !isSuper && !db.getSetting('ics_apikey')) {
      const candidate = extractApiKey(text)
      if (candidate) {
        try {
          const r = await setupApiKey(db, candidate)
          await safeSend(
            client,
            event.key.remoteJid,
            `API key tersimpan. ${r.total} produk tersinkron (${r.available} tersedia).\n\n` +
              `Webhook URL:\n${webhookUrl(db, sessionId)}\n\nSalin URL itu ke dashboard ICS → Webhook.`,
            undefined,
            log
          )
        } catch (err) {
          log.warn({ err: err?.message }, 'apikey ditolak ICS')
          await safeSend(
            client,
            event.key.remoteJid,
            `API key belum benar: ${err.message}\n\nKirim lagi: APIKEY.ICS_sk_xxx`,
            undefined,
            log
          )
        }
        return
      }
      if (!ALLOWED_WITHOUT_APIKEY.has(parsed.cmd)) {
        await safeSend(client, event.key.remoteJid, apiKeyPrompt(webhookUrl(db, sessionId)), undefined, log)
        return
      }
    }

    // Deactivated mitra: only read-only status/menu commands get through.
    const deactivated = Boolean(mitra && !mitra.aktif && !isAdmin)

    if (deactivated && !ALLOWED_WHEN_INACTIVE.has(parsed.cmd)) {
      await safeSend(client, event.key.remoteJid, INACTIVE, undefined, log)
      return
    }

    const command = getCommand(parsed.cmd)
    if (!command) {
      // Owner gets the session menu instead of silence; a mitra with no prefix
      // is ignored (typing random text must not spam the chat).
      if (isSuper) {
        await handleSuper(event, { cmd: '', args: [] })
        return
      }
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
    const reply = (msg, to) => safeSend(client, to ?? jid, msg, undefined, log)
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
      await reply('*Super admin*\n• SESI — daftar session\n• SESIBUAT.ID.NOMORADMIN[.NOMORWA][LABEL]\n• SESION.ID / SESIOFF.ID\n• SESIHAPUS.ID\n• LAPTRX.ID[HARI|BULAN|YYYY-MM-DD]')
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
    const rows = registry.listSessions()
    if (!rows.length) {
      await reply('Belum ada session. Buat: SESIBUAT.ID.NOMORADMIN')
      return
    }
    const lines = rows.map(
      (s) =>
        `• ${s.id} — admin ${s.admin_nohp || '-'} — WA ${s.pairing_phone || '-'} — ${s.status}${s.label ? ` — ${s.label}` : ''}`
    )
    await reply(`*Sessions:*\n${lines.join('\n')}\n\nLaporan: LAPTRX.ID`)
  }

  // SESIBUAT.ID.NOMORADMIN.NOMORWA[LABEL]
  // Admin number and bot number are both required and must differ: the bot's
  // phone cannot also be its own admin. Then the session connects right away so
  // the pairing code is requested automatically.
  async function registerSession(reply, args) {
    const [id, adminRaw, waRaw, ...rest] = args
    if (!id || !adminRaw || !waRaw) {
      await reply('Gunakan format: SESIBUAT.ID.NOMORADMIN.NOMORWA[LABEL]\nNomor admin wajib beda dengan nomor bot (WA).')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(id)) {
      await reply('ID hanya huruf/angka/-/_')
      return
    }
    const adminNohp = normalizeNohp(adminRaw)
    if (!adminNohp) {
      await reply('Nomor admin tidak valid')
      return
    }
    if (!/^\+?\d{8,15}$/.test(waRaw)) {
      await reply('Nomor WA bot tidak valid (token ke-3 wajib: SESIBUAT.ID.ADMIN.WA[LABEL])')
      return
    }
    const pairingPhone = normalizeNohp(waRaw)
    if (sameNumberProblem(adminNohp, pairingPhone)) {
      await reply('Nomor admin tidak boleh sama dengan nomor bot (WA)')
      return
    }
    // A bot waiting to be (re)paired by QR is identified by its env id, not by a
    // registry row yet — accept it so pusat can still serve admins.
    const existing = registry.getSession(id)
    if (existing && !(existing.pairing_phone === '' && registry.isBootstrapSession(id))) {
      await reply(`Session ${id} sudah ada`)
      return
    }
    const label = rest.join(' ')

    // A bootstrap (QR) row exists but carries no admin yet: adopt it instead of
    // refusing, so pusat keeps its already-paired credentials.
    if (existing) {
      registry.updateSessionAdmin(id, { label: label || existing.label, adminNohp, pairingPhone })
    } else {
      const row = registry.createSession({ id, label, adminNohp, pairingPhone })
      if (!row) {
        await reply(`Session ${id} sudah ada`)
        return
      }
    }

    // Seed the new session with its admin (root) so DAFTAR/CH work immediately.
    const sdb = openDb(sessionPath(id))
    try {
      if (!sdb.findAgenByNohp(adminNohp)) {
        sdb.createAgen({ nama: 'Admin', kota: '', nohp: adminNohp, seniorId: null, markup: 0, pin: config.ownerPin })
      }
    } finally {
      sdb.close()
    }

    await reply(`Session *${id}* terdaftar (admin ${adminNohp}, WA ${pairingPhone}). Menyambungkan + minta kode pairing…`)
    // Stale WhatsApp credentials from an earlier pairing would silently resume
    // the old device instead of asking for a code.
    try {
      await wipeSessionStore(id)
    } catch (err) {
      log.warn({ err: err?.message, id }, 'session store wipe failed')
    }
    await startRuntimeSession(reply, id)  }

  // Connects a session now. `notify(jid, text)`: no jid = owner chat (pairing
  // codes), jid = the admin's own number (onboarding).
  async function startRuntimeSession(reply, id) {
    if (!runtime) {
      await reply(`Runtime belum siap, restart bot lalu SESION.${id}`)
      return
    }
    // notify(jid, text) reaches the owner chat for pairing codes, and the
    // admin's own number for onboarding (see src/apikey.js).
    await runtime.startSession(id, {
      notify: (jid, text) => (jid ? reply(text, jid) : reply(text)),
    })
  }

  async function setSessionStatus(reply, args, status) {
    const id = args[0]
    if (!id) {
      await reply(`Gunakan format: ${status === 'on' ? 'SESION' : 'SESIOFF'}.ID`)
      return
    }
    if (!registry.getSession(id)) {
      await reply('Session tidak ditemukan')
      return
    }
    if (status === 'on') {
      await reply(`Session ${id} dinyalakan. Menyambungkan + minta kode pairing…`)
      await startRuntimeSession(reply, id)
      return
    }
    await stopRuntimeSession(id)
    await reply(`Session ${id} OFF.`)
  }

  async function stopRuntimeSession(id) {
    if (runtime) await runtime.stopSession(id)
    else registry.setSessionStatus(id, 'off')
  }

  async function deleteSession(reply, args) {
    const id = args[0]
    if (!id) {
      await reply('Gunakan format: SESIHAPUS.ID')
      return
    }
    if (!registry.getSession(id)) {
      await reply('Session tidak ditemukan')
      return
    }
    await stopRuntimeSession(id)
    registry.removeSession(id)
    // Irreversible: the session DB and the stored WhatsApp credentials are
    // wiped, so re-creating the same id starts from a fresh pairing.
    try {
      rmSync(sessionPath(id), { force: true })
    } catch (err) {
      log.warn({ err: err?.message, id }, 'session db remove failed')
    }
    try {
      await wipeSessionStore(id)
    } catch (err) {
      log.warn({ err: err?.message, id }, 'session store wipe failed')
    }
    await reply(`Session ${id} dihapus beserta DB & kredensialnya.`)
  }

  // Read-only: any session's transactions, no mitra row needed.
  async function lapTrx(reply, args) {
    const id = args[0]
    if (!id) {
      await reply('Gunakan format: LAPTRX.ID[HARI|BULAN|YYYY-MM-DD]')
      return
    }
    if (!registry.getSession(id)) {
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

  return { db, close: closeDb }
}
