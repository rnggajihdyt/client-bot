import { totalmem, freemem, uptime as osUptime, hostname, platform, release } from 'node:os'
import { register, listCommands } from './registry.js'
import { formatRupiah } from '../money.js'
import { config } from '../config.js'
import { resolveHumanMode } from '../human.js'
import * as registry from '../registry.js'

// Utility commands for the super admin (OWNERS). Registered here so they live
// next to the other commands; the auth gate already blocks non-owners from
// super commands, and these extra checks keep mitra from reaching them too.
const OWNER_ONLY = 'Khusus owner'

function fmtDur(ms) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}h ${h}j ${m}m` : h > 0 ? `${h}j ${m}m` : `${m}m`
}

function registeredSessions() {
  try {
    return registry.listSessions()
  } catch {
    return []
  }
}

// ---- ping (owner-grade: process + OS uptime + memory) ----
register({
  name: 'status',
  description: 'Owner: status proses & server',
  async handler({ client, event, isSuper }) {
    if (!isSuper) {
      await client.message.send(event.key.remoteJid, OWNER_ONLY)
      return
    }
    const mem = process.memoryUsage()
    const sysFree = freemem()
    const sysTotal = totalmem()
    const startedAt = Number(process.env.SUPERVISOR_STARTED_AT)
    const uptimeMs =
      Number.isFinite(startedAt) && startedAt > 0
        ? Math.max(0, Date.now() - startedAt)
        : process.uptime() * 1000
    await client.message.send(
      event.key.remoteJid,
      `*Status Server*\n` +
        `Host: ${hostname()} (${platform()} ${release()})\n` +
        `Uptime proses: ${fmtDur(uptimeMs)}\n` +
        `Uptime OS: ${fmtDur(osUptime() * 1000)}\n` +
        `RSS: ${formatRupiah(Math.round(mem.rss / 1024))} KB | Heap: ${formatRupiah(Math.round(mem.heapUsed / 1024))}/${formatRupiah(Math.round(mem.heapTotal / 1024))} KB\n` +
        `RAM sistem: ${formatRupiah(Math.round((sysTotal - sysFree) / 1048576))}/${formatRupiah(Math.round(sysTotal / 1048576))} MB\n` +
        `Node: ${process.version}`
    )
  },
})

// ---- session list with live status ----
register({
  name: 'sessions',
  description: 'Owner: daftar session + status live',
  async handler({ client, event, isSuper, owners }) {
    if (!isSuper) {
      await client.message.send(event.key.remoteJid, OWNER_ONLY)
      return
    }
    const rt = globalThis.__waRuntime
    const rows = registeredSessions()
    const live = rt ? [...rt.clients.keys()] : []
    if (!rows.length) {
      await client.message.send(event.key.remoteJid, 'Belum ada session terdaftar')
      return
    }
    const lines = rows.map((s) => {
      const state = live.includes(s.id) ? '🟢 live' : s.status === 'on' ? '🟡 on (belum live)' : '⚪ off'
      const role = registry.isOwnerSession(s)
        ? `owner ${owners.join(',') || '-'}`
        : `admin ${s.admin_nohp || '-'}`
      const wa = s.wa_nohp || s.pairing_phone || '-'
      return `• ${s.id} — ${state} — ${role} — WA ${wa}${s.label ? ` — ${s.label}` : ''}`
    })
    await client.message.send(event.key.remoteJid, `*Sessions:*\n${lines.join('\n')}`)
  },
})

// ---- restart a session's WhatsApp connection ----
register({
  name: 'restart',
  description: 'Owner: RESTART.ID — connect ulang session',
  async handler({ client, event, args, isSuper, log }) {
    if (!isSuper) {
      await client.message.send(event.key.remoteJid, OWNER_ONLY)
      return
    }
    const id = args[0]
    const rt = globalThis.__waRuntime
    if (!id) {
      await client.message.send(event.key.remoteJid, 'Gunakan format: RESTART.ID')
      return
    }
    if (!rt) {
      await client.message.send(event.key.remoteJid, 'Runtime belum siap')
      return
    }
    if (!registry.getSession(id)) {
      await client.message.send(event.key.remoteJid, 'Session tidak ditemukan')
      return
    }
    await rt.stopSession(id)
    await rt.startSession(id, {
      notify: (msg) =>
        client.message.send(event.key.remoteJid, msg).catch((err) => log?.warn({ err, id }, 'restart notify failed')),
    })
    await client.message.send(event.key.remoteJid, `Session ${id} di-restart. Pairing kode dikirim kalau perlu.`)
  },
})

// ---- command list (all registered commands incl. owner ones) ----
register({
  name: 'cmd',
  description: 'Owner: daftar semua command terdaftar',
  async handler({ client, event, isSuper }) {
    if (!isSuper) {
      await client.message.send(event.key.remoteJid, OWNER_ONLY)
      return
    }
    const lines = listCommands().map((c) => `• ${c.name} — ${c.description}`)
    await client.message.send(event.key.remoteJid, `*Commands:*\n${lines.join('\n')}`)
  },
})

// ---- env/config snapshot (values only, secrets masked) ----
register({
  name: 'env',
  description: 'Owner: ringkasan config aktif',
  async handler({ client, event, isSuper }) {
    if (!isSuper) {
      await client.message.send(event.key.remoteJid, OWNER_ONLY)
      return
    }
    const mask = (v) => (v ? `${String(v).slice(0, 4)}***` : '-')
    await client.message.send(
      event.key.remoteJid,
      `*Config*\n` +
        `Sessions: ${config.sessionId} | dir: ${config.sessionDir}\n` +
        `Prefix: ${JSON.stringify(config.commandPrefix)} | pairing: ${config.pairingMode}\n` +
        `Store: ${config.storePath} | autoread: ${config.autoRead}\n` +
        `Human: ${resolveHumanMode()} | unknown: ${config.unknownSenderMode} | ignoreGroups: ${config.ignoreGroups}\n` +
        `Owners: ${mask(process.env.OWNERS)} | pairingPhone: ${mask(config.pairingPhone)}\n` +
        `Node: ${process.version} | pid: ${process.pid}`
    )
  },
})
