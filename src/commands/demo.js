import { register, listCommands } from './registry.js'

// With an empty prefix, show bare command names; otherwise prefix them.
function label(prefix, name) {
  return prefix ? `${prefix}${name}` : name
}

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
    const lines = listCommands().map((c) => `• ${label(prefix, c.name)} — ${c.description}`)
    await client.message.send(event.key.remoteJid, `*Available commands:*\n${lines.join('\n')}`)
  },
})

register({
  name: 'help',
  description: 'Explain a command, e.g. help ping',
  async handler({ client, event, args, prefix }) {
    if (!args.length) {
      await client.message.send(
        event.key.remoteJid,
        `Usage: ${label(prefix, 'help')} <command>\nSend ${label(prefix, 'menu')} to list all commands.`
      )
      return
    }
    const cmd = listCommands().find((c) => c.name === args[0].toLowerCase())
    if (!cmd) {
      await client.message.send(event.key.remoteJid, `Unknown command: ${args[0]}`)
      return
    }
    await client.message.send(
      event.key.remoteJid,
      `${label(prefix, cmd.name)} — ${cmd.description}`
    )
  },
})
