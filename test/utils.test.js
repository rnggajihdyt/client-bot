import { parseCommand, extractText, splitArgs, isOwner, normalizeNohp, nohpVariants, to62, toJid } from '../src/utils.js'
import assert from 'node:assert'

// normalizeNohp: semua bentuk disimpan sebagai lokal "08..."
assert.equal(normalizeNohp('085642927473'), '085642927473')
assert.equal(normalizeNohp('6285642927473'), '085642927473')
assert.equal(normalizeNohp('+62 856-4292-7473'), '085642927473')
assert.equal(normalizeNohp('0856429274735@s.whatsapp.net'), '0856429274735')
assert.equal(normalizeNohp('85940800009'), '085940800009')
assert.equal(normalizeNohp(''), '')
assert.equal(to62('085642927473'), '6285642927473')
assert.equal(toJid('085642927473'), '6285642927473@s.whatsapp.net')

// nohpVariants: baris lama "85940800009" tetap cocok dengan pengirim 62...
assert.ok(nohpVariants('6285940800009').includes('85940800009'))
assert.ok(nohpVariants('85940800009').includes('6285940800009'))
assert.deepEqual(nohpVariants(''), [])

// parseCommand
{
  const r = parseCommand('!ping arg1 arg2', '!')
  assert.ok(r && r.cmd === 'ping')
  assert.deepEqual(r.args, ['arg1', 'arg2'])
}

// prefix mismatch
assert.equal(parseCommand('ping', '!'), null)
assert.equal(parseCommand('', '!'), null)

// extractText across shapes
assert.equal(extractText({ conversation: 'hi' }), 'hi')
assert.equal(extractText({ extendedTextMessage: { text: 'yo' } }), 'yo')
assert.equal(extractText({ imageMessage: { caption: 'cap' } }), 'cap')
assert.equal(extractText(null), undefined)
assert.equal(extractText({}), undefined)

// splitArgs
assert.deepEqual(splitArgs('  a   b  '), ['a', 'b'])

// parseCommand with empty prefix => every text is a command
{
  const r = parseCommand('Format', '')
  assert.ok(r && r.cmd === 'format')
  assert.deepEqual(r.args, [])
  const r2 = parseCommand('TUKAR 100', '')
  assert.ok(r2 && r2.cmd === 'tukar')
  assert.deepEqual(r2.args, ['100'])
}
// empty prefix: empty/whitespace text => null
assert.equal(parseCommand('   ', ''), null)
assert.equal(parseCommand('', ''), null)

// isOwner: own phone matches (PN remoteJid)
assert.equal(isOwner({ key: { remoteJid: '628123456@s.whatsapp.net' } }, ['628123456']), true)
// not owner
assert.equal(isOwner({ key: { remoteJid: '999@s.whatsapp.net' } }, ['628123456']), false)
// empty owners => nobody
assert.equal(isOwner({ key: { remoteJid: '628123456@s.whatsapp.net' } }, []), false)
// LID group: participant is @lid, but participantAlt carries the PN
assert.equal(
  isOwner(
    { key: { participant: '199998888777@lid', participantAlt: '628123456@s.whatsapp.net' } },
    ['628123456']
  ),
  true
)
// LID without alt => none
assert.equal(
  isOwner({ key: { participant: '199998888777@lid' } }, ['628123456']),
  false
)
// owner with + / spaces in .env still matches (digits normalized)
assert.equal(
  isOwner({ key: { remoteJid: '628123456@s.whatsapp.net' } }, ['+62 812-3456']),
  true
)
// device-prefixed jid strips :device
assert.equal(
  isOwner({ key: { remoteJid: '628123456:12@s.whatsapp.net' } }, ['628123456']),
  true
)

console.log('utils self-check passed')
