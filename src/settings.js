import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const FILE = process.env.SETTINGS_PATH ?? '.auth/settings.json'

function read() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

function write(data) {
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, FILE) // atomic-ish swap, no half-written file
}

export function getPrefix(sessionId, fallback) {
  return read().prefix?.[sessionId] ?? fallback
}

export function setPrefix(sessionId, prefix) {
  const data = read()
  data.prefix ??= {}
  data.prefix[sessionId] = prefix
  write(data)
  return prefix
}
