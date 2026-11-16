import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)

function stub(root, connectionId, name, remotePath) {
  const dir = join(root, connectionId, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.dsh-remote.json'), JSON.stringify({
    version: 1,
    connectionId,
    path: remotePath,
    host: 'dev',
    color: 'blue',
  }))
  return dir
}

test('listWorkspaces exposes the registry workspaceId for a marked stub', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-workspace-id-'))
  try {
    const dir = stub(workspaceRoot, 'conn1', 'demo-hash', '/data/apps/demo')
    const registry = {
      list: () => [{
        id: 'workspace-id-1',
        path: dir,
        title: 'dev · demo',
        record: { createdAt: '2026-11-16T00:00:00.000Z' },
      }],
    }
    const routing = new Routing({
      workspaceRoot,
      legacyRoots: [],
      hostFor: () => undefined,
      getRegistry: () => registry,
    })
    const rows = routing.listWorkspaces()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].workspaceId, 'workspace-id-1')
    assert.equal(rows[0].stub, dir)
    assert.equal(rows[0].host, 'dev')
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('an unregistered stub keeps an empty workspaceId instead of guessing', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-workspace-id-'))
  try {
    const dir = stub(workspaceRoot, 'conn1', 'orphan-hash', '/data/apps/orphan')
    const routing = new Routing({
      workspaceRoot,
      legacyRoots: [],
      hostFor: () => undefined,
      getRegistry: () => ({ list: () => [] }),
    })
    const rows = routing.listWorkspaces()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].stub, dir)
    assert.equal(rows[0].workspaceId, '')
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
