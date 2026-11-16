import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemorySettings } from '../lib/memory/settings.js'
import { MemoryStore } from '../lib/memory/store.js'
import { buildMemoryBundle, resolveMemoryScope, machineScope, formatWorkspaceBrief, formatMachineBrief } from '../lib/memory/scope.js'

test('both switches default to off and gate the bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const settings = new MemorySettings({ dataDir: dir })
    const store = new MemoryStore({ dataDir: dir })
    const brief = {
      machine: () => ({ data: { os: 'Linux' } }),
      workspace: () => ({ data: { git: { remote: 'git@example/app.git' }, stack: 'Node' } }),
    }
    const scope = { kind: 'workspace', connectionId: 'conn-1', remotePath: '/data/app' }
    assert.equal(settings.masterEnabled(), false)
    assert.equal(settings.machineEnabled('conn-1'), false)
    assert.equal(buildMemoryBundle({ settings, store, brief, scope }), '')

    settings.setMaster(true)
    assert.equal(buildMemoryBundle({ settings, store, brief, scope }), '')
    settings.setMachine('conn-1', true)
    const text = buildMemoryBundle({ settings, store, brief, scope })
    assert.match(text, /Remote Deck/)
    assert.match(text, /machine: conn-1/)
    assert.match(text, /workspace: \/data\/app/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bundle includes machine/workspace briefs and notes under the byte budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const settings = new MemorySettings({ dataDir: dir })
    settings.setMaster(true)
    settings.setMachine('conn-1', true)
    settings.update({ injectBytes: 512 })
    const store = new MemoryStore({ dataDir: dir })
    const scope = { kind: 'workspace', connectionId: 'conn-1', remotePath: '/data/app' }
    store.upsert(scope, { text: 'command one '.repeat(30), kind: 'command', pinned: true })
    for (let index = 0; index < 12; index += 1) {
      store.upsert(scope, { text: `note ${index} `.repeat(6), kind: 'fact' })
    }
    const brief = {
      machine: () => ({ data: { os: 'AlmaLinux 9.4', resources: '8 cores', tools: ['node', 'git'] } }),
      workspace: () => ({ data: { git: { branch: 'main', head: 'abc123' }, stack: 'Node', commands: ['npm test'], readme: 'demo' } }),
    }
    const text = buildMemoryBundle({ settings, store, brief, scope })
    assert.ok(Buffer.byteLength(text, 'utf8') <= 512, `bundle is ${Buffer.byteLength(text, 'utf8')} bytes`)
    assert.match(text, /AlmaLinux/)
    assert.match(text, /workspace: \/data\/app/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope resolution maps a remote cwd and leaves local cwd alone', () => {
  const routing = {
    resolveTarget: (cwd) => (cwd.includes('stub') ? { connectionId: 'conn-1', path: '/data/app' } : null),
  }
  assert.deepEqual(resolveMemoryScope(routing, 'E:/stub'), {
    kind: 'workspace',
    connectionId: 'conn-1',
    remotePath: '/data/app',
  })
  assert.equal(resolveMemoryScope(routing, 'C:/local/project'), null)
  assert.deepEqual(machineScope('conn-1'), { kind: 'machine', connectionId: 'conn-1' })
})

test('multi-repo brief lists subrepos and omits volatile disk/branch facts', () => {
  const lines = formatWorkspaceBrief({
    kind: 'multi-repo',
    readme: 'workspace root',
    repos: [
      { name: 'agentflow-server', stack: 'Python', commands: ['pytest'], remote: 'git@example/server.git' },
      { name: 'agentflow-admin', stack: 'Node', commands: ['npm run build'], remote: '' },
    ],
  })
  assert.match(lines.join('\n'), /multi-repo \(2 subrepos\)/)
  assert.match(lines.join('\n'), /agentflow-server: Python · pytest/)
  assert.doesNotMatch(lines.join('\n'), /GB free|branch|HEAD/)
})

test('machine brief has no live disk usage', () => {
  const lines = formatMachineBrief({
    os: 'AlmaLinux 9.7 · Linux 5.14 · x86_64',
    resources: '4 核 · 11 GB',
    tools: ['node 20.11', 'git 2.43'],
    shell: '/bin/bash',
  })
  assert.match(lines.join('\n'), /4 核 · 11 GB/)
  assert.doesNotMatch(lines.join('\n'), /free|used|disk/i)
})
