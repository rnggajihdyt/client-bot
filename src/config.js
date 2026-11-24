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
  // Unknown sender handling (1:1 chats): 'always' | 'once' (1x/24h) | 'ignore'
  unknownSenderMode: (process.env.UNKNOWN_SENDER_MODE ?? 'always').toLowerCase(),
  // Ignore group chats (@g.us) silently by default to reduce spam/ban risk.
  ignoreGroups: process.env.IGNORE_GROUPS !== 'false',
  // Product catalog cache TTL in seconds (on-demand refresh for CH/BELI)
  productCacheTtlSec: Number(process.env.PRODUCT_CACHE_TTL_SEC ?? 60),
  // Background cron interval in minutes to auto-sync ICS products (0 = off)
  syncIntervalMin: Number(process.env.SYNC_INTERVAL_MIN ?? 15),
  // Read-only web report (dashboard per session). Empty REPORT_TOKEN => localhost only.
  reportPort: Number(process.env.REPORT_PORT ?? 8090),
  reportHost: process.env.REPORT_HOST ?? '127.0.0.1',
  reportToken: process.env.REPORT_TOKEN ?? '',
  // Public base URL for per-user report links, e.g. https://report.example.com
  reportBaseUrl: process.env.REPORT_BASE_URL ?? '',
  // Owner session whose id mints the owner report link /<KODE>/report (admin view).
  ownerReportSession: process.env.OWNER_REPORT_SESSION ?? '',
}

export const sessionPath = (id) => `${config.sessionDir}/${id}.sqlite`
