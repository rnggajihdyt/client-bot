import { register } from './registry.js'
import { setPrefix } from '../settings.js'
import { isOwner } from '../utils.js'

register({
  name: 'setprefix',
  description: 'Change command prefix, e.g. !setprefix # (owner only)',
  async handler({ client, event, args, sessionId, owners, prefix }) {
    if (!isOwner(event, owners)) {
      await client.message.send(event.key.remoteJid, 'Owner only.')
      return
    }

    const next = args[0]
    if (!next || next.length > 3 || /\s/.test(next)) {
      await client.message.send(
        event.key.remoteJid,
        `Usage: ${prefix}setprefix <1-3 chars> — e.g. ${prefix}setprefix #`
      )
      return
    }

    setPrefix(sessionId, next)
    await client.message.send(event.key.remoteJid, `Prefix set to "${next}".`)
  },
})
