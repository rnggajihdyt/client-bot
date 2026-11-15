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
// Prefer the alternate (PN) form: in LID chats the primary JID is an opaque @lid
// with no phone number, so the number only exists on participantAlt/remoteJidAlt.
export function isOwner(event, owners) {
  if (!owners?.length) return false
  const jids = [
    event.key.participant,
    event.key.participantAlt,
    event.key.remoteJid,
    event.key.remoteJidAlt,
  ].filter(Boolean)
  return jids.some((jid) => {
    if (jid.endsWith('@lid')) return false
    const number = jid.split('@')[0].split(':')[0]
    return owners.includes(number)
  })
}
