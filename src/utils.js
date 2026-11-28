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

// Parse "!cmd arg1 arg2" -> { cmd, args }. Empty prefix => every text is a
// command (bot menu style). Non-empty prefix => must start with it.
export function parseCommand(text, prefix) {
  if (!text) return null
  let t = text.trim()
  if (!t) return null
  if (prefix) {
    if (!t.startsWith(prefix)) return null
    t = t.slice(prefix.length).trim()
  }
  const [cmd, ...args] = splitArgs(t)
  if (!cmd) return null
  return { cmd: cmd.toLowerCase(), args }
}

export function formatLatency(startMs) {
  return `${Date.now() - startMs}ms`
}

export function mentionFromJid(jid) {
  return `@${jid.split('@')[0]}`
}

// Auto-read: mark an incoming message as read (blue ticks). Never throws —
// a failed receipt must not block command dispatch.
export async function markRead(client, event) {
  try {
    await client.message.sendReceipt(event, { type: 'read' })
  } catch {
    // best-effort; ignore
  }
}

// All candidate phone numbers for the sender, digits only. In LID chats the
// primary JID is opaque, so the PN only exists on the *Alt fields.
export function senderNumbers(event) {
  return [
    event.key.participant,
    event.key.participantAlt,
    event.key.remoteJid,
    event.key.remoteJidAlt,
  ]
    .filter((jid) => jid && !jid.endsWith('@lid'))
    .map((jid) => jid.split('@')[0].split(':')[0].replace(/\D/g, ''))
    .filter(Boolean)
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
  const wanted = owners.map(digitsOnly)
  return jids.some((jid) => {
    if (jid.endsWith('@lid')) return false
    return wanted.includes(digitsOnly(jid))
  })
}

// Semua nomor disimpan & ditampilkan dalam bentuk lokal "08...". WhatsApp JID
// butuh bentuk internasional "628...", jadi pakai to62()/toJid() saat kirim.
export function normalizeNohp(value) {
  const d = String(value ?? '').replace(/\D/g, '')
  if (!d) return ''
  const bare = d.replace(/^62/, '').replace(/^0/, '')
  return bare ? `0${bare}` : ''
}

export function to62(value) {
  const d = normalizeNohp(value)
  return d ? `62${d.slice(1)}` : ''
}

export function toJid(value) {
  const d = to62(value)
  return d ? `${d}@s.whatsapp.net` : ''
}

// Bentuk lain dari nomor yang sama, untuk mencocokkan baris lama yang tersimpan
// dalam bentuk "62..." (sebelum migrasi ke bentuk 0).
export function nohpVariants(value) {
  const d = String(value ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
  if (!d) return []
  const out = new Set([d])
  const bare = d.replace(/^62/, '').replace(/^0/, '')
  if (bare) {
    out.add(bare)
    out.add(`0${bare}`)
    out.add(`62${bare}`)
  }
  return [...out]
}

// "628123456:12@s.whatsapp.net" -> "628123456"; "+62 812-3456" -> "628123456"
function digitsOnly(value) {
  return value.split('@')[0].split(':')[0].replace(/\D/g, '')
}

// Nomor untuk ditampilkan ke pengguna: selalu bentuk lokal "08123456789".
export function displayNohp(value) {
  const d = normalizeNohp(value)
  return d || String(value ?? '').replace(/\D/g, '')
}
