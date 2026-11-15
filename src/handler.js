import { config } from './config.js'
import { parseCommand, extractText, markRead } from './utils.js'
import { getCommand, unknownCommandText } from './commands/registry.js'
import { getPrefix } from './settings.js'

const commandPrefix = config.commandPrefix
const owners = (process.env.OWNERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

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

export function attachHandlers(client, sessionId, logger) {
  const log = logger.child({ sessionId })
  const prefixFor = () => getPrefix(sessionId, commandPrefix)

  client.on('message', async (event) => {
    if (event.key.fromMe) return
    if (!event.key.remoteJid) return

    const selectedId = extractSelectedId(event.message)
    const text = selectedId ?? extractText(event.message)
    if (!text) return

    if (config.autoRead) await markRead(client, event)

    const prefix = prefixFor()

    const parsed = selectedId
      ? { cmd: selectedId.toLowerCase(), args: [] }
      : parseCommand(text, prefix)
    if (!parsed) return

    const command = getCommand(parsed.cmd)
    if (!command) {
      await client.message.send(event.key.remoteJid, unknownCommandText(prefix), {
        quote: event,
      })
      return
    }

    try {
      await command.handler({ client, event, args: parsed.args, log, sessionId, owners, prefix })
    } catch (err) {
      log.error({ err, cmd: parsed.cmd }, 'command failed')
      await client.message
        .send(event.key.remoteJid, `Command failed: ${prefix}${parsed.cmd}`, {
          quote: event,
        })
        .catch(() => {})
    }
  })

  client.on('group', (event) => {
    log.info({ action: event.action, groupJid: event.groupJid }, 'group event')
  })
}
