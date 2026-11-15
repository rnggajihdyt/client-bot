import { parseCommand, extractText, splitArgs, isOwner } from '../src/utils.js'
import assert from 'node:assert'

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

console.log('utils self-check passed')
