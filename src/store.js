import { createStore } from 'zapo-js'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

// Ensure the storage directory exists before opening the SQLite file.
mkdirSync(dirname(config.storePath), { recursive: true })

// One store holds every session, keyed by sessionId.
export const store = createStore({
  backends: {
    sqlite: createSqliteStore({ path: config.storePath, driver: 'auto' }),
  },
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
