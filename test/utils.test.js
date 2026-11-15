import { parseCommand, extractText, splitArgs } from '../src/utils.js'
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

console.log('utils self-check passed')
