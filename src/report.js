// Date ranges for LAP. All bounds are [from, to) ISO strings in UTC.
// Accepted: hari, minggu, bulan, YYYY-MM-DD, DD (hari ini bulan ini), DD-MM-YYYY,
// DD/MM/YYYY, YYYY-MM, MM-YYYY.
const DAY_MS = 86400000
const iso = (d) => d.toISOString().slice(0, 10)

function dayRange(start) {
  return { from: iso(start), to: iso(new Date(start.getTime() + DAY_MS)), label: iso(start) }
}

function monthRange(year, month1) {
  const start = new Date(Date.UTC(year, month1 - 1, 1))
  const end = new Date(Date.UTC(year, month1, 1))
  return { from: iso(start), to: iso(end), label: iso(start).slice(0, 7) }
}

export function parseRange(arg) {
  const now = new Date()
  const a = String(arg ?? '').toLowerCase().trim()

  if (!a || a === 'hari') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    return { ...dayRange(start), label: `hari ini ${iso(start)}` }
  }
  if (a === 'bulan') return monthRange(now.getUTCFullYear(), now.getUTCMonth() + 1)
  if (a === 'minggu') {
    // Last 7 days including today.
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 6 * DAY_MS)
    return { from: iso(start), to: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))), label: `7 hari ${iso(start)} s/d ${iso(now)}` }
  }

  // DD — day of the current month.
  if (/^\d{1,2}$/.test(a)) {
    const d = Number(a)
    if (d >= 1 && d <= 31) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d))
      // Guard against overflow (e.g. 31 Feb rolls into March).
      if (start.getUTCMonth() === now.getUTCMonth()) return dayRange(start)
    }
    return parseRange()
  }

  // YYYY-MM
  let m = a.match(/^(\d{4})-(\d{1,2})$/)
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return monthRange(Number(m[1]), Number(m[2]))

  // MM-YYYY
  m = a.match(/^(\d{1,2})-(\d{4})$/)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return monthRange(Number(m[2]), Number(m[1]))

  // YYYY-MM-DD | DD-MM-YYYY | DD/MM/YYYY
  let year, month, day
  m = a.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) [, year, month, day] = m.map(Number)
  else if ((m = a.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) [day, month, year] = m.slice(1).map(Number)
  if (year) {
    const start = new Date(Date.UTC(year, month - 1, day))
    if (!Number.isNaN(start.getTime()) && start.getUTCMonth() === month - 1) return dayRange(start)
  }
  return parseRange()
}
