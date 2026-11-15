import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

export function hashPin(pin) {
  const salt = randomBytes(16)
  const h = scryptSync(String(pin), salt, 32)
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`
}

export function verifyPin(pin, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false
  const parts = stored.split('$')
  if (parts.length !== 3) return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  const actual = scryptSync(String(pin), salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
