import { config } from './config.js'
import { parseCommand, extractText, markRead, senderNumbers } from './utils.js'
import { getCommand, unknownCommandText } from './commands/registry.js'
import { getPrefix } from './settings.js'
import { parsePpob } from './parse.js'
import { findAgenByNohp } from './db.js'

const commandPrefix = config.commandPrefix
const owners = (process.env.OWNERS ?? '')
  .split(',')
  .map((s) => s.replace(/\D/g, ''))
  .filter(Boolean)

const NOT_MITRA = 'Anda bukan mitra kami'

// Commands a deactivated mitra may still run.
const ALLOWED_WHEN_INACTIVE = new Set(['sal', 'ldl', 'lno', 'cs', 'gp', 'un', 'menu', 'help'])

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

export function attachHandlers(client, sessionId, logger) {
  const log = logger.child({ sessionId })
  const prefixFor = () => getPrefix(sessionId, commandPrefix)

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

    // -- auth gate: must be a registered mitra (or admin) --
    // Try every candidate number: in groups the chat JID is a group address,
    // so the sender's number may only appear on the *Alt field.
    const numbers = senderNumbers(event)
    let mitra
    for (const n of numbers) {
      mitra = findAgenByNohp(n)
      if (mitra) break
    }
    const isAdmin = owners.some((o) => numbers.includes(o)) || (mitra && mitra.senior_id == null)
    if (!mitra && !isAdmin) {
      await safeSend(client, event.key.remoteJid, NOT_MITRA, undefined, log)
      return
    }

    const prefix = prefixFor()

    let parsed
    if (selectedId) parsed = { cmd: selectedId.toLowerCase(), args: [] }
    else if (prefix && text.trim().startsWith(prefix)) parsed = parseCommand(text, prefix)
    else parsed = parsePpob(text)
    if (!parsed) return

    const command = getCommand(parsed.cmd)
    if (!command) {
      if (!prefix) return
      await safeSend(client, event.key.remoteJid, unknownCommandText(prefix), { quote: event }, log)
      return
    }

    if (mitra && !mitra.aktif && !isAdmin && !ALLOWED_WHEN_INACTIVE.has(parsed.cmd)) {
      await safeSend(client, event.key.remoteJid, 'Akun Anda nonaktif', undefined, log)
      return
    }

    const ctx = { client, event, args: parsed.args, log, sessionId, owners, prefix, mitra, isAdmin }
    try {
      await command.handler(ctx)
    } catch (err) {
      log.error({ err, cmd: parsed.cmd }, 'command failed')
      await safeSend(client, event.key.remoteJid, `Command failed: ${prefix}${parsed.cmd}`, { quote: event }, log)
    }
  }

  client.on('group', (event) => {
    log.info({ action: event.action, groupJid: event.groupJid }, 'group event')
  })
}
