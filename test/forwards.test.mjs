import test from 'node:test'
import assert from 'node:assert/strict'
import { parseListeningPorts } from '../lib/forwards.js'

test('parses ss -ltn output', () => {
  const output = `
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      1024         0.0.0.0:8001       0.0.0.0:*
LISTEN 0      1024         127.0.0.1:5432     0.0.0.0:*
LISTEN 0      128             [::]:22          [::]:*
`
  assert.deepEqual(parseListeningPorts(output), [22, 5432, 8001])
})

test('parses netstat -ltn output and deduplicates', () => {
  const output = `
Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
tcp        0      0 0.0.0.0:8001            0.0.0.0:*               LISTEN
tcp        0      0 0.0.0.0:8001            0.0.0.0:*               LISTEN
tcp6       0      0 :::9000                 :::*                    LISTEN
`
  assert.deepEqual(parseListeningPorts(output), [8001, 9000])
})

test('ignores header lines and peer columns', () => {
  assert.deepEqual(parseListeningPorts('State Recv-Q Send-Q Local Address:Port Peer Address:Port'), [])
  assert.deepEqual(parseListeningPorts('LISTEN 0 128 0.0.0.0:443 0.0.0.0:*'), [443])
})
