/**
 * Remote Deck — host half.
 *
 * One DSH, many execution environments. Each configured SSH host owns one
 * persistent connection; marked workspace stubs route `ctx.fs` through SFTP,
 * a `bash` tool runs commands on the host, and ripgrep moves there too.
 * A loopback API feeds the sidebar chip, the quick panel and the console.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from './lib/api.js'
import { ConnectionStore, RemoteHost, Secrets, ssh2SelfTest } from './lib/connection.js'
import { ForwardManager } from './lib/forwards.js'
import { Routing } from './lib/routing.js'
import { readSshConfig } from './lib/ssh-config.js'
import { TerminalManager } from './lib/terminal.js'
import { errorText, normalizeRemotePath } from './lib/util.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(PLUGIN_DIR, 'vendor', 'xterm')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'remote-deck')
const LEGACY_DIR = join(DSH_HOME, 'remote-ssh')
const WORKSPACE_ROOT = join(DATA_DIR, 'workspaces')
const LEGACY_WORKSPACE_ROOT = join(LEGACY_DIR, 'workspaces')
const BUILD = '1.0.5'
const diagnostics = { pid: process.pid, ssh2: 'pending', ssh2Error: '', checkedAt: 0 }
void ssh2SelfTest().then((result) => {
  diagnostics.ssh2 = result.ok ? 'ok' : 'failed'
  diagnostics.ssh2Error = result.ok ? '' : result.error
  diagnostics.checkedAt = Date.now()
  if (process.env.DSH_REMOTE_DECK_DEBUG === '1') {
    console.error('[remote-deck] ssh2 self-test', JSON.stringify(diagnostics))
  }
})
const SHELL_TIMEOUT_MS = 120000

/** Services the plugin needs; web server and credentials store stay optional. */
export const inject = ['fs', 'workingDirectory', 'tools']
export const name = 'dsh-remote-deck'

export function apply(ctx) {
  const debug = (...args) => {
    if (process.env.DSH_REMOTE_DECK_DEBUG === '1') console.error('[remote-deck]', ...args)
  }

  const store = new ConnectionStore({ dataDir: DATA_DIR, legacyDir: LEGACY_DIR })
  const secrets = new Secrets({ dataDir: DATA_DIR, legacyDir: LEGACY_DIR, credentials: ctx.get('credentials') })
  const hosts = new Map()

  const hostFor = (id) => {
    let host = hosts.get(id)
    if (host === undefined) {
      const record = store.get(id)
      if (record === undefined) return undefined
      host = new RemoteHost(record, {
        onLog: debug,
        onConnected: (connected) => {
          void forwards.restoreFor(connected.record.id)
        },
      })
      hosts.set(id, host)
    } else {
      const record = store.get(id)
      if (record !== undefined) host.record = record
    }
    return host
  }

  const listHosts = () => [...hosts.values()]

  const ensureConnected = async (id) => {
    const record = store.get(id)
    if (record === undefined) return
    const host = hostFor(id)
    if (host === undefined) return
    if (host.state === 'connected') return
    if (record.autoConnect === true || process.env.DSH_REMOTE_DECK_AUTOCONNECT === '1') {
      await host.connect(secrets)
    }
  }

  const routing = new Routing({
    workspaceRoot: WORKSPACE_ROOT,
    legacyRoots: [LEGACY_WORKSPACE_ROOT],
    hostFor,
    ensureConnected,
    getRegistry: () => ctx.get('workspaceRegistry'),
  })

  const forwards = new ForwardManager({ hostFor, secrets, dataDir: DATA_DIR, onLog: debug })
  const terminals = new TerminalManager({ hostFor, secrets, onLog: debug })

  // --- ctx.fs routing -------------------------------------------------------
  const restoreFs = routing.installFs(ctx.fs)
  ctx.effect(() => () => restoreFs(), 'remote-deck: fs patch')

  // --- bash tool ------------------------------------------------------------
  ctx.tools.register({
    name: 'bash',
    description:
      'Run a shell command on the connected remote SSH host. Use it for every command inside a remote workspace: build, test, git, ripgrep, package managers. The working directory is the remote workspace (a POSIX path); use POSIX paths, not Windows paths.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run on the remote host.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words.' },
        workdir: { type: 'string', description: 'Optional absolute POSIX working directory on the remote host; defaults to the session workspace.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, exitCode: { type: 'integer' } },
        required: ['text', 'exitCode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        const sessionCwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const target = routing.resolveTarget(sessionCwd, undefined)
        if (target === null) {
          return {
            text: `The bash tool only runs inside a remote workspace. The current working directory is local: ${JSON.stringify(sessionCwd)}. Use pwsh for local commands.`,
            exitCode: 1,
          }
        }
        const host = hostFor(target.connectionId)
        if (host === undefined) return { text: 'That connection no longer exists; recreate it.', exitCode: 1 }
        await host.connect(secrets)
        const cwd = typeof args.workdir === 'string' && args.workdir.startsWith('/')
          ? normalizeRemotePath(args.workdir)
          : target.path
        const result = await host.runCommand(args.command, cwd, { signal: exec.signal, maxBytes: 4 * 1024 * 1024 })
        const parts = [result.stdout]
        if (result.stderr.trim().length > 0) parts.push(`[stderr]\n${result.stderr}`)
        if (result.code !== 0) parts.push(`[exit code: ${result.code}]`)
        return { text: parts.filter((part) => part.length > 0).join('\n').trimEnd(), exitCode: result.code }
      } catch (error) {
        return { text: errorText(error), exitCode: 1 }
      }
    },
  })

  // --- ripgrep on the connected host ---------------------------------------
  const subprocessService = ctx.get('subprocess')
  let originalSpawn = null
  if (subprocessService !== undefined && typeof subprocessService.spawn === 'function') {
    originalSpawn = subprocessService.spawn
    subprocessService.spawn = function (spec) {
      try {
        const argv = spec !== null && typeof spec === 'object' && Array.isArray(spec.argv) ? spec.argv : null
        if (argv !== null && argv.length > 0 && /(^|[\\/])rg(\.exe)?$/i.test(String(argv[0]))) {
          const target = routing.resolveTarget(spec.cwd, undefined)
          if (target !== null) {
            const host = hostFor(target.connectionId)
            if (host !== undefined) return routing.makeRemoteRipgrep(host, target.path, argv.slice(1), spec)
          }
        }
      } catch {
        /* fall back to the local process */
      }
      return originalSpawn.call(this, spec)
    }
    ctx.effect(() => () => {
      if (originalSpawn !== null) subprocessService.spawn = originalSpawn
    }, 'remote-deck: subprocess patch')
  }

  // --- loopback API ---------------------------------------------------------
  const token = randomBytes(24).toString('hex')
  let apiPort = 0

  const testConnection = async (input) => {
    const record = {
      id: 'test-' + randomBytes(4).toString('hex'),
      name: String(input.name || 'test'),
      host: String(input.host || '').trim(),
      port: Number(input.port) || 22,
      username: String(input.username || '').trim() || 'root',
      authType: input.authType === 'password' ? 'password' : 'key',
      privateKeyPath: String(input.privateKeyPath || '').trim(),
      color: 'blue',
    }
    if (record.host.length === 0) throw new Error('host is required')
    const tempSecrets = {
      get: async (_id, kind) => {
        if (kind === 'PASSWORD') return typeof input.password === 'string' && input.password.length > 0 ? input.password : null
        return typeof input.passphrase === 'string' && input.passphrase.length > 0 ? input.passphrase : null
      },
      set: async () => {},
      clear: async () => {},
      describe: async () => ({ password: Boolean(input.password), passphrase: Boolean(input.passphrase) }),
    }
    const host = new RemoteHost(record, {})
    try {
      await host.connect(tempSecrets)
      const status = host.status()
      return { latencyMs: status.latencyMs ?? null, sys: status.sys ?? null }
    } finally {
      host.dispose()
    }
  }

  const server = createApi({
    token,
    store,
    secrets,
    hostFor,
    listHosts,
    routing,
    getRegistry: () => ctx.get('workspaceRegistry'),
    build: BUILD,
    diagnostics,
    dataDir: DATA_DIR,
    readSshConfig,
    testConnection,
    terminals,
    forwards,
    assetDir: ASSET_DIR,
  })
  server.on('error', (error) => {
    console.error('[remote-deck] api server failed:', errorText(error))
  })
  if (process.env.DSH_REMOTE_DECK_DEBUG === '1') debug('api token', token)
  server.listen(0, '127.0.0.1', () => {
    apiPort = server.address().port
    debug('api ready on', apiPort)
  })

  ctx.effect(() => () => {
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }, 'remote-deck: api')

  // --- inject connection info into the page --------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'global',
        name: '__DSH_REMOTE_DECK__',
        value: {
          get port() {
            return apiPort
          },
          token,
          build: BUILD,
          dataDir: DATA_DIR,
        },
      })
    })
  })

  // --- auto-connect at startup ---------------------------------------------
  ctx.effect(() => {
    const timer = setTimeout(() => {
      for (const record of store.list()) {
        if (record.autoConnect !== true) continue
        hostFor(record.id)?.connect(secrets).catch((error) => debug('auto-connect failed', record.name, errorText(error)))
      }
    }, 1500)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'remote-deck: auto-connect')

  // A moved DSH home (folder migration, drive change, junction) leaves stored
  // workspace paths spelled with the old alias; re-register under the canonical
  // path keeping the title, otherwise sessions cannot attach.
  ctx.inject(['workspaceRegistry'], (scope) => {
    void (async () => {
      const registry = scope.get('workspaceRegistry')
      if (registry === undefined) return
      const roots = [WORKSPACE_ROOT, LEGACY_WORKSPACE_ROOT].filter((root) => existsSync(root))
      for (const entity of [...registry.list()]) {
        try {
          const canonical = await realpath(entity.path)
          if (canonical === entity.path) continue
          if (!roots.some((root) => canonical.toLowerCase().startsWith(root.toLowerCase()))) continue
          const title = entity.title
          await registry.delete(entity.id)
          await registry.create(canonical, title)
          console.log('[remote-deck] re-registered moved workspace', canonical)
        } catch (error) {
          debug('workspace heal failed:', errorText(error))
        }
      }
    })()
  })

  // --- teardown -------------------------------------------------------------
  ctx.effect(() => () => {
    terminals.closeAll()
    forwards.closeAll()
    for (const host of hosts.values()) host.dispose()
    hosts.clear()
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }, 'remote-deck: teardown')

  debug('loaded', BUILD, 'data dir', DATA_DIR, 'legacy', LEGACY_DIR)
}
