import assert from 'node:assert/strict'
import test from 'node:test'
import { createHumanController, getHumanProfile, resolveHumanMode, typingDurationMs, withJitter } from '../src/human.js'

test('mode default di node --test adalah off; profile normal & fast selalu < 500ms total', () => {
  assert.equal(resolveHumanMode(), 'off')
  for (const mode of ['normal', 'fast']) {
    const p = getHumanProfile(mode)
    assert.equal(p.enabled, true)
    assert.ok(p.readMaxMs + p.typeMaxMs < 500, `${mode}: total max read+type (${p.readMaxMs + p.typeMaxMs}ms) harus < 500ms`)
    assert.ok(p.warmupMinMs >= 1_000 && p.warmupMaxMs >= p.warmupMinMs)
    assert.ok(p.idleMinMs >= 60_000 && p.idleMaxMs >= p.idleMinMs)
    assert.ok(typingDurationMs('pendek', p) <= p.typeMaxMs)
    assert.ok(typingDurationMs('x'.repeat(2000), p) <= p.typeMaxMs)
  }
})

test('withJitter: hasil tetap dalam rentang ±ratio dan minimal 200ms', () => {
  const low = withJitter(1000, 0.25, () => 0)
  const mid = withJitter(1000, 0.25, () => 0.5)
  const high = withJitter(1000, 0.25, () => 1)
  assert.equal(low, 750)
  assert.equal(mid, 1000)
  assert.equal(high, 1250)
  assert.equal(withJitter(1000, 0), 1000)
})

test('human controller: read delay -> composing -> send -> paused (<500ms) + warm-up + idle offline', async () => {
  const events = []
  const sleeps = []
  const rawClient = {
    presence: {
      send: async (state) => {
        events.push(`presence:${state}`)
      },
      sendChatstate: async (jid, { state }) => {
        events.push(`chatstate:${jid}:${state}`)
      },
    },
    message: {
      send: async (jid, text) => {
        events.push(`send:${jid}:${text}`)
        return { id: 'm1' }
      },
    },
  }

  const profile = {
    ...getHumanProfile('normal'),
    idleMinMs: 40,
    idleMaxMs: 40,
  }
  const human = createHumanController(rawClient, 'tokoku', null, {
    profile,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    rng: () => 0.5,
  })

  // 1) Warm-up on open before marking online
  await human.onOpen()
  assert.ok(sleeps[0] >= 2_000 && sleeps[0] <= 5_000, 'warm-up 2-5 detik saat open')
  assert.equal(events[0], 'presence:available')
  assert.equal(human.isOnline, true)

  // 2) Incoming + reply: read delay + composing -> send -> paused, total < 500ms
  sleeps.length = 0
  events.length = 0
  await human.onIncoming()
  await human.client.message.send('628111@s.whatsapp.net', 'Halo mitra!')
  const totalReplyDelay = sleeps.reduce((a, b) => a + b, 0)
  assert.ok(totalReplyDelay > 0 && totalReplyDelay < 500, `total read+typing (${totalReplyDelay}ms) harus >0 dan <500ms`)
  assert.deepEqual(events, [
    'chatstate:628111@s.whatsapp.net:composing',
    'send:628111@s.whatsapp.net:Halo mitra!',
    'chatstate:628111@s.whatsapp.net:paused',
  ])

  // 3) Idle offline: otomatis kirim unavailable setelah idle
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(human.isOnline, false)
  assert.ok(events.includes('presence:unavailable'), 'harus pindah ke unavailable saat idle')

  // 4) Aktivitas berikutnya otomatis kembali available
  events.length = 0
  await human.client.message.send('628111@s.whatsapp.net', 'Lanjut')
  assert.equal(human.isOnline, true)
  assert.equal(events[0], 'presence:available')

  human.stop()
})
