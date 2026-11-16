/**
 * Inject the memory bundle as a per-agent system-prompt context.
 *
 * Only agents whose session cwd resolves to a registered remote workspace are
 * touched. The context callback is synchronous and reads only local caches, so
 * a prompt is never blocked by SSH.
 */
import { buildMemoryBundle, machineScope, pluginScope, resolveMemoryScope } from './scope.js'

export function installMemoryInjection({ ctx, routing, workingDirectory, settings, store, brief, connectionName }) {
  const disposers = new Map()

  const warm = async (connectionId, remotePath, force = false) => {
    try {
      await brief.refresh(connectionId, remotePath, { force })
    } catch {
      /* brief keeps its previous cache */
    }
  }

  const onCreated = async ({ agent, signal }) => {
    let cwd
    try {
      cwd = await workingDirectory.ensure(agent, signal)
    } catch {
      return
    }
    if (signal?.aborted) return
    const scope = resolveMemoryScope(routing, cwd)
    if (scope === null) return
    const agentSystemPrompt = agent.ctx?.systemPrompt
    if (!agentSystemPrompt || typeof agentSystemPrompt.context !== 'function') return
    if (process.env.DSH_REMOTE_DECK_DEBUG === '1') {
      console.error('[remote-deck] memory inject', JSON.stringify({ agent: agent.id, cwd, scope, master: settings.masterEnabled(), machine: settings.machineEnabled(scope.connectionId) }))
    }
    const name = connectionName(scope.connectionId)
    const dispose = agentSystemPrompt.context({
      name: 'remote-deck:memory',
      order: 300,
      text: () => buildMemoryBundle({ settings, store, brief, scope, connectionName: name }),
    })
    disposers.set(agent.id ?? Symbol('agent'), dispose)
    // The first request may race the probe; pre-warm so the next turn has facts.
    void warm(scope.connectionId, scope.remotePath, false)
  }

  const off = ctx.on('agent/created', onCreated)
  ctx.effect(() => () => {
    off()
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    disposers.clear()
  }, 'remote-deck: memory injection')

  return { warm }
}

/** Scopes used by the console for the selected host/workspace. */
export function consoleScopes(connectionId, remotePath) {
  const scopes = [pluginScope(), machineScope(connectionId)]
  if (typeof remotePath === 'string' && remotePath.length > 0) {
    scopes.push({ kind: 'workspace', connectionId, remotePath })
  }
  return scopes
}
