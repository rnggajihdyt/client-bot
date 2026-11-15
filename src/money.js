// Rupiah formatting, Indonesian style. Tokens split on . or whitespace.
export function formatRupiah(n) {
  const s = String(Math.trunc(Number(n) || 0))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function parseNumber(s) {
  const d = String(s ?? '').replace(/[^\d]/g, '')
  return d ? parseInt(d, 10) : NaN
}
