export const config = {
  sessionId: process.env.DEFAULT_SESSION ?? 'owner',
  commandPrefix: process.env.COMMAND_PREFIX ?? '', // '' = no prefix, every text is a command
  pairingMode: process.env.PAIRING_MODE ?? 'both', // 'qr' | 'code' | 'both'
  // Phone number (digits, with country code) used for the pairing-code flow.
  pairingPhone: process.env.PAIRING_PHONE ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  storePath: process.env.STORE_PATH ?? '.auth/state.sqlite',
  autoRead: process.env.AUTOREAD === 'true',
  sessionDir: process.env.SESSION_DIR ?? '.data/sessions',
  // Public base URL the supplier calls back on, e.g. https://bot.example.com
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL ?? '',
  webhookPort: Number(process.env.WEBHOOK_PORT ?? 8080),
  // Supplier API used by every BELI (per-session apikey overrides the default).
  icsBaseUrl: process.env.ICS_BASE_URL ?? 'https://api.ics-store.my.id',
  icsApiKey: process.env.ICS_API_KEY ?? '',
  ownerPin: process.env.OWNER_PIN ?? '1234',
  // Human-like pacing: 'off' | 'fast' | 'normal' (auto 'off' under node --test)
  humanMode: process.env.HUMAN_MODE ?? '',
  // Unknown sender handling: 'ignore' (silent) | 'once' (1x/24h) | 'always'
  unknownSenderMode: (process.env.UNKNOWN_SENDER_MODE ?? 'ignore').toLowerCase(),
  // Ignore group chats (@g.us) silently by default to reduce spam/ban risk.
  ignoreGroups: process.env.IGNORE_GROUPS !== 'false',
}

export const sessionPath = (id) => `${config.sessionDir}/${id}.sqlite`
