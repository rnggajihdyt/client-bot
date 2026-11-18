// Date ranges for LAP. All bounds are [from, to) ISO strings in UTC.
export function parseRange(arg) {
  const now = new Date()
  const day = (d) => d.toISOString().slice(0, 10)
  const a = String(arg ?? '').toLowerCase()

  if (!a || a === 'hari') {
    const from = day(now)
    const to = day(new Date(now.getTime() + 86400000))
    return { from, to, label: `hari ini ${from}` }
  }
  if (a === 'bulan') {
    const from = `${day(now).slice(0, 7)}-01`
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    return { from, to: day(next), label: `bulan ${from.slice(0, 7)}` }
  }
  const m = a.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const start = new Date(`${a}T00:00:00.000Z`)
    if (Number.isNaN(start.getTime())) return parseRange()
    const end = new Date(start.getTime() + 86400000)
    return { from: a, to: day(end), label: a }
  }
  return parseRange()
}
