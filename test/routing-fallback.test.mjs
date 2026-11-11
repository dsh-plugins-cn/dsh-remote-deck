import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)

function fixture() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-fallback-'))
  const stub = join(workspaceRoot, 'conn1', 'ws-slug')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, '.dsh-remote.json'), JSON.stringify({ version: 1, connectionId: 'conn1', path: '/data/ws', host: 'dev' }))
  return { workspaceRoot, stub }
}

test('a disconnected remote Session keeps prompt-time stat from throwing', async () => {
  const { workspaceRoot } = fixture()
  const host = {
    state: 'disconnected',
    record: { id: 'conn1', name: 'dev' },
    requireSftp() {
      const error = new Error('not connected')
      error.code = 'REMOTE_DECK_NOT_CONNECTED'
      throw error
    },
  }
  const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: (id) => (id === 'conn1' ? host : undefined) })
  const local = (name) => () => { throw new Error('local fallback used: ' + name) }
  const fakeFs = {
    resolve: local('resolve'), stat: local('stat'), lstat: local('lstat'), readText: local('readText'),
    streamText: local('streamText'), readBytes: local('readBytes'), readByteRange: local('readByteRange'),
    listDir: local('listDir'), writeText: local('writeText'), editText: local('editText'),
    patchText: local('patchText'), deleteFile: local('deleteFile'), moveFile: local('moveFile'),
    watch: local('watch'), contains: local('contains'), fileUrl: local('fileUrl'), processPath: local('processPath'),
    processPathFromHostPath: local('processPathFromHostPath'),
  }
  const dispose = routing.installFs(fakeFs)
  try {
    const target = await fakeFs.resolve('/data/ws', { cwd: '/data/ws' })
    const info = await fakeFs.stat(target)
    assert.equal(info.type, 'directory')
    assert.equal(info.version, 'remote-degraded')
    // The actual file access must still surface the connection error clearly.
    await assert.rejects(fakeFs.readText(target), /not connected|REMOTE_DECK/)
  } finally {
    dispose()
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
