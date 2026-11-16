/**
 * Remote Deck memory service: settings, notes, briefs, injection and the tool.
 * The host half owns this object; the loopback API and the tool both call it.
 */
import { join } from 'node:path'
import { MemoryStore } from './store.js'
import { MemorySettings } from './settings.js'
import { MemoryBrief } from './brief.js'
import { installMemoryInjection, consoleScopes } from './inject.js'
import { buildMemoryBundle, previewMemory } from './scope.js'
import { createMemoryTool } from './tools.js'

export class MemoryService {
  constructor({ ctx, dataDir, routing, hostFor, connectHost, connectionName, now }) {
    this.ctx = ctx
    this.routing = routing
    this.hostFor = hostFor
    this.connectHost = connectHost
    this.connectionName = connectionName
    const memoryDir = join(dataDir, 'memory')
    this.settings = new MemorySettings({ dataDir: memoryDir, now })
    this.store = new MemoryStore({ dataDir: memoryDir, now })
    this.brief = new MemoryBrief({ dataDir: memoryDir, hostFor, routing, settings: this.settings, connectHost, now })
    this.injection = null
    this.tool = null
  }

  install(workingDirectory) {
    this.injection = installMemoryInjection({
      ctx: this.ctx,
      routing: this.routing,
      workingDirectory,
      settings: this.settings,
      store: this.store,
      brief: this.brief,
      connectionName: this.connectionName,
    })
    this.tool = createMemoryTool({
      ctx: this.ctx,
      routing: this.routing,
      workingDirectory,
      settings: this.settings,
      store: this.store,
    })
    return this
  }

  warm(connectionId, remotePath, force = false) {
    return this.brief.refresh(connectionId, remotePath, { force })
  }

  refresh({ connectionId, remotePath, force = true }) {
    return this.brief.refresh(connectionId, remotePath, { force })
  }

  setSettings(input) {
    if (input && typeof input.enabled === 'boolean') this.settings.setMaster(input.enabled)
    if (input && input.machine && typeof input.machine.connectionId === 'string') {
      this.settings.setMachine(input.machine.connectionId, input.machine.enabled === true)
    }
    if (input && Number.isFinite(input.injectBytes)) this.settings.update({ injectBytes: input.injectBytes })
    return this.settings.get()
  }

  setMachine(connectionId, enabled) {
    return this.settings.setMachine(connectionId, enabled === true)
  }

  list({ connectionId, remotePath, workspaces = [] }) {
    const scopes = consoleScopes(connectionId, remotePath)
    const notes = {}
    for (const scope of scopes) {
      notes[scope.kind] = this.store.load(scope)
    }
    const preview = remotePath
      ? previewMemory({
          settings: this.settings,
          store: this.store,
          brief: this.brief,
          scope: { kind: 'workspace', connectionId, remotePath },
          connectionName: this.connectionName(connectionId),
        })
      : { text: '', bytes: 0, limit: this.settings.get().injectBytes }
    return {
      settings: this.settings.get(),
      enabled: this.settings.get().enabled,
      machineEnabled: this.settings.machineEnabled(connectionId),
      connectionId,
      connectionName: this.connectionName(connectionId),
      remotePath: remotePath || '',
      machine: {
        brief: this.brief.machine(connectionId),
        notes: notes.machine || [],
      },
      workspace: {
        brief: remotePath ? this.brief.workspace(connectionId, remotePath) : null,
        notes: notes.workspace || [],
      },
      workspaces: this.summarizeWorkspaces(connectionId, workspaces),
      pluginNotes: notes.plugin || [],
      preview,
    }
  }

  /** Per-workspace counters for the workspace picker. Read-only. */
  summarizeWorkspaces(connectionId, paths) {
    const seen = new Set()
    const rows = []
    for (const raw of paths) {
      const remotePath = String(raw || '')
      if (remotePath.length === 0 || seen.has(remotePath)) continue
      seen.add(remotePath)
      const scope = { kind: 'workspace', connectionId, remotePath }
      const brief = this.brief.workspace(connectionId, remotePath)
      rows.push({
        path: remotePath,
        noteCount: this.store.active(scope).length,
        hasBrief: brief !== null && brief !== undefined,
        generatedAt: brief ? brief.generatedAt : null,
      })
    }
    return rows
  }

  plugin() {
    return { settings: this.settings.get(), notes: this.store.load({ kind: 'plugin' }) }
  }

  saveNote(input) {
    const connectionId = String(input.connectionId || '')
    const remotePath = typeof input.remotePath === 'string' ? input.remotePath : ''
    const kind = input.scope === 'plugin' ? 'plugin' : input.scope === 'machine' ? 'machine' : 'workspace'
    const scope = kind === 'plugin'
      ? { kind: 'plugin' }
      : kind === 'machine'
        ? { kind: 'machine', connectionId }
        : { kind: 'workspace', connectionId, remotePath }
    if (kind !== 'plugin' && connectionId.length === 0) throw new Error('connectionId is required')
    if (kind === 'workspace' && remotePath.length === 0) throw new Error('remotePath is required')
    const note = this.store.upsert(scope, {
      id: typeof input.id === 'string' ? input.id : undefined,
      text: input.text,
      kind: input.kind,
      tags: input.tags,
      pinned: input.pinned,
      source: 'user',
    })
    return { note, notes: this.store.load(scope) }
  }

  archiveNote({ connectionId, remotePath, scope, id }) {
    const target = scopeForInput(connectionId, remotePath, scope)
    const note = this.store.archive(target, String(id || ''))
    return { note, notes: this.store.load(target) }
  }

  restoreNote({ connectionId, remotePath, scope, id }) {
    const target = scopeForInput(connectionId, remotePath, scope)
    const note = this.store.restore(target, String(id || ''))
    return { note, notes: this.store.load(target) }
  }

  deleteNote({ connectionId, remotePath, scope, id }) {
    const target = scopeForInput(connectionId, remotePath, scope)
    const removed = this.store.remove(target, String(id || ''))
    return { removed, notes: this.store.load(target) }
  }

  tidy({ connectionId, remotePath, scope }) {
    const target = scopeForInput(connectionId, remotePath, scope)
    return this.store.tidy(target)
  }

  bundle(connectionId, remotePath) {
    return buildMemoryBundle({
      settings: this.settings,
      store: this.store,
      brief: this.brief,
      scope: { kind: 'workspace', connectionId, remotePath },
      connectionName: this.connectionName(connectionId),
    })
  }
}

function scopeForInput(connectionId, remotePath, scope) {
  if (scope === 'plugin') return { kind: 'plugin' }
  if (scope === 'machine') return { kind: 'machine', connectionId }
  return { kind: 'workspace', connectionId, remotePath }
}
