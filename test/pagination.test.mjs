import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { slicePage } = await import(pathToFileURL(`${root}/lib/api.js`).href)

test('slicePage pages rows and reports the remaining count', () => {
  const rows = Array.from({ length: 12 }, (_, index) => index)
  assert.deepEqual(slicePage(rows, new URLSearchParams('offset=0&limit=5')), { items: [0, 1, 2, 3, 4], total: 12, offset: 0, limit: 5, hasMore: true })
  assert.deepEqual(slicePage(rows, new URLSearchParams('offset=10&limit=5')), { items: [10, 11], total: 12, offset: 10, limit: 5, hasMore: false })
  // No paging parameters keeps the old first-page behavior (default 500).
  assert.deepEqual(slicePage(rows, new URLSearchParams('')).items, rows)
  assert.equal(slicePage(rows, new URLSearchParams('')).limit, 500)
  // Invalid/negative values fall back instead of returning garbage.
  assert.equal(slicePage(rows, new URLSearchParams('offset=-2&limit=0')).offset, 0)
  assert.equal(slicePage(rows, new URLSearchParams('offset=-2&limit=0')).limit, 500)
})
