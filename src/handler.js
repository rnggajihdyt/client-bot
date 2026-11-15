import { config } from './config.js'
import { parseCommand, extractText } from './utils.js'
import { getCommand, unknownCommandText } from './commands/registry.js'

const commandPrefix = config.commandPrefix

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

  client.on('message', async (event) => {
    if (event.key.fromMe) return
    if (!event.key.remoteJid) return

    const selectedId = extractSelectedId(event.message)
    const text = selectedId ?? extractText(event.message)
    if (!text) return

    const parsed = selectedId
      ? { cmd: selectedId.toLowerCase(), args: [] }
      : parseCommand(text, commandPrefix)
    if (!parsed) return

    const command = getCommand(parsed.cmd)
    if (!command) {
      await client.message.send(event.key.remoteJid, unknownCommandText(commandPrefix), {
        quote: event,
      })
      return
    }

    try {
      await command.handler({ client, event, args: parsed.args, log })
    } catch (err) {
      log.error({ err, cmd: parsed.cmd }, 'command failed')
      await client.message
        .send(event.key.remoteJid, `Command failed: ${commandPrefix}${parsed.cmd}`, {
          quote: event,
        })
        .catch(() => {})
    }
  })

  client.on('group', (event) => {
    log.info({ action: event.action, groupJid: event.groupJid }, 'group event')
  })
}
