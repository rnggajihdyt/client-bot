// PPOB command parser: tokens may be separated by `.` or whitespace, case-insensitive.
// "BELI.PULSA10.0812.PIN" -> { cmd: 'beli', args: ['pulsa10','0812','pin'] }
export function parsePpob(text) {
  if (!text) return null
  const t = text.trim()
  if (!t) return null
  const parts = t.split(/[.\s]+/).filter(Boolean)
  if (!parts.length) return null
  return { cmd: parts[0].toLowerCase(), args: parts.slice(1) }
}
