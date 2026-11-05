import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ssh2SelfTest } from '../lib/connection.js'

const requireFromTest = createRequire(import.meta.url)

test('require() exposes a constructable ssh2 Client', () => {
  const mod = requireFromTest('../vendor/node_modules/ssh2/lib/index.js')
  assert.equal(typeof mod.Client, 'function')
  const client = new mod.Client()
  assert.ok(client)
  client.end()
})

test('ssh2SelfTest reports ok in plain Node', async () => {
  const result = await ssh2SelfTest()
  assert.equal(result.ok, true, result.error)
  assert.equal(typeof result.pid, 'number')
})
