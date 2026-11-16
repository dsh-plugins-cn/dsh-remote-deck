/**
 * The single model-facing memory tool. It is registered once and excluded from
 * every step by `when` unless both the master and machine switches are on and
 * the session is inside a remote workspace.
 */
import { errorText } from '../util.js'
import { resolveMemoryScope, machineScope, pluginScope, scopesFor } from './scope.js'

const ACTIONS = ['search', 'remember', 'update', 'archive']

export function createMemoryTool({ ctx, routing, workingDirectory, settings, store }) {
  const scopeByAgent = new WeakMap()

  const scopeFor = async (agent, signal) => {
    if (scopeByAgent.has(agent)) return scopeByAgent.get(agent)
    const cwd = await workingDirectory.ensure(agent, signal)
    const scope = resolveMemoryScope(routing, cwd)
    if (scope !== null) scopeByAgent.set(agent, scope)
    return scope
  }

  const active = (scope) => scope !== null && settings.activeFor(scope.connectionId)

  const targetScope = (scope, name) => {
    if (name === 'machine') return machineScope(scope.connectionId)
    if (name === 'plugin') return pluginScope()
    return scope
  }

  const findNote = (scope, id) => {
    for (const candidate of scopesFor(scope)) {
      const note = store.load(candidate).find((entry) => entry.id === id)
      if (note) return { scope: candidate, note }
    }
    return null
  }

  const definition = {
    name: 'remote_memory',
    description:
      'Search or update Remote Deck memory for the current remote workstation/workspace: saved notes about the environment, commands, cautions and decisions. ' +
      'Use it when the user asks you to remember something, when a stable command or constraint is confirmed, or when earlier notes may answer a question. ' +
      'Default scope is the current workspace; writing to the machine or plugin scope requires an explicit scope. Only available when Remote Memory is enabled for this machine.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'search: find notes; remember: add a note; update: edit an existing note; archive: retire a note.' },
        query: { type: 'string', description: 'Search words for action=search.' },
        text: { type: 'string', description: 'Note content, at most 500 characters. Prefer one executable fact per note.' },
        scope: { type: 'string', enum: ['workspace', 'machine', 'plugin'], description: 'Where a new note belongs. Defaults to the current workspace; machine/plugin must be explicit.' },
        kind: { type: 'string', enum: ['fact', 'preference', 'command', 'caution', 'decision'], description: 'Note type; defaults to fact.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
        pinned: { type: 'boolean', description: 'Pin the note so it is injected before unpinned notes.' },
        id: { type: 'string', description: 'Existing note id for action=update or action=archive.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['text', 'action'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        const scope = await scopeFor(exec.agent, exec.signal)
        if (!active(scope)) {
          return { text: 'Remote Memory is disabled for this remote machine. Enable it in Remote Deck → Memory first.', action: 'disabled' }
        }
        if (args.action === 'search') {
          const query = String(args.query || '')
          const scopes = scopesFor(scope)
          const seen = new Set()
          const rows = []
          for (const candidate of scopes) {
            for (const note of store.search(candidate, query)) {
              if (seen.has(note.id)) continue
              seen.add(note.id)
              rows.push({ note, scope: candidate })
              if (rows.length >= 8) break
            }
            if (rows.length >= 8) break
          }
          if (rows.length === 0) return { text: 'No matching notes.', action: 'search' }
          return {
            text: rows.map(({ note, scope: where }) => `[${note.kind}${note.pinned ? ' · pinned' : ''}] ${note.text} (${where.kind} · ${note.id})`).join('\n'),
            action: 'search',
          }
        }
        if (args.action === 'remember') {
          const where = targetScope(scope, args.scope)
          const note = store.upsert(where, {
            text: args.text,
            kind: args.kind,
            tags: args.tags,
            pinned: args.pinned,
            source: 'model',
            sessionId: exec.agent?.session?.id || '',
          })
          return { text: `Saved ${note.kind} note in ${where.kind} scope: ${note.text}`, action: 'remember' }
        }
        if (args.action === 'update') {
          const found = findNote(scope, String(args.id || ''))
          if (!found) return { text: 'Note not found in this session scope.', action: 'update' }
          const note = store.upsert(found.scope, {
            ...found.note,
            text: args.text ?? found.note.text,
            kind: args.kind ?? found.note.kind,
            tags: args.tags ?? found.note.tags,
            pinned: args.pinned ?? found.note.pinned,
            source: 'model',
            sessionId: exec.agent?.session?.id || '',
          })
          return { text: `Updated note: ${note.text}`, action: 'update' }
        }
        if (args.action === 'archive') {
          const found = findNote(scope, String(args.id || ''))
          if (!found) return { text: 'Note not found in this session scope.', action: 'archive' }
          store.archive(found.scope, found.note.id)
          return { text: `Archived note: ${found.note.text}`, action: 'archive' }
        }
        return { text: 'Unknown action.', action: 'unknown' }
      } catch (error) {
        return { text: `Error: ${errorText(error)}`, action: String(args.action || '') }
      }
    },
  }

  try {
    ctx.tools.register(definition, {
      when: async ({ agent, signal }) => {
        try {
          const scope = await scopeFor(agent, signal)
          const enabled = active(scope)
          if (process.env.DSH_REMOTE_DECK_DEBUG === '1') {
            console.error('[remote-deck] memory tool when', JSON.stringify({ scope, enabled, master: settings.masterEnabled(), machine: scope ? settings.machineEnabled(scope.connectionId) : false }))
          }
          return enabled
        } catch (error) {
          if (process.env.DSH_REMOTE_DECK_DEBUG === '1') console.error('[remote-deck] memory tool when failed', errorText(error))
          return false
        }
      },
    })
  } catch (error) {
    // Another plugin may already own this tool name. Keep the rest of Remote
    // Deck working instead of aborting the whole plugin load.
    if (process.env.DSH_REMOTE_DECK_DEBUG === '1') console.error('[remote-deck] memory tool registration failed', errorText(error))
  }
  return definition
}
