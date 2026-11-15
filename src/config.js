export const config = {
  sessionId: process.env.DEFAULT_SESSION ?? 'default',
  commandPrefix: process.env.COMMAND_PREFIX ?? '', // '' = no prefix, every text is a command
  pairingMode: process.env.PAIRING_MODE ?? 'both', // 'qr' | 'code' | 'both'
  // Phone number (digits, with country code) used for the pairing-code flow.
  pairingPhone: process.env.PAIRING_PHONE ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  storePath: process.env.STORE_PATH ?? '.auth/state.sqlite',
  autoRead: process.env.AUTOREAD === 'true',
  ppobDbPath: process.env.PPOB_DB_PATH ?? '.data/ppob.sqlite',
  ownerPin: process.env.OWNER_PIN ?? '1234',
}
