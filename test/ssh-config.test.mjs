import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSshConfig } from '../lib/ssh-config.js'

test('parses hosts with common options', () => {
  const config = `
Host vm01
  HostName 10.0.0.11
  User root
  Port 2222
  IdentityFile /home/me/.ssh/id_ed25519
  ProxyJump bastion

Host vm02
  HostName 10.0.0.12
`
  const hosts = parseSshConfig(config)
  assert.equal(hosts.length, 2)
  const first = hosts.find((row) => row.alias === 'vm01')
  assert.equal(first.host, '10.0.0.11')
  assert.equal(first.user, 'root')
  assert.equal(first.port, 2222)
  assert.equal(first.identityFile, '/home/me/.ssh/id_ed25519')
  assert.equal(first.proxy, 'jump:bastion')
  const second = hosts.find((row) => row.alias === 'vm02')
  assert.equal(second.port, 22)
  assert.equal(second.user, '')
})

test('skips wildcard aliases and Match blocks', () => {
  const config = `
Host *.internal
  User nobody

Host real
  HostName 10.0.0.20

Match host *.internal
  User ignored
`
  const hosts = parseSshConfig(config)
  assert.deepEqual(hosts.map((row) => row.alias), ['real'])
  assert.equal(hosts[0].user, '')
})

test('ignores comments and keeps the first value', () => {
  const config = `
# a comment
Host box # trailing comment
  HostName 10.0.0.30
  Port 2200
`
  const hosts = parseSshConfig(config)
  assert.equal(hosts[0].alias, 'box')
  assert.equal(hosts[0].host, '10.0.0.30')
  assert.equal(hosts[0].port, 2200)
})
