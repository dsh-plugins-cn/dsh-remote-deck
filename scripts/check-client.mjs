#!/usr/bin/env node
/**
 * Cheap guard for the plugin client bundle.
 *
 * client.js is a browser-only module, so a syntax check cannot catch a helper
 * that was deleted while its call sites stayed behind (that shipped once as
 * `ReferenceError: activeNotesOf is not defined`). Keep a small list of
 * required declarations and banned leftovers instead.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** Names that must have a declaration in client.js. */
const required = [
  'NOTE_KIND_LABEL',
  'NOTE_KINDS',
  'activeNotesOf',
  'noteRowV3',
  'NoteDialog',
  'MemoryPanel',
  'RemoteDeckSettings',
  'Console',
  'pushToast',
  'pushInfo',
]

/** Identifiers that were removed; any mention means a half-finished edit. */
const banned = ['briefLines']

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const problems = []

for (const name of required) {
  const pattern = new RegExp(`(function\\s+${escape(name)}\\b|const\\s+${escape(name)}\\b|class\\s+${escape(name)}\\b)`)
  if (!pattern.test(source)) problems.push(`missing declaration: ${name}`)
}
for (const name of banned) {
  if (new RegExp(`\\b${escape(name)}\\b`).test(source)) problems.push(`stale reference: ${name}`)
}

if (problems.length > 0) {
  console.error(`client guard failed:\n${problems.map((row) => `  - ${row}`).join('\n')}`)
  process.exit(1)
}
console.log(`client guard ok: ${required.length} declarations present`)
