// Thin client for the ICS Store reseller API (supplier side of every BELI).
// Docs: GET /api/reseller/products, POST /trx, GET /reseller/trx/:refid.
const TIMEOUT_MS = 20_000

function join(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`
}

async function call(baseUrl, apiKey, path, { method = 'GET', body } = {}) {
  const res = await fetch(join(baseUrl, path), {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`ICS: respons bukan JSON (HTTP ${res.status})`)
  }
  if (!res.ok || json?.success === false) {
    const msg = json?.message ?? json?.error ?? `HTTP ${res.status}`
    throw new Error(`ICS: ${msg}`)
  }
  return json
}

// Supplier price is what we pay; `discount` is already included in `price` per
// the API sample, so modal = price.
export const ics = {
  products: (baseUrl, apiKey) => call(baseUrl, apiKey, '/api/reseller/products'),
  order: (baseUrl, apiKey, { productCode, dest, refId }) =>
    call(baseUrl, apiKey, '/trx', {
      method: 'POST',
      body: { product_code: productCode, dest_number: dest, ref_id_custom: refId },
    }),
  status: (baseUrl, apiKey, refId) =>
    call(baseUrl, apiKey, `/reseller/trx/${encodeURIComponent(refId)}`),
}
