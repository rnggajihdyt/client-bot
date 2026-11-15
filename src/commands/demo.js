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
  async handler({ client, event }) {
    const lines = listCommands().map((c) => `• !${c.name} — ${c.description}`)
    await client.message.send(event.key.remoteJid, `*Available commands:*\n${lines.join('\n')}`)
  },
})

register({
  name: 'help',
  description: 'Explain a command, e.g. !help ping',
  async handler({ client, event, args }) {
    if (!args.length) {
      await client.message.send(
        event.key.remoteJid,
        `Usage: !help <command> — e.g. !help ping\nSend !menu to list all commands.`
      )
      return
    }
    const cmd = listCommands().find((c) => c.name === args[0].toLowerCase())
    if (!cmd) {
      await client.message.send(event.key.remoteJid, `Unknown command: ${args[0]}`)
      return
    }
    await client.message.send(event.key.remoteJid, `!${cmd.name} — ${cmd.description}`)
  },
})
