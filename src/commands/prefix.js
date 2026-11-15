import { register } from './registry.js'
import { clearPrefix, setPrefix } from '../settings.js'
import { isOwner } from '../utils.js'

register({
  name: 'setprefix',
  description: 'Change command prefix, e.g. setprefix # (owner only). No arg = reset to env default.',
  async handler({ client, event, args, sessionId, owners, prefix }) {
    if (!isOwner(event, owners)) {
      await client.message.send(event.key.remoteJid, 'Owner only.')
      return
    }

    if (!args.length) {
      clearPrefix(sessionId)
      await client.message.send(event.key.remoteJid, `Prefix reset to env default.`)
      return
    }

    const next = args[0]
    if (next.length > 3 || /\s/.test(next)) {
      await client.message.send(
        event.key.remoteJid,
        `Usage: ${prefix}setprefix <1-3 chars> — no arg to reset.`
      )
      return
    }

    setPrefix(sessionId, next)
    await client.message.send(event.key.remoteJid, `Prefix set to "${next}".`)
  },
})
