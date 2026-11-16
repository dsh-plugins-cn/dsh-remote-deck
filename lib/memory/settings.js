/**
 * Remote Deck memory switches.
 *
 * Both levels default to off: the plugin master switch and each machine switch
 * must be on before a remote session receives any memory. Settings live in the
 * plugin's own data directory, so toggling does not rewrite the profile.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SETTINGS_VERSION = 1
export const DEFAULT_INJECT_BYTES = 2000
export const MAX_INJECT_BYTES = 3000
export const MIN_INJECT_BYTES = 512

function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
}

export class MemorySettings {
  constructor({ dataDir, now = () => new Date().toISOString() }) {
    this.file = join(dataDir, 'settings.json')
    this.now = now
    this.cache = this.load()
  }

  defaults() {
    return {
      version: SETTINGS_VERSION,
      enabled: false,
      machines: {},
      injectBytes: DEFAULT_INJECT_BYTES,
      machineProbe: true,
      workspaceScan: true,
      probeTtlHours: 24,
      noteTtlDays: 90,
      injectSubagents: true,
      updatedAt: this.now(),
    }
  }

  load() {
    const doc = readJson(this.file)
    const defaults = this.defaults()
    if (!doc || typeof doc !== 'object') return defaults
    const machines = {}
    if (doc.machines && typeof doc.machines === 'object') {
      for (const [id, value] of Object.entries(doc.machines)) {
        if (typeof id === 'string' && id.length > 0) machines[id] = value === true
      }
    }
    return {
      ...defaults,
      enabled: doc.enabled === true,
      machines,
      injectBytes: clampBytes(doc.injectBytes),
      machineProbe: doc.machineProbe !== false,
      workspaceScan: doc.workspaceScan !== false,
      probeTtlHours: clampNumber(doc.probeTtlHours, 1, 24 * 30, 24),
      noteTtlDays: clampNumber(doc.noteTtlDays, 1, 3650, 90),
      injectSubagents: doc.injectSubagents !== false,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : defaults.updatedAt,
    }
  }

  get() {
    return this.cache
  }

  masterEnabled() {
    return this.cache.enabled === true
  }

  machineEnabled(connectionId) {
    return this.cache.machines[connectionId] === true
  }

  activeFor(connectionId) {
    return this.masterEnabled() && this.machineEnabled(connectionId)
  }

  setMaster(enabled) {
    this.cache = { ...this.cache, enabled: enabled === true, updatedAt: this.now() }
    this.save()
    return this.cache
  }

  setMachine(connectionId, enabled) {
    const machines = { ...this.cache.machines, [connectionId]: enabled === true }
    this.cache = { ...this.cache, machines, updatedAt: this.now() }
    this.save()
    return this.cache
  }

  update(patch) {
    const next = { ...this.cache }
    if (patch && typeof patch === 'object') {
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (typeof patch.machineProbe === 'boolean') next.machineProbe = patch.machineProbe
      if (typeof patch.workspaceScan === 'boolean') next.workspaceScan = patch.workspaceScan
      if (Number.isFinite(patch.injectBytes)) next.injectBytes = clampBytes(patch.injectBytes)
      if (Number.isFinite(patch.probeTtlHours)) next.probeTtlHours = clampNumber(patch.probeTtlHours, 1, 24 * 30, 24)
      if (Number.isFinite(patch.noteTtlDays)) next.noteTtlDays = clampNumber(patch.noteTtlDays, 1, 3650, 90)
      if (typeof patch.injectSubagents === 'boolean') next.injectSubagents = patch.injectSubagents
    }
    next.updatedAt = this.now()
    this.cache = next
    this.save()
    return this.cache
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    writeFileSync(temp, `${JSON.stringify(this.cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }
}

function clampBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_INJECT_BYTES
  return Math.min(MAX_INJECT_BYTES, Math.max(MIN_INJECT_BYTES, Math.round(number)))
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}
