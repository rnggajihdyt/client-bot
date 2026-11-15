import { register, listCommands } from './registry.js'

register({
  name: 'ping',
  description: 'Check bot latency',
  async handler({ client, event }) {
    const start = Date.now()
    await client.message.send(event.key.remoteJid, 'pong', {
      quote: event,
    })
    await client.message.send(event.key.remoteJid, `Latency: ${Date.now() - start}ms`)
  },
})

register({
  name: 'menu',
  description: 'List all commands',
  async handler({ client, event, prefix }) {
    const lines = listCommands().map((c) => `• ${prefix}${c.name} — ${c.description}`)
    await client.message.send(event.key.remoteJid, `*Available commands:*\n${lines.join('\n')}`)
  },
})

register({
  name: 'help',
  description: 'Explain a command, e.g. !help ping',
  async handler({ client, event, args, prefix }) {
    if (!args.length) {
      await client.message.send(
        event.key.remoteJid,
        `Usage: ${prefix}help <command> — e.g. ${prefix}help ping\nSend ${prefix}menu to list all commands.`
      )
      return
    }
    const cmd = listCommands().find((c) => c.name === args[0].toLowerCase())
    if (!cmd) {
      await client.message.send(event.key.remoteJid, `Unknown command: ${args[0]}`)
      return
    }
    await client.message.send(event.key.remoteJid, `${prefix}${cmd.name} — ${cmd.description}`)
  },
})
