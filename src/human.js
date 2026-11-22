// Human-like behavior layer for WhatsApp sessions:
// 1. Short read + typing rhythm (always < 500ms total by default) using zapo
//    chat-state (`composing` -> send -> `paused`).
// 2. Natural online/offline presence (`available` on activity, `unavailable`
//    after a randomized 2-5 minute idle window).
// 3. Post-connect warm-up delay and reconnect jitter.
// Automatically disabled under `node --test` unless explicitly overridden.

const PROFILES = {
  off: {
    enabled: false,
    readMinMs: 0,
    readMaxMs: 0,
    typeMinMs: 0,
    typeMaxMs: 0,
    warmupMinMs: 0,
    warmupMaxMs: 0,
    idleMinMs: 0,
    idleMaxMs: 0,
    jitterRatio: 0,
  },
  fast: {
    enabled: true,
    readMinMs: 40,
    readMaxMs: 80,
    typeMinMs: 80,
    typeMaxMs: 180,
    warmupMinMs: 1_000,
    warmupMaxMs: 2_500,
    idleMinMs: 120_000,
    idleMaxMs: 300_000,
    jitterRatio: 0.25,
  },
  normal: {
    enabled: true,
    readMinMs: 60,
    readMaxMs: 140,
    typeMinMs: 140,
    typeMaxMs: 300,
    warmupMinMs: 2_000,
    warmupMaxMs: 5_000,
    idleMinMs: 120_000,
    idleMaxMs: 300_000,
    jitterRatio: 0.25,
  },
}

export function resolveHumanMode(explicit) {
  const isTest = Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')
  const raw = explicit ?? process.env.HUMAN_MODE ?? (isTest ? 'off' : 'normal')
  const key = String(raw).trim().toLowerCase()
  return key in PROFILES ? key : 'normal'
}

export function getHumanProfile(mode) {
  return PROFILES[resolveHumanMode(mode)]
}

export function randBetween(min, max, rng = Math.random) {
  if (max <= min) return min
  return Math.floor(min + rng() * (max - min + 1))
}

export function withJitter(baseMs, ratio = 0.25, rng = Math.random) {
  if (!ratio || ratio <= 0) return baseMs
  const factor = 1 + (rng() * 2 - 1) * ratio
  return Math.max(200, Math.round(baseMs * factor))
}

export function typingDurationMs(text, profile, rng = Math.random) {
  if (!profile.enabled || profile.typeMaxMs <= 0) return 0
  const len = typeof text === 'string' ? text.length : 40
  const scale = Math.min(1, len / 250)
  const span = profile.typeMaxMs - profile.typeMinMs
  const raw = profile.typeMinMs + span * (0.35 * scale + 0.65 * rng())
  return Math.max(profile.typeMinMs, Math.min(profile.typeMaxMs, Math.round(raw)))
}

const defaultSleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

export function createHumanController(
  rawClient,
  sessionId,
  logger,
  { mode, profile: customProfile, sleep = defaultSleep, rng = Math.random } = {}
) {
  const profile = customProfile ?? getHumanProfile(mode)
  let isOnline = false
  let stopped = false
  let idleTimer = null

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdleOffline() {
    clearIdleTimer()
    if (stopped || !profile.enabled || profile.idleMaxMs <= 0) return
    const waitMs = randBetween(profile.idleMinMs, profile.idleMaxMs, rng)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (stopped || !isOnline) return
      isOnline = false
      void rawClient.presence?.send?.('unavailable')?.catch?.((err) => {
        logger?.debug?.({ sessionId, err: err?.message }, 'presence unavailable failed')
      })
    }, waitMs)
    idleTimer.unref?.()
  }

  function markOnline() {
    if (stopped || !profile.enabled) return
    if (!isOnline) {
      isOnline = true
      void rawClient.presence?.send?.('available')?.catch?.((err) => {
        logger?.debug?.({ sessionId, err: err?.message }, 'presence available failed')
      })
    }
    scheduleIdleOffline()
  }

  async function onOpen() {
    if (stopped || !profile.enabled) return
    const waitMs = randBetween(profile.warmupMinMs, profile.warmupMaxMs, rng)
    if (waitMs > 0) await sleep(waitMs)
    if (stopped) return
    markOnline()
  }

  function onClose() {
    clearIdleTimer()
    isOnline = false
  }

  async function onIncoming() {
    if (stopped || !profile.enabled) return
    markOnline()
    const readMs = randBetween(profile.readMinMs, profile.readMaxMs, rng)
    if (readMs > 0) await sleep(readMs)
  }

  function stop() {
    stopped = true
    clearIdleTimer()
    isOnline = false
  }

  async function sendHuman(jid, content, opts) {
    const rawMsg = rawClient.message
    if (!profile.enabled || stopped) {
      return rawMsg.send(jid, content, opts)
    }
    markOnline()
    await rawClient.presence?.sendChatstate?.(jid, { state: 'composing' })?.catch?.(() => {})
    const delay = typingDurationMs(content, profile, rng)
    if (delay > 0) await sleep(delay)
    try {
      return await rawMsg.send(jid, content, opts)
    } finally {
      void rawClient.presence?.sendChatstate?.(jid, { state: 'paused' })?.catch?.(() => {})
      scheduleIdleOffline()
    }
  }

  const messageProxyCache = new WeakMap()
  function wrapMessage(targetMsg) {
    if (!targetMsg || typeof targetMsg !== 'object') return targetMsg
    let cached = messageProxyCache.get(targetMsg)
    if (!cached) {
      cached = new Proxy(targetMsg, {
        get(target, prop) {
          if (prop === 'send') return sendHuman
          const val = Reflect.get(target, prop)
          return typeof val === 'function' ? val.bind(target) : val
        },
      })
      messageProxyCache.set(targetMsg, cached)
    }
    return cached
  }

  const client = new Proxy(rawClient, {
    get(target, prop) {
      if (prop === 'message') return wrapMessage(target.message)
      const val = Reflect.get(target, prop)
      return typeof val === 'function' ? val.bind(target) : val
    },
  })

  return {
    client,
    profile,
    onOpen,
    onClose,
    onIncoming,
    markOnline,
    stop,
    get isOnline() {
      return isOnline
    },
  }
}
