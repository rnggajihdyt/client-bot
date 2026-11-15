export function extractText(message) {
  if (!message) return undefined
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    undefined
  )
}

export function splitArgs(text) {
  return text.trim().split(/\s+/).filter(Boolean)
}

// Parse "!cmd arg1 arg2" -> { cmd, args }
export function parseCommand(text, prefix) {
  if (!text) return null
  const t = text.trim()
  if (!t.startsWith(prefix)) return null
  const [cmd, ...args] = splitArgs(t.slice(prefix.length))
  if (!cmd) return null
  return { cmd: cmd.toLowerCase(), args }
}

export function formatLatency(startMs) {
  return `${Date.now() - startMs}ms`
}

export function mentionFromJid(jid) {
  return `@${jid.split('@')[0]}`
}

// Owner check: match the sender's phone number against OWNERS (comma-separated).
// Fails closed — empty OWNERS means nobody is owner.
export function isOwner(event, owners) {
  if (!owners?.length) return false
  const jid = event.key.participant ?? event.key.remoteJid
  const number = jid?.split('@')[0].split(':')[0]
  return Boolean(number) && owners.includes(number)
}
