/**
 * Remote Deck — host half.
 *
 * One DSH, many execution environments. Each configured SSH host owns one
 * persistent connection; marked workspace stubs route `ctx.fs` through SFTP,
 * a `bash` tool runs commands on the host, and ripgrep moves there too.
 * A loopback API feeds the sidebar chip, the quick panel and the console.
 */
import { randomBytes, randomUUID } from 'node:crypto'
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
import { errorText } from './lib/util.js'
import { renderBashResult, renderPromoted, resolveWorkdir } from './lib/bash-result.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(PLUGIN_DIR, 'vendor', 'xterm')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'remote-deck')
const LEGACY_DIR = join(DSH_HOME, 'remote-ssh')
const WORKSPACE_ROOT = join(DATA_DIR, 'workspaces')
const LEGACY_WORKSPACE_ROOT = join(LEGACY_DIR, 'workspaces')
const BUILD = '1.3.0'
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

/** Clamp an integer environment override; invalid values fall back to the default. */
function readIntEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Remote bash execution limits; dsh-remote-deck-fix/DESIGN.md 5.5 is the contract. */
const BASH_CONFIG = Object.freeze({
  foregroundTimeoutMs: readIntEnv('DSH_REMOTE_DECK_FOREGROUND_TIMEOUT_MS', 600000, 1000, 7200000),
  maxOutputBytes: readIntEnv('DSH_REMOTE_DECK_MAX_OUTPUT_BYTES', 4 * 1024 * 1024, 65536, 16 * 1024 * 1024),
  killGraceMs: readIntEnv('DSH_REMOTE_DECK_KILL_GRACE_MS', 1000, 200, 10000),
  progressIntervalMs: readIntEnv('DSH_REMOTE_DECK_PROGRESS_MS', 5000, 1000, 60000),
})

/** Resolve a request timeout against the configured default and hard cap. */
function clampTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return BASH_CONFIG.foregroundTimeoutMs
  return Math.min(7200000, Math.max(1000, Math.round(value)))
}

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
  // Every call registers a DSH background job, waits a bounded time in the
  // foreground, and on timeout returns the job id instead of killing the
  // remote process. This mirrors @deepseek-ai/dsh-tool-bash: long legitimate
  // tasks are promoted, never interrupted; only job_kill / the Stop button
  // terminate the remote process.
  const bashToolConfiguration = {
    name: 'bash',
    description:
      'Run a shell command on the connected remote SSH host. Use it for every command inside a remote workspace: build, test, git, ripgrep, package managers. The working directory is the remote workspace (a POSIX path); use POSIX paths, not Windows paths. The working directory is strict: a missing directory fails the command instead of falling back to the home directory. Long commands keep running as a background job after the foreground wait; use job_output to read their output and job_kill to stop them.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run on the remote host.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words.' },
        workdir: { type: 'string', description: 'Optional remote working directory. An absolute POSIX path is used as-is; a relative path resolves against the session workspace.' },
        timeoutMs: { type: 'number', description: 'How long to wait in the foreground before moving the command to a background job. Defaults to the plugin limit; the command is not killed on timeout.' },
        run_in_background: { type: 'boolean', description: 'Run the command as a background job and return its job id immediately; collect it with job_output and stop it with job_kill.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          jobId: { type: 'string' },
        },
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
        const resolved = resolveWorkdir(args.workdir, target.path)
        if (resolved.error !== undefined) return { text: resolved.error, exitCode: 1 }
        if (exec.signal !== undefined && exec.signal.aborted === true) {
          return { text: 'Error: tool call aborted', exitCode: 1 }
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          const result = await host.runCommand(args.command, resolved.cwd, {
            signal: exec.signal,
            maxBytes: BASH_CONFIG.maxOutputBytes,
          })
          return renderBashResult(result, { maxBytes: BASH_CONFIG.maxOutputBytes })
        }
        const owner = exec.agent?.id
        const timeoutMs = clampTimeoutMs(args.timeoutMs)
        const background = args.run_in_background === true
        const jobKey = randomUUID().replaceAll('-', '').slice(0, 16)
        const startedAt = Date.now()
        let commandResultPromise = null
        let commandHandle = null
        let pendingKill = null
        let jobId
        try {
          jobId = jobs.start({
            kind: 'bash',
            label: String(args.command).slice(0, 80),
            ...(owner !== undefined ? { owner } : {}),
            ...(typeof exec.callId === 'string'
              ? { toolCall: { callId: exec.callId, ...(typeof exec.rootCallId === 'string' ? { rootCallId: exec.rootCallId } : {}) } }
              : {}),
            outputLimitBytes: BASH_CONFIG.maxOutputBytes,
            run: (handle) => {
              commandResultPromise = (async () => {
                const started = await host.startCommand(args.command, resolved.cwd, {
                  jobKey,
                  maxBytes: BASH_CONFIG.maxOutputBytes,
                  killGraceMs: BASH_CONFIG.killGraceMs,
                  onChunk: (channel, text) => {
                    try {
                      handle.append(text, { channel })
                    } catch {
                      /* job already settled */
                    }
                  },
                })
                commandHandle = started
                if (pendingKill !== null) void started.kill(pendingKill)
                return await started.done
              })()
              const timer = setInterval(() => {
                try {
                  handle.updateProgress(`running for ${Math.round((Date.now() - startedAt) / 1000)}s`)
                } catch {
                  /* settled */
                }
              }, BASH_CONFIG.progressIntervalMs)
              timer.unref?.()
              const done = commandResultPromise.then(
                (result) => {
                  clearInterval(timer)
                  const failed = typeof result.transportError === 'string' && result.transportError.length > 0
                  return failed ? { status: 'failed', detail: result.transportError } : { status: 'completed' }
                },
                (error) => {
                  clearInterval(timer)
                  return { status: 'failed', detail: errorText(error) }
                },
              )
              return {
                done,
                cancel: (reason) => {
                  pendingKill = typeof reason === 'string' && reason.length > 0 ? reason : 'killed'
                  if (commandHandle !== null) void commandHandle.kill(pendingKill)
                },
              }
            },
          })
        } catch (jobError) {
          const result = await host.runCommand(args.command, resolved.cwd, {
            signal: exec.signal,
            maxBytes: BASH_CONFIG.maxOutputBytes,
          })
          const rendered = renderBashResult(result, { maxBytes: BASH_CONFIG.maxOutputBytes })
          const notice = `[background jobs unavailable: ${errorText(jobError)}]`
          return { ...rendered, text: `${notice}\n${rendered.text}`.trimEnd() }
        }
        if (background === true) {
          return {
            text: `[started background job ${jobId}; use job_output to read output, job_kill to stop]`,
            exitCode: null,
            jobId,
          }
        }
        let view
        try {
          view = await jobs.wait(jobId, timeoutMs, owner, exec.signal)
        } catch {
          try {
            jobs.kill(jobId, owner, 'tool call aborted')
          } catch {
            /* already settled */
          }
          return { text: 'Error: tool call aborted', exitCode: null, jobId }
        }
        if (view.status === 'running' || view.status === 'stopping') {
          try {
            const read = jobs.read(jobId, owner)
            return renderPromoted(read, jobId, timeoutMs)
          } catch {
            return {
              text: `[still running after ${timeoutMs}ms; moved to background job ${jobId}; use job_output to read output, job_kill to stop]`,
              exitCode: null,
              jobId,
            }
          }
        }
        const result = commandResultPromise === null ? null : await commandResultPromise
        try {
          jobs.remove(jobId, owner)
        } catch {
          /* keep the record when removal is not allowed */
        }
        return renderBashResult(result ?? { code: -1 }, { maxBytes: BASH_CONFIG.maxOutputBytes })
      } catch (error) {
        return { text: errorText(error), exitCode: 1 }
      }
    },
  }
  ctx.tools.register(bashToolConfiguration)

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
    homeDir: DSH_HOME,
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
