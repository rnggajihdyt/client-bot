// One-off: wipe leftover WhatsApp credentials for a deleted session id.
// Usage: node scripts/wipe-session-store.mjs <sessionId>
import { createStore } from 'zapo-js'
import { createSqliteStore } from '@zapo-js/store-sqlite'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('Usage: node scripts/wipe-session-store.mjs <sessionId>')
  process.exit(1)
}

const path = process.env.STORE_PATH ?? '.auth/state.sqlite'
const store = createStore({
  backends: { sqlite: createSqliteStore({ path, driver: 'auto' }) },
  providers: {
    auth: 'sqlite',
    signal: 'sqlite',
    preKey: 'sqlite',
    session: 'sqlite',
    identity: 'sqlite',
    senderKey: 'sqlite',
    appState: 'sqlite',
    privacyToken: 'sqlite',
    messages: 'sqlite',
    threads: 'sqlite',
    contacts: 'sqlite',
  },
})

const DOMAINS = ['auth', 'signal', 'preKey', 'session', 'identity', 'senderKey', 'appState', 'privacyToken', 'messages', 'threads', 'contacts']
const bundle = store.session(sessionId)
for (const d of DOMAINS) await bundle[d].clear()
await bundle.destroyCaches?.()
await bundle.destroy()
console.log(`credentials for "${sessionId}" cleared in ${path}`)
