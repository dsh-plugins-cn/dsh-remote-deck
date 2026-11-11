import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Routing } = await import(pathToFileURL(`${root}/lib/routing.js`).href)

function directoryAttrs() {
  return { mtime: 1700000000, size: 0, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
}

function fakeSftp(writes) {
  return {
    stat(path, callback) {
      if (path === '/data/ws') return callback(null, directoryAttrs())
      const error = new Error('no such file')
      error.code = 2
      callback(error)
    },
    mkdir(path, callback) {
      callback(null)
    },
    writeFile(path, content, callback) {
      writes.push({ path, content: Buffer.isBuffer(content) ? content.toString('utf8') : String(content) })
      callback(null)
    },
  }
}

test('creating a workspace writes AGENTS.md only when explicitly requested', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deck-guide-'))
  try {
    const writes = []
    const sftp = fakeSftp(writes)
    const host = { record: { id: 'conn1', name: 'dev' }, requireSftp: () => sftp }
    const routing = new Routing({ workspaceRoot, legacyRoots: [], hostFor: (id) => (id === 'conn1' ? host : undefined) })
    await routing.createWorkspace('conn1', '/data/ws', { name: 'dev' })
    assert.equal(writes.filter((entry) => entry.path === '/data/ws/AGENTS.md').length, 0)
    await routing.createWorkspace('conn1', '/data/ws', { name: 'dev' }, { writeGuide: true })
    const guide = writes.filter((entry) => entry.path === '/data/ws/AGENTS.md')
    assert.equal(guide.length, 1)
    assert.match(guide[0].content, /remote host "dev"/)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
