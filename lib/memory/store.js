/**
 * Remote Deck memory storage.
 *
 * One small JSON file per scope (plugin / machine / workspace). Notes are the
 * only durable memory; environment briefs live in `lib/memory/brief.js`.
 * Writes are atomic and every structural change keeps a history snapshot so the
 * UI can undo it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { slugFor } from '../util.js'

export const SCHEMA_VERSION = 1
export const NOTE_KINDS = ['fact', 'preference', 'command', 'caution', 'decision']
export const MAX_NOTE_CHARS = 500
export const MAX_ACTIVE_NOTES = 40
const HISTORY_LIMIT = 20

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /\b(?:token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
]

export function looksSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(String(text || '')))
}

export function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function noteHash(text) {
  return createHash('sha1').update(normalizeText(text).toLowerCase()).digest('hex')
}

export function scopeKey(scope) {
  if (!scope || typeof scope !== 'object') return ''
  if (scope.kind === 'plugin') return 'plugin'
  if (scope.kind === 'machine') return `machine:${String(scope.connectionId || '')}`
  if (scope.kind === 'workspace') {
    return `workspace:${String(scope.connectionId || '')}:${String(scope.remotePath || '')}`
  }
  return ''
}

export function parseScopeKey(key) {
  const value = String(key || '')
  if (value === 'plugin') return { kind: 'plugin' }
  if (value.startsWith('machine:')) {
    const connectionId = value.slice('machine:'.length)
    return connectionId ? { kind: 'machine', connectionId } : null
  }
  if (value.startsWith('workspace:')) {
    const rest = value.slice('workspace:'.length)
    const index = rest.indexOf(':')
    if (index <= 0) return null
    const connectionId = rest.slice(0, index)
    const remotePath = rest.slice(index + 1)
    return connectionId && remotePath ? { kind: 'workspace', connectionId, remotePath } : null
  }
  return null
}

export function scopeLabel(scope) {
  if (scope.kind === 'plugin') return '插件'
  if (scope.kind === 'machine') return `机器 ${scope.connectionId}`
  return `工作区 ${scope.remotePath}`
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'unknown'
}

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
}

function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
}

export class MemoryStore {
  constructor({ dataDir, now = () => new Date().toISOString() }) {
    this.root = join(dataDir, 'notes')
    this.historyRoot = join(dataDir, 'history')
    this.now = now
    this.cache = new Map()
  }

  fileFor(scope) {
    if (scope.kind === 'plugin') return join(this.root, 'plugin.json')
    if (scope.kind === 'machine') return join(this.root, 'machines', `${safeSegment(scope.connectionId)}.json`)
    return join(this.root, 'workspaces', safeSegment(scope.connectionId), `${slugFor(scope.remotePath)}.json`)
  }

  historyDir(scope) {
    const id = createHash('sha1').update(scopeKey(scope)).digest('hex').slice(0, 10)
    return join(this.historyRoot, id)
  }

  /** Load one scope, tolerating a missing or corrupt file (read-only empty). */
  load(scope) {
    const key = scopeKey(scope)
    if (this.cache.has(key)) return this.cache.get(key)
    const doc = readJson(this.fileFor(scope))
    const notes = Array.isArray(doc?.notes) ? doc.notes.filter(isValidNote).map(normalizeNote) : []
    this.cache.set(key, notes)
    return notes
  }

  save(scope, notes) {
    const key = scopeKey(scope)
    const clean = notes.filter(isValidNote).map(normalizeNote)
    this.snapshot(scope)
    writeAtomic(this.fileFor(scope), {
      version: SCHEMA_VERSION,
      scope,
      updatedAt: this.now(),
      notes: clean,
    })
    this.cache.set(key, clean)
    return clean
  }

  resetCache() {
    this.cache.clear()
  }

  snapshot(scope) {
    const notes = this.cache.get(scopeKey(scope))
    if (!notes || notes.length === 0) return
    try {
      const dir = this.historyDir(scope)
      mkdirSync(dir, { recursive: true })
      writeAtomic(join(dir, `${Date.now()}.json`), {
        version: SCHEMA_VERSION,
        scope,
        savedAt: this.now(),
        notes,
      })
      const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
      for (const name of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
        rmSync(join(dir, name), { force: true })
      }
    } catch {
      /* history is best effort; a failed snapshot must not block a write */
    }
  }

  active(scope) {
    return this.load(scope).filter((note) => note.status === 'active')
  }

  upsert(scope, input) {
    const text = normalizeText(input.text)
    if (text.length === 0) throw memoryError('MEMORY_EMPTY', '笔记内容不能为空')
    if (text.length > MAX_NOTE_CHARS) throw memoryError('MEMORY_TOO_LONG', `笔记不能超过 ${MAX_NOTE_CHARS} 字`)
    if (looksSecret(text)) throw memoryError('MEMORY_SECRET', '内容看起来包含密码/token/私钥，已拒绝保存')
    const kind = NOTE_KINDS.includes(input.kind) ? input.kind : 'fact'
    const notes = this.load(scope).slice()
    const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : `note_${randomUUID()}`
    const existing = notes.find((note) => note.id === id)
    const now = this.now()
    if (existing) {
      const updated = {
        ...existing,
        kind,
        text,
        tags: normalizeTags(input.tags),
        pinned: input.pinned === true,
        source: { ...existing.source, updatedAt: now },
        updatedAt: now,
        verifiedAt: now,
      }
      this.save(scope, notes.map((note) => (note.id === id ? updated : note)))
      return updated
    }
    // A note with the same key supersedes the previous one; the old note stays
    // readable with status "superseded".
    let next = notes
    if (typeof input.key === 'string' && input.key.trim().length > 0) {
      next = notes.map((note) => (
        note.key === input.key.trim() && note.status === 'active'
          ? { ...note, status: 'superseded', updatedAt: now }
          : note
      ))
    }
    const note = normalizeNote({
      id,
      kind,
      key: typeof input.key === 'string' ? input.key.trim() : '',
      text,
      tags: normalizeTags(input.tags),
      pinned: input.pinned === true,
      source: {
        kind: input.source === 'model' ? 'model' : 'user',
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
        at: now,
      },
      status: 'active',
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
    })
    next = this.cap(scope, [...next, note])
    this.save(scope, next)
    return note
  }

  cap(scope, notes) {
    const active = notes.filter((note) => note.status === 'active')
    if (active.length <= MAX_ACTIVE_NOTES) return notes
    const sorted = active.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.source.kind !== b.source.kind) return a.source.kind === 'user' ? -1 : 1
      return String(b.updatedAt).localeCompare(String(a.updatedAt))
    })
    const keep = new Set(sorted.slice(0, MAX_ACTIVE_NOTES).map((note) => note.id))
    const now = this.now()
    return notes.map((note) => (
      note.status === 'active' && !keep.has(note.id)
        ? { ...note, status: 'archived', updatedAt: now }
        : note
    ))
  }

  archive(scope, id) {
    const notes = this.load(scope).slice()
    const note = notes.find((entry) => entry.id === id)
    if (!note) return null
    note.status = 'archived'
    note.updatedAt = this.now()
    this.save(scope, notes)
    return note
  }

  restore(scope, id) {
    const notes = this.load(scope).slice()
    const note = notes.find((entry) => entry.id === id)
    if (!note) return null
    note.status = 'active'
    note.updatedAt = this.now()
    this.save(scope, this.cap(scope, notes))
    return note
  }

  remove(scope, id) {
    const notes = this.load(scope)
    const next = notes.filter((note) => note.id !== id)
    if (next.length === notes.length) return false
    this.save(scope, next)
    return true
  }

  /** Deterministic tidy: exact duplicates and over-limit notes. */
  tidy(scope) {
    const notes = this.load(scope).slice()
    const seen = new Set()
    const now = this.now()
    let removed = 0
    const deduped = []
    for (const note of notes) {
      const hash = noteHash(note.text)
      if (note.status === 'active' && seen.has(hash)) {
        removed += 1
        continue
      }
      if (note.status === 'active') seen.add(hash)
      deduped.push(note)
    }
    const capped = this.cap(scope, deduped)
    const beforeArchived = new Set(notes.filter((note) => note.status === 'archived').map((note) => note.id))
    const archived = capped.filter((note) => note.status === 'archived' && !beforeArchived.has(note.id)).length
    if (removed > 0 || archived > 0) {
      this.save(scope, capped)
      return { removed, archived, total: capped.length }
    }
    return { removed: 0, archived: 0, total: notes.length }
  }

  search(scope, query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
    return this.active(scope)
      .map((note) => {
        const text = `${note.text} ${note.tags.join(' ')}`.toLowerCase()
        const score = tokens.length === 0 ? 1 : tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0)
        return { note, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score - a.score) || (b.note.pinned ? 1 : 0) - (a.note.pinned ? 1 : 0))
      .map((entry) => entry.note)
  }
}

export function memoryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []
  return [...new Set(list
    .map((tag) => String(tag).trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= 24))]
    .slice(0, 8)
}

function isValidNote(note) {
  return note && typeof note.id === 'string' && typeof note.text === 'string'
}

function normalizeNote(note) {
  return {
    id: note.id,
    kind: NOTE_KINDS.includes(note.kind) ? note.kind : 'fact',
    key: typeof note.key === 'string' ? note.key : '',
    text: normalizeText(note.text).slice(0, MAX_NOTE_CHARS),
    tags: normalizeTags(note.tags),
    pinned: note.pinned === true,
    source: {
      kind: note.source?.kind === 'model' ? 'model' : 'user',
      sessionId: typeof note.source?.sessionId === 'string' ? note.source.sessionId : '',
      at: typeof note.source?.at === 'string' ? note.source.at : '',
      updatedAt: typeof note.source?.updatedAt === 'string' ? note.source.updatedAt : '',
    },
    status: ['active', 'archived', 'superseded'].includes(note.status) ? note.status : 'active',
    createdAt: typeof note.createdAt === 'string' ? note.createdAt : '',
    updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : '',
    verifiedAt: typeof note.verifiedAt === 'string' ? note.verifiedAt : '',
  }
}
