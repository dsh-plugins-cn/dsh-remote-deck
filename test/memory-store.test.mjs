import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_ACTIVE_NOTES, MemoryStore, scopeKey } from '../lib/memory/store.js'

function workspaceScope(remotePath = '/data/app') {
  return { kind: 'workspace', connectionId: 'conn-1', remotePath }
}

test('notes round-trip through the workspace scope and normalize text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const store = new MemoryStore({ dataDir: dir })
    const scope = workspaceScope()
    const note = store.upsert(scope, {
      text: '  build with   npm run build\n\n',
      kind: 'command',
      tags: ['Build', ' build '],
      pinned: true,
      source: 'user',
    })
    assert.equal(note.text, 'build with npm run build')
    assert.deepEqual(note.tags, ['build'])
    assert.equal(note.pinned, true)
    const loaded = store.active(scope)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, note.id)
    assert.equal(scopeKey(scope), 'workspace:conn-1:/data/app')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('secrets are rejected instead of stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const store = new MemoryStore({ dataDir: dir })
    const scope = workspaceScope()
    assert.throws(
      () => store.upsert(scope, { text: 'password=super-secret' }),
      /密码|token|私钥/,
    )
    assert.equal(store.active(scope).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a same-key note supersedes the previous active note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const store = new MemoryStore({ dataDir: dir })
    const scope = workspaceScope()
    store.upsert(scope, { key: 'build', text: 'npm run build', kind: 'command' })
    store.upsert(scope, { key: 'build', text: 'pnpm build', kind: 'command' })
    const all = store.load(scope)
    assert.equal(all.filter((note) => note.status === 'active').length, 1)
    assert.equal(all.find((note) => note.status === 'active').text, 'pnpm build')
    assert.equal(all.filter((note) => note.status === 'superseded').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the active note cap archives the oldest unpinned notes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const store = new MemoryStore({ dataDir: dir })
    const scope = workspaceScope()
    for (let index = 0; index < MAX_ACTIVE_NOTES + 5; index += 1) {
      store.upsert(scope, { text: `fact ${index}`, kind: 'fact' })
    }
    const all = store.load(scope)
    assert.equal(all.filter((note) => note.status === 'active').length, MAX_ACTIVE_NOTES)
    assert.equal(all.filter((note) => note.status === 'archived').length, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tidy removes exact duplicates and keeps one copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const store = new MemoryStore({ dataDir: dir })
    const scope = workspaceScope()
    store.upsert(scope, { text: 'same fact', kind: 'fact' })
    store.upsert(scope, { text: 'same fact', kind: 'fact' })
    const result = store.tidy(scope)
    assert.equal(result.removed, 1)
    assert.equal(store.active(scope).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archive, restore and remove change status without losing history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-memory-'))
  try {
    const store = new MemoryStore({ dataDir: dir })
    const scope = workspaceScope()
    const note = store.upsert(scope, { text: 'keep me', kind: 'fact' })
    assert.equal(store.archive(scope, note.id).status, 'archived')
    assert.equal(store.active(scope).length, 0)
    assert.equal(store.restore(scope, note.id).status, 'active')
    assert.equal(store.active(scope).length, 1)
    assert.equal(store.remove(scope, note.id), true)
    assert.equal(store.load(scope).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
