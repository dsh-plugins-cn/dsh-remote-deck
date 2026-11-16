/**
 * Remote Deck — browser half.
 *
 * Surfaces:
 *   1. sidebar chip + quick panel  (sidebar.footer.action)
 *   2. session identity            (header pill, row badge, hover line)
 *
 * React is provided by the module loader. All reads come from two sources:
 * the host loopback API (/state) and the client services
 * (ctx.get('workspaces').list / ctx.get('sessions').list), so identity stays
 * live without re-fetching.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-deck',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useSyncExternalStore =
      React.useSyncExternalStore ||
      ((subscribe, getSnapshot) => {
        const [value, set] = React.useState(getSnapshot)
        React.useEffect(() => subscribe(() => set(getSnapshot())), [subscribe])
        return value
      })

    // ---------------------------------------------------------------- api

    function boot() {
      const info = globalThis.__DSH_REMOTE_DECK__
      return info && info.port && info.token ? info : null
    }

    async function call(path, options) {
      const info = boot()
      if (info === null) throw new Error('remote-deck is not active yet; restart DSH')
      const init = { method: (options && options.method) || 'GET', headers: { 'x-dsh-remote-token': info.token } }
      if (options && options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const timeoutMs = options && typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      init.signal = controller.signal
      let response
      try {
        response = await fetch('http://127.0.0.1:' + info.port + path, init)
      } catch (failure) {
        if (controller.signal.aborted) throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请重试')
        throw failure
      } finally {
        clearTimeout(timer)
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.message || 'HTTP ' + response.status)
      return body
    }

    // ---------------------------------------------------------------- store

    const store = {
      state: null,
      error: '',
      ready: false,
      open: false,
      consoleTab: 'overview',
      consoleView: 'console',
      dialog: null,
      errorText: '',
      notice: '',
      busy: '',
      selectedHost: '',
      quickPins: [],
      toasts: [],
      listeners: new Set(),
      workspaces: { items: [] },
      sessions: { ids: [], byId: {} },
    }

    function emit() {
      for (const listener of store.listeners) listener()
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }

    function useStore(selector) {
      return useSyncExternalStore(subscribe, () => selector(store))
    }

    const QUICK_PINS_KEY = 'dsh.remote-deck.quick-pins'

    function loadQuickPins() {
      try {
        const raw = globalThis.localStorage ? globalThis.localStorage.getItem(QUICK_PINS_KEY) : null
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, 3) : []
      } catch {
        return []
      }
    }

    function saveQuickPins() {
      try {
        if (globalThis.localStorage) globalThis.localStorage.setItem(QUICK_PINS_KEY, JSON.stringify(store.quickPins))
      } catch {
        /* storage unavailable */
      }
    }

    function isQuickPinned(connectionId) {
      return store.quickPins.includes(connectionId)
    }

    function toggleQuickPin(connectionId) {
      const next = store.quickPins.slice()
      const index = next.indexOf(connectionId)
      if (index >= 0) {
        next.splice(index, 1)
      } else {
        if (next.length >= 3) return { ok: false, max: true }
        next.push(connectionId)
      }
      store.quickPins = next
      saveQuickPins()
      emit()
      return { ok: true }
    }

    store.quickPins = loadQuickPins()

    function friendlyError(raw) {
      const message = raw instanceof Error ? raw.message : String(raw || '')
      const lower = message.toLowerCase()
      const make = (title, hint) => ({ level: 'error', title, hint, detail: message })
      if (/failed to fetch|networkerror|load failed/.test(lower)) {
        return make('Remote Deck 服务地址已失效', '插件在运行中被更新过，当前页面的服务地址已过期：先刷新页面（Ctrl+R）；仍不行再完全退出 DSH 后重开。')
      }
      if (/http 403|forbidden|token/.test(lower)) {
        return make('插件服务令牌已过期', '刷新页面；仍失败则完全重启 DSH。')
      }
      if (/timed out while waiting for handshake|handshake.*timeout/.test(lower)) {
        return make('SSH 连接超时', '主机可能已关机、IP/端口不对，或被防火墙拦截。')
      }
      if (/all configured authentication methods failed|permission denied|authentication failed/.test(lower)) {
        return make('SSH 认证失败', '检查用户名、密钥或密码；新机器需要先在控制台配置密钥。')
      }
      if (/econnrefused|connection refused/.test(lower)) {
        return make('SSH 端口未开放', '确认 sshd 已启动，端口号正确。')
      }
      if (/enotfound|getaddrinfo/.test(lower)) {
        return make('主机名无法解析', '检查主机地址、DNS 或 /etc/hosts。')
      }
      if (/host key verification failed|host key mismatch/.test(lower)) {
        return make('主机指纹不匹配', '确认这台机器可信后，更新 known_hosts。')
      }
      if (/connection closed|client is not connected|not connected/.test(lower)) {
        return make('SSH 连接已断开', '点击重连后再试。')
      }
      if (/fs_not_found|no such file/.test(lower)) {
        return make('文件不存在', '路径可能已变更，刷新目录后再试。')
      }
      if (/fs_access_denied|access denied/.test(lower)) {
        return make('没有权限', '检查远端用户对该目录的权限。')
      }
      if (/timeout|超时/.test(lower)) {
        return make('请求超时', '服务暂时无响应，请重试。')
      }
      return make('操作失败', '请重试；如果持续失败，展开详情查看原因。')
    }

    function friendlyText(raw) {
      const info = friendlyError(raw)
      return info.title + '：' + info.hint
    }

    let toastSeq = 0
    const toastTimers = new Map()

    function pushToast(raw) {
      const info = friendlyError(raw)
      const now = Date.now()
      const first = store.toasts[0]
      if (first && first.title === info.title && now - first.at < 2000) return
      toastSeq += 1
      const item = { id: toastSeq, at: now, level: info.level, title: info.title, hint: info.hint, detail: info.detail }
      store.toasts = [item, ...store.toasts].slice(0, 2)
      emit()
      const timer = setTimeout(() => {
        store.toasts = store.toasts.filter((toast) => toast.id !== item.id)
        toastTimers.delete(item.id)
        emit()
      }, 5000)
      toastTimers.set(item.id, timer)
    }

    /** Success/informational toast. pushToast() maps its argument as an error. */
    function pushInfo(text) {
      const now = Date.now()
      const first = store.toasts[0]
      if (first && first.title === text && now - first.at < 2000) return
      toastSeq += 1
      const item = { id: toastSeq, at: now, level: 'ok', title: String(text), hint: '', detail: '' }
      store.toasts = [item, ...store.toasts].slice(0, 2)
      emit()
      const timer = setTimeout(() => {
        store.toasts = store.toasts.filter((toast) => toast.id !== item.id)
        toastTimers.delete(item.id)
        emit()
      }, 3000)
      toastTimers.set(item.id, timer)
    }

    function dismissToast(id) {
      const timer = toastTimers.get(id)
      if (timer !== undefined) clearTimeout(timer)
      toastTimers.delete(id)
      store.toasts = store.toasts.filter((toast) => toast.id !== id)
      emit()
    }

    let downloadToastTimer = null

    /** Download feedback that also works outside the Remote Deck panel. */
    function showDownloadToast(text, level) {
      try {
        let element = document.getElementById('rd-download-toast')
        if (element === null) {
          element = document.createElement('div')
          element.id = 'rd-download-toast'
          document.body.appendChild(element)
        }
        element.textContent = String(text || '')
        element.className = 'rd-download-toast show' + (level === 'error' ? ' error' : '')
        if (downloadToastTimer !== null) clearTimeout(downloadToastTimer)
        downloadToastTimer = setTimeout(() => {
          element.className = 'rd-download-toast' + (level === 'error' ? ' error' : '')
        }, 6000)
      } catch {
        /* page not ready */
      }
    }

    async function refresh() {
      if (boot() === null) {
        store.ready = false
        emit()
        return
      }
      try {
        store.state = await call('/state')
        store.error = ''
        store.ready = true
        syncWorkspaceStatusStyles()
      } catch (error) {
        store.error = error instanceof Error ? error.message : String(error)
      }
      emit()
    }

    function readClientServices(ctx) {
      try {
        const workspaces = ctx.get('workspaces')
        const sessions = ctx.get('sessions')
        if (workspaces && workspaces.list) store.workspaces = workspaces.list.getSnapshot()
        if (sessions && sessions.list) store.sessions = sessions.list.getSnapshot()
      } catch {
        /* services appear after boot */
      }
      syncWorkspaceStatusStyles()
      emit()
    }

    // ---------------------------------------------------------------- lookup

    const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
    const under = (parent, child) => {
      if (typeof parent !== 'string' || typeof child !== 'string') return false
      const p = parent.replace(/\\/g, '/').replace(/\/+$/, '')
      const c = child.replace(/\\/g, '/')
      return c === p || c.startsWith(p + '/')
    }

    function remoteWorkspaces() {
      return store.state ? store.state.workspaces : []
    }

    function findByStub(stub) {
      return remoteWorkspaces().find((row) => samePath(row.stub, stub))
    }

    function workspaceItemForSession(sessionId) {
      const items = store.workspaces.items || []
      return items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
    }

    function remoteForSession(sessionId) {
      if (sessionId === undefined) return null
      const summary = store.sessions.byId ? store.sessions.byId[sessionId] : undefined
      const item = workspaceItemForSession(sessionId)
      const cwd = (summary && summary.cwd) || (item && item.path) || ''
      const rows = remoteWorkspaces()
      for (const row of rows) {
        if (under(row.stub, cwd) || samePath(row.stub, cwd)) return row
        if (typeof cwd === 'string' && cwd.startsWith('/') && (cwd === row.path || cwd.startsWith(row.path + '/'))) return row
      }
      if (item) {
        const byPath = rows.find((row) => samePath(row.stub, item.path))
        if (byPath !== undefined) return byPath
      }
      return null
    }

    function openWorkspaceFor(remote) {
      const items = store.workspaces.items || []
      return items.find((item) => samePath(item.path, remote.stub))
    }

    // ------------------------------------------------- workspace status dots

    const WORKSPACE_STATUS_STYLE_ATTR = 'data-rd-ws-status'
    const WORKSPACE_STATUS_ANIMATION = 'rd-ws-status-spin'
    let workspaceStatusCss = ''

    function connectionStatusLabel(status) {
      if (status === 'connected') return '已连接'
      if (status === 'connecting') return '连接中'
      if (status === 'error') return '连接失败'
      return '未连接'
    }

    /** One display sentence for the SSH chip's accessible name. */
    function sshStatusSummary(connections) {
      if (connections.length === 0) return '远程开发：还没有 SSH 连接'
      return '远程开发：' + connections.map((row) => row.name + ' ' + connectionStatusLabel(row.status)).join('，')
    }

    function cssAttributeValue(value) {
      return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }

    /**
     * Resolve every DSH workspace item that belongs to a remote host.
     * The host /state row carries workspaceId after 1.6.1; samePath is only a
     * fallback for an older host whose rules are still in memory.
     */
    function workspaceStatusEntries() {
      const items = store.workspaces.items || []
      const rows = remoteWorkspaces()
      const connections = (store.state && store.state.connections) || []
      const entries = []
      const seen = new Set()
      for (const item of items) {
        const row = (item.workspaceId
          ? rows.find((candidate) => candidate.workspaceId === item.workspaceId)
          : undefined) ?? rows.find((candidate) => samePath(candidate.stub, item.path))
        if (row === undefined) continue
        const workspaceId = row.workspaceId || item.workspaceId
        if (typeof workspaceId !== 'string' || workspaceId.length === 0 || seen.has(workspaceId)) continue
        const host = connections.find((candidate) => candidate.id === row.connectionId)
        if (host === undefined) continue
        const status = host.status === 'connected' || host.status === 'connecting' || host.status === 'error'
          ? host.status
          : 'disconnected'
        entries.push({ workspaceId, status })
        seen.add(workspaceId)
      }
      return entries
    }

    function workspaceStatusRules(entries) {
      const grouped = { connected: [], connecting: [], disconnected: [], error: [] }
      for (const entry of entries) grouped[entry.status].push(entry.workspaceId)
      const common = [
        'content:""',
        'position:absolute',
        'box-sizing:border-box',
        'width:7px',
        'height:7px',
        'border-radius:50%',
        'inset-inline-start:calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px) + var(--dsh-workspace-indent,0px) + 10px)',
        'top:calc(50% + 5.5px)',
        'pointer-events:none',
        'z-index:1',
        'box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill)',
      ].join(';')
      const variants = {
        connected: 'background:var(--dsw-alias-state-success-primary)',
        connecting:
          'background:transparent;border:1.5px solid var(--dsw-alias-state-warn-primary);border-inline-end-color:transparent;animation:' +
          WORKSPACE_STATUS_ANIMATION + ' 1.2s linear infinite',
        disconnected: 'background:transparent;border:1.5px solid var(--dsw-alias-label-tertiary)',
        error:
          'background:var(--dsw-alias-state-error-primary);background-image:linear-gradient(135deg,transparent 42%,var(--dsw-alias-label-on-color) 42% 58%,transparent 58%)',
      }
      const rules = ['[data-row-key^="workspace:"]{position:relative}']
      for (const status of Object.keys(grouped)) {
        const ids = grouped[status]
        if (ids.length === 0) continue
        const selectors = ids
          .map((id) => '[data-row-key="workspace:' + cssAttributeValue(id) + '"]::after')
          .join(',')
        rules.push(selectors + '{' + common + ';' + variants[status] + '}')
      }
      rules.push(
        '@keyframes ' + WORKSPACE_STATUS_ANIMATION + '{to{transform:rotate(360deg)}}',
        '@media (prefers-reduced-motion: reduce){[data-row-key^="workspace:"]::after{animation:none!important}}',
      )
      return rules.join('\n')
    }

    function syncWorkspaceStatusStyles() {
      try {
        syncWorkspaceStatusStylesUnsafe()
      } catch (error) {
        // The status layer is cosmetic. A DSH DOM/theme change must never take
        // down the rest of the plugin UI.
        workspaceStatusCss = ''
        if (boot()?.debug === true) console.warn('[remote-deck] workspace status styles:', error)
      }
    }

    function syncWorkspaceStatusStylesUnsafe() {
      if (typeof document === 'undefined') return
      const info = boot()
      if (info === null || info.workspaceStatus === false) {
        const old = document.querySelector('style[' + WORKSPACE_STATUS_STYLE_ATTR + ']')
        if (old !== null) old.remove()
        workspaceStatusCss = ''
        return
      }
      if (!store.ready || store.state === null) return
      const entries = workspaceStatusEntries()
      const css = workspaceStatusRules(entries)
      if (css === workspaceStatusCss) return
      let node = document.querySelector('style[' + WORKSPACE_STATUS_STYLE_ATTR + ']')
      if (node === null) {
        node = document.createElement('style')
        node.setAttribute(WORKSPACE_STATUS_STYLE_ATTR, '1')
        document.head.appendChild(node)
      }
      node.textContent = css
      workspaceStatusCss = css
      if (info.debug === true) {
        window.__RD_WS_STATUS__ = {
          css,
          entries,
          sync: syncWorkspaceStatusStyles,
        }
      }
    }

    // ---------------------------------------------------------------- styles

    const COLORS = {
      blue: '#2f7ddd',
      teal: '#12a594',
      violet: '#7c5cff',
      amber: '#d97706',
      rose: '#e04f6a',
      cyan: '#0e9bb5',
    }
    const colorOf = (name) => COLORS[name] || COLORS.blue

    function shortKernel(kernel) {
      if (typeof kernel !== 'string') return ''
      const match = /(\d+\.\d+)/.exec(kernel)
      return match ? match[1] : kernel
    }

    const ICONS = {
      server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      chev: '<path d="M6 9l6 6 6-6"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/>',
      file: '<path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M13 2v6h6"/>',
      term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
      edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
      arrowleft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
      check: '<path d="M5 13l4 4L19 7"/>',
      key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4"/>',
      link: '<path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1"/>',
      dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
      bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
      wand: '<path d="M15 4V2M15 10V8M10 6h2M18 6h2M4 20l10-10 2 2-10 10z"/>',
      sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
      lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    }

    function Icon({ name, size = 16, style }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style,
        dangerouslySetInnerHTML: { __html: ICONS[name] || '' },
      })
    }

    const CSS = `
      .rd-chip { appearance:none;background:transparent;border:1px solid transparent;border-radius:8px;display:inline-flex;align-items:center;gap:6px;padding:4px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;line-height:18px }
      .rd-chip:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.05)) }
      .rd-chip[data-open="true"] { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-dot { width:7px;height:7px;border-radius:50%;background:#c3c8d0;flex:none }
      .rd-dot.ok { background:#2ea043;box-shadow:0 0 0 3px rgba(46,160,67,.14) }
      .rd-dot.warn { background:#d29922;box-shadow:0 0 0 3px rgba(210,153,34,.14) }
      .rd-dot.err { background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.14) }
      .rd-dot.idle { background:#c3c8d0 }

      .rd-panel { position:fixed;left:8px;bottom:76px;width:370px;max-height:640px;display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);
        border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:14px;
        box-shadow:0 24px 60px rgba(16,24,40,.22),0 2px 6px rgba(16,24,40,.06);
        z-index:1001;overflow:hidden;font-size:13px }
      .rd-head { display:flex;align-items:center;gap:8px;padding:13px 14px 10px }
      .rd-head .t { font-size:13px;font-weight:700 }
      .rd-head .s { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:1px }
      .rd-head .r { margin-left:auto;display:flex;gap:2px }
      .rd-ibtn { width:26px;height:26px;display:grid;place-items:center;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer }
      .rd-ibtn:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-body { overflow:auto;padding:0 14px 4px;display:flex;flex-direction:column;gap:8px }

      .rd-hosts { display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px }
      .rd-host { border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:9px;padding:8px 9px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;position:relative }
      .rd-host[data-active="true"] { border-color:#a9c9ec;background:rgba(47,125,221,.06);box-shadow:0 0 0 2px rgba(47,125,221,.09) }
      .rd-host .r1 { display:flex;align-items:center;gap:6px;min-width:0 }
      .rd-host .box { width:20px;height:20px;border-radius:6px;display:grid;place-items:center;color:#fff;flex:none }
      .rd-host .nm { font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .rd-host .st { font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);display:flex;align-items:center;gap:4px }
      .rd-host .lat { font-family:ui-monospace,Consolas,monospace;color:#4c8f5c }
      .rd-auto { display:inline-grid;place-items:center;width:15px;height:15px;border-radius:4px;background:rgba(210,153,34,.14);color:#b07d18;flex:none;cursor:pointer }
      .rd-auto:hover { background:rgba(210,153,34,.24) }
      [data-rd-theme="dark"] .rd-auto { background:rgba(210,153,34,.2);color:#e3b341 }
      .rd-host .pw { position:absolute;right:4px;top:4px;width:18px;height:18px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer;display:grid;place-items:center;opacity:0 }
      .rd-host:hover .pw { opacity:1 }
      .rd-host.add { border-style:dashed;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;gap:4px }

      .rd-sect { display:flex;align-items:center;padding:6px 0 2px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);font-weight:600 }
      .rd-sect .r { margin-left:auto;font-weight:400;color:var(--dsw-alias-brand-primary,#1d6fc4);font-size:10.5px;cursor:pointer }

      .rd-ws { display:flex;align-items:center;gap:9px;padding:8px;border-radius:9px;cursor:pointer }
      .rd-ws:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.045)) }
      .rd-ws .fi { width:26px;height:26px;border-radius:7px;display:grid;place-items:center;flex:none;background:rgba(47,125,221,.1);color:#2f7ddd }
      .rd-ws .nm { font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px }
      .rd-ws .cur { font-size:9px;color:#1b7a33;background:#e8f6ec;border-radius:3px;padding:0 3px }
      .rd-ws .pa { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px }
      .rd-ws .rt { margin-left:auto;text-align:right;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.5;flex:none }
      .rd-ws .rt b { color:var(--dsw-alias-label-primary,#1f2329);font-weight:500 }

      .rd-quick { display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px 0 10px }
      .rd-qa { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));border-radius:9px;padding:9px 4px 7px;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:transparent;cursor:pointer }
      .rd-qa:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-qa[disabled] { opacity:.45;cursor:default }

      .rd-foot { border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.02));padding:8px 14px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-foot .mono { font-family:ui-monospace,Consolas,monospace }

      .rd-notice { border:1px solid rgba(210,153,34,.35);background:rgba(210,153,34,.08);color:#7a5b12;border-radius:9px;padding:10px 12px;font-size:11.5px;line-height:1.6 }
      .rd-err { color:#b42318;font-size:11px;line-height:1.5;word-break:break-word }
      .rd-hint { color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;line-height:1.6;padding:6px 0 }

      .rd-field { display:flex;flex-direction:column;gap:5px }
      .rd-field label { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-input { height:30px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 9px;font-size:12px;color:inherit;outline:none;min-width:0 }
      .rd-input:focus { border-color:#9cc4ea;box-shadow:0 0 0 3px rgba(29,111,196,.12) }
      .rd-input.mono { font-family:ui-monospace,Consolas,monospace;font-size:11px }
      .rd-grid2 { display:grid;grid-template-columns:1fr 1fr;gap:10px }
      .rd-grid3 { display:grid;grid-template-columns:76px 1fr 92px;gap:8px }
      .rd-btn { height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);background:transparent;color:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;justify-content:center }
      .rd-btn:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-btn.primary { background:#1d6fc4;border-color:#1d6fc4;color:#fff }
      .rd-btn.primary:hover { background:#1a64b1 }
      .rd-btn.danger { color:#b42318;border-color:#f0cdcd }
      .rd-btn[disabled] { opacity:.5;cursor:default }

      .rd-pathbar { display:flex;gap:6px;align-items:center;margin-top:2px }
      .rd-pathbar .rd-input { flex:1 }
      .rd-dirs { border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:8px;max-height:170px;overflow:auto;margin-top:2px }
      .rd-dir { display:flex;align-items:center;gap:7px;padding:6px 9px;font-size:11.5px;cursor:pointer }
      .rd-dir:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.045)) }
      .rd-dir .sub { margin-left:auto;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e) }

      .rd-pill { display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;border:1px solid #c8dcf3;background:rgba(47,125,221,.08);color:#175a99;font-size:11.5px;white-space:nowrap;cursor:pointer;max-width:340px }
      .rd-pill .mono { font-family:ui-monospace,Consolas,monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis }
      .rd-pill:hover { background:rgba(47,125,221,.14) }

      .rd-badge { width:15px;height:15px;border-radius:4px;display:grid;place-items:center;color:#fff;flex:none }
      .rd-badge svg { width:9px;height:9px;stroke-width:2.4 }
      .rd-hover { display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }

      /* ---- console ---- */
      .rd-console { display:flex;flex-direction:column;height:100%;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-ctop { height:52px;flex:none;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-ctop .t { font-size:14px;font-weight:650 }
      .rd-ctop .s { font-size:12px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-ctop .r { margin-left:auto;display:flex;gap:8px;align-items:center }
      .rd-csearch { display:flex;align-items:center;gap:6px;height:30px;width:200px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:8px;padding:0 9px;color:var(--dsw-alias-label-secondary,#8f959e);background:var(--dsw-alias-bg-layer-1,#fff) }
      .rd-csearch input { border:0;outline:none;background:transparent;flex:1;font-size:11.5px;color:var(--dsw-alias-label-primary,#1f2329);min-width:0 }
      .rd-cbody { flex:1;min-height:0;display:flex }
      .rd-rail2 { width:236px;flex:none;border-right:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.015));padding:14px 10px;display:flex;flex-direction:column;gap:3px;overflow:auto }
      .rd-rail2 .rh2 { display:flex;align-items:center;padding:6px 8px;font-size:10.5px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-rail2 .rh2 .add2 { margin-left:auto;color:#1d6fc4;cursor:pointer;display:grid;place-items:center;width:18px;height:18px;border-radius:5px }
      .rd-rail2 .add2:hover { background:rgba(29,111,196,.1) }
      .rd-host2 { display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent }
      .rd-host2:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-host2[data-active="true"] { background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dsw-alias-border-l1, rgba(15,23,42,.1));box-shadow:0 1px 2px rgba(16,24,40,.05) }
      .rd-host2 .ico2 { width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:#fff;flex:none }
      .rd-host2 .nm2 { font-size:12.5px;font-weight:600;line-height:1.3 }
      .rd-host2 .meta2 { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);font-family:ui-monospace,Consolas,monospace }
      .rd-host2 .rt2 { margin-left:auto;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:2px }
      .rd-host2 .lat2 { font-size:10px;font-family:ui-monospace,Consolas,monospace;color:#4c8f5c }
      .rd-rail2 .sep2 { height:1px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.07));margin:8px }
      .rd-rail2 .railfoot2 { margin-top:auto;padding:10px 8px 2px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.7;border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07)) }
      .rd-cpane { flex:1;min-width:0;overflow:auto;padding:22px 26px 30px }
      .rd-chead { display:flex;align-items:flex-start;gap:14px }
      .rd-cavatar { width:46px;height:46px;border-radius:12px;color:#fff;display:grid;place-items:center;flex:none }
      .rd-ctitle { font-size:19px;font-weight:700;letter-spacing:-.3px;display:flex;align-items:center;gap:8px }
      .rd-cmeta { display:flex;align-items:center;gap:8px;margin-top:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8f959e);flex-wrap:wrap }
      .rd-cmeta .mono { font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-chead .acts { margin-left:auto;display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end }
      .rd-stats { display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:20px }
      .rd-stat { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;padding:11px 13px }
      .rd-stat .k { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-stat .v { font-size:19px;font-weight:700;margin-top:3px;letter-spacing:-.4px }
      .rd-stat .v small { font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#8f959e);margin-left:3px }
      .rd-csect { display:flex;align-items:center;margin:26px 0 10px }
      .rd-csect .st2 { font-size:13px;font-weight:600 }
      .rd-csect .ct2 { margin-left:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-csect .rt2 { margin-left:auto;display:flex;gap:7px }
      .rd-cards { display:grid;grid-template-columns:1fr 1fr;gap:10px }
      .rd-card { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:11px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1,#fff);position:relative;cursor:pointer }
      .rd-card:hover { border-color:rgba(15,23,42,.22);box-shadow:0 2px 8px rgba(16,24,40,.05) }
      .rd-card .stripe2 { position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0 }
      .rd-card .top2 { display:flex;align-items:center;gap:7px }
      .rd-card .nm3 { font-size:12.5px;font-weight:600 }
      .rd-card .path2 { margin-top:7px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.035));border-radius:6px;padding:5px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-card .foot2 { display:flex;align-items:center;gap:8px;margin-top:9px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-card .foot2 .go2 { margin-left:auto;color:#1d6fc4;font-size:11px }
      .rd-card.add2 { border-style:dashed;display:flex;align-items:center;justify-content:center;gap:7px;color:var(--dsw-alias-label-secondary,#8f959e);font-size:12px;min-height:96px;cursor:pointer }
      .rd-card.add2:hover { border-color:#a9c9ec;color:#1d6fc4 }
      .rd-sess { display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.06));cursor:pointer }
      .rd-sess:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03)) }
      .rd-sess .t2 { font-size:12.5px }
      .rd-sess .tag2 { font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:4px;padding:1px 4px }
      .rd-sess .m2 { margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-empty { border:1px dashed rgba(15,23,42,.18);border-radius:12px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary,#8f959e);font-size:12px;line-height:1.7 }
      .rd-empty .rd-btn { margin-top:12px }
      .rd-pico { display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;color:inherit }

      /* ---- remote files ---- */
      .rd-files { padding: 12px 0 18px }
      .rd-fbar { display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap }
      .rd-crumbs { display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-width:0 }
      .rd-crumb { border:0;background:none;padding:3px 6px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-crumb:hover { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-crumb.on { color:var(--dsw-alias-label-primary,#1f2329);font-weight:600 }
      .rd-crumb + .rd-crumb::before { content:'/';color:var(--dsw-alias-label-secondary,#8f959e);margin-right:2px }
      .rd-fright { display:flex;align-items:center;gap:8px;margin-left:auto }
      .rd-fsearch { width:150px;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));border-radius:7px;padding:0 8px;font-size:12px;background:var(--dsw-alias-bg-l1,#fff);color:inherit;outline:none }
      .rd-fjump { display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-fchip { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:none;border-radius:999px;padding:2px 9px;font-size:11px;color:inherit;cursor:pointer }
      .rd-fchip:hover { background:rgba(15,23,42,.05) }
      .rd-fnotice { margin-bottom:10px;padding:7px 10px;border-radius:8px;background:rgba(29,111,196,.08);color:#1d6fc4;font-size:11.5px;word-break:break-all }
      .rd-flist { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:10px;overflow:hidden }
      .rd-frow { display:grid;grid-template-columns:18px minmax(0,1fr) 84px 92px auto;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.06));font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-frow:first-child { border-top:0 }
      .rd-frow:hover { background:rgba(15,23,42,.035) }
      .rd-frow.dir { cursor:pointer }
      .rd-fname { overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-fsize, .rd-fmod { color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;text-align:right }
      .rd-factions { display:flex;gap:6px;justify-content:flex-end;opacity:0;transition:opacity .12s }
      .rd-frow:hover .rd-factions { opacity:1 }
      [data-rd-theme="dark"] .rd-crumb:hover, [data-rd-theme="dark"] .rd-frow:hover { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-fnotice { background:rgba(99,182,255,.14);color:#8ecbff }
      [data-rd-theme="dark"] .rd-fsearch { background:#12161b;border-color:rgba(255,255,255,.14) }

      .rd-pill-restore { border:1px solid rgba(29,111,196,.35);background:rgba(29,111,196,.08);color:#1d6fc4;border-radius:999px;font-size:11px;padding:2px 8px;margin-left:6px;cursor:pointer;line-height:1.5 }
      .rd-pill-restore:hover { background:rgba(29,111,196,.16) }
      [data-rd-theme="dark"] .rd-pill-restore { border-color:rgba(124,196,255,.4);background:rgba(124,196,255,.12);color:#7cc4ff }

      .rd-dl-wrap { display:inline-flex;margin-left:4px }
      .rd-dl { display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer;flex:none }
      .rd-dl:hover { background:var(--dsw-alias-bg-l2, rgba(15,23,42,.06));color:var(--dsw-alias-label-primary,#1f2329) }
      [data-rd-theme="dark"] .rd-dl { color:var(--dsw-alias-label-secondary,#a8b0bb) }
      [data-rd-theme="dark"] .rd-dl:hover { background:rgba(255,255,255,.08);color:#e6e8eb }

      .rd-newfolder { display: inline-flex; align-items: center; gap: 6px; }
      .rd-newfolder .rd-input { width: 150px; }
      .rd-qpin { width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 6px; font-size: 13px; color: #c2c7cf; cursor: pointer; flex: none; }
      .rd-qpin.on { color: #d97706; background: rgba(217,119,6,.12); }
      .rd-qpin:hover { background: rgba(15,23,42,.06); }
      .rd-pinhint { margin: 0 4px 6px; padding: 6px 8px; border-radius: 7px; background: rgba(210,153,34,.12); color: #9a5b00; font-size: 11px; line-height: 1.5; }
      [data-rd-theme="dark"] .rd-pinhint { background: rgba(210,153,34,.18); color: #e3b341; }
      .rd-status { height: 26px; flex: none; margin: 0 14px 6px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 7px; background: rgba(15,23,42,.03); color: var(--dsw-alias-label-secondary, #8f959e); font-size: 10.5px; overflow: hidden; }
      .rd-status .t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .rd-status .retry { margin-left: auto; flex: none; color: inherit; cursor: pointer; text-decoration: underline; }
      .rd-status.bad { background: rgba(180,35,24,.08); color: #b42318; }
      .rd-toasts { position: absolute; left: 14px; right: 14px; bottom: 44px; display: flex; flex-direction: column-reverse; gap: 6px; pointer-events: none; z-index: 6; }
      .rd-toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 8px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e8e8ec); border-left: 3px solid #b42318; border-radius: 8px; padding: 7px 9px; box-shadow: 0 8px 22px rgba(16,24,40,.16); font-size: 11px; }
      .rd-toast.ok { border-left-color: #2ea043 }
      .rd-toast.info { border-left-color: #2f7ddd }
      .rd-toast .tt { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
      .rd-toast .th { margin-top: 2px; color: var(--dsw-alias-label-secondary, #8f959e); line-height: 1.5; }
      .rd-toast .x { margin-left: auto; flex: none; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #a3a8b0); cursor: pointer; font-size: 11px; }
      .rd-console { position: relative; }
      .rd-console .rd-toasts { left: auto; right: 18px; bottom: 18px; width: 320px; }
.rd-download-toast { position: fixed; right: 18px; bottom: 18px; z-index: 9999; max-width: min(460px, calc(100vw - 36px)); padding: 10px 13px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1, #e8e8ec); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: 12px; line-height: 1.5; word-break: break-all; opacity: 0; transform: translateY(6px); transition: opacity .16s ease, transform .16s ease; pointer-events: none; }
.rd-download-toast.show { opacity: 1; transform: translateY(0); }
.rd-download-toast.error { border-color: #dc2626; color: #b91c1c; }
      .rd-cpane > .rd-status { margin: 8px 0 10px; }
      [data-rd-theme="dark"] .rd-status { background: rgba(255,255,255,.05); }
      [data-rd-theme="dark"] .rd-status.bad { background: rgba(255,107,92,.12); color: #ff8f82; }

      /* ---- failed-send recovery ---- */
      .rd-recover { margin: 0 0 10px; border: 1px solid #f0d9ae; background: #fffaf0; border-radius: 12px; padding: 10px 12px; }
      .rd-recover .rt { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #9a5b00; }
      .rd-recover .rtext { margin-top: 6px; font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-primary, #1f2329); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .rd-recover .rchips { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .rd-chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; background: rgba(15,23,42,.06); color: var(--dsw-alias-label-secondary, #5f6672); font-size: 11px; }
      .rd-recover .ractions { margin-top: 9px; display: flex; align-items: center; gap: 8px; }
      .rd-rbtn { height: 27px; padding: 0 12px; border-radius: 7px; font-size: 12px; border: 1px solid transparent; }
      .rd-rbtn.primary { background: #1d6fc4; color: #fff; }
      .rd-rbtn.ghost { background: transparent; color: var(--dsw-alias-label-secondary, #5f6672); }
      .rd-recover .rhint { margin-top: 6px; font-size: 10.5px; color: #a3a8b0; }
      [data-rd-theme="dark"] .rd-recover { background: rgba(210,153,34,.1); border-color: rgba(210,153,34,.35); }
      [data-rd-theme="dark"] .rd-recover .rt { color: #e3b341; }
      [data-rd-theme="dark"] .rd-recover .rtext { color: #e6e8eb; }
      [data-rd-theme="dark"] .rd-chip { background: rgba(255,255,255,.08); color: #a8b0bb; }

      /* ---- dialogs ---- */
      .rd-overlay { position:fixed;inset:0;background:rgba(17,24,39,.32);z-index:1200;display:flex;align-items:center;justify-content:center }
      .rd-modal { background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:16px;box-shadow:0 30px 80px rgba(15,23,42,.3);display:flex;flex-direction:column;overflow:hidden }
      .rd-modal-host { width:980px;height:648px }
      .rd-modal-ws { width:1040px;height:636px }
      .rd-mhead3 { display:flex;align-items:center;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-mtitle { font-size:14px;font-weight:700 }
      .rd-msub { font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px }
      .rd-mclose { margin-left:auto;width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer }
      .rd-mclose:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-mbody3 { flex:1;min-height:0;display:flex }
      .rd-mleft3 { width:360px;flex:none;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.02));border-right:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));padding:16px 18px;display:flex;flex-direction:column;min-height:0 }
      .rd-mright3 { flex:1;min-width:0;padding:16px 20px;display:flex;flex-direction:column;overflow:auto }
      .rd-formtitle { font-size:12px;font-weight:700 }
      .switch { width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-state-idle-primary, #d7dbe1);position:relative;flex:none;cursor:pointer;transition:background .15s }
      .switch::after { content:"";position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:2px;left:2px;box-shadow:0 1px 2px rgba(0,0,0,.15);transition:left .15s }
      .switch.on { background:#1d6fc4 }
      .switch.on::after { left:16px }
      .rd-formsub { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:3px;line-height:1.6 }
      .rd-formhint { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.6 }
      .rd-link { color:#1d6fc4;cursor:pointer;font-size:10.5px }
      .rd-cfg { display:flex;align-items:center;gap:7px;height:30px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 9px;margin-top:9px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-cfg .mono { font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-import { flex:1;overflow:auto;min-height:0;margin-top:4px }
      .rd-improw { display:flex;align-items:center;gap:9px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);margin-top:7px;cursor:pointer }
      .rd-improw:hover { border-color:#a9c9ec }
      .rd-ck { width:15px;height:15px;accent-color:#1d6fc4;flex:none }
      .rd-impalias { font-family:ui-monospace,Consolas,monospace;font-size:11.5px;font-weight:600 }
      .rd-impmeta { font-family:ui-monospace,Consolas,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px }
      .rd-impkey { margin-left:auto;font-size:9px;color:#1b7a33;background:rgba(46,160,67,.1);border-radius:4px;padding:2px 5px;white-space:nowrap }
      .rd-importbtn { margin-top:10px;width:100% }
      .rd-seg { display:inline-flex;padding:2px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.06));border-radius:8px;height:32px;align-items:center }
      .rd-seg button { border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:11.5px;padding:4px 12px;border-radius:6px;cursor:pointer;white-space:nowrap }
      .rd-mright3 .rd-grid3 { grid-template-columns: 76px 1fr 150px }
      .rd-seg button.on { background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.08) }
      .rd-toggles { display:flex;gap:22px;margin-top:12px;flex-wrap:wrap }
      .rd-tg { display:flex;align-items:flex-start;gap:8px;font-size:11.5px }
      .rd-tg small { display:block;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:1px }
      .rd-testok { margin-top:12px;border:1px solid rgba(46,160,67,.35);background:rgba(46,160,67,.07);border-radius:9px;padding:9px 11px;display:flex;align-items:center;gap:8px;font-size:11px;color:#1b7a33 }
      .rd-testok .mono { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#39704a }
      .rd-mfoot3 { margin-top:auto;display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-wscol { flex:1;min-width:0;padding:12px 16px;display:flex;flex-direction:column;min-height:0 }
      .rd-wshosts { display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px }
      .rd-hostchip { display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));background:transparent;color:inherit;font-size:11px;cursor:pointer }
      .rd-hostchip.on { border-color:#a9c9ec;background:rgba(47,125,221,.08);color:#175a99 }
      .rd-wscrumbs { display:flex;align-items:center;gap:2px;margin:2px 0 6px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);overflow:hidden;white-space:nowrap }
      .rd-wscrumbs .c3 { padding:1px 4px;border-radius:4px;cursor:pointer }
      .rd-wscrumbs .c3:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-wscrumbs .sep3 { color:#c6ccd4 }
      .rd-wsfilter { display:flex;align-items:center;gap:6px;height:28px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:7px;padding:0 8px;margin-bottom:8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-wsfilter input { flex:1;border:0;outline:none;background:transparent;font-size:11.5px;color:inherit;min-width:0 }
      .rd-wtable { flex:1;min-height:0;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;overflow:auto;outline:none }
      .rd-wtable:focus { border-color:#a9c9ec;box-shadow:0 0 0 3px rgba(29,111,196,.1) }
      .rd-wthead { display:grid;grid-template-columns:1fr 92px 60px;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03));border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);position:sticky;top:0 }
      .rd-wsrow { padding:10px 12px }
      .rd-wsrow2 { display:grid;grid-template-columns:1fr 92px 60px;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.05));font-size:12px;cursor:pointer }
      .rd-wsrow2:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03)) }
      .rd-wsrow2.sel { background:rgba(29,111,196,.08);box-shadow:inset 2px 0 0 #1d6fc4 }
      .rd-wsrow2 .nm4 { display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-wsrow2 .dim2 { color:var(--dsw-alias-label-secondary,#8f959e);font-size:10.5px }
      .rd-wsfoot { display:flex;align-items:center;gap:8px;padding:9px 2px 0;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-wsfoot .rd-pill { margin-left:auto }
      .rd-wspreview { width:304px;flex:none;border-left:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.02));padding:14px 16px;display:flex;flex-direction:column;overflow:auto }
      .rd-wshost { display:flex;align-items:center;gap:7px;margin:8px 0 10px;font-size:11.5px;font-weight:600 }
      .rd-wshost .mono { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#4c8f5c }
      .rd-wspath { font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04));border-radius:7px;padding:7px 9px;word-break:break-all;margin-top:5px }
      .rd-wsadd { margin-top:14px;width:100% }
      .rd-wsdivider { height:1px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.1));margin:14px 0 10px }
      .rd-exist { display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px }
      .rd-existpath { font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,#5f6672);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-exist .rd-mini { margin-left:auto }
      .rd-mini { height:22px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px }
      .rd-mini:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.05)) }
      .rd-mini.danger { color:#b42318;border-color:#f0cdcd }
      .rd-confirm { margin-left:auto;display:flex;gap:4px }

      /* ---- console tabs, terminal, ports ---- */
      .rd-tabs { display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));margin:-6px 0 16px }
      .rd-tab { border:0;background:transparent;padding:7px 11px;font-size:12px;color:var(--dsw-alias-label-secondary,#8f959e);border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer }
      .rd-tab.on { color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;border-bottom-color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-terminal { display:flex;flex-direction:column;gap:0 }
      .rd-termhead { display:flex;align-items:center;gap:8px;background:#0f1216;border:1px solid #1c232c;border-bottom:0;border-radius:11px 11px 0 0;padding:9px 12px;color:#8b949e;font-size:10.5px }
      .rd-termhead .dotrow { display:flex;gap:4px }
      .rd-termhead .dotrow i { width:8px;height:8px;border-radius:50%;background:#2a313a;display:block }
      .rd-termtab { color:#d7dee6;background:#1a212a;border-radius:5px;padding:2px 8px;font-family:ui-monospace,Consolas,monospace;font-size:10px }
      .rd-termstatus { margin-left:auto;display:flex;align-items:center;gap:5px }
      .rd-termbtn { border:0;background:transparent;color:#8b949e;cursor:pointer;display:grid;place-items:center;width:22px;height:22px;border-radius:5px }
      .rd-termbtn:hover { background:#1a212a;color:#d7dee6 }
      .rd-termout { background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;padding:12px 14px;height:420px;overflow:auto;color:#c9d1d9;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all;outline:none;cursor:text }
      .rd-termout:focus { box-shadow:inset 0 0 0 1px rgba(99,182,255,.35) }
      .rd-xterm { height:420px;background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;padding:8px 10px;overflow:hidden }
      .rd-xterm .xterm { height:100% }
      .rd-xterm-placeholder { height:420px;display:grid;place-items:center;color:#5b6674;background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;font-size:12px }
      .rd-termplaceholder { color:#5b6674 }
      .rd-termerror { color:#f85149;background:#161b22;border:1px solid #3a1d1d;border-top:0;padding:8px 12px;font-size:11px }
      .rd-termfoot { display:flex;gap:8px;align-items:center;padding:8px 2px 0;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-ports { display:flex;flex-direction:column }
      .rd-porthead { display:flex;align-items:center;gap:8px }
      .rd-portrow { display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;margin-bottom:8px;font-size:11.5px }
      .rd-portmap { font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-portarrow { color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portactions { margin-left:auto;display:flex;gap:6px }
      .rd-porttable { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;overflow:hidden }
      .rd-portheadrow { display:grid;grid-template-columns:90px 1fr 120px;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03));border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portrow2 { display:grid;grid-template-columns:90px 1fr 120px;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.05));font-size:11.5px }
      .rd-portrow2:last-child { border-bottom:0 }
      .rd-portrow2 .mono { font-family:ui-monospace,Consolas,monospace }
      .rd-portempty { padding:14px 12px;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portadd { display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 12px;border:1px dashed rgba(15,23,42,.18);border-radius:10px }

      .rd-mempane { display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start }
      .rd-memmain { min-width:0 }
      .rd-memtop { display:flex;align-items:flex-start;gap:12px;margin-bottom:10px }
      .rd-memtitle { font-size:14px;font-weight:600 }
      .rd-memhint { font-size:10.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:3px }
      .rd-memtopactions { margin-left:auto;display:flex;gap:6px }
      .rd-memerror { margin-bottom:10px;padding:8px 10px;border:1px solid #f0cdcd;background:#fdecec;color:#b42318;border-radius:8px;font-size:11.5px }
      .rd-memoff { display:flex;align-items:center;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.02));margin-bottom:12px }
      .rd-memoff .tt { font-size:12.5px;font-weight:600 }
      .rd-memoff .td { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px;line-height:1.5 }
      .rd-memoff .rd-btn { margin-left:auto }
      .rd-memws { display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px }
      .rd-memwsbtn { height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:11px;display:inline-flex;align-items:center;gap:5px;cursor:pointer }
      .rd-memwsbtn.on { background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600 }
      .rd-memgrid { display:grid;gap:10px }
      .rd-memcard { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);margin-bottom:10px;overflow:hidden }
      .rd-memhead { display:flex;align-items:center;gap:7px;padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.05);color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-memhead .t { font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-memhead .rt { margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-membadge { font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(15,23,42,.05);color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-membody { padding:10px 12px }
      .rd-memkv { display:flex;gap:10px;padding:4px 0;font-size:11px }
      .rd-memkv .k { flex:none;width:58px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-memkv .v { min-width:0;color:var(--dsw-alias-label-primary,#1f2329);line-height:1.6;word-break:break-word }
      .rd-memswitchrow { display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(15,23,42,.05) }
      .rd-memswitchrow:last-of-type { border-bottom:0 }
      .rd-memswitchrow .tt { font-size:11.5px }
      .rd-memswitchrow .td { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:1px }
      .rd-memswitch { margin-left:auto;width:30px;height:18px;border:0;border-radius:999px;background:#dfe3e8;position:relative;cursor:pointer;flex:none;padding:0 }
      .rd-memswitch span { position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.15) }
      .rd-memswitch.on { background:#2f7ddd }
      .rd-memswitch.on span { left:auto;right:2px }
      .rd-memscopes { display:flex;gap:2px;margin-left:8px }
      .rd-memscopebtn { border:0;background:transparent;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);padding:2px 5px;border-radius:5px;cursor:pointer }
      .rd-memscopebtn.on { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600 }
      .rd-memnote { display:flex;gap:8px;padding:8px 0;border-bottom:1px solid rgba(15,23,42,.05);align-items:flex-start }
      .rd-memnote:last-child { border-bottom:0 }
      .rd-memkind { flex:none;font-size:9.5px;padding:2px 5px;border-radius:4px;margin-top:1px }
      .rd-memkind.fact { background:#e8f6ec;color:#1b7a33 }
      .rd-memkind.preference { background:#f1edff;color:#6b4bd1 }
      .rd-memkind.command { background:#eaf2fb;color:#175a99 }
      .rd-memkind.caution { background:#fdf3df;color:#8a5a00 }
      .rd-memkind.decision { background:#eef1f5;color:#3f4a59 }
      .rd-memnote .body { min-width:0;flex:1 }
      .rd-memnote .txt { font-size:11.5px;line-height:1.6 }
      .rd-memnote .sub { margin-top:2px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);display:flex;gap:6px;flex-wrap:wrap }
      .rd-memnote .ops { flex:none;display:flex;gap:2px }
      .rd-memicon { border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer;padding:2px;border-radius:4px }
      .rd-memicon:hover { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-memeditor { border-color:rgba(47,125,221,.35) }
      .rd-memfield { display:flex;align-items:center;gap:8px;margin:8px 0;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);flex-wrap:wrap }
      .rd-memfield select,.rd-memfield .rd-meminput { height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:11px;padding:0 7px }
      .rd-memfield .rd-meminput { flex:1;min-width:120px }
      .rd-memtextarea { width:100%;min-height:76px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:8px;padding:8px 9px;font:inherit;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-1,#fff);box-sizing:border-box }
      .rd-memcheck { display:inline-flex;align-items:center;gap:5px }
      .rd-memactions { display:flex;gap:6px;justify-content:flex-end;margin-top:8px }
      .rd-memaside { position:sticky;top:0 }
      .rd-memmeter { height:4px;border-radius:999px;background:rgba(15,23,42,.08);overflow:hidden;margin:5px 0 8px }
      .rd-memmeter i { display:block;height:100%;background:#2f7ddd;border-radius:999px }
      .rd-mempreview { margin:0;max-height:190px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:9.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5f6672);background:rgba(15,23,42,.03);border-radius:7px;padding:8px }
      [data-rd-theme="dark"] .rd-memcard { background:#1b1e24;border-color:rgba(255,255,255,.1) }
      [data-rd-theme="dark"] .rd-memhead,[data-rd-theme="dark"] .rd-memnote,[data-rd-theme="dark"] .rd-memswitchrow { border-color:rgba(255,255,255,.07) }
      [data-rd-theme="dark"] .rd-memoff { background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.1) }
      [data-rd-theme="dark"] .rd-memkind.fact { background:rgba(46,160,67,.18);color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-memkind.preference { background:rgba(124,92,255,.2);color:#c3b5ff }
      [data-rd-theme="dark"] .rd-memkind.command { background:rgba(47,125,221,.2);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-memkind.caution { background:rgba(210,153,34,.2);color:#f0c66b }
      [data-rd-theme="dark"] .rd-memkind.decision { background:rgba(255,255,255,.08);color:#c8ced8 }
      [data-rd-theme="dark"] .rd-mempreview { background:rgba(255,255,255,.04) }

      .rd-mem2 { max-width:980px }
      .rd-chip.rd-mem-global { padding:4px 8px;gap:5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-chip.rd-mem-global:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.05)) }
      .rd-mem-globaldot { width:6px;height:6px;border-radius:50%;background:#2ea043;flex:none }
      .rd-mem2-head { display:flex;align-items:flex-start;gap:12px;margin-bottom:14px }
      .rd-mem2-title { font-size:16px;font-weight:650;letter-spacing:-.01em }
      .rd-mem2-sub { margin-top:4px;font-size:10.8px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-actions { margin-left:auto;display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end }
      .rd-mem2-global { display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px 0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:11.5px;color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer }
      .rd-mem2-global:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.03)) }
      .rd-mem2-state { font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(15,23,42,.06);color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-state.on { background:#e8f6ec;color:#1b7a33 }
      .rd-mem2-error { margin-bottom:12px;padding:9px 11px;border:1px solid #f0cdcd;background:#fdecec;color:#b42318;border-radius:8px;font-size:11.5px }
      .rd-mem2-onboard { max-width:720px;padding:28px 30px 26px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:14px;background:linear-gradient(180deg,rgba(47,125,221,.045),rgba(47,125,221,0) 62%),var(--dsw-alias-bg-layer-1,#fff) }
      .rd-mem2-onboardicon { width:42px;height:42px;border-radius:12px;background:#eaf2fb;color:#1d6fc4;display:grid;place-items:center;margin-bottom:12px }
      .rd-mem2-onboardtitle { font-size:16px;font-weight:650 }
      .rd-mem2-onboardsub { margin-top:6px;max-width:560px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-mem2-features { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:18px 0 20px }
      .rd-mem2-feature { padding:11px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-mem2-feature .n { margin-top:7px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-mem2-feature .d { margin-top:3px;font-size:10px;line-height:1.55;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-onboardactions { display:flex;align-items:center;gap:8px }
      .rd-mem2-toolbar { display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.025));margin-bottom:12px }
      .rd-mem2-host { display:flex;align-items:center;gap:7px;font-size:12px }
      .rd-mem2-toolbartag { font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:4px;padding:1px 5px }
      .rd-mem2-toolbarswitch { display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-switch { margin-left:auto;width:30px;height:18px;border:0;border-radius:999px;background:#dfe3e8;position:relative;cursor:pointer;flex:none;padding:0 }
      .rd-mem2-switch span { position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.15) }
      .rd-mem2-switch.on { background:#2f7ddd }
      .rd-mem2-switch.on span { left:auto;right:2px }
      .rd-mem2-ws { display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-left:auto }
      .rd-mem2-wschip { height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:10.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer }
      .rd-mem2-wschip.on { background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600 }
      .rd-mem2-hint { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-summary { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-bottom:12px }
      .rd-mem2-stat { padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff) }
      .rd-mem2-stat .k { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-stat .v { margin-top:3px;font-size:13px;font-weight:650 }
      .rd-mem2-stat .h { margin-top:2px;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .rd-mem2-card { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);margin-bottom:11px;overflow:hidden }
      .rd-mem2-cardhead { display:flex;align-items:center;gap:8px;min-height:44px;padding:0 13px;border-bottom:1px solid rgba(15,23,42,.05);color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-mem2-cardtitle { display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-mem2-badge { font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(15,23,42,.05);color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-cardactions { margin-left:auto;display:flex;align-items:center;gap:6px }
      .rd-mem2-cardbody { padding:4px 13px 10px }
      .rd-mem2-section { padding:9px 0;border-bottom:1px solid rgba(15,23,42,.05) }
      .rd-mem2-section:last-child { border-bottom:0 }
      .rd-mem2-sectionhead { display:flex;align-items:center;gap:8px;margin-bottom:3px }
      .rd-mem2-label { font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-mem2-meta { font-size:9.8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-row { display:flex;gap:10px;padding:3px 0;font-size:11px }
      .rd-mem2-row .k { flex:none;min-width:62px;max-width:38%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-row .v { flex:1;min-width:0;line-height:1.6;word-break:break-word }
      .rd-mem2-emptyline { padding:8px 0;font-size:10.8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-tabs { display:flex;gap:2px;margin-left:8px }
      .rd-mem2-tab { border:0;background:transparent;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);padding:2px 6px;border-radius:5px;cursor:pointer }
      .rd-mem2-tab.on { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600 }
      .rd-mem2-count { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-note { display:flex;gap:8px;padding:9px 0;border-bottom:1px solid rgba(15,23,42,.05);align-items:flex-start }
      .rd-mem2-note:last-child { border-bottom:0 }
      .rd-mem2-kind { flex:none;font-size:9.5px;padding:2px 5px;border-radius:4px;margin-top:1px }
      .rd-mem2-kind.fact { background:#e8f6ec;color:#1b7a33 }
      .rd-mem2-kind.preference { background:#f1edff;color:#6b4bd1 }
      .rd-mem2-kind.command { background:#eaf2fb;color:#175a99 }
      .rd-mem2-kind.caution { background:#fdf3df;color:#8a5a00 }
      .rd-mem2-kind.decision { background:#eef1f5;color:#3f4a59 }
      .rd-mem2-note .body { min-width:0;flex:1 }
      .rd-mem2-note .txt { font-size:11.5px;line-height:1.65 }
      .rd-mem2-note .sub { margin-top:2px;font-size:9.8px;color:var(--dsw-alias-label-secondary,#8f959e);display:flex;gap:6px;flex-wrap:wrap }
      .rd-mem2-note .ops { flex:none;display:flex;gap:2px }
      .rd-mem2-icon { border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer;padding:3px;border-radius:4px }
      .rd-mem2-icon:hover { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-mem2-inject { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 12px;margin-top:2px }
      .rd-mem2-inject summary { display:flex;align-items:center;gap:7px;height:38px;cursor:pointer;font-size:10.8px;color:var(--dsw-alias-label-secondary,#5f6672);list-style:none }
      .rd-mem2-inject summary::-webkit-details-marker { display:none }
      .rd-mem2-injectmeta { margin-left:auto;font-size:9.8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-inject pre { margin:0 0 10px;max-height:190px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:9.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5f6672);background:rgba(15,23,42,.03);border-radius:7px;padding:8px }
      .rd-mem2-overlay { position:fixed;inset:0;background:rgba(18,22,29,.34);z-index:80;display:grid;place-items:center;padding:20px }
      .rd-mem2-modal { width:min(600px,100%);max-height:min(720px,calc(100vh - 40px));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 24px 70px rgba(16,24,40,.26);overflow:hidden }
      .rd-mem2-modalhead { display:flex;align-items:flex-start;gap:10px;padding:16px 18px 12px;border-bottom:1px solid rgba(15,23,42,.06) }
      .rd-mem2-modalhead .t { font-size:14px;font-weight:650 }
      .rd-mem2-modalhead .s { margin-top:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-modalhead .rd-mem2-icon { margin-left:auto }
      .rd-mem2-modalbody { padding:8px 18px 4px;overflow:auto }
      .rd-mem2-modalfoot { display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:12px 18px 16px;border-top:1px solid rgba(15,23,42,.06);margin-top:8px }
      .rd-mem2-modalfoot .rd-mem2-meta { margin-right:auto }
      .rd-mem2-settingrow { display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(15,23,42,.06) }
      .rd-mem2-settingrow .tt { font-size:11.5px;font-weight:500 }
      .rd-mem2-settingrow .td { margin-top:2px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.5 }
      .rd-mem2-settingrow .rd-mem2-switch { margin-left:auto }
      .rd-mem2-budget { margin-left:auto;display:flex;align-items:center;gap:6px }
      .rd-mem2-budget input { width:72px;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;padding:0 7px;font:inherit;font-size:11px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-mem2-pluginnotes { padding:12px 0 4px;border-bottom:1px solid rgba(15,23,42,.06) }
      .rd-mem2-pluginnoteshead { display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:500 }
      .rd-mem2-pluginnoteshead .rd-btn { margin-left:auto }
      .rd-mem2-datapath { padding:10px 0 4px;font-size:9.8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-formrow { display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:9px 0;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem2-formrow select { height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:11px;padding:0 7px }
      .rd-mem2-formrow .rd-mem2-input { flex:1;min-width:120px;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;padding:0 8px;font:inherit;font-size:11px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-mem2-textarea { width:100%;min-height:88px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:8px;padding:8px 9px;font:inherit;font-size:11.5px;line-height:1.6;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-sizing:border-box }
      .rd-mem2-check { display:inline-flex;align-items:center;gap:5px }

      .rd-mem3 { max-width:980px }
      .rd-mem3-head { display:flex;align-items:flex-start;gap:12px;margin-bottom:10px }
      .rd-mem3-title { font-size:16px;font-weight:650;letter-spacing:-.01em }
      .rd-mem3-sub { margin-top:3px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-mem3-actions { margin-left:auto;display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end }
      .rd-mem3-error { margin-bottom:10px;padding:8px 11px;border:1px solid #f0cdcd;background:#fdecec;color:#b42318;border-radius:8px;font-size:11.5px }
      .rd-mem3-onboard { max-width:560px;padding:22px 24px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff) }
      .rd-mem3-onboard .ic { width:38px;height:38px;border-radius:10px;background:#eaf2fb;color:#1d6fc4;display:grid;place-items:center;margin-bottom:10px }
      .rd-mem3-onboard .tt { font-size:15px;font-weight:650 }
      .rd-mem3-onboard .ts { margin:5px 0 14px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#5f6672) }

      .rd-layer { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);margin-bottom:10px;overflow:hidden }
      .rd-layer.workspace { border-color:rgba(47,125,221,.32) }
      .rd-layer-head { display:flex;align-items:center;gap:10px;padding:9px 14px 7px }
      .rd-layer-icon { width:30px;height:30px;border-radius:8px;display:grid;place-items:center;flex:none;background:rgba(120,130,145,.16);color:#6b7684 }
      .rd-layer.workspace .rd-layer-icon { background:rgba(47,125,221,.13);color:#2f7ddd }
      .rd-layer-title { min-width:0 }
      .rd-layer-title .t { display:flex;align-items:center;gap:7px;font-size:13px;font-weight:650 }
      .rd-layer-title .s { margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);display:flex;align-items:center;gap:4px }
      .rd-layer-badge { font-size:9.5px;font-weight:500;padding:1px 6px;border-radius:4px;color:var(--dsw-alias-label-secondary,#5f6672);background:rgba(15,23,42,.06) }
      .rd-layer.workspace .rd-layer-badge { color:#175a99;background:rgba(47,125,221,.14) }
      .rd-live { color:#2ea043;font-size:9px }
      .rd-layer-right { margin-left:auto;display:flex;align-items:center;gap:9px;flex:none }
      .rd-layer-switchlabel { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-switch { width:32px;height:18px;border:0;border-radius:999px;background:#dfe3e8;position:relative;cursor:pointer;flex:none;padding:0 }
      .rd-switch span { position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.15) }
      .rd-switch.on { background:#2f7ddd }
      .rd-switch.on span { left:auto;right:2px }
      .rd-switch:disabled { opacity:.5;cursor:default }
      .rd-wschips { display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end }
      .rd-wschip { display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:11px;cursor:pointer;max-width:220px }
      .rd-wschip > :first-child { overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-wschip.on { border-color:rgba(47,125,221,.5);background:rgba(47,125,221,.1);color:#175a99;font-weight:600 }
      .rd-wschip .n { flex:none;font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(15,23,42,.07);color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-wschip.on .n { background:rgba(47,125,221,.18);color:#175a99 }
      .rd-pathline { display:flex;align-items:center;gap:7px;margin:0 14px 2px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-pathline code { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#5f6672);background:rgba(15,23,42,.05);border-radius:4px;padding:1px 5px }
      .rd-subhead { display:flex;align-items:center;gap:8px;padding:5px 14px 2px }
      .rd-subhead .t { font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-subhead .meta { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-subhead-right { margin-left:auto;display:flex;align-items:center;gap:8px }
      .rd-count { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-facts { padding:2px 14px 6px }
      .rd-fact { display:flex;gap:10px;padding:2px 0 }
      .rd-fact .k { flex:none;min-width:62px;max-width:34%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-fact .v { flex:1;min-width:0;font-size:11.5px;line-height:1.65;word-break:break-word }
      .rd-fact .v.clamp2 { display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden }
      .rd-fact.clampable .v { cursor:pointer }
      .rd-fact-more { flex:none;align-self:flex-start;margin-top:1px;border:0;background:transparent;padding:0 2px;font:inherit;font-size:10px;color:var(--dsw-alias-brand-primary,#1d6fc4);cursor:pointer;opacity:.85 }
      .rd-fact-more:hover { opacity:1;text-decoration:underline }
      .rd-fact.sub .v { color:var(--dsw-alias-label-secondary,#5f6672);font-size:11px }
      .rd-fact.sub .k { padding-left:10px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-divider { height:1px;background:rgba(15,23,42,.06);margin:2px 0 }
      .rd-blank { padding:8px 0 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-layer > .rd-blank, .rd-layer > .rd-facts + .rd-blank { padding-left:14px;padding-right:14px }
      .rd-notes { padding:2px 14px 8px }
      .rd-note { display:flex;gap:9px;padding:6px 0;border-bottom:1px solid rgba(15,23,42,.055);align-items:flex-start }
      .rd-note:last-child { border-bottom:0 }
      .rd-note.archived { opacity:.6 }
      .rd-note-kind { flex:none;font-size:9.5px;padding:2px 6px;border-radius:4px;margin-top:1px }
      .rd-note-kind.fact { background:#e8f6ec;color:#1b7a33 }
      .rd-note-kind.preference { background:#f1edff;color:#6b4bd1 }
      .rd-note-kind.command { background:#eaf2fb;color:#175a99 }
      .rd-note-kind.caution { background:#fdf3df;color:#8a5a00 }
      .rd-note-kind.decision { background:#eef1f5;color:#3f4a59 }
      .rd-note-body { flex:1;min-width:0 }
      .rd-note-txt { font-size:11.5px;line-height:1.6 }
      .rd-note-sub { margin-top:1px;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);display:flex;gap:5px;flex-wrap:wrap }
      .rd-note-ops { flex:none;display:flex;gap:8px }
      .rd-note-op { border:0;background:transparent;padding:1px 0;font:inherit;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer }
      .rd-note-op:hover { color:var(--dsw-alias-brand-primary,#1d6fc4) }
      .rd-note-op:disabled { opacity:.5;cursor:default }
      .rd-raw { margin:2px 0 0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(15,23,42,.08));padding:0 14px 8px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-raw summary { height:26px;display:flex;align-items:center;cursor:pointer;list-style:none }
      .rd-raw summary::-webkit-details-marker { display:none }
      .rd-raw summary::before { content:'▸';margin-right:5px;font-size:9px }
      .rd-raw[open] summary::before { content:'▾' }
      .rd-raw pre { margin:2px 0 4px;max-height:220px;overflow:auto;padding:8px;border-radius:7px;background:rgba(15,23,42,.04);font-family:ui-monospace,Consolas,monospace;font-size:9.5px;line-height:1.5;white-space:pre-wrap }
      .rd-inject { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 12px }
      .rd-inject summary { display:flex;align-items:center;gap:7px;height:32px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);list-style:none }
      .rd-inject summary::-webkit-details-marker { display:none }
      .rd-injectmeta { margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-inject pre { margin:0 0 9px;max-height:300px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:9.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5f6672);background:rgba(15,23,42,.03);border-radius:7px;padding:8px }

      .rd-dlg-overlay { position:fixed;inset:0;background:rgba(10,12,16,.55);z-index:80;display:grid;place-items:center;padding:20px }
      .rd-dlg { width:min(512px,100%);max-height:calc(100vh - 40px);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 26px 70px rgba(16,24,40,.3);overflow:hidden }
      .rd-dlg-head { display:flex;align-items:flex-start;gap:10px;padding:15px 16px 11px }
      .rd-dlg-head .t { font-size:14px;font-weight:650 }
      .rd-dlg-head .s { margin-top:3px;font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-dlg-x { margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer;padding:2px;border-radius:4px }
      .rd-dlg-x:hover { background:rgba(15,23,42,.06) }
      .rd-dlg-body { padding:2px 16px 4px;overflow:auto }
      .rd-dlg-target { display:flex;align-items:center;gap:7px;padding:8px 10px;border-radius:8px;background:rgba(47,125,221,.09);border:1px solid rgba(47,125,221,.26);font-size:11px;color:#175a99;margin-bottom:13px }
      .rd-dlg-target.machine { background:rgba(15,23,42,.04);border-color:var(--dsw-alias-border-l1,rgba(15,23,42,.1));color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-dlg-target code { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-dlg-field { margin-bottom:12px }
      .rd-dlg-label { font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);margin-bottom:6px }
      .rd-dlg-chips { display:flex;gap:6px;flex-wrap:wrap }
      .rd-dlg-chip { height:27px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:11px;cursor:pointer }
      .rd-dlg-chip.on { border-color:rgba(47,125,221,.55);background:rgba(47,125,221,.12);color:#175a99;font-weight:600 }
      .rd-dlg-textarea { width:100%;min-height:84px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:8px;padding:9px 10px;font:inherit;font-size:11.5px;line-height:1.6;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);box-sizing:border-box }
      .rd-dlg-counter { margin-top:4px;text-align:right;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-dlg-inline { display:flex;align-items:center;gap:10px }
      .rd-dlg-input { flex:1;min-width:0;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;padding:0 9px;font:inherit;font-size:11px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-dlg-check { display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);white-space:nowrap }
      .rd-dlg-foot { display:flex;align-items:center;gap:8px;padding:11px 16px 13px;border-top:1px solid rgba(15,23,42,.06);margin-top:6px }
      .rd-dlg-hint { margin-right:auto;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      [data-rd-theme="dark"] .rd-mem3-onboard,[data-rd-theme="dark"] .rd-layer,[data-rd-theme="dark"] .rd-dlg,[data-rd-theme="dark"] .rd-inject { background:#1b1e24;border-color:rgba(255,255,255,.1) }
      [data-rd-theme="dark"] .rd-layer.workspace { border-color:rgba(47,125,221,.4) }
      [data-rd-theme="dark"] .rd-layer-badge { background:rgba(255,255,255,.07);color:#b9c0c9 }
      [data-rd-theme="dark"] .rd-layer.workspace .rd-layer-badge { background:rgba(47,125,221,.2);color:#8cc0f5 }
      [data-rd-theme="dark"] .rd-layer-icon { background:rgba(120,130,145,.18);color:#a9b1bd }
      [data-rd-theme="dark"] .rd-layer.workspace .rd-layer-icon { background:rgba(47,125,221,.16);color:#6ea9ea }
      [data-rd-theme="dark"] .rd-switch { background:#3a3f47 }
      [data-rd-theme="dark"] .rd-switch.on { background:#2f7ddd }
      [data-rd-theme="dark"] .rd-wschip { border-color:rgba(255,255,255,.1);color:#9aa1ab }
      [data-rd-theme="dark"] .rd-wschip.on { border-color:rgba(47,125,221,.55);background:rgba(47,125,221,.16);color:#cfe3f9 }
      [data-rd-theme="dark"] .rd-wschip .n { background:rgba(255,255,255,.08);color:#9aa1ab }
      [data-rd-theme="dark"] .rd-wschip.on .n { background:rgba(255,255,255,.16);color:#dbe9f8 }
      [data-rd-theme="dark"] .rd-pathline code { background:rgba(255,255,255,.05);color:#b9c0c9 }
      [data-rd-theme="dark"] .rd-raw { border-color:rgba(255,255,255,.08) }
      [data-rd-theme="dark"] .rd-raw pre { background:rgba(255,255,255,.04) }
      [data-rd-theme="dark"] .rd-divider,[data-rd-theme="dark"] .rd-note { border-color:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-dlg-foot { border-color:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-dlg-target { background:rgba(47,125,221,.14);border-color:rgba(47,125,221,.32);color:#cfe3f9 }
      [data-rd-theme="dark"] .rd-dlg-target.machine { background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);color:#9aa1ab }
      [data-rd-theme="dark"] .rd-dlg-target code { color:#9fc7f0 }
      [data-rd-theme="dark"] .rd-dlg-chip.on { border-color:rgba(47,125,221,.6);background:rgba(47,125,221,.18);color:#cfe3f9 }
      [data-rd-theme="dark"] .rd-note-kind.fact { background:rgba(63,185,80,.16);color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-note-kind.preference { background:rgba(124,92,255,.2);color:#c3b5ff }
      [data-rd-theme="dark"] .rd-note-kind.command { background:rgba(47,125,221,.2);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-note-kind.caution { background:rgba(210,153,34,.2);color:#f0c66b }
      [data-rd-theme="dark"] .rd-note-kind.decision { background:rgba(255,255,255,.08);color:#c8ced8 }
      [data-rd-theme="dark"] .rd-inject pre { background:rgba(255,255,255,.04) }

      .rd-set { flex:1;min-height:0;display:grid;grid-template-columns:190px minmax(0,1fr) }
      .rd-set-nav { display:flex;flex-direction:column;gap:3px;padding:18px 10px 14px;border-right:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.02)) }
      .rd-set-navtitle { padding:0 9px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-navitem { display:flex;align-items:center;gap:7px;height:32px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:12px;text-align:left;cursor:pointer }
      .rd-set-navitem:hover { background:var(--dsw-alias-border-l1,rgba(15,23,42,.05)) }
      .rd-set-navitem.on { background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.06) }
      .rd-set-navfoot { margin-top:auto;padding:10px 9px 0;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);border-top:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.06)) }
      .rd-set-main { min-width:0;overflow:auto;padding:22px 26px 32px }
      .rd-set-head { margin-bottom:14px }
      .rd-set-head .t { font-size:17px;font-weight:650;letter-spacing:-.01em }
      .rd-set-head .s { margin-top:4px;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-error { margin-bottom:12px;padding:9px 11px;border:1px solid #f0cdcd;background:#fdecec;color:#b42318;border-radius:8px;font-size:11.5px }
      .rd-set-card { max-width:780px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);padding:4px 16px 10px;margin-bottom:12px }
      .rd-set-cardhead { display:flex;align-items:center;gap:8px;padding:12px 0 4px;font-size:12.5px;font-weight:600 }
      .rd-set-cardhead .rd-btn { margin-left:auto }
      .rd-set-row { display:flex;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.06)) }
      .rd-set-row:last-child { border-bottom:0 }
      .rd-set-row .tt { font-size:12.5px;font-weight:500 }
      .rd-set-row .td { margin-top:3px;font-size:10.8px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-row .ctl { margin-left:auto;flex:none;display:flex;align-items:center;gap:7px }
      .rd-set-switch { width:32px;height:19px;border:0;border-radius:999px;background:#dfe3e8;position:relative;cursor:pointer;flex:none;padding:0 }
      .rd-set-switch span { position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.15) }
      .rd-set-switch.on { background:#2f7ddd }
      .rd-set-switch.on span { left:auto;right:2px }
      .rd-set-switch:disabled { opacity:.45;cursor:default }
      .rd-set-note { padding:8px 0 10px;font-size:10.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-desc { padding:4px 0 8px;font-size:10.8px;line-height:1.65;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-seg { display:flex;gap:6px;padding:2px 0 10px }
      .rd-set-segbtn { min-width:64px;height:30px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:11px;cursor:pointer }
      .rd-set-segbtn.on { border-color:#a9c9ec;background:rgba(47,125,221,.08);color:#175a99;font-weight:600 }
      .rd-set-empty { padding:8px 0;font-size:10.8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-noteitem { display:flex;gap:8px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.06));align-items:flex-start }
      .rd-set-noteitem:last-child { border-bottom:0 }
      .rd-set-kind { flex:none;font-size:9.5px;padding:2px 5px;border-radius:4px;margin-top:1px }
      .rd-set-kind.fact { background:#e8f6ec;color:#1b7a33 }
      .rd-set-kind.preference { background:#f1edff;color:#6b4bd1 }
      .rd-set-kind.command { background:#eaf2fb;color:#175a99 }
      .rd-set-kind.caution { background:#fdf3df;color:#8a5a00 }
      .rd-set-kind.decision { background:#eef1f5;color:#3f4a59 }
      .rd-set-noteitem .body { min-width:0;flex:1 }
      .rd-set-noteitem .txt { font-size:11.5px;line-height:1.6 }
      .rd-set-noteitem .sub { margin-top:2px;font-size:9.8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-set-noteitem .ops { flex:none;display:flex;gap:2px }
      .rd-set-icon { border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer;padding:3px;border-radius:4px }
      .rd-set-icon:hover { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-set-path { display:inline-block;font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#5a6270;background:rgba(15,23,42,.04);border-radius:5px;padding:2px 6px }
      .rd-set-value { font-size:12px;font-weight:600 }
      [data-rd-theme="dark"] .rd-set-nav { background:rgba(255,255,255,.02);border-color:rgba(255,255,255,.08) }
      [data-rd-theme="dark"] .rd-set-navitem.on { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-set-card { background:#1b1e24;border-color:rgba(255,255,255,.1) }
      [data-rd-theme="dark"] .rd-set-row,[data-rd-theme="dark"] .rd-set-noteitem { border-color:rgba(255,255,255,.07) }
      [data-rd-theme="dark"] .rd-set-path { background:rgba(255,255,255,.06);color:#c8ced8 }
      [data-rd-theme="dark"] .rd-set-kind.fact { background:rgba(46,160,67,.18);color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-set-kind.preference { background:rgba(124,92,255,.2);color:#c3b5ff }
      [data-rd-theme="dark"] .rd-set-kind.command { background:rgba(47,125,221,.2);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-set-kind.caution { background:rgba(210,153,34,.2);color:#f0c66b }
      [data-rd-theme="dark"] .rd-set-kind.decision { background:rgba(255,255,255,.08);color:#c8ced8 }

      [data-rd-theme="dark"] .rd-mem2-card,[data-rd-theme="dark"] .rd-mem2-stat,[data-rd-theme="dark"] .rd-mem2-toolbar,[data-rd-theme="dark"] .rd-mem2-inject,[data-rd-theme="dark"] .rd-mem2-modal { background:#1b1e24;border-color:rgba(255,255,255,.1) }
      [data-rd-theme="dark"] .rd-mem2-onboard { background:linear-gradient(180deg,rgba(47,125,221,.12),rgba(47,125,221,0) 70%),#1b1e24;border-color:rgba(255,255,255,.1) }
      [data-rd-theme="dark"] .rd-mem2-cardhead,[data-rd-theme="dark"] .rd-mem2-note,[data-rd-theme="dark"] .rd-mem2-section { border-color:rgba(255,255,255,.07) }
      [data-rd-theme="dark"] .rd-mem2-kind.fact { background:rgba(46,160,67,.18);color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-mem2-kind.preference { background:rgba(124,92,255,.2);color:#c3b5ff }
      [data-rd-theme="dark"] .rd-mem2-kind.command { background:rgba(47,125,221,.2);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-mem2-kind.caution { background:rgba(210,153,34,.2);color:#f0c66b }
      [data-rd-theme="dark"] .rd-mem2-kind.decision { background:rgba(255,255,255,.08);color:#c8ced8 }
      [data-rd-theme="dark"] .rd-mem2-state.on { background:rgba(46,160,67,.2);color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-mem2-inject pre { background:rgba(255,255,255,.04) }

      [data-rd-theme="dark"] .rd-pill { color:#8cc6ff;border-color:#2b4f74;background:rgba(47,125,221,.18) }
      [data-rd-theme="dark"] .rd-err { color:#ff9a9a }
      [data-rd-theme="dark"] .rd-testok { color:#7ee2a0;border-color:rgba(46,160,67,.4) }
      [data-rd-theme="dark"] .rd-testok .mono { color:#9fe3b5 }
      [data-rd-theme="dark"] .rd-impkey { color:#7ee2a0;background:rgba(46,160,67,.15) }
      [data-rd-theme="dark"] .rd-host2 .lat2,[data-rd-theme="dark"] .rd-k { color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-wthead,[data-rd-theme="dark"] .rd-portheadrow { background:rgba(255,255,255,.04) }
      [data-rd-theme="dark"] .rd-wspath,[data-rd-theme="dark"] .rd-card .path2 { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-wtable:focus,[data-rd-theme="dark"] .rd-input:focus { border-color:#4f8fd6;box-shadow:0 0 0 3px rgba(79,143,214,.2) }
      [data-rd-theme="dark"] .rd-card .foot2 .go2,[data-rd-theme="dark"] .rd-link,[data-rd-theme="dark"] .rd-sect .r { color:#7cc4ff }
      [data-rd-theme="dark"] .rd-sess:hover,[data-rd-theme="dark"] .rd-card:hover,[data-rd-theme="dark"] .rd-wsrow2:hover { background:rgba(255,255,255,.04) }
      [data-rd-theme="dark"] .rd-wsrow2.sel { background:rgba(47,125,221,.16) }
    `

    let styleInjected = false
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return
      const node = document.createElement('style')
      node.setAttribute('data-remote-deck', '1')
      node.textContent = CSS
      document.head.appendChild(node)
      styleInjected = true
    }

    // ---------------------------------------------------------------- atoms

    function Dot({ state }) {
      const cls = state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : state === 'error' ? 'err' : 'idle'
      return h('span', { className: 'rd-dot ' + cls })
    }

    function HostMark({ color, size = 20 }) {
      return h('span', {
        style: {
          width: size, height: size, borderRadius: 6, background: color, color: '#fff',
          display: 'grid', placeItems: 'center', flex: 'none',
        },
      }, h(Icon, { name: 'server', size: size - 9 }))
    }

    function ago(ms) {
      if (ms === undefined || ms === null || ms === '') return ''
      const value = typeof ms === 'string' ? Date.parse(ms) : Number(ms)
      if (!Number.isFinite(value)) return ''
      const diff = Date.now() - value
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return Math.round(diff / 60_000) + ' 分钟前'
      if (diff < 86_400_000) return Math.round(diff / 3_600_000) + ' 小时前'
      return Math.round(diff / 86_400_000) + ' 天前'
    }

    // ---------------------------------------------------------------- chip + panel

    function Chip() {
      const ready = useStore((s) => s.ready)
      const state = useStore((s) => s.state)
      const open = useStore((s) => s.open)
      const connections = (state && state.connections) || []
      const connected = connections.filter((row) => row.status === 'connected')
      const label = connected.length === 0 ? 'SSH' : connected.length === 1 ? 'SSH · ' + connected[0].name : 'SSH · ' + connected.length + ' 台'
      const latency = connected.length === 1 && connected[0].latencyMs ? connected[0].latencyMs + 'ms' : ''
      const ariaLabel = sshStatusSummary(connections)
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'rd-chip',
          'data-open': String(open),
          'aria-label': ariaLabel,
          title: ariaLabel + (latency ? ' · ' + latency : ''),
          onClick: () => {
            store.open = !store.open
            if (store.open) void refresh()
            emit()
          },
        },
          h(Dot, { state: !ready ? 'error' : connected.length > 0 ? 'connected' : 'disconnected' }),
          h('span', null, label),
          h(Icon, { name: 'chev', size: 12 }),
        ),
        h(Panel),
        h(Dialogs),
      )
    }

    function ToastStack() {
      const toasts = useStore((s) => s.toasts || [])
      if (toasts.length === 0) return null
      return h('div', { className: 'rd-toasts' },
        toasts.map((toast) => h('div', { key: toast.id, className: 'rd-toast ' + toast.level },
          h('div', { className: 'tx' },
            h('div', { className: 'tt' }, toast.title),
            toast.hint ? h('div', { className: 'th' }, toast.hint) : null,
          ),
          h('button', { className: 'x', title: '关闭', onClick: () => dismissToast(toast.id) }, '✕'),
        )),
      )
    }

    function Panel() {
      const open = useStore((s) => s.open)
      const ready = useStore((s) => s.ready)
      const state = useStore((s) => s.state)
      const error = useStore((s) => s.error)
      const busy = useStore((s) => s.busy)
      const notice = useStore((s) => s.notice)
      const selectedHost = useStore((s) => s.selectedHost)
      const quickPins = useStore((s) => s.quickPins || [])
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!notice) return
        pushToast(notice)
        store.notice = ''
        emit()
      }, [notice])

      React.useEffect(() => {
        if (!open) return undefined
        const close = () => {
          if (store.open) {
            store.open = false
            emit()
          }
        }
        const onPointer = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          if (target.closest('.rd-chip')) return
          close()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      if (!open) return null

      const connections = (state && state.connections) || []
      const workspaces = (state && state.workspaces) || []
      const connected = connections.filter((row) => row.status === 'connected')
      const pinnedHosts = quickPins.map((id) => connections.find((row) => row.id === id)).filter(Boolean)
      const hasPins = pinnedHosts.length > 0
      const pinnedSet = new Set(pinnedHosts.map((row) => row.id))
      const fillers = connections.filter((row) => !pinnedSet.has(row.id)).slice(0, Math.max(0, 3 - pinnedHosts.length))
      const shownHosts = hasPins ? pinnedHosts.concat(fillers).slice(0, 3) : connections.slice(0, 5)
      const first = connected[0] || connections[0]
      const shownWorkspaces = workspaces.filter((row) => !selectedHost || row.connectionId === selectedHost)

      const toggle = (row) => {
        void (async () => {
          store.busy = 'power:' + row.id
          store.notice = ''
          emit()
          try {
            await call('/connections/' + row.id + '/action', {
              method: 'POST',
              body: { action: row.status === 'connected' ? 'disconnect' : 'connect' },
            })
          } catch (failure) {
            store.notice = failure instanceof Error ? failure.message : String(failure)
          }
          store.busy = ''
          await refresh()
          emit()
        })()
      }

      const openWorkspace = (row) => {
        const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, row.stub))
        if (item === undefined) { store.notice = '这个工作区不在 DSH 注册表里'; emit(); return }
        store.open = false
        emit()
        const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
        if (ui) ui.openWorkspace(item.workspaceId)
      }

      const status = error ? friendlyError(error) : null
      return h('div', { className: 'rd-panel', ref: panelRef },
        h('div', { className: 'rd-head' },
          h('div', null,
            h('div', { className: 't' }, '远程开发'),
            h('div', { className: 's' }, ready
              ? connected.length + ' 台已连接 · ' + workspaces.length + ' 个工作区'
              : '正在加载 host…'),
          ),
          h('div', { className: 'r' },
            h('button', { className: 'rd-ibtn', title: '远程控制台', onClick: () => openConsole(first ? first.id : undefined) }, h(Icon, { name: 'server', size: 14 })),
            h('button', { className: 'rd-ibtn', title: '刷新', onClick: () => void refresh() }, h(Icon, { name: 'refresh', size: 14 })),
            h('button', { className: 'rd-ibtn', title: '关闭', onClick: () => { store.open = false; emit() } }, h(Icon, { name: 'x', size: 14 })),
          ),
        ),
        h('div', { className: 'rd-status' + (status ? ' bad' : '') },
          h(Dot, { state: status ? 'error' : connected.length > 0 ? 'connected' : 'disconnected' }),
          h('span', { className: 't', title: status ? (status.title + ' — ' + status.hint) : '' },
            status ? status.title : (connected.length > 0 ? '连接正常 · ' + connected.length + ' 台在线' : '未连接机器')),
          status ? h('span', { className: 'retry', onClick: () => void refresh() }, '重试') : null,
          status && /失效|服务|超时/.test(status.title) ? h('span', { className: 'retry', onClick: () => location.reload() }, '重新加载') : null,
        ),
        h('div', { className: 'rd-body' },
          !ready
            ? h('div', { className: 'rd-notice' },
              h('b', { style: { display: 'block', marginBottom: 2 } }, '插件还没激活'),
              'DSH 需要重启一次才能加载 Remote Deck 的 host 部分。重启后这里会显示连接列表。')
            : null,
          status
            ? h('div', { className: 'rd-notice' }, status.hint)
            : null,
          connections.length === 0 && ready
            ? h('div', { className: 'rd-hint' }, '还没有连接。添加一台 SSH 主机后，它的目录就能作为工作区。')
            : null,
          h('div', { className: 'rd-hosts' },
            shownHosts.map((row) => h('div', {
              key: row.id,
              className: 'rd-host',
              'data-active': String(selectedHost === row.id),
              onClick: () => { store.selectedHost = selectedHost === row.id ? '' : row.id; emit() },
            },
              h('button', {
                className: 'pw',
                title: row.status === 'connected' ? '断开' : '连接',
                onClick: (event) => { event.stopPropagation(); void toggle(row) },
              }, h(Icon, { name: 'power', size: 12 })),
              h('div', { className: 'r1' },
                h(HostMark, { color: colorOf(row.color) }),
                h('span', { className: 'nm' }, row.name),
                h(Dot, { state: row.status }),
                row.autoConnect
                  ? h('span', {
                    className: 'rd-auto',
                    title: '启动 DSH 时自动连接（点击关闭）',
                    onClick: (event) => { event.stopPropagation(); void setAutoConnect(row.id, false) },
                  }, h(Icon, { name: 'bolt', size: 10 }))
                  : null,
              ),
              h('div', { className: 'st' },
                row.status === 'connected' ? '已连接' : row.status === 'connecting' ? '连接中…' : row.status === 'error' ? '连接失败' : '未连接',
                row.status === 'connected' && row.latencyMs ? h('span', { className: 'lat' }, row.latencyMs + 'ms') : null,
              ),
            )),
            hasPins && shownHosts.length >= 3
              ? null
              : h('div', { className: 'rd-host add', onClick: () => openHostDialog() },
                h(Icon, { name: 'plus', size: 13 }), '添加机器'),
          ),
          h('div', { className: 'rd-sect' }, '快捷操作'),
          h('div', { className: 'rd-quick' },
            h('button', { className: 'rd-qa', onClick: () => openWorkspaceDialog(first ? first.id : undefined) },
              h(Icon, { name: 'plus', size: 14 }), '新建工作区'),
            h('button', { className: 'rd-qa', onClick: () => openConsole(first ? first.id : undefined, 'terminal') },
              h(Icon, { name: 'term', size: 14 }), '远程终端'),
            h('button', { className: 'rd-qa', onClick: () => openConsole(first ? first.id : undefined, 'ports') },
              h(Icon, { name: 'link', size: 14 }), '端口转发'),
            h('button', { className: 'rd-qa', onClick: () => openConsole(first ? first.id : undefined) },
              h(Icon, { name: 'server', size: 14 }), '控制台'),
          ),
        ),
        h(ToastStack),
        h('div', { className: 'rd-foot' },
          h(Dot, { state: first ? first.status : 'disconnected' }),
          h('span', null, first ? first.name : '未配置'),
          first && first.sys ? h('span', { className: 'mono' }, '· ' + first.sys.os + ' ' + shortKernel(first.sys.kernel)) : null,
          h('span', { style: { marginLeft: 'auto' } }, state ? 'host ' + state.build + (error ? ' · 已断开' : '') : ''),
        ),
      )
    }


    let ctxRef = null

    // ---------------------------------------------------------------- dialogs

    function emptyHostForm(record) {
      return {
        id: record ? record.id : '',
        name: record ? record.name : '',
        host: record ? record.host : '',
        port: String(record ? record.port : 22),
        username: record ? record.username : 'root',
        authType: record ? record.authType : 'key',
        privateKeyPath: record ? record.privateKeyPath : '',
        password: '',
        passphrase: '',
        autoConnect: record ? Boolean(record.autoConnect) : false,
        connectAfter: record ? false : true,
        hasPassword: record ? Boolean(record.hasPassword) : false,
      }
    }

    function openHostDialog(record) {
      store.dialog = { kind: 'host', record: record || null }
      store.open = false
      emit()
    }

    function openWorkspaceDialog(hostId) {
      store.dialog = { kind: 'workspace', hostId: hostId || '' }
      store.open = false
      emit()
    }

    function closeDialog() {
      store.dialog = null
      emit()
    }

    function Dialogs() {
      const dialog = useStore((s) => s.dialog)
      if (!dialog) return null
      return h('div', {
        className: 'rd-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) closeDialog() },
      },
        h('div', { className: 'rd-modal ' + (dialog.kind === 'host' ? 'rd-modal-host' : 'rd-modal-ws') },
          dialog.kind === 'host'
            ? h(HostDialog, { record: dialog.record })
            : h(WorkspaceDialog, { hostId: dialog.hostId }),
        ),
      )
    }

    function HostDialog({ record }) {
      const state = useStore((s) => s.state)
      const [form, setForm] = React.useState(() => emptyHostForm(record))
      const [config, setConfig] = React.useState(null)
      const [picked, setPicked] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [tested, setTested] = React.useState(null)

      const loadConfig = React.useCallback(async () => {
        setConfig(null)
        setError('')
        try {
          const result = await call('/ssh-config', { timeoutMs: 10000 })
          setConfig(result)
          if (record === null) {
            const existing = new Set(((state && state.connections) || []).map((row) => row.name))
            const next = {}
            for (const entry of result.hosts) next[entry.alias] = !existing.has(entry.alias)
            setPicked(next)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => { void loadConfig() }, [loadConfig])

      const set = (patch) => setForm((current) => Object.assign({}, current, patch))

      const selectedAliases = Object.keys(picked).filter((alias) => picked[alias])

      const importSelected = () => {
        void (async () => {
          setBusy('import')
          setError('')
          try {
            for (const alias of selectedAliases) {
              const entry = (config && config.hosts || []).find((row) => row.alias === alias)
              if (!entry) continue
              await call('/connections', {
                method: 'POST',
                body: {
                  name: entry.alias,
                  host: entry.host,
                  port: entry.port,
                  username: entry.user || 'root',
                  authType: 'key',
                  privateKeyPath: entry.identityFile || ((config && config.keys && config.keys[0]) || ''),
                },
              })
            }
            await refresh()
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const test = () => {
        void (async () => {
          setBusy('test')
          setError('')
          setTested(null)
          try {
            const result = await call('/connections/test', {
              method: 'POST',
              body: {
                name: form.name,
                host: form.host.trim(),
                port: Number(form.port) || 22,
                username: form.username.trim(),
                authType: form.authType,
                privateKeyPath: form.privateKeyPath.trim(),
                password: form.password,
                passphrase: form.passphrase,
              },
            })
            setTested(result)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const save = () => {
        void (async () => {
          if (!form.host.trim()) { setError('主机不能为空'); return }
          setBusy('save')
          setError('')
          try {
            const payload = {
              id: form.id || undefined,
              name: form.name,
              host: form.host.trim(),
              port: Number(form.port) || 22,
              username: form.username.trim(),
              authType: form.authType,
              privateKeyPath: form.privateKeyPath.trim(),
              autoConnect: form.autoConnect,
            }
            if (form.authType === 'password' && form.password) payload.password = form.password
            if (form.authType === 'key' && form.passphrase) payload.passphrase = form.passphrase
            const saved = await call('/connections', { method: 'POST', body: payload })
            if (form.connectAfter && form.id === '') {
              await call('/connections/' + saved.connection.id + '/action', { method: 'POST', body: { action: 'connect' } }).catch(() => {})
            }
            await refresh()
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const remove = () => {
        void (async () => {
          if (!form.id) return
          setBusy('delete')
          try {
            await call('/connections/' + form.id, { method: 'DELETE' })
            await refresh()
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const editor = h('div', { className: 'rd-mright3' },
        h('div', { className: 'rd-formtitle' }, '手动配置'),
        h('div', { className: 'rd-formsub' }, '适用于没有写入 SSH 配置的主机，或需要密码认证时。'),
        h('div', { className: 'rd-grid2', style: { marginTop: 12 } },
          field('名称', h('input', { className: 'rd-input', value: form.name, placeholder: 'build-box', onChange: (e) => set({ name: e.target.value }) })),
          field('主机', h('input', { className: 'rd-input mono', value: form.host, placeholder: '192.168.1.10', onChange: (e) => set({ host: e.target.value }) })),
        ),
        h('div', { className: 'rd-grid3' },
          field('端口', h('input', { className: 'rd-input mono', value: form.port, onChange: (e) => set({ port: e.target.value }) })),
          field('用户名', h('input', { className: 'rd-input', value: form.username, onChange: (e) => set({ username: e.target.value }) })),
          field('认证方式', h('div', { className: 'rd-seg' },
            h('button', { type: 'button', className: form.authType === 'key' ? 'on' : '', onClick: () => set({ authType: 'key' }) }, '密钥'),
            h('button', { type: 'button', className: form.authType === 'password' ? 'on' : '', onClick: () => set({ authType: 'password' }) }, '密码'),
          )),
        ),
        form.authType === 'key'
          ? h('div', { className: 'rd-field' },
            h('label', null, '私钥路径'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', { className: 'rd-input mono', style: { flex: 1 }, value: form.privateKeyPath, placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519', onChange: (e) => set({ privateKeyPath: e.target.value }) }),
            ),
            config && config.keys && config.keys.length > 0
              ? h('div', { className: 'rd-formhint' }, '已检测到 ' + config.keys.length + ' 个密钥：' + config.keys.map((key) => key.split(/[\\/]/).pop()).join('、') + ' · ',
                h('span', { className: 'rd-link', onClick: () => set({ privateKeyPath: config.keys[0] }) }, '使用第一个'))
              : null,
          )
          : h('div', { className: 'rd-field' },
            h('label', null, '密码'),
            h('input', { className: 'rd-input', type: 'password', value: form.password, placeholder: form.hasPassword ? '已保存，留空不修改' : '登录密码', onChange: (e) => set({ password: e.target.value }) }),
          ),
        form.authType === 'key'
          ? field('私钥口令（可选）', h('input', { className: 'rd-input', type: 'password', value: form.passphrase, placeholder: form.hasPassword ? '已保存，留空不修改' : '', onChange: (e) => set({ passphrase: e.target.value }) }))
          : null,
        h('div', { className: 'rd-toggles' },
          toggleSwitch('启动时自动连接', 'DSH 启动后自动拨通', form.autoConnect, (value) => set({ autoConnect: value })),
          toggleSwitch('保存后立即连接', '省一次点击', form.connectAfter, (value) => set({ connectAfter: value })),
        ),
        tested
          ? h('div', { className: 'rd-testok' },
            h(Icon, { name: 'check', size: 13 }),
            h('b', null, '连接成功'),
            h('span', { className: 'mono' }, (tested.sys ? tested.sys.os + ' ' + shortKernel(tested.sys.kernel) + ' · ' : '') + (tested.latencyMs ? tested.latencyMs + 'ms' : '') + (tested.sys && tested.sys.shell ? ' · ' + tested.sys.shell : '')),
            h('span', { className: 'rd-link', style: { marginLeft: 'auto' }, onClick: test }, '再测一次'))
          : null,
        error ? h('div', { className: 'rd-err' }, friendlyText(error)) : null,
        h('div', { className: 'rd-mfoot3' },
          h('button', { className: 'rd-btn', disabled: busy !== '', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            form.id ? h('button', { className: 'rd-btn danger', disabled: busy !== '', onClick: remove }, '删除') : null,
            h('button', { className: 'rd-btn', onClick: closeDialog }, '取消'),
            h('button', { className: 'rd-btn primary', disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存并连接'),
          ),
        ),
      )

      return h(React.Fragment, null,
        h('div', { className: 'rd-mhead3' },
          h('div', null,
            h('div', { className: 'rd-mtitle' }, record ? '编辑机器' : '添加机器'),
            h('div', { className: 'rd-msub' }, '从 ~/.ssh/config 导入，或手动填写一台 SSH 主机'),
          ),
          h('button', { className: 'rd-mclose', onClick: closeDialog }, h(Icon, { name: 'x', size: 14 })),
        ),
        h('div', { className: 'rd-mbody3' },
          h('div', { className: 'rd-mleft3' },
            h('div', { className: 'rd-formtitle' }, '从 SSH 配置导入'),
            h('div', { className: 'rd-formsub' }, '自动识别主机、端口、用户与私钥，已有的连接会跳过。'),
            h('div', { className: 'rd-cfg' },
              h(Icon, { name: 'key', size: 12 }),
              h('span', { className: 'mono' }, config ? config.path || '~/.ssh/config' : '读取中…'),
              h('span', { className: 'rd-link', style: { marginLeft: 'auto' }, onClick: () => { void loadConfig() } }, '重新扫描'),
            ),
            config === null
              ? (error
                ? h('div', { className: 'rd-err' }, friendlyText(error) + '（可点「重新扫描」重试）')
                : h('div', { className: 'rd-hint' }, '正在读取 SSH 配置…'))
              : config.hosts.length === 0
                ? h('div', { className: 'rd-hint' }, config.exists ? '配置里没有可导入的主机（通配符和 Match 会被跳过）。' : '没有找到 ~/.ssh/config，可以直接在右侧手动填写。')
                : h('div', { className: 'rd-import' },
                  h('div', { className: 'rd-formhint', style: { margin: '4px 0 2px' } }, '检测到 ' + config.hosts.length + ' 台可用机器'),
                  config.hosts.map((entry) => h('label', { key: entry.alias, className: 'rd-improw' },
                    h('input', {
                      type: 'checkbox',
                      className: 'rd-ck',
                      checked: Boolean(picked[entry.alias]),
                      onChange: (event) => setPicked(Object.assign({}, picked, { [entry.alias]: event.target.checked })),
                    }),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { className: 'rd-impalias' }, entry.alias),
                      h('div', { className: 'rd-impmeta' }, (entry.user || 'root') + '@' + entry.host + ':' + entry.port + (entry.proxy ? ' · ' + (entry.proxy.startsWith('jump:') ? '跳板' : '代理') : '')),
                    ),
                    h('span', { className: 'rd-impkey' }, entry.identityFile ? entry.identityFile.split(/[\\/]/).pop() : '默认密钥'),
                  )),
                  h('button', { className: 'rd-btn primary rd-importbtn', disabled: busy !== '' || selectedAliases.length === 0, onClick: importSelected },
                    busy === 'import' ? '导入中…' : '导入选中 ' + selectedAliases.length + ' 台'),
                ),
            h('div', { className: 'rd-formhint', style: { marginTop: 'auto' } }, '导入后不会自动连接；可在机器卡上点连接，或打开「启动时自动连接」。'),
          ),
          editor,
        ),
      )
    }

    function field(label, control) {
      return h('div', { className: 'rd-field' }, h('label', null, label), control)
    }

    function toggleSwitch(title, hint, value, onChange) {
      return h('div', { className: 'rd-tg' },
        h('span', { className: 'switch' + (value ? ' on' : ''), onClick: () => onChange(!value) }),
        h('div', null, h('div', null, title), h('small', null, hint)),
      )
    }

    function WorkspaceDialog({ hostId }) {
      const state = useStore((s) => s.state)
      const [currentHost, setCurrentHost] = React.useState(hostId || '')
      const [listing, setListing] = React.useState(null)
      const [pathInput, setPathInput] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [title, setTitle] = React.useState('')
      const [titleEdited, setTitleEdited] = React.useState(false)
      const [writeGuide, setWriteGuide] = React.useState(false)
      const [openAfter, setOpenAfter] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [pendingDelete, setPendingDelete] = React.useState('')
      const [newFolder, setNewFolder] = React.useState(null)

      const connections = (state && state.connections) || []
      const host = connections.find((row) => row.id === currentHost) || connections.find((row) => row.status === 'connected') || connections[0]
      const existing = ((state && state.workspaces) || []).filter((row) => host && row.connectionId === host.id)
      const targetPath = ((pathInput.trim() || (listing && listing.path) || '').replace(/\/+$/, '')) || '/'

      const load = React.useCallback(async (target, hostRow, offset = 0, append = false) => {
        if (!hostRow) return
        setBusy(append ? 'more' : 'dirs')
        setError('')
        try {
          if (hostRow.status !== 'connected') {
            await call('/connections/' + hostRow.id + '/action', { method: 'POST', body: { action: 'connect' } })
            await refresh()
          }
          const result = await call('/connections/' + hostRow.id + '/dirs?path=' + encodeURIComponent(target || '~') + '&offset=' + offset + '&limit=500')
          setListing((previous) => append && previous !== null
            ? { ...result, dirs: [...(previous.dirs || []), ...(result.dirs || [])] }
            : result)
          if (!append) {
            setPathInput(result.path)
            setSelected('')
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }, [])

      React.useEffect(() => {
        const initial = hostId || (connections.find((row) => row.status === 'connected') || connections[0] || {}).id
        if (initial) setCurrentHost(initial)
        if (initial) {
          const row = connections.find((entry) => entry.id === initial)
          void load('~', row)
        }
      }, [])

      React.useEffect(() => {
        if (titleEdited || !host || !listing) return
        const base = listing.path === '/' ? '/' : listing.path.split('/').filter(Boolean).pop()
        setTitle(host.name + ' · ' + base)
      }, [listing && listing.path, host && host.id, titleEdited])

      const dirs = (listing ? listing.dirs : []).filter((dir) => !filter || dir.name.toLowerCase().includes(filter.toLowerCase()))

      const switchHost = (id) => {
        setCurrentHost(id)
        setTitleEdited(false)
        const row = connections.find((entry) => entry.id === id)
        void load('~', row)
      }

      const crumbs = (() => {
        if (!listing) return []
        const parts = listing.path.split('/').filter(Boolean)
        const rows = [{ label: '/', path: '/' }]
        let acc = ''
        for (const part of parts) {
          acc += '/' + part
          rows.push({ label: part, path: acc })
        }
        return rows
      })()

      const goParent = () => {
        if (listing && listing.parent) void load(listing.parent, host)
      }

      const enter = (dir) => { setSelected(dir.path); void load(dir.path, host) }

      const loadMore = () => {
        if (!listing || listing.hasMore !== true) return
        void load(listing.path, host, Number(listing.offset) + Number(listing.limit), true)
      }

      const add = () => {
        void (async () => {
          if (!host || targetPath.length === 0) return
          setBusy('add')
          setError('')
          try {
            const result = await call('/connections/' + host.id + '/workspaces', {
              method: 'POST',
              body: { path: targetPath, title: titleEdited ? title : undefined, writeGuide },
            })
            await refresh()
            if (openAfter) {
              const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, result.stub))
              const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
              if (item && ui) ui.openWorkspace(item.workspaceId)
            }
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const removeWorkspace = (stub) => {
        void (async () => {
          setBusy('remove')
          try {
            await call('/workspaces?stub=' + encodeURIComponent(stub), { method: 'DELETE' })
            setPendingDelete('')
            await refresh()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const preview = h('div', { className: 'rd-wspreview' },
        h('div', { className: 'rd-formhint', style: { marginTop: 0 } }, '将添加为工作区'),
        h('div', { className: 'rd-wshost' },
          h(HostMark, { color: colorOf(host ? host.color : 'blue'), size: 18 }),
          h('span', null, host ? host.name : '—'),
          h(Dot, { state: host ? host.status : 'disconnected' }),
          host && host.latencyMs ? h('span', { className: 'mono' }, host.latencyMs + 'ms') : null,
        ),
        field('侧栏显示名称', h('input', {
          className: 'rd-input',
          value: title,
          onChange: (event) => { setTitle(event.target.value); setTitleEdited(true) },
        })),
        field('远程路径', h('div', { className: 'rd-wspath mono' }, targetPath || '—')),
        h('div', { style: { marginTop: 10 } },
          toggleSwitch('写入 AGENTS.md', '可选：告诉模型这里在远程机器上，路径用 POSIX（默认不写）', writeGuide, setWriteGuide),
          toggleSwitch('创建后打开新会话', '直接进入该工作区的对话', openAfter, setOpenAfter),
        ),
        h('button', { className: 'rd-btn primary rd-wsadd', disabled: busy !== '' || !host || targetPath.length === 0, onClick: add },
          busy === 'add' ? '添加中…' : '添加工作区'),
        error ? h('div', { className: 'rd-err', style: { marginTop: 8 } }, friendlyText(error)) : null,
        h('div', { className: 'rd-wsdivider' }),
        h('div', { className: 'rd-formhint', style: { margin: '0 0 6px' } }, '已在 ' + (host ? host.name : '') + ' 的工作区 · ' + existing.length),
        existing.length === 0
          ? h('div', { className: 'rd-formhint' }, '还没有工作区。')
          : existing.map((row) => h('div', { key: row.stub, className: 'rd-exist' },
            h(Dot, { state: row.connected ? 'connected' : 'disconnected' }),
            h('span', { className: 'rd-existpath' }, row.path),
            pendingDelete === row.stub
              ? h('span', { className: 'rd-confirm' },
                h('button', { className: 'rd-mini danger', disabled: busy !== '', onClick: () => removeWorkspace(row.stub) }, '确认移除'),
                h('button', { className: 'rd-mini', onClick: () => setPendingDelete('') }, '取消'))
              : h('button', { className: 'rd-mini', title: '移除工作区（保留远端目录）', onClick: () => setPendingDelete(row.stub) }, h(Icon, { name: 'trash', size: 12 })),
          )),
        h('div', { className: 'rd-formhint', style: { marginTop: 8 } }, '移除只从 DSH 侧栏摘除，机器上的目录不会被删除。'),
      )

      return h(React.Fragment, null,
        h('div', { className: 'rd-mhead3' },
          h('div', null,
            h('div', { className: 'rd-mtitle' }, '新建远程工作区'),
            h('div', { className: 'rd-msub' }, host ? '在 ' + host.name + ' 上选择一个目录，它就会成为 DSH 的一个工作区' : '选择一台机器'),
          ),
          h('button', { className: 'rd-mclose', onClick: closeDialog }, h(Icon, { name: 'x', size: 14 })),
        ),
        h('div', { className: 'rd-mbody3' },
          h('div', { className: 'rd-wscol' },
            h('div', { className: 'rd-wshosts' },
              connections.map((row) => h('button', {
                key: row.id,
                className: 'rd-hostchip' + (host && host.id === row.id ? ' on' : ''),
                onClick: () => switchHost(row.id),
              }, h(Dot, { state: row.status }), row.name)),
            ),
            h('div', { className: 'rd-pathbar' },
              h('button', { className: 'rd-btn', disabled: !listing || !listing.parent || busy !== '', onClick: goParent }, h(Icon, { name: 'arrowleft', size: 12 })),
              h('input', {
                className: 'rd-input mono',
                style: { flex: 1 },
                value: pathInput,
                spellCheck: false,
                onChange: (event) => setPathInput(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void load(pathInput.trim() || '~', host) },
              }),
              h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => void load(pathInput.trim() || '~', host) }, '前往'),
              h('button', {
                className: 'rd-btn',
                disabled: busy !== '' || !pathInput.trim(),
                title: '创建输入框中的目录（包含缺失的父目录）',
                onClick: () => {
                  void (async () => {
                    const target = pathInput.trim()
                    if (!target || !host) return
                    setBusy('mkdir')
                    setError('')
                    try {
                      await call('/connections/' + host.id + '/mkdir', { method: 'POST', body: { path: target, recursive: true } })
                      await load(target, host)
                    } catch (failure) {
                      setError(failure instanceof Error ? failure.message : String(failure))
                    }
                    setBusy('')
                  })()
                },
              }, h(Icon, { name: 'plus', size: 12 })),
              h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => void load(listing ? listing.path : '~', host) }, h(Icon, { name: 'refresh', size: 12 })),
            ),
            h('div', { className: 'rd-wscrumbs' },
              crumbs.map((crumb, index) => h(React.Fragment, { key: crumb.path },
                index > 0 && crumbs[index - 1].label !== '/' ? h('span', { className: 'sep3' }, '/') : null,
                h('span', { className: 'c3', onClick: () => void load(crumb.path, host) }, crumb.label),
              )),
            ),
            h('div', { className: 'rd-wsfilter' },
              h(Icon, { name: 'search', size: 12 }),
              h('input', { placeholder: '筛选当前目录', value: filter, onChange: (event) => setFilter(event.target.value) }),
              h('span', { className: 'rd-formhint' }, '只显示目录'),
            ),
            h('div', {
              className: 'rd-wtable',
              tabIndex: 0,
              onKeyDown: (event) => {
                const index = dirs.findIndex((dir) => dir.path === selected)
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const next = Math.max(0, Math.min(dirs.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
                  if (dirs[next]) setSelected(dirs[next].path)
                } else if (event.key === 'Enter' && index >= 0) {
                  enter(dirs[index])
                } else if (event.key === 'Backspace') {
                  event.preventDefault()
                  goParent()
                }
              },
            },
              h('div', { className: 'rd-wthead' }, h('span', null, '名称'), h('span', null, '修改时间'), h('span', null, '类型')),
              busy === 'dirs' && !listing
                ? h('div', { className: 'rd-wsrow' }, h('span', { className: 'rd-formhint' }, '正在读取目录…'))
                : dirs.length === 0
                  ? h('div', { className: 'rd-wsrow' }, h('span', { className: 'rd-formhint' }, filter ? '没有匹配的目录' : '（空目录）'))
                  : [
                    ...dirs.map((dir) => h('div', {
                      key: dir.path,
                      className: 'rd-wsrow2' + (selected === dir.path ? ' sel' : ''),
                      onClick: () => setSelected(dir.path),
                      onDoubleClick: () => enter(dir),
                    },
                      h('div', { className: 'nm4' },
                        h(Icon, { name: 'folder', size: 13, style: { color: '#c1a06a' } }),
                        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, dir.name),
                      ),
                      h('span', { className: 'dim2' }, dir.mtime ? ago(dir.mtime) : ''),
                      h('span', { className: 'dim2' }, '目录'),
                    )),
                    listing && listing.hasMore === true
                      ? h('div', { key: 'more', className: 'rd-wsrow' },
                        h('button', { className: 'rd-btn sm', disabled: busy === 'more', onClick: () => loadMore() },
                          busy === 'more' ? '加载中…' : '加载更多（' + dirs.length + '/' + (listing.total ?? dirs.length) + '）'))
                      : null,
                  ],
            ),
            h('div', { className: 'rd-wsfoot' },
              h('span', null, '双击进入目录 · ↑↓ 选择 · Enter 进入 · Backspace 上级'),
              newFolder === null
                ? h('span', {
                  className: 'rd-pill',
                  style: { height: 24, cursor: 'pointer' },
                  onClick: () => { setNewFolder(''); setError('') },
                }, h(Icon, { name: 'plus', size: 12 }), '新建文件夹')
                : h('span', { className: 'rd-newfolder' },
                  h('input', {
                    className: 'rd-input',
                    style: { height: 24, width: 150 },
                    value: newFolder,
                    autoFocus: true,
                    placeholder: '文件夹名',
                    onChange: (event) => setNewFolder(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') setNewFolder(null)
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void (async () => {
                        const name = newFolder.trim()
                        if (!name || !listing) return
                        setBusy('folder')
                        setError('')
                        try {
                          await call('/connections/' + host.id + '/mkdir', { method: 'POST', body: { path: listing.path, name } })
                          setNewFolder(null)
                          await load(listing.path, host)
                        } catch (failure) {
                          setError(failure instanceof Error ? failure.message : String(failure))
                        }
                        setBusy('')
                      })()
                    },
                  }),
                  h('button', {
                    className: 'rd-btn',
                    disabled: busy !== '' || newFolder.trim().length === 0,
                    onClick: () => {
                      void (async () => {
                        const name = newFolder.trim()
                        if (!name || !listing) return
                        setBusy('folder')
                        setError('')
                        try {
                          await call('/connections/' + host.id + '/mkdir', { method: 'POST', body: { path: listing.path, name } })
                          setNewFolder(null)
                          await load(listing.path, host)
                        } catch (failure) {
                          setError(failure instanceof Error ? failure.message : String(failure))
                        }
                        setBusy('')
                      })()
                    },
                  }, '创建'),
                  h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => setNewFolder(null) }, '取消'),
                ),
            ),
          ),
          preview,
        ),
      )
    }


    // ---------------------------------------------------------------- console

    function sessionsForHost(hostId) {
      const ids = store.sessions.ids || []
      const out = []
      for (const id of ids) {
        const summary = store.sessions.byId ? store.sessions.byId[id] : undefined
        if (!summary) continue
        const remote = remoteForSession(id)
        if (remote && remote.connectionId === hostId) out.push({ summary, remote })
      }
      out.sort((a, b) => (b.summary.updatedAt || 0) - (a.summary.updatedAt || 0))
      return out
    }

    function ConsoleIcon({ size = 16, active }) {
      return h('span', {
        className: 'rd-pico',
        'data-active': String(active === true),
        style: { width: size + 'px', height: size + 'px' },
        title: 'Remote Deck',
      }, h(Icon, { name: 'server', size }))
    }

    // ---------------------------------------------------------------- terminal + ports

    const stripAnsi = (value) => String(value)
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-9A-B]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')

    const cleanTerminalText = (value) => String(value)
      .split('\n')
      .map((line) => {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        const index = trimmed.lastIndexOf('\r')
        return index >= 0 ? trimmed.slice(index + 1) : trimmed
      })
      .join('\n')

    // ---------------------------------------------------------------- terminal engines

    let xtermLoader = null

    function apiBase() {
      const info = boot()
      return info === null ? '' : 'http://127.0.0.1:' + info.port
    }

    function isRemotePosix(value) {
      return typeof value === 'string' && value.startsWith('/')
    }

    function isLocalAbsolute(value) {
      return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
    }

    function downloadNameFor(target) {
      const parts = String(target || '').split(/[\\/]/)
      return parts[parts.length - 1] || 'download'
    }

    async function saveDownload(url, name, mode = 'saveAs') {
      const desktop = globalThis.dshDesktop
      if (desktop !== null && typeof desktop === 'object') {
        const bridge = desktop.fileActions
        if (bridge !== null && typeof bridge === 'object' && typeof bridge.save === 'function') {
          return await bridge.save({ url, mode, name })
        }
        // Older desktop builds have no fileActions bridge; keep the previous
        // browser behavior but report it so the caller can explain the fallback.
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = name || 'download'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        return { status: 'browser-fallback' }
      }
      // Web build: keep the existing browser download behavior.
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name || 'download'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      return { status: 'requested' }
    }

    function downloadUrlFor(connectionId, target) {
      const info = boot()
      if (info === null) return ''
      if (isRemotePosix(target)) {
        return apiBase() + '/connections/' + connectionId + '/download?path=' + encodeURIComponent(target) + '&token=' + encodeURIComponent(info.token)
      }
      if (isLocalAbsolute(target)) {
        return apiBase() + '/local/download?path=' + encodeURIComponent(target) + '&token=' + encodeURIComponent(info.token)
      }
      return ''
    }

    function assetUrl(name) {
      const info = boot()
      return info === null ? '' : apiBase() + '/assets/' + name + '?token=' + encodeURIComponent(info.token)
    }

    function loadXterm() {
      if (typeof window === 'undefined') return Promise.resolve(false)
      if (window.Terminal && window.FitAddon) return Promise.resolve(true)
      if (xtermLoader !== null) return xtermLoader
      const addTag = (tag, attrs) =>
        new Promise((resolve, reject) => {
          const el = document.createElement(tag)
          Object.assign(el, attrs)
          el.onload = () => resolve(true)
          el.onerror = () => reject(new Error('failed to load ' + (attrs.src || attrs.href)))
          document.head.appendChild(el)
        })
      xtermLoader = addTag('link', { rel: 'stylesheet', href: assetUrl('xterm.css') })
        .then(() => addTag('script', { src: assetUrl('xterm.js') }))
        .then(() => addTag('script', { src: assetUrl('addon-fit.js') }))
        .then(() => Boolean(window.Terminal && window.FitAddon))
        .catch(() => false)
      return xtermLoader
    }

    function XtermTerminal({ host }) {
      const boxRef = React.useRef(null)
      const [status, setStatus] = React.useState('connecting')
      const [error, setError] = React.useState('')
      const [sessionId, setSessionId] = React.useState('')
      const sessionRef = React.useRef('')
      const termRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const observerRef = React.useRef(null)

      const cleanup = React.useCallback(() => {
        abortRef.current?.abort()
        abortRef.current = null
        if (observerRef.current !== null) {
          observerRef.current.disconnect()
          observerRef.current = null
        }
        const id = sessionRef.current
        sessionRef.current = ''
        if (id) call('/terminals/' + id, { method: 'DELETE' }).catch(() => {})
        const term = termRef.current
        termRef.current = null
        if (term) {
          try {
            term.dispose()
          } catch {
            /* already gone */
          }
        }
      }, [])

      const open = React.useCallback(async () => {
        cleanup()
        setStatus('connecting')
        setError('')
        const info = boot()
        if (!boxRef.current || !window.Terminal || info === null) return
        const term = new window.Terminal({
          fontFamily: '"Cascadia Code", Consolas, ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          scrollback: 2000,
          theme: {
            background: '#0f1216',
            foreground: '#c9d1d9',
            cursor: '#63b6ff',
            selectionBackground: 'rgba(99,182,255,.28)',
          },
        })
        const fit = new window.FitAddon.FitAddon()
        term.loadAddon(fit)
        term.open(boxRef.current)
        try {
          fit.fit()
        } catch {
          /* element not measured yet */
        }
        termRef.current = term
        try {
          window.__RD_TERM__ = term
        } catch {
          /* not a page */
        }
        term.focus()
        term.onData((data) => {
          const id = sessionRef.current
          if (id) call('/terminals/' + id + '/input', { method: 'POST', body: { data } }).catch(() => {})
        })
        term.onResize(({ cols, rows }) => {
          const id = sessionRef.current
          if (id) call('/terminals/' + id + '/resize', { method: 'POST', body: { cols, rows } }).catch(() => {})
        })
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(() => {
            try {
              fit.fit()
            } catch {
              /* ignore */
            }
          })
          observer.observe(boxRef.current)
          observerRef.current = observer
        }
        try {
          const created = await call('/terminals', { method: 'POST', body: { connectionId: host.id, cols: term.cols, rows: term.rows, title: host.name } })
          sessionRef.current = created.id
          setSessionId(created.id)
          setStatus('open')
          const controller = new AbortController()
          abortRef.current = controller
          const response = await fetch(apiBase() + '/terminals/' + created.id + '/stream', {
            headers: { 'x-dsh-remote-token': info.token },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error('terminal stream failed: HTTP ' + response.status)
          const reader = response.body.getReader()
          const sseDecoder = new TextDecoder('utf-8', { stream: true })
          const terminalDecoder = new TextDecoder('utf-8', { stream: true })
          let pending = ''
          void (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                pending += sseDecoder.decode(value, { stream: true })
                let index
                while ((index = pending.indexOf('\n\n')) >= 0) {
                  const frame = pending.slice(0, index)
                  pending = pending.slice(index + 2)
                  const line = frame.split('\n').find((row) => row.startsWith('data: '))
                  if (line === undefined) continue
                  let event
                  try {
                    event = JSON.parse(line.slice(6))
                  } catch {
                    continue
                  }
                  if (event.type === 'data') {
                    term.write(Uint8Array.from(atob(event.b64), (char) => char.charCodeAt(0)))
                  } else if (event.type === 'exit') {
                    setStatus('closed')
                    term.write('\r\n[process exited' + (event.code === null ? '' : ' with code ' + event.code) + ']\r\n')
                  } else if (event.type === 'error') {
                    setError(event.message || 'terminal error')
                  }
                }
              }
            } catch {
              /* aborted on unmount */
            }
          })()
          term.focus()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setStatus('error')
        }
      }, [host.id, cleanup])

      React.useEffect(() => {
        void open()
        return cleanup
      }, [host.id])

      return h('div', { className: 'rd-terminal' },
        h('div', { className: 'rd-termhead' },
          h('span', { className: 'dotrow' }, h('i'), h('i'), h('i')),
          h('span', { className: 'rd-termtab' }, host.name + ' — bash'),
          h('span', { className: 'rd-termstatus' },
            h(Dot, { state: status === 'open' ? 'connected' : status === 'error' ? 'error' : status === 'closed' ? 'disconnected' : 'connecting' }),
            status === 'open' ? '已连接' : status === 'closed' ? '已退出' : status === 'error' ? '失败' : '连接中',
          ),
          h('button', { className: 'rd-termbtn', onClick: () => void open(), title: '重开终端' }, h(Icon, { name: 'refresh', size: 13 })),
        ),
        h('div', { className: 'rd-xterm', ref: boxRef }),
        error ? h('div', { className: 'rd-termerror' }, friendlyText(error)) : null,
        h('div', { className: 'rd-termfoot' },
          h('span', null, '完整终端（xterm.js）· 支持颜色、光标与全屏程序'),
          h('span', { style: { marginLeft: 'auto' } }, sessionId ? 'session ' + sessionId.slice(0, 8) : ''),
        ),
      )
    }

    function TerminalPanel({ host }) {
      const [engine, setEngine] = React.useState('loading')
      React.useEffect(() => {
        let alive = true
        loadXterm().then((ok) => {
          if (alive) setEngine(ok ? 'xterm' : 'lines')
        })
        return () => {
          alive = false
        }
      }, [host.id])
      if (engine === 'loading') {
        return h('div', { className: 'rd-terminal' },
          h('div', { className: 'rd-termhead' },
            h('span', { className: 'dotrow' }, h('i'), h('i'), h('i')),
            h('span', { className: 'rd-termtab' }, host.name + ' — bash'),
            h('span', { className: 'rd-termstatus' }, h(Dot, { state: 'connecting' }), '加载终端…'),
          ),
          h('div', { className: 'rd-xterm-placeholder' }, '正在加载完整终端…'),
        )
      }
      return engine === 'xterm' ? h(XtermTerminal, { host }) : h(LineTerminal, { host })
    }

    function LineTerminal({ host }) {
      const [sessionId, setSessionId] = React.useState('')
      const sessionRef = React.useRef('')
      const [text, setText] = React.useState('')
      const [status, setStatus] = React.useState('connecting')
      const [error, setError] = React.useState('')
      const bufferRef = React.useRef('')
      const viewRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const flushRef = React.useRef(null)

      const schedule = () => {
        if (flushRef.current !== null) return
        flushRef.current = setTimeout(() => {
          flushRef.current = null
          setText(bufferRef.current)
          const node = viewRef.current
          if (node) node.scrollTop = node.scrollHeight
        }, 60)
      }

      const close = React.useCallback(() => {
        abortRef.current?.abort()
        abortRef.current = null
        const id = sessionRef.current
        sessionRef.current = ''
        if (id) call('/terminals/' + id, { method: 'DELETE' }).catch(() => {})
      }, [])

      const open = React.useCallback(async () => {
        close()
        setStatus('connecting')
        setError('')
        setText('')
        bufferRef.current = ''
        try {
          const created = await call('/terminals', { method: 'POST', body: { connectionId: host.id, cols: 120, rows: 30, title: host.name } })
          sessionRef.current = created.id
          setSessionId(created.id)
          try {
            window.__RD_TERM_ID__ = created.id
          } catch {
            /* not a page */
          }
          const info = boot()
          if (info === null) throw new Error('remote-deck is not active')
          const controller = new AbortController()
          abortRef.current = controller
          const response = await fetch('http://127.0.0.1:' + info.port + '/terminals/' + created.id + '/stream', {
            headers: { 'x-dsh-remote-token': info.token },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error('terminal stream failed: HTTP ' + response.status)
          setStatus('open')
          const sseDecoder = new TextDecoder('utf-8', { stream: true })
          const terminalDecoder = new TextDecoder('utf-8', { stream: true })
          const reader = response.body.getReader()
          let pending = ''
          void (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                pending += sseDecoder.decode(value, { stream: true })
                let index
                while ((index = pending.indexOf('\n\n')) >= 0) {
                  const frame = pending.slice(0, index)
                  pending = pending.slice(index + 2)
                  const line = frame.split('\n').find((row) => row.startsWith('data: '))
                  if (line === undefined) continue
                  let event
                  try {
                    event = JSON.parse(line.slice(6))
                  } catch {
                    continue
                  }
                  if (event.type === 'data') {
                    const bytes = Uint8Array.from(atob(event.b64), (char) => char.charCodeAt(0))
                    bufferRef.current += cleanTerminalText(stripAnsi(terminalDecoder.decode(bytes, { stream: true })))
                    if (bufferRef.current.length > 400000) bufferRef.current = bufferRef.current.slice(-300000)
                    schedule()
                  } else if (event.type === 'exit') {
                    setStatus('closed')
                    bufferRef.current += '\n[process exited' + (event.code === null ? '' : ' with code ' + event.code) + ']\n'
                    schedule()
                  } else if (event.type === 'error') {
                    setError(event.message || 'terminal error')
                  }
                }
              }
            } catch {
              /* aborted on unmount */
            }
          })()
          setTimeout(() => viewRef.current?.focus(), 120)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setStatus('error')
        }
      }, [host.id])

      React.useEffect(() => {
        void open()
        return () => {
          close()
          if (flushRef.current !== null) clearTimeout(flushRef.current)
        }
      }, [host.id])

      const send = (data) => {
        const id = sessionRef.current
        if (!id || data.length === 0) return
        call('/terminals/' + id + '/input', { method: 'POST', body: { data } }).catch(() => {})
      }

      const onKeyDown = (event) => {
        if (event.ctrlKey && event.key.length === 1) {
          const code = event.key.toUpperCase().charCodeAt(0)
          if (code >= 64 && code <= 95) {
            send(String.fromCharCode(code - 64))
            event.preventDefault()
            return
          }
        }
        const map = {
          Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
          ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
          Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
        }
        if (map[event.key] !== undefined) {
          send(map[event.key])
          event.preventDefault()
          return
        }
        if (event.key.length === 1) {
          send(event.key)
          event.preventDefault()
        }
      }

      return h('div', { className: 'rd-terminal' },
        h('div', { className: 'rd-termhead' },
          h('span', { className: 'dotrow' }, h('i'), h('i'), h('i')),
          h('span', { className: 'rd-termtab' }, host.name + ' — bash'),
          h('span', { className: 'rd-termstatus' },
            h(Dot, { state: status === 'open' ? 'connected' : status === 'error' ? 'error' : status === 'closed' ? 'disconnected' : 'connecting' }),
            status === 'open' ? '已连接' : status === 'closed' ? '已退出' : status === 'error' ? '失败' : '连接中',
          ),
          h('button', { className: 'rd-termbtn', onClick: () => void open(), title: '重开终端' }, h(Icon, { name: 'refresh', size: 13 })),
        ),
        h('div', {
          className: 'rd-termout',
          ref: viewRef,
          tabIndex: 0,
          onKeyDown,
          onPaste: (event) => {
            const text = event.clipboardData ? event.clipboardData.getData('text') : ''
            if (text) {
              send(text)
              event.preventDefault()
            }
          },
          onMouseDown: () => viewRef.current?.focus(),
        }, text.length === 0 ? h('span', { className: 'rd-termplaceholder' }, '正在打开远端 shell…') : text),
        error ? h('div', { className: 'rd-termerror' }, friendlyText(error)) : null,
        h('div', { className: 'rd-termfoot' },
          h('span', null, '点击终端后可直接输入 · 支持粘贴 · Ctrl+C 中断'),
          h('span', { style: { marginLeft: 'auto' } }, sessionId ? 'session ' + sessionId.slice(0, 8) : ''),
        ),
      )
    }

    function PortsPanel({ host }) {
      const [ports, setPorts] = React.useState(null)
      const [forwards, setForwards] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [remotePort, setRemotePort] = React.useState('')
      const [localPort, setLocalPort] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const [detected, all] = await Promise.all([
            call('/connections/' + host.id + '/ports'),
            call('/forwards'),
          ])
          setPorts(detected.ports)
          setForwards(all.forwards.filter((row) => row.connectionId === host.id))
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [host.id])

      React.useEffect(() => {
        let cancelled = false
        let timer = null
        let running = false
        const tick = async () => {
          if (cancelled || running) return
          running = true
          try {
            await load()
          } finally {
            running = false
          }
          if (!cancelled) timer = setTimeout(tick, 8000)
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [load])

      const start = async (port, local) => {
        setBusy('port:' + port)
        setError('')
        try {
          await call('/forwards', { method: 'POST', body: { connectionId: host.id, remotePort: Number(port), localPort: Number(local) || 0 } })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const stop = async (id) => {
        setBusy('stop:' + id)
        try {
          await call('/forwards/' + id, { method: 'DELETE' })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const forwarded = new Map(forwards.map((row) => [row.remotePort, row]))

      return h('div', { className: 'rd-ports' },
        h('div', { className: 'rd-porthead' },
          h('div', null,
            h('div', { className: 'rd-csect', style: { margin: '0 0 4px' } },
              h('span', { className: 'st2' }, '已转发'),
              h('span', { className: 'ct2' }, forwards.length + ' 个 · 连接恢复后自动重建'),
            ),
          ),
          h('button', { className: 'rd-btn sm', onClick: () => void load(), disabled: busy !== '' }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
        ),
        forwards.length === 0
          ? h('div', { className: 'rd-empty', style: { padding: '18px' } }, '还没有端口转发。下面可以从监听端口里选一个，或手动填写。')
          : forwards.map((row) => h('div', { key: row.id, className: 'rd-portrow' },
            h(Dot, { state: 'connected' }),
            h('span', { className: 'rd-portmap mono' }, '127.0.0.1:' + row.localPort),
            h('span', { className: 'rd-portarrow' }, '→'),
            h('span', { className: 'rd-portmap mono' }, host.name + ':' + row.remotePort),
            h('span', { className: 'rd-portactions' },
              h('button', { className: 'rd-btn sm', onClick: () => window.open(row.url, '_blank') }, '打开'),
              h('button', { className: 'rd-btn sm', onClick: () => { void navigator.clipboard?.writeText(row.url) } }, h(Icon, { name: 'copy', size: 12 }), '复制'),
              h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => void stop(row.id) }, '停止'),
            ),
          )),

        h('div', { className: 'rd-csect', style: { marginTop: 22 } },
          h('span', { className: 'st2' }, '正在监听的端口'),
          h('span', { className: 'ct2' }, ports === null ? '读取中…' : ports.length + ' 个 · 自动刷新'),
        ),
        h('div', { className: 'rd-porttable' },
          h('div', { className: 'rd-portheadrow' }, h('span', null, '端口'), h('span', null, '状态'), h('span', null, '操作')),
          ports === null
            ? h('div', { className: 'rd-portempty' }, '读取远端监听端口…')
            : ports.length === 0
              ? h('div', { className: 'rd-portempty' }, '没有读到监听端口（ss/netstat 不可用或无服务）。')
              : ports.slice(0, 40).map((row) => {
                const existing = forwarded.get(row.port)
                return h('div', { key: row.port, className: 'rd-portrow2' },
                  h('span', { className: 'mono' }, ':' + row.port),
                  h('span', { className: 'rd-formhint' }, existing ? '已转发到 ' + existing.localPort : '监听中'),
                  h('span', { className: 'rd-portactions' },
                    existing
                      ? h('button', { className: 'rd-btn sm', onClick: () => window.open(existing.url, '_blank') }, '打开')
                      : h('button', {
                        className: 'rd-btn sm',
                        disabled: busy !== '',
                        onClick: () => void start(row.port, 0),
                      }, busy === 'port:' + row.port ? '转发中…' : '转发'),
                  ),
                )
              }),
        ),

        h('div', { className: 'rd-portadd' },
          h('span', { className: 'rd-formhint' }, '手动添加'),
          h('input', { className: 'rd-input mono', style: { width: 110 }, placeholder: '远程端口', value: remotePort, onChange: (event) => setRemotePort(event.target.value) }),
          h('span', { className: 'rd-portarrow' }, '→'),
          h('input', { className: 'rd-input mono', style: { width: 120 }, placeholder: '本地端口（自动）', value: localPort, onChange: (event) => setLocalPort(event.target.value) }),
          h('button', { className: 'rd-btn primary', disabled: busy !== '' || !remotePort, onClick: () => void start(remotePort, localPort) }, '开启'),
        ),
        error ? h('div', { className: 'rd-err', style: { marginTop: 10 } }, friendlyText(error)) : null,
      )
    }


    function FilePanel({ host }) {
      try {
        return FilePanelInner({ host })
      } catch (error) {
        return h('div', { className: 'rd-err', style: { margin: '12px 0' } }, '文件面板出错：' + friendlyText(error && error.message ? error.message : error))
      }
    }

    function FilePanelInner({ host }) {
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState([])
      const [page, setPage] = React.useState({ total: 0, offset: 0, limit: 500, hasMore: false })
      const [loading, setLoading] = React.useState(false)
      const [loadingMore, setLoadingMore] = React.useState(false)
      const [downloading, setDownloading] = React.useState('')
      const [error, setError] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const stateWorkspaces = (store.state && store.state.workspaces) || []
      const workspace = stateWorkspaces.find((row) => row.connectionId === host.id)
      const root = workspace ? workspace.path : '/'

      const load = React.useCallback(async (next, offset = 0, append = false) => {
        if (append) setLoadingMore(true)
        else setLoading(true)
        setError('')
        setNotice('')
        try {
          const target = typeof next === 'string' && next.length > 0 ? next : root
          const data = await call('/connections/' + host.id + '/files?path=' + encodeURIComponent(target) + '&offset=' + offset + '&limit=500')
          setPath(data.path)
          setPage({
            total: Number(data.total) || 0,
            offset: Number(data.offset) || offset,
            limit: Number(data.limit) || 500,
            hasMore: data.hasMore === true,
          })
          setEntries((previous) => append ? [...previous, ...(data.entries || [])] : (data.entries || []))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
          setLoadingMore(false)
        }
      }, [host.id, root])

      const loadMore = () => {
        if (page.hasMore !== true) return
        void load(path || root, Number(page.offset) + Number(page.limit), true)
      }

      React.useEffect(() => {
        setPath('')
        setEntries([])
        setFilter('')
        void load(root)
      }, [host.id])

      async function download(entry) {
        if (downloading === entry.path) return
        const info = boot()
        if (info === null) return
        const url = apiBase() + '/connections/' + host.id + '/download?path=' + encodeURIComponent(entry.path) + '&token=' + encodeURIComponent(info.token)
        setError('')
        setNotice('')
        setDownloading(entry.path)
        showDownloadToast('请选择保存位置：' + entry.name)
        try {
          const result = await saveDownload(url, entry.name)
          if (result && result.status === 'saved') {
            setNotice('已保存到 ' + result.path)
            showDownloadToast('已保存到 ' + result.path)
          } else if (result && result.status === 'cancelled') {
            setNotice('已取消保存')
            showDownloadToast('已取消保存')
          } else if (result && result.status === 'browser-fallback') {
            setNotice('当前桌面版本不支持应用内下载，已使用浏览器下载 ' + entry.name)
            showDownloadToast('当前桌面版本不支持应用内下载，已使用浏览器下载', 'error')
          } else {
            setNotice('已开始下载 ' + entry.name)
            showDownloadToast('已开始下载 ' + entry.name)
          }
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setError(message)
          showDownloadToast('下载失败：' + message, 'error')
        } finally {
          setDownloading('')
        }
      }

      async function saveLocal(entry) {
        try {
          const result = await call('/connections/' + host.id + '/save-local', { method: 'POST', body: { path: entry.path } })
          setNotice('已保存到 ' + result.localPath)
          await call('/connections/' + host.id + '/reveal', { method: 'POST', body: { localPath: result.localPath } }).catch(() => {})
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      function crumbsFor(value) {
        const all = [{ label: '/', value: '/' }]
        let acc = ''
        for (const part of value.split('/').filter(Boolean)) {
          acc += '/' + part
          all.push({ label: part, value: acc })
        }
        return all
      }

      const crumbs = crumbsFor(path || root)
      const hostWorkspaces = stateWorkspaces.filter((row) => row.connectionId === host.id)
      const visible = entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))

      return h('div', { className: 'rd-files' },
        h('div', { className: 'rd-fbar' },
          h('div', { className: 'rd-crumbs' },
            crumbs.map((crumb, index) => h('button', {
              key: crumb.value,
              className: 'rd-crumb' + (index === crumbs.length - 1 ? ' on' : ''),
              onClick: () => void load(crumb.value),
            }, crumb.label)),
          ),
          h('div', { className: 'rd-fright' },
            h('input', { className: 'rd-fsearch', value: filter, placeholder: '筛选文件…', onChange: (event) => setFilter(event.target.value) }),
            h('button', { className: 'rd-btn sm', onClick: () => void load(path) }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
          ),
        ),
        hostWorkspaces.length > 0 ? h('div', { className: 'rd-fjump' },
          h('span', null, '快速跳转：'),
          hostWorkspaces.map((row) => h('button', { key: row.workspaceId || row.path, className: 'rd-fchip', onClick: () => void load(row.path) }, row.folder || row.title || row.path)),
        ) : null,
        notice ? h('div', { className: 'rd-fnotice' }, notice) : null,
        error ? h('div', { className: 'rd-err' }, friendlyText(error)) : null,
        loading ? h('div', { className: 'rd-empty', style: { padding: '20px' } }, '正在读取远程目录…') : null,
        !loading && !error && visible.length === 0 ? h('div', { className: 'rd-empty', style: { padding: '20px' } }, '这个目录是空的。') : null,
        !loading && visible.length > 0 ? h('div', { className: 'rd-flist' },
          visible.map((entry) => h('div', {
            key: entry.path,
            className: 'rd-frow' + (entry.type === 'dir' ? ' dir' : ''),
            onClick: entry.type === 'dir' ? () => void load(entry.path) : undefined,
          },
            h(Icon, { name: entry.type === 'dir' ? 'folder' : 'file', size: 14 }),
            h('span', { className: 'rd-fname', title: entry.name }, entry.name),
            h('span', { className: 'rd-fsize' }, entry.type === 'dir' ? '文件夹' : formatBytes(entry.size)),
            h('span', { className: 'rd-fmod' }, entry.mtime ? ago(entry.mtime) : ''),
            h('span', { className: 'rd-factions' },
              entry.type === 'dir' ? null : h('button', {
                className: 'rd-btn sm',
                disabled: downloading === entry.path,
                onClick: (event) => { event.stopPropagation(); void download(entry) },
              }, downloading === entry.path ? '下载中…' : '下载'),
              entry.type === 'dir' ? null : h('button', {
                className: 'rd-btn sm',
                onClick: (event) => { event.stopPropagation(); void saveLocal(entry) },
              }, '本地显示'),
            ),
          )),
        ) : null,
        page.hasMore === true
          ? h('div', { className: 'rd-empty', style: { padding: '8px 0' } },
            h('button', { className: 'rd-btn sm', disabled: loadingMore, onClick: () => loadMore() },
              loadingMore ? '加载中…' : '加载更多（已显示 ' + entries.length + '/' + page.total + '）'))
          : null,
      )
    }

    function formatBytes(value) {
      const size = Number(value) || 0
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
    }

    const NOTE_KIND_LABEL = {
      fact: '事实',
      preference: '偏好',
      command: '命令',
      caution: '注意',
      decision: '决定',
    }

    const NOTE_KINDS = ['fact', 'preference', 'command', 'caution', 'decision']

    function activeNotesOf(list) {
      return (list || []).filter((note) => note.status === 'active')
    }

    function noteRowV3(note, scope, busy, handlers) {
      const archived = note.status !== 'active'
      return h('div', { className: 'rd-note' + (archived ? ' archived' : ''), key: note.id },
        h('span', { className: 'rd-note-kind ' + note.kind }, NOTE_KIND_LABEL[note.kind] || note.kind),
        h('div', { className: 'rd-note-body' },
          h('div', { className: 'rd-note-txt' }, note.text),
          h('div', { className: 'rd-note-sub' },
            h('span', null, note.source && note.source.kind === 'model' ? '模型' : '你'),
            h('span', null, '·'),
            h('span', null, ago(note.updatedAt) || '刚刚'),
            note.pinned ? h('span', null, '· 已固定') : null,
            archived ? h('span', null, '· ' + (note.status === 'archived' ? '已归档' : '已被替换')) : null,
          ),
        ),
        h('div', { className: 'rd-note-ops' },
          archived
            ? h('button', { className: 'rd-note-op', disabled: busy, onClick: () => handlers.restore(note) }, '恢复')
            : h(React.Fragment, null,
                h('button', { className: 'rd-note-op', disabled: busy, onClick: () => handlers.edit(note) }, '编辑'),
                h('button', { className: 'rd-note-op', disabled: busy, onClick: () => handlers.archive(note) }, '归档'),
              ),
        ),
      )
    }

    function NoteDialog({ scope, host, remotePath, workspaceName, note, busy, onClose, onSave }) {
      const [kind, setKind] = React.useState(note ? note.kind : scope === 'machine' ? 'caution' : 'fact')
      const [text, setText] = React.useState(note ? note.text : '')
      const [tags, setTags] = React.useState(note ? note.tags.join(', ') : '')
      const [pinned, setPinned] = React.useState(note ? note.pinned : false)
      const editing = Boolean(note && note.id)
      const title = (editing ? '编辑' : '添加') + (scope === 'machine' ? '机器笔记' : '工作区笔记')
      const canSave = text.trim().length > 0 && !busy

      return h('div', { className: 'rd-dlg-overlay', onClick: onClose },
        h('div', { className: 'rd-dlg', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'rd-dlg-head' },
            h('div', null,
              h('div', { className: 't' }, title),
              h('div', { className: 's' }, scope === 'machine'
                ? '注入到 ' + host.name + ' 上所有工作区的会话；从下一次请求开始生效。'
                : '只注入到 ' + (workspaceName || remotePath) + ' 的会话；从下一次请求开始生效。'),
            ),
            h('button', { className: 'rd-dlg-x', onClick: onClose }, h(Icon, { name: 'x', size: 14 })),
          ),
          h('div', { className: 'rd-dlg-body' },
            h('div', { className: 'rd-dlg-target' + (scope === 'machine' ? ' machine' : '') },
              h(Icon, { name: scope === 'machine' ? 'server' : 'folder', size: 13 }),
              h('span', null, scope === 'machine' ? '机器 · ' + host.name : '工作区 · ' + (workspaceName || remotePath)),
              h('code', null, scope === 'machine' ? '所有工作区共享' : remotePath),
            ),
            h('div', { className: 'rd-dlg-field' },
              h('div', { className: 'rd-dlg-label' }, '类型'),
              h('div', { className: 'rd-dlg-chips' },
                NOTE_KINDS.map((id) => h('button', {
                  key: id,
                  className: 'rd-dlg-chip' + (kind === id ? ' on' : ''),
                  onClick: () => setKind(id),
                }, NOTE_KIND_LABEL[id] || id)),
              ),
            ),
            h('div', { className: 'rd-dlg-field' },
              h('div', { className: 'rd-dlg-label' }, '内容'),
              h('textarea', {
                className: 'rd-dlg-textarea',
                value: text,
                maxLength: 500,
                autoFocus: true,
                placeholder: scope === 'machine'
                  ? '这台机器特有的：内网镜像、权限、固定路径、外网限制。'
                  : '这个仓库特有的：构建顺序、生成物、坑。',
                onChange: (event) => setText(event.target.value),
              }),
              h('div', { className: 'rd-dlg-counter' }, text.length + ' / 500'),
            ),
            h('div', { className: 'rd-dlg-field' },
              h('div', { className: 'rd-dlg-inline' },
                h('input', {
                  className: 'rd-dlg-input',
                  value: tags,
                  placeholder: '标签，用逗号分隔（可选）',
                  onChange: (event) => setTags(event.target.value),
                }),
                h('label', { className: 'rd-dlg-check' },
                  h('input', { type: 'checkbox', checked: pinned, onChange: (event) => setPinned(event.target.checked) }),
                  '固定到注入顶部',
                ),
              ),
            ),
          ),
          h('div', { className: 'rd-dlg-foot' },
            h('span', { className: 'rd-dlg-hint' }, '敏感内容（密钥、token）会被拒绝保存'),
            h('button', { className: 'rd-btn', onClick: onClose, disabled: busy }, '取消'),
            h('button', {
              className: 'rd-btn primary',
              disabled: !canSave,
              onClick: () => onSave({ kind, text, tags, pinned }),
            }, busy ? '保存中…' : '保存'),
          ),
        ),
      )
    }

    function MemoryPanel({ host, hostWorkspaces }) {
      const [data, setData] = React.useState(null)
      const [path, setPath] = React.useState('')
      const [editor, setEditor] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [expandedFacts, setExpandedFacts] = React.useState(() => new Set())

      const workspaceKey = hostWorkspaces.map((row) => row.path).join('|')
      React.useEffect(() => {
        const first = (hostWorkspaces[0] || {}).path || ''
        setPath((current) => (hostWorkspaces.some((row) => row.path === current) ? current : first))
      }, [host.id, workspaceKey])

      const workspacePaths = React.useMemo(() => hostWorkspaces.map((row) => row.path), [workspaceKey])

      const load = React.useCallback(async (remotePath) => {
        setLoading(true)
        setError('')
        try {
          let query = '/memory?connectionId=' + encodeURIComponent(host.id) + '&path=' + encodeURIComponent(remotePath || '')
          for (const item of workspacePaths) query += '&wp=' + encodeURIComponent(item)
          setData(await call(query))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setLoading(false)
      }, [host.id, workspacePaths.join('|')])

      React.useEffect(() => {
        void load(path)
      }, [load, path])

      const settings = (data && data.settings) || {}
      const machineOn = data ? data.machineEnabled === true : false
      const machineBrief = data && data.machine && data.machine.brief
      const machineNotes = (data && data.machine && data.machine.notes) || []
      const workspaceBrief = data && data.workspace && data.workspace.brief
      const workspaceNotes = (data && data.workspace && data.workspace.notes) || []
      const preview = (data && data.preview) || { text: '', bytes: 0, limit: 2000 }
      const counts = {}
      for (const row of (data && data.workspaces) || []) counts[row.path] = row.noteCount
      const currentName = (hostWorkspaces.find((row) => row.path === path) || {}).folder || path
      const latency = host.latencyMs !== undefined && host.latencyMs !== null ? Math.round(host.latencyMs) + 'ms' : ''
      const connected = host.status === 'connected'

      const setMachine = async (enabled) => {
        setBusy('machine')
        setError('')
        try {
          await call('/memory/settings', { method: 'POST', body: { machine: { connectionId: host.id, enabled } } })
          if (enabled && path) {
            await call('/memory/refresh', { method: 'POST', body: { connectionId: host.id, path, workspaces: workspacePaths } }).catch(() => {})
          }
          await load(path)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const refresh = async () => {
        setBusy('refresh')
        setError('')
        try {
          await call('/memory/refresh', { method: 'POST', body: { connectionId: host.id, path, workspaces: workspacePaths } })
            .then((result) => setData(result))
            .catch(async (failure) => {
              setError(failure instanceof Error ? failure.message : String(failure))
              await load(path)
            })
          pushInfo('记忆简报已刷新')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const saveNote = async (payload) => {
        if (!editor) return
        setBusy('note')
        setError('')
        try {
          await call('/memory/note', {
            method: 'POST',
            body: {
              connectionId: host.id,
              remotePath: editor.scope === 'machine' ? '' : path,
              scope: editor.scope,
              id: editor.note ? editor.note.id : undefined,
              text: payload.text,
              kind: payload.kind,
              tags: payload.tags,
              pinned: payload.pinned,
            },
          })
          setEditor(null)
          await load(path)
          pushInfo('笔记已保存')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const noteAction = async (action, scope, note) => {
        setBusy('note')
        setError('')
        try {
          await call('/memory/note/' + action, {
            method: 'POST',
            body: { connectionId: host.id, remotePath: scope === 'machine' ? '' : path, scope, id: note.id },
          })
          await load(path)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const handlers = {
        edit: (note) => setEditor({ scope: 'workspace', note }),
        archive: (note) => void noteAction('archive', 'workspace', note),
        restore: (note) => void noteAction('restore', 'workspace', note),
      }
      const machineHandlers = {
        edit: (note) => setEditor({ scope: 'machine', note }),
        archive: (note) => void noteAction('archive', 'machine', note),
        restore: (note) => void noteAction('restore', 'machine', note),
      }

      const rawBlock = (label, data) => h('details', { className: 'rd-raw' },
        h('summary', null, label),
        h('pre', null, JSON.stringify(data, null, 2)),
      )

      const facts = (rows) => h('div', { className: 'rd-facts' },
        rows.map(([key, value, sub, clamp], index) => {
          const id = key + ':' + index
          const open = expandedFacts.has(id)
          const toggle = () => setExpandedFacts((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
          return h('div', { className: 'rd-fact' + (sub ? ' sub' : '') + (clamp ? ' clampable' : ''), key: id },
            h('span', { className: 'k' }, key),
            h('span', {
              className: 'v' + (clamp && !open ? ' clamp2' : ''),
              title: clamp ? String(value) : undefined,
              onClick: clamp ? toggle : undefined,
            }, value),
            clamp ? h('button', { className: 'rd-fact-more', onClick: toggle, title: open ? '收起' : '显示全文' }, open ? '收起' : '展开') : null,
          )
        }),
      )

      const machineFactRows = []
      if (machineBrief && machineBrief.data) {
        const d = machineBrief.data
        if (d.os) machineFactRows.push(['系统', d.os])
        if (d.resources) machineFactRows.push(['资源', d.resources])
        if (Array.isArray(d.tools) && d.tools.length > 0) machineFactRows.push(['已装', d.tools.join(' · ')])
        if (d.shell) machineFactRows.push(['Shell', d.shell])
      }

      const workspaceFactRows = []
      if (workspaceBrief && workspaceBrief.data) {
        const d = workspaceBrief.data
        if (Array.isArray(d.repos) && d.repos.length > 0) {
          const total = Number.isFinite(d.totalRepos) ? d.totalRepos : d.repos.length
          workspaceFactRows.push(['结构', total + ' 个子仓库'])
          for (const repo of d.repos) {
            const parts = [repo.stack, ...(repo.commands || []), repo.role].filter(Boolean)
            workspaceFactRows.push([repo.name, parts.length > 0 ? parts.join(' · ') : '—', true])
          }
          if (total > d.repos.length) {
            workspaceFactRows.push(['…', '还有 ' + (total - d.repos.length) + ' 个子仓库未列出（上限 12 个）', true])
          }
        }
        if (Array.isArray(d.entryDocs) && d.entryDocs.length > 0) {
          workspaceFactRows.push(['入口文档', d.entryDocs.join(' · ')])
        }
        if (d.vcs) workspaceFactRows.push(['版本库', d.vcs])
        if (d.git && d.git.remote) workspaceFactRows.push(['Git', d.git.remote])
        if (d.stack) workspaceFactRows.push(['技术栈', d.stack])
        if (Array.isArray(d.commands) && d.commands.length > 0) workspaceFactRows.push(['命令', d.commands.join(' · ')])
        if (Array.isArray(d.children) && d.children.length > 0) {
          const kids = d.children.filter((child) => child.vcs || child.stack)
          if (kids.length > 0) {
            workspaceFactRows.push(['结构', kids.length + ' 个版本库 / 组件'])
            for (const kid of kids.slice(0, 5)) {
              const parts = [kid.vcs ? kid.vcs.toUpperCase() + ' 工作副本' : '', kid.stack].filter(Boolean)
              workspaceFactRows.push([kid.name, parts.join(' · '), true])
            }
          }
        }
        if (Array.isArray(d.dirs) && d.dirs.length > 0) workspaceFactRows.push(['顶层目录', d.dirs.join(' · ')])
        if (d.readme) workspaceFactRows.push(['README', d.readme, false, true])
      }

      const machineNoteList = machineNotes.length === 0
        ? h('div', { className: 'rd-blank' }, '还没有机器笔记。这里放整台机器通用的事实：内网镜像、权限、固定路径。')
        : machineNotes.slice().sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1))
            .map((note) => noteRowV3(note, 'machine', busy !== '', machineHandlers))

      const workspaceNoteList = workspaceNotes.length === 0
        ? h('div', { className: 'rd-blank' }, workspaceBrief
            ? '这个工作区还没有笔记。简报已生成，注入里目前只有机器信息和上面的自动摘要。'
            : '这个工作区还没有笔记，简报也还没生成。点右上角「刷新简报」先采集一次。')
        : workspaceNotes.slice().sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1))
            .map((note) => noteRowV3(note, 'workspace', busy !== '', handlers))

      const switchButton = (on, onClick, disabled) => h('button', {
        className: 'rd-switch' + (on ? ' on' : ''),
        onClick,
        disabled,
        title: on ? '点击关闭' : '点击开启',
      }, h('span', null))

      return h('div', { className: 'rd-mem3' },
        h('div', { className: 'rd-mem3-head' },
          h('div', null,
            h('div', { className: 'rd-mem3-title' }, '远程记忆'),
            h('div', { className: 'rd-mem3-sub' }, '只影响远程工作区会话；数据只存本机，不写远端仓库。'),
          ),
          h('div', { className: 'rd-mem3-actions' },
            h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => void refresh() },
              h(Icon, { name: 'refresh', size: 12 }), busy === 'refresh' ? '刷新中…' : '刷新简报'),
          ),
        ),
        error ? h('div', { className: 'rd-mem3-error' }, error) : null,
        loading && !data
          ? h('div', { className: 'rd-blank' }, '正在读取记忆…')
          : !machineOn
            ? h('div', { className: 'rd-mem3-onboard' },
                h('div', { className: 'ic' }, h(Icon, { name: 'server', size: 20 })),
                h('div', { className: 'tt' }, host.name + ' 的记忆未开启'),
                h('div', { className: 'ts' }, '全局记忆已开启；每台机器还需要单独开启。开启后才会生成简报并注入。'),
                h('button', { className: 'rd-btn primary', disabled: busy !== '', onClick: () => void setMachine(true) }, '开启本机记忆'),
              )
            : h(React.Fragment, null,
                // ---------------------------------------------- 机器层
                h('section', { className: 'rd-layer machine' },
                  h('div', { className: 'rd-layer-head' },
                    h('span', { className: 'rd-layer-icon' }, h(Icon, { name: 'server', size: 15 })),
                    h('div', { className: 'rd-layer-title' },
                      h('div', { className: 't' }, host.name, h('span', { className: 'rd-layer-badge' }, '机器层')),
                      h('div', { className: 's' },
                        connected ? h('span', { className: 'rd-live' }, '●', latency ? ' 已连接 · ' + latency : ' 已连接') : '未连接',
                        ' · 所有工作区共享',
                      ),
                    ),
                    h('div', { className: 'rd-layer-right' },
                      h('span', { className: 'rd-layer-switchlabel' }, '本机记忆'),
                      switchButton(machineOn, () => void setMachine(false), busy !== ''),
                    ),
                  ),
                  h('div', { className: 'rd-subhead' },
                    h('span', { className: 't' }, '机器信息'),
                    machineBrief ? h('span', { className: 'meta' }, '自动 · ' + (ago(machineBrief.generatedAt) || '已生成')) : h('span', { className: 'meta' }, '未生成'),
                  ),
                  machineFactRows.length > 0
                    ? facts(machineFactRows)
                    : h('div', { className: 'rd-blank' }, '还没有机器简报。点右上角「刷新简报」生成。'),
                  h('div', { className: 'rd-divider' }),
                  h('div', { className: 'rd-subhead' },
                    h('span', { className: 't' }, '机器笔记'),
                    h('span', { className: 'rd-count' }, String(activeNotesOf(machineNotes).length)),
                    h('div', { className: 'rd-subhead-right' },
                      h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => setEditor({ scope: 'machine', note: null }) },
                        h(Icon, { name: 'plus', size: 12 }), '添加机器笔记'),
                    ),
                  ),
                  h('div', { className: 'rd-notes' }, machineNoteList),
                  rawBlock('原始数据（存储内容）', machineBrief ? machineBrief.data : null),
                ),
                // ---------------------------------------------- 工作区层
                h('section', { className: 'rd-layer workspace' },
                  h('div', { className: 'rd-layer-head' },
                    h('span', { className: 'rd-layer-icon' }, h(Icon, { name: 'folder', size: 15 })),
                    h('div', { className: 'rd-layer-title' },
                      h('div', { className: 't' }, '工作区层', h('span', { className: 'rd-layer-badge' }, '只对当前工作区生效')),
                      h('div', { className: 's' }, '切换工作区会看到它自己的简报和笔记'),
                    ),
                    h('div', { className: 'rd-layer-right' },
                      hostWorkspaces.length === 0
                        ? h('span', { className: 'rd-layer-switchlabel' }, '这台机器还没有工作区')
                        : h('div', { className: 'rd-wschips' },
                            hostWorkspaces.map((row) => h('button', {
                              key: row.stub || row.path,
                              className: 'rd-wschip' + (row.path === path ? ' on' : ''),
                              onClick: () => setPath(row.path),
                            },
                            row.folder || row.title,
                            h('span', { className: 'n' }, String(counts[row.path] || 0)),
                            )),
                          ),
                    ),
                  ),
                  path ? h('div', { className: 'rd-pathline' }, h('span', null, '路径'), h('code', null, path)) : null,
                  !path
                    ? h('div', { className: 'rd-blank' }, '先在概览里把远端目录添加为工作区，才能生成工作区记忆。')
                    : h(React.Fragment, null,
                        h('div', { className: 'rd-subhead' },
                          h('span', { className: 't' }, '工作区信息'),
                          workspaceBrief ? h('span', { className: 'meta' }, '自动 · ' + (ago(workspaceBrief.generatedAt) || '已生成')) : h('span', { className: 'meta' }, '未生成'),
                        ),
                        workspaceFactRows.length > 0
                          ? facts(workspaceFactRows)
                          : h('div', { className: 'rd-blank' }, '还没有生成工作区简报。点右上角「刷新简报」生成。'),
                        h('div', { className: 'rd-divider' }),
                        h('div', { className: 'rd-subhead' },
                          h('span', { className: 't' }, '工作区笔记'),
                          h('span', { className: 'rd-count' }, String(activeNotesOf(workspaceNotes).length)),
                          h('div', { className: 'rd-subhead-right' },
                            h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => setEditor({ scope: 'workspace', note: null }) },
                              h(Icon, { name: 'plus', size: 12 }), '添加工作区笔记'),
                          ),
                        ),
                        h('div', { className: 'rd-notes' }, workspaceNoteList),
                        rawBlock('原始数据（存储内容）', workspaceBrief ? workspaceBrief.data : null),
                      ),
                ),
                h('details', { className: 'rd-inject' },
                  h('summary', null,
                    h(Icon, { name: 'wand', size: 13 }),
                    h('span', null, '本次会话注入'),
                    h('span', { className: 'rd-injectmeta' }, preview.bytes + ' B / ' + preview.limit + ' B'),
                  ),
                  h('pre', null, preview.text || '（无内容）'),
                ),
              ),
        editor
          ? h(NoteDialog, {
              scope: editor.scope,
              host,
              remotePath: path,
              workspaceName: currentName,
              note: editor.note,
              busy: busy === 'note',
              onClose: () => setEditor(null),
              onSave: (payload) => void saveNote(payload),
            })
          : null,
      )
    }

    function RemoteDeckSettings({ state }) {
      const [section, setSection] = React.useState('memory')
      const [settings, setSettings] = React.useState(null)
      const [notes, setNotes] = React.useState([])
      const [editor, setEditor] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const [settingsResult, pluginResult] = await Promise.all([
            call('/memory/settings'),
            call('/memory/plugin'),
          ])
          setSettings(settingsResult.settings)
          setNotes((pluginResult.notes || []).filter((note) => note.status === 'active'))
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const save = async (patch) => {
        setBusy('save')
        setError('')
        try {
          const result = await call('/memory/settings', { method: 'POST', body: patch })
          setSettings(result.settings)
          await refresh()
          pushInfo('已保存')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const saveBudget = async (kilobytes) => {
        await save({ injectBytes: kilobytes * 1024 })
      }

      const saveNote = async () => {
        if (!editor) return
        setBusy('note')
        setError('')
        try {
          await call('/memory/note', {
            method: 'POST',
            body: { scope: 'plugin', id: editor.id, text: editor.text, kind: editor.kind, tags: editor.tags, pinned: editor.pinned },
          })
          setEditor(null)
          await load()
          pushInfo('笔记已保存')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const archiveNote = async (id) => {
        setBusy('archive')
        try {
          await call('/memory/note/archive', { method: 'POST', body: { scope: 'plugin', id } })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const openEditor = (note) => {
        setEditor({
          id: note ? note.id : '',
          kind: note ? note.kind : 'fact',
          text: note ? note.text : '',
          tags: note ? note.tags.join(', ') : '',
          pinned: note ? note.pinned : false,
        })
      }

      const enabled = settings && settings.enabled === true
      const budgetKb = settings ? Math.round((settings.injectBytes || 2000) / 1024) : 2
      const switchButton = (on, onClick, disabled) => h('button', {
        className: 'rd-set-switch' + (on ? ' on' : ''),
        onClick,
        disabled,
        title: on ? '点击关闭' : '点击开启',
      }, h('span', null))

      const row = (title, description, control) => h('div', { className: 'rd-set-row' },
        h('div', null, h('div', { className: 'tt' }, title), h('div', { className: 'td' }, description)),
        h('div', { className: 'ctl' }, control),
      )

      const memory = h(React.Fragment, null,
        h('div', { className: 'rd-set-head' },
          h('div', { className: 't' }, '记忆'),
          h('div', { className: 's' }, '全局记忆开关与所有机器共享的采集、预算和插件级笔记。'),
        ),
        error ? h('div', { className: 'rd-set-error' }, error) : null,
        h('div', { className: 'rd-set-card' },
          row('全局记忆', '关闭后所有机器都不显示记忆页、不注入、不探测；已有数据保留。', switchButton(enabled, () => void save({ enabled: !enabled }), busy !== '' && busy !== 'note')),
          h('div', { className: 'rd-set-note' }, enabled ? '已开启。进入任一台机器的「记忆」tab，可以单独开启本机记忆。' : '默认关闭。开启后，机器页才会出现「记忆」tab。'),
        ),
        h('div', { className: 'rd-set-card' },
          h('div', { className: 'rd-set-cardhead' }, '注入预算'),
          h('div', { className: 'rd-set-desc' }, '每次请求最多注入多少环境摘要。数值越小越省 token；默认 2 KB。'),
          h('div', { className: 'rd-set-seg' },
            [1, 2, 3].map((kb) => h('button', {
              key: kb,
              className: 'rd-set-segbtn' + (budgetKb === kb ? ' on' : ''),
              disabled: busy !== '' || !settings,
              onClick: () => void saveBudget(kb),
            }, kb + ' KB')),
          ),
        ),
        h('div', { className: 'rd-set-card' },
          h('div', { className: 'rd-set-cardhead' }, '自动采集'),
          h('div', { className: 'rd-set-desc' }, enabled ? '全局开启时按以下方式采集；关闭全局后停止采集。' : '全局记忆关闭时不会采集；开启后按以下设置执行。'),
          row('机器信息', '系统、CPU、内存总量、工具版本；每天一次。不含磁盘/负载等实时状态。', switchButton(settings ? settings.machineProbe !== false : true, () => void save({ machineProbe: !(settings && settings.machineProbe !== false) }), busy !== '' || !enabled)),
          row('工作区信息', '子仓库、技术栈、构建命令；文件变化时重新扫描。不含分支/HEAD 等实时状态。', switchButton(settings ? settings.workspaceScan !== false : true, () => void save({ workspaceScan: !(settings && settings.workspaceScan !== false) }), busy !== '' || !enabled)),
        ),
        h('div', { className: 'rd-set-card' },
          h('div', { className: 'rd-set-cardhead' }, '插件级笔记',
            h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => openEditor() }, h(Icon, { name: 'plus', size: 12 }), '添加'),
          ),
          h('div', { className: 'rd-set-desc' }, '对所有远程会话生效；机器/工作区笔记仍在各自机器页。'),
          notes.length === 0
            ? h('div', { className: 'rd-set-empty' }, '还没有插件级笔记。')
            : notes.map((note) => h('div', { className: 'rd-set-noteitem', key: note.id },
                h('span', { className: 'rd-set-kind ' + note.kind }, NOTE_KIND_LABEL[note.kind] || note.kind),
                h('div', { className: 'body' },
                  h('div', { className: 'txt' }, note.text),
                  h('div', { className: 'sub' }, note.pinned ? '已固定 · ' : '', ago(note.updatedAt) || '刚刚'),
                ),
                h('div', { className: 'ops' },
                  h('button', { className: 'rd-set-icon', title: '编辑', onClick: () => openEditor(note) }, h(Icon, { name: 'edit', size: 12 })),
                  h('button', { className: 'rd-set-icon', title: '归档', onClick: () => void archiveNote(note.id) }, h(Icon, { name: 'trash', size: 12 })),
                ),
              )),
        ),
        h('div', { className: 'rd-set-card' },
          h('div', { className: 'rd-set-cardhead' }, '数据位置'),
          h('div', { className: 'rd-set-path' }, '<DSH_HOME>/remote-deck/memory'),
          h('div', { className: 'rd-set-desc' }, '只保存在本机；关闭开关或卸载插件都不会删除。'),
        ),
      )

      const diagnostics = h(React.Fragment, null,
        h('div', { className: 'rd-set-head' },
          h('div', { className: 't' }, '数据与诊断'),
          h('div', { className: 's' }, '远程开发插件的数据位置与当前版本。'),
        ),
        h('div', { className: 'rd-set-card' },
          row('插件版本', 'Host 与浏览器端应一致；升级后需完全退出 DSH 再打开。', h('span', { className: 'rd-set-value' }, state && state.build ? state.build : '—')),
          row('数据目录', '连接、工作区、转发与记忆都在这里；不会被远端仓库访问。', h('span', { className: 'rd-set-path' }, '<DSH_HOME>/remote-deck')),
          row('记忆目录', '记忆开关、笔记、简报缓存与历史。', h('span', { className: 'rd-set-path' }, '<DSH_HOME>/remote-deck/memory')),
        ),
        h('div', { className: 'rd-set-card' },
          h('div', { className: 'rd-set-cardhead' }, '后续'),
          h('div', { className: 'rd-set-desc' }, '这里会继续承载远程开发的全局设置，例如默认连接行为、外观与诊断；左侧会随功能增加分组。'),
        ),
      )

      return h('div', { className: 'rd-set' },
        h('aside', { className: 'rd-set-nav' },
          h('div', { className: 'rd-set-navtitle' }, '设置'),
          h('button', { className: 'rd-set-navitem' + (section === 'memory' ? ' on' : ''), onClick: () => setSection('memory') }, h(Icon, { name: 'sliders', size: 13 }), '记忆'),
          h('button', { className: 'rd-set-navitem' + (section === 'diagnostics' ? ' on' : ''), onClick: () => setSection('diagnostics') }, h(Icon, { name: 'server', size: 13 }), '数据与诊断'),
          h('div', { className: 'rd-set-navfoot' }, '远程开发'),
        ),
        h('section', { className: 'rd-set-main' }, section === 'memory' ? memory : diagnostics),
        editor
          ? h('div', { className: 'rd-mem2-overlay', onClick: () => setEditor(null) },
              h('div', { className: 'rd-mem2-modal', onClick: (event) => event.stopPropagation() },
                h('div', { className: 'rd-mem2-modalhead' },
                  h('div', null, h('div', { className: 't' }, editor.id ? '编辑插件笔记' : '添加插件笔记'), h('div', { className: 's' }, '对所有远程会话生效。')),
                  h('button', { className: 'rd-mem2-icon', onClick: () => setEditor(null) }, h(Icon, { name: 'x', size: 14 })),
                ),
                h('div', { className: 'rd-mem2-modalbody' },
                  h('div', { className: 'rd-mem2-formrow' },
                    h('span', null, '类型'),
                    h('select', { value: editor.kind, onChange: (event) => setEditor({ ...editor, kind: event.target.value }) },
                      Object.entries(NOTE_KIND_LABEL).map(([id, label]) => h('option', { key: id, value: id }, label)),
                    ),
                  ),
                  h('textarea', {
                    className: 'rd-mem2-textarea',
                    value: editor.text,
                    maxLength: 500,
                    placeholder: '所有远程会话都适用的事实或偏好。',
                    onChange: (event) => setEditor({ ...editor, text: event.target.value }),
                  }),
                  h('div', { className: 'rd-mem2-formrow' },
                    h('span', null, '标签'),
                    h('input', { className: 'rd-mem2-input', value: editor.tags, placeholder: 'build, preference', onChange: (event) => setEditor({ ...editor, tags: event.target.value }) }),
                    h('label', { className: 'rd-mem2-check' }, h('input', { type: 'checkbox', checked: editor.pinned, onChange: (event) => setEditor({ ...editor, pinned: event.target.checked }) }), '固定到简报'),
                  ),
                ),
                h('div', { className: 'rd-mem2-modalfoot' },
                  h('button', { className: 'rd-btn', onClick: () => setEditor(null), disabled: busy !== '' }, '取消'),
                  h('button', { className: 'rd-btn primary', onClick: () => void saveNote(), disabled: busy !== '' || editor.text.trim().length === 0 }, busy === 'note' ? '保存中…' : '保存'),
                ),
              ),
            )
          : null,
      )
    }

    function Console() {
      const state = useStore((s) => s.state)
      const ready = useStore((s) => s.ready)
      const view = useStore((s) => s.consoleView || 'console')
      const selectedId = useStore((s) => s.consoleHost)
      const busy = useStore((s) => s.busy)
      const tab = useStore((s) => s.consoleTab || 'overview')
      const memoryEnabled = useStore((s) => Boolean(s.state && s.state.memory && s.state.memory.enabled === true))
      const activeTab = tab === 'memory' && !memoryEnabled ? 'overview' : tab
      const [query, setQuery] = React.useState('')
      const quickPins = useStore((s) => s.quickPins || [])
      const [pinHint, setPinHint] = React.useState('')

      if (view === 'settings') {
        return h('div', { className: 'rd-console' },
          h('div', { className: 'rd-ctop' },
            h('button', { className: 'rd-btn ghost', onClick: () => { store.consoleView = 'console'; emit() } }, h(Icon, { name: 'arrowleft', size: 13 }), '返回'),
            h('span', { className: 't' }, '设置'),
            h('span', { className: 's' }, '远程开发'),
          ),
          h(RemoteDeckSettings, { state }),
        )
      }

      const connections = (state && state.connections) || []
      const workspaces = (state && state.workspaces) || []
      const connected = connections.filter((row) => row.status === 'connected')
      const host = connections.find((row) => row.id === selectedId) || connected[0] || connections[0]
      const filter = query.trim().toLowerCase()

      if (!ready) {
        return h('div', { className: 'rd-console' },
          h('div', { className: 'rd-ctop' }, h('span', { className: 't' }, '远程开发')),
          h('div', { style: { padding: 26 } }, h('div', { className: 'rd-empty' }, '正在加载远程连接…')),
        )
      }

      if (connections.length === 0) {
        return h('div', { className: 'rd-console' },
          h('div', { className: 'rd-ctop' }, h('span', { className: 't' }, '远程开发'), h('span', { className: 's' }, 'SSH 工作区'),
            h('div', { className: 'r' },
              h('button', { className: 'rd-btn', onClick: () => { store.consoleView = 'settings'; emit() } }, h(Icon, { name: 'sliders', size: 13 }), '设置'),
            ),
          ),
          h('div', { style: { padding: 26 } },
            h('div', { className: 'rd-empty' },
              h('div', { style: { fontSize: 13, color: 'inherit', marginBottom: 4 } }, '还没有连接任何机器'),
              '添加一台 SSH 主机后，它的目录就能作为工作区在这里打开。',
              h('div', null, h('button', { className: 'rd-btn primary', onClick: () => openHostDialog() }, h(Icon, { name: 'plus', size: 13 }), '添加机器')),
            ),
          ),
        )
      }

      const hostWorkspaces = workspaces.filter((row) => row.connectionId === host.id && (!filter || (row.folder + ' ' + row.path).toLowerCase().includes(filter)))
      const hostSessions = sessionsForHost(host.id).filter((row) => !filter || (row.summary.displayTitle || '').toLowerCase().includes(filter))
      const color = colorOf(host.color)
      const hostIssue = host.error ? friendlyError(host.error) : null

      const act = (action) => {
        void (async () => {
          store.busy = 'act:' + action
          store.notice = ''
          emit()
          try {
            await call('/connections/' + host.id + '/action', { method: 'POST', body: { action } })
            await refresh()
          } catch (failure) {
            store.notice = failure instanceof Error ? failure.message : String(failure)
          }
          store.busy = ''
          emit()
        })()
      }

      const editHost = () => {
        openHostDialog(host)
      }

      const openWorkspaceRow = (row) => {
        const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, row.stub))
        if (item === undefined) { store.notice = '这个工作区不在 DSH 注册表里'; emit(); return }
        store.consoleHost = host.id
        const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
        if (ui) ui.openWorkspace(item.workspaceId)
      }

      const openSessionRow = (summary) => {
        const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
        if (ui) ui.openSession(summary.id)
      }

      const rail = (rows, label) => rows.length === 0 ? null : h(React.Fragment, null,
        h('div', { className: 'rh2' }, label, label === '已连接'
          ? h('span', { className: 'add2', title: '添加机器', onClick: () => openHostDialog() }, h(Icon, { name: 'plus', size: 12 }))
          : null),
        rows.map((row) => h('div', {
          key: row.id,
          className: 'rd-host2',
          'data-active': String(host.id === row.id),
          onClick: () => { store.consoleHost = row.id; emit() },
        },
          h('span', { className: 'ico2', style: { background: colorOf(row.color) } }, h(Icon, { name: 'server', size: 14 })),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'nm2' }, row.name),
            h('div', { className: 'meta2' }, row.username + '@' + row.host),
          ),
          h('div', { className: 'rt2' },
            h(Dot, { state: row.status }),
            row.status === 'connected' && row.latencyMs ? h('span', { className: 'lat2' }, row.latencyMs + 'ms') : null,
            h('span', {
              className: 'rd-qpin' + (quickPins.includes(row.id) ? ' on' : ''),
              title: quickPins.includes(row.id) ? '取消固定到快捷面板' : '固定到快捷面板（最多 3 台）',
              onClick: (event) => {
                event.stopPropagation()
                const result = toggleQuickPin(row.id)
                if (result.max) {
                  setPinHint('快捷面板最多固定 3 台，请先取消一台')
                  setTimeout(() => setPinHint(''), 2600)
                }
              },
            }, '★'),
          ),
        )),
      )

      return h('div', { className: 'rd-console' },
        h('div', { className: 'rd-ctop' },
          h('span', { className: 't' }, '远程开发'),
          h('span', { className: 's' }, connected.length + ' 台在线 · ' + workspaces.length + ' 个工作区'),
          h('div', { className: 'r' },
            h('label', { className: 'rd-csearch' },
              h(Icon, { name: 'search', size: 13 }),
              h('input', { value: query, placeholder: '搜索机器、工作区…', onChange: (event) => setQuery(event.target.value) }),
            ),
            h('button', { className: 'rd-btn', onClick: () => { store.consoleView = 'settings'; emit() } },
              h(Icon, { name: 'sliders', size: 13 }), '设置'),
            h('button', { className: 'rd-btn primary', onClick: () => openHostDialog() },
              h(Icon, { name: 'plus', size: 13 }), '添加机器'),
          ),
        ),
        h('div', { className: 'rd-cbody' },
          h('aside', { className: 'rd-rail2' },
            pinHint ? h('div', { className: 'rd-pinhint' }, pinHint) : null,
            rail(connected.filter((row) => !filter || (row.name + ' ' + row.host + ' ' + row.username).toLowerCase().includes(filter)), '已连接'),
            connected.length > 0 ? h('div', { className: 'sep2' }) : null,
            rail(connections.filter((row) => row.status !== 'connected').filter((row) => !filter || (row.name + ' ' + row.host + ' ' + row.username).toLowerCase().includes(filter)), '未连接'),
            h('div', { className: 'railfoot2' },
              h('div', null, 'Data: <DSH_HOME>/remote-deck'),
              h('div', null, 'Host ' + (state ? state.build : '')),
            ),
          ),
          h('section', { className: 'rd-cpane' },
            h('div', { className: 'rd-tabs' },
              [['overview', '概览'], ...(memoryEnabled ? [['memory', '记忆']] : []), ['terminal', '终端'], ['files', '文件'], ['ports', '端口转发']].map(([id, label]) => h('button', {
                key: id,
                className: 'rd-tab' + (activeTab === id ? ' on' : ''),
                onClick: () => { store.consoleTab = id; emit() },
              }, label)),
            ),
            activeTab === 'memory' ? null : h('div', { className: 'rd-status' + (hostIssue ? ' bad' : '') },
              h(Dot, { state: hostIssue ? 'error' : host.status }),
              h('span', { className: 't', title: hostIssue ? (hostIssue.title + ' — ' + hostIssue.hint) : '' },
                hostIssue ? hostIssue.title : (host.status === 'connected' ? '连接正常' : '未连接')),
            ),
            activeTab === 'overview' ? null : (activeTab === 'terminal' ? h(TerminalPanel, { host }) : activeTab === 'files' ? h(FilePanel, { host }) : activeTab === 'memory' ? h(MemoryPanel, { host, hostWorkspaces }) : h(PortsPanel, { host })),
            h('div', { className: 'rd-overview', style: { display: activeTab === 'overview' ? 'contents' : 'none' } },
            h('div', { className: 'rd-chead' },
              h('span', { className: 'rd-cavatar', style: { background: color } }, h(Icon, { name: 'server', size: 24 })),
              h('div', null,
                h('div', { className: 'rd-ctitle' }, host.name,
                  h('span', { className: 'rd-pill', style: { cursor: 'default', height: 22, fontSize: 10.5 } },
                    h(Dot, { state: host.status }),
                    host.status === 'connected' ? '已连接' : host.status === 'connecting' ? '连接中' : host.status === 'error' ? '连接失败' : '未连接',
                  ),
                ),
                h('div', { className: 'rd-cmeta' },
                  h('span', { className: 'mono' }, host.username + '@' + host.host + ':' + host.port),
                  h('span', null, '·'),
                  h('span', null, host.authType === 'password' ? '密码认证' : '密钥 ' + (host.privateKeyPath ? host.privateKeyPath.split(/[\\/]/).pop() : '')),
                  host.sys ? h('span', null, '·') : null,
                  host.sys ? h('span', null, host.sys.os + ' ' + shortKernel(host.sys.kernel)) : null,
                ),
              ),
              h('div', { className: 'acts' },
                h('button', { className: 'rd-btn', onClick: () => { store.consoleTab = 'terminal'; emit() } }, h(Icon, { name: 'term', size: 13 }), '终端'),
                h('button', { className: 'rd-btn', onClick: () => { store.consoleTab = 'ports'; emit() } }, h(Icon, { name: 'link', size: 13 }), '端口'),
                h('button', {
                  className: 'rd-btn',
                  title: host.autoConnect ? '启动 DSH 时自动连接：已开启' : '启动 DSH 时自动连接：已关闭',
                  onClick: () => void setAutoConnect(host.id, !host.autoConnect),
                }, h(Icon, { name: 'bolt', size: 13 }), '自动连接：' + (host.autoConnect ? '开' : '关')),
                host.status === 'connected'
                  ? h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => act('reconnect') }, h(Icon, { name: 'refresh', size: 13 }), '重连')
                  : null,
                h('button', {
                  className: 'rd-btn',
                  disabled: busy !== '',
                  onClick: () => act(host.status === 'connected' ? 'disconnect' : 'connect'),
                }, host.status === 'connected' ? '断开' : '连接'),
                h('button', { className: 'rd-btn', onClick: editHost }, h(Icon, { name: 'edit', size: 13 }), '编辑'),
              ),
            ),

            h('div', { className: 'rd-stats' },
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '工作区'), h('div', { className: 'v' }, String(hostWorkspaces.length))),
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '会话'), h('div', { className: 'v' }, String(hostSessions.length))),
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '端口转发'), h('div', { className: 'v' }, String(((state && state.forwards) || []).filter((row) => row.connectionId === host.id).length), h('small', null, '运行中'))),
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '往返延迟'), h('div', { className: 'v' }, host.latencyMs ? String(host.latencyMs) : '—', h('small', null, 'ms'))),
            ),

            h('div', { className: 'rd-csect' },
              h('span', { className: 'st2' }, '工作区'),
              h('span', { className: 'ct2' }, hostWorkspaces.length + ' 个'),
              h('span', { className: 'rt2' },
                h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => void refresh() }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
                h('button', { className: 'rd-btn sm primary', onClick: () => startBrowserFromConsole(host) }, h(Icon, { name: 'plus', size: 12 }), '新建工作区'),
              ),
            ),

            hostWorkspaces.length === 0
              ? h('div', { className: 'rd-empty' }, '这台机器还没有工作区。', h('div', null,
                h('button', { className: 'rd-btn primary', onClick: () => startBrowserFromConsole(host) }, h(Icon, { name: 'plus', size: 13 }), '在远程目录中新建')))
              : h('div', { className: 'rd-cards' },
                hostWorkspaces.map((row) => {
                  const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, row.stub))
                  const count = hostSessions.filter((entry) => entry.remote.stub === row.stub).length
                  return h('div', { key: row.stub, className: 'rd-card', onClick: () => openWorkspaceRow(row) },
                    h('span', { className: 'stripe2', style: { background: colorOf(row.color) } }),
                    h('div', { className: 'top2' },
                      h(Icon, { name: 'folder', size: 13, style: { color: colorOf(row.color) } }),
                      h('span', { className: 'nm3' }, row.folder || row.title),
                      item === undefined ? h('span', { className: 'pill', style: { fontSize: 9.5, height: 18, marginLeft: 'auto', padding: '0 5px' } }, '未注册') : null,
                    ),
                    h('div', { className: 'path2' }, row.path),
                    h('div', { className: 'foot2' },
                      h('span', null, count + ' 个会话'),
                      h('span', null, '·'),
                      h('span', null, ago(item && item.updatedAt) || '未使用'),
                      h('span', { className: 'go2' }, '打开 ›'),
                    ),
                  )
                }),
                h('div', { className: 'rd-card add2', onClick: () => startBrowserFromConsole(host) },
                  h(Icon, { name: 'plus', size: 14 }), '从远程目录新建工作区'),
              ),

            h('div', { className: 'rd-csect' },
              h('span', { className: 'st2' }, '最近会话'),
              h('span', { className: 'ct2' }, hostSessions.length + ' 个 · 按更新时间'),
            ),
            hostSessions.length === 0
              ? h('div', { className: 'rd-hint' }, '这台机器上还没有会话。')
              : h('div', null,
                hostSessions.slice(0, 6).map((row) => h('div', { key: row.summary.id, className: 'rd-sess', onClick: () => openSessionRow(row.summary) },
                  h('span', { className: 'rd-badge', style: { background: colorOf(row.remote.color), width: 18, height: 18 } }, h(Icon, { name: 'term', size: 10 })),
                  h('span', { className: 't2' }, row.summary.title || row.summary.displayTitle || '未命名会话'),
                  h('span', { className: 'tag2' }, row.remote.folder),
                  h('span', { className: 'm2' }, ago(row.summary.updatedAt)),
                )),
              ),

            ),
          ),
        ),
        h(ToastStack),
      )
    }

    function startBrowserFromConsole(host) {
      void openWorkspaceDialog(host.id)
    }

    // ---------------------------------------------------------------- shared actions

    async function setAutoConnect(id, enabled) {
      try {
        await call('/connections/' + id + '/auto-connect', { method: 'POST', body: { enabled } })
        await refresh()
      } catch (failure) {
        store.notice = failure instanceof Error ? failure.message : String(failure)
        emit()
      }
    }

    function openConsole(hostId, tabId) {
      if (hostId) store.consoleHost = hostId
      if (tabId) store.consoleTab = tabId
      store.open = false
      emit()
      try {
        const layout = ctxRef ? ctxRef.get('layout') : undefined
        if (layout) layout.selectPanel('remote-deck')
      } catch {
        /* layout is optional */
      }
    }

    // ---------------------------------------------------------------- identity

    function useRemote(sessionId) {
      return useStore(() => remoteForSession(sessionId))
    }

    function SessionHoverExtra({ sessionId }) {
      const remote = useRemote(sessionId)
      if (!remote) return null
      const host = (store.state && store.state.connections || []).find((row) => row.id === remote.connectionId)
      return h('div', { className: 'rd-hover' },
        h(Dot, { state: host ? host.status : 'disconnected' }),
        h('span', null, remote.host),
        h('span', { style: { opacity: 0.5 } }, '·'),
        h('span', {
          style: {
            fontFamily: 'ui-monospace,Consolas,monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 150,
          },
          title: remote.path,
        }, remote.path),
      )
    }

    // ---------------------------------------------------------------- preview download

    function PreviewDownloadAction(props) {
      const remote = useRemote(props.sessionId)
      const [downloadStatus, setDownloadStatus] = React.useState('')
      if (!remote || !props.absolutePath) return null
      const target = String(props.absolutePath)
      const info = boot()
      if (info === null) return null
      const download = async () => {
        if (downloadStatus === '选择位置…') return
        const href = downloadUrlFor(remote.connectionId, target)
        if (href.length === 0) return
        const name = downloadNameFor(target)
        setDownloadStatus('选择位置…')
        showDownloadToast('请选择保存位置：' + name)
        try {
          const result = await saveDownload(href, name)
          if (result && result.status === 'saved') {
            setDownloadStatus('已保存到本机')
            showDownloadToast('已保存到 ' + result.path)
          } else if (result && result.status === 'cancelled') {
            setDownloadStatus('已取消保存')
            showDownloadToast('已取消保存')
          } else {
            setDownloadStatus('已开始下载')
            showDownloadToast('已开始下载 ' + name)
          }
        } catch (failure) {
          setDownloadStatus('下载失败')
          showDownloadToast('下载失败：' + (failure instanceof Error ? failure.message : String(failure)), 'error')
        }
      }
      return h('button', {
        type: 'button',
        className: 'rd-dl',
        title: downloadStatus || ('下载到本机：' + target),
        'aria-label': '下载到本机',
        disabled: downloadStatus === '选择位置…',
        onClick: () => void download(),
      }, h(Icon, { name: 'download', size: 16 }))
    }

    function DeliverableDownloadAction(props) {
      const remote = useRemote(props.sessionId)
      const wrapRef = React.useRef(null)
      const [downloadStatus, setDownloadStatus] = React.useState('')
      if (!remote) return null
      const resolveTarget = () => {
        const card = wrapRef.current && wrapRef.current.closest ? wrapRef.current.closest('[data-presented-file]') : null
        if (card === null) return ''
        const button = card.querySelector('button[title]')
        const title = button === null ? '' : button.getAttribute('title') || ''
        if (title.startsWith('/')) return title
        const stub = remote.stub || ''
        if (stub.length > 0 && (title === stub || title.startsWith(stub + '\\') || title.startsWith(stub + '/'))) {
          const rest = title.slice(stub.length).replace(/\\/g, '/')
          return (remote.path || '').replace(/\/$/, '') + rest
        }
        if (isLocalAbsolute(title)) return title
        const label = button === null ? '' : button.getAttribute('aria-label') || ''
        const match = label.match(/\/[^\s"']+/)
        return match === null ? '' : match[0]
      }
      const download = async () => {
        if (downloadStatus === '选择位置…') return
        const target = resolveTarget()
        if (target.length === 0) return
        const info = boot()
        if (info === null) return
        const href = downloadUrlFor(remote.connectionId, target)
        if (href.length === 0) return
        const name = downloadNameFor(target)
        setDownloadStatus('选择位置…')
        showDownloadToast('请选择保存位置：' + name)
        try {
          const result = await saveDownload(href, name)
          if (result && result.status === 'saved') {
            setDownloadStatus('已保存到本机')
            showDownloadToast('已保存到 ' + result.path)
          } else if (result && result.status === 'cancelled') {
            setDownloadStatus('已取消保存')
            showDownloadToast('已取消保存')
          } else {
            setDownloadStatus('已开始下载')
            showDownloadToast('已开始下载 ' + name)
          }
        } catch (failure) {
          setDownloadStatus('下载失败')
          showDownloadToast('下载失败：' + (failure instanceof Error ? failure.message : String(failure)), 'error')
        }
      }
      return h('span', { ref: wrapRef, className: 'rd-dl-wrap' },
        h('button', {
          type: 'button',
          className: 'rd-dl',
          title: downloadStatus || '下载到本机',
          'aria-label': '下载到本机',
          disabled: downloadStatus === '选择位置…',
          onClick: () => void download(),
        }, h(Icon, { name: 'download', size: 16 })),
      )
    }

    // ---------------------------------------------------------------- failed-send recovery

    const recoveryStore = new Map()
    const recoverySubs = new Set()

    function notifyRecovery() {
      for (const handler of recoverySubs) handler()
    }

    function setRecovery(sessionId, value) {
      if (value) recoveryStore.set(sessionId, value)
      else recoveryStore.delete(sessionId)
      notifyRecovery()
    }

    function useRecovery(sessionId) {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        recoverySubs.add(force)
        return () => { recoverySubs.delete(force) }
      }, [])
      return recoveryStore.get(sessionId) || null
    }

    function restoreRecovery(sessionId, inputActions) {
      const entry = recoveryStore.get(sessionId)
      if (!entry) return false
      try {
        if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(entry.text)
        const ids = (entry.attachments || [])
          .map((item) => (typeof item === 'string' ? item : item && (item.id || item.attachmentId)))
          .filter(Boolean)
        if (ids.length > 0 && inputActions && typeof inputActions.addAttachments === 'function') inputActions.addAttachments(ids)
      } catch {
        return false
      }
      setRecovery(sessionId, null)
      return true
    }

    function RecoveryDock(props) {
      const { sessionId } = props
      const remote = useRemote(sessionId)
      const pendingRef = React.useRef(null)
      const lastDraftRef = React.useRef(null)
      const recovery = useRecovery(sessionId)
      const input = typeof props.useInput === 'function' ? props.useInput((value) => value) : null
      const draftValue = input === null ? null : (input.text !== undefined ? input.text : input.draft)
      const inputText = typeof draftValue === 'string' ? draftValue : draftValue && typeof draftValue.text === 'string' ? draftValue.text : ''
      const inputAttachments = input && Array.isArray(input.attachmentIds)
        ? input.attachmentIds
        : input && Array.isArray(input.attachments) ? input.attachments : []
      if (inputText.trim().length > 0) lastDraftRef.current = { text: inputText, attachments: inputAttachments }
      const session = typeof props.useSession === 'function' ? props.useSession((value) => value) : null
      const pending = session && Array.isArray(session.pendingSubmissions) ? session.pendingSubmissions : []
      if (pending.length > 0) {
        const last = pending[pending.length - 1]
        if (last && typeof last.text === 'string' && last.text.trim().length > 0) pendingRef.current = last
      }
      const promptError = session && session.promptError ? session.promptError : null
      const errorText = promptError ? (promptError.message || String(promptError)) : ''
      React.useEffect(() => {
        if (!remote) {
          if (recovery) setRecovery(sessionId, null)
          return
        }
        const source = pendingRef.current || lastDraftRef.current
        if (promptError && source) {
          setRecovery(sessionId, {
            text: source.text,
            attachments: source.attachments || [],
            error: errorText,
          })
        } else if (recovery) {
          setRecovery(sessionId, null)
          pendingRef.current = null
          lastDraftRef.current = null
        }
      }, [sessionId, remote, promptError, errorText])
      try {
        window.__RD_RECOVERY_DEBUG__ = {
          sessionId,
          hasSession: session !== null,
          pending: pending.length,
          inputKeys: input === null ? null : Object.keys(input),
          draftType: input === null ? null : typeof input.draft,
          attachmentIds: input && Array.isArray(input.attachmentIds) ? input.attachmentIds.length : null,
          remoteFound: remote !== null,
          cwd: session && typeof session.cwd === 'string' ? session.cwd.slice(-70) : null,
          error: errorText,
          active: recovery !== null,
        }
      } catch { /* debug only */ }
      if (!remote || !recovery) return null
      const attachmentCount = (recovery.attachments || []).length
      return h('div', { className: 'rd-recover' },
        h('div', { className: 'rt' }, '⚠ 上一条消息发送失败'),
        h('div', { className: 'rtext' }, recovery.text),
        attachmentCount > 0
          ? h('div', { className: 'rchips' },
            h('span', { className: 'rd-chip' }, '附件 ' + attachmentCount + ' 个'),
            h('span', { className: 'rd-chip' }, '会一并恢复'))
          : null,
        h('div', { className: 'ractions' },
          h('button', {
            className: 'rd-rbtn primary',
            onClick: () => {
              restoreRecovery(sessionId, props.inputActions)
              pendingRef.current = null
              lastDraftRef.current = null
            },
          }, '恢复消息'),
          h('button', {
            className: 'rd-rbtn ghost',
            onClick: () => setRecovery(sessionId, null),
          }, '忽略'),
        ),
        h('div', { className: 'rhint' }, '只在当前会话显示；恢复后文档引用可能需重新 @ 添加'),
      )
    }

    function HeaderPill(props) {
      const { sessionId } = props
      const remote = useRemote(sessionId)
      const recovery = useRecovery(sessionId)
      if (!remote) return null
      const host = (store.state && store.state.connections || []).find((row) => row.id === remote.connectionId)
      const status = host ? host.status : 'disconnected'
      const open = () => {
        openConsole(remote.connectionId)
      }
      return h('span', { className: 'rd-pill', onClick: open, title: remote.path },
        h(Dot, { state: status }),
        h(Icon, { name: 'server', size: 12 }),
        h('span', null, remote.host + ' · ' + (remote.folder || remote.title)),
        h(Icon, { name: 'chev', size: 11 }),
        recovery
          ? h('button', {
            className: 'rd-pill-restore',
            title: '恢复上一条发送失败的消息',
            onClick: (event) => { event.stopPropagation(); restoreRecovery(sessionId, props.inputActions) },
          }, '恢复')
          : null,
      )
    }

    // ---------------------------------------------------------------- apply

    function apply(ctx) {
      ctxRef = ctx
      ensureStyle()
      try {
        const debugInfo = globalThis.__DSH_REMOTE_DECK__
        if (debugInfo !== null && typeof debugInfo === 'object' && debugInfo.debug === true) {
          // Debug/screenshot affordances only when the host was started with
          // DSH_REMOTE_DECK_DEBUG=1; they are not exposed in normal sessions.
          window.__RD_STORE__ = store
          window.__RD_OPEN_SESSION__ = (id) => {
            const ui = ctx.get('uiWorkspace')
            if (ui) ui.openSession(id)
          }
          window.__RD_OPEN_CONSOLE__ = () => openConsole()
          window.__RD_CTX__ = ctx
          window.__RD_WS_STATUS__ = {
            get css() {
              return workspaceStatusCss
            },
            sync: syncWorkspaceStatusStyles,
          }
        }
      } catch {
        /* not a page context */
      }

      const start = () => {
        readClientServices(ctx)
        void refresh()
        const syncTheme = () => {
          try {
            const themeService = ctx.get('theme')
            const snapshot = themeService && themeService.getTheme ? themeService.getTheme() : null
            const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : ''
            if (scheme) document.documentElement.setAttribute('data-rd-theme', scheme)
          } catch {
            /* theme service is optional */
          }
        }
        syncTheme()
        const themeTimer = setInterval(syncTheme, 1500)
        let unsubWorkspaces = null
        let unsubSessions = null
        const bind = () => {
          try {
            const workspaces = ctx.get('workspaces')
            const sessions = ctx.get('sessions')
            if (unsubWorkspaces === null && workspaces && workspaces.list && typeof workspaces.list.subscribe === 'function') {
              unsubWorkspaces = workspaces.list.subscribe(() => readClientServices(ctx))
            }
            if (unsubSessions === null && sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
              unsubSessions = sessions.list.subscribe(() => readClientServices(ctx))
            }
            readClientServices(ctx)
          } catch {
            /* services appear after boot */
          }
        }
        bind()
        const onVisible = () => {
          if (document.visibilityState !== 'hidden') void refresh()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onVisible)
        let refreshing = false
        const timer = setInterval(() => {
          if (refreshing || document.visibilityState === 'hidden') return
          refreshing = true
          void refresh().finally(() => { refreshing = false })
        }, 8000)
        const bindTimer = setInterval(() => {
          bind()
          if (unsubWorkspaces !== null && unsubSessions !== null) clearInterval(bindTimer)
        }, 1000)
        const retry = setInterval(() => {
          if (!store.ready && boot() !== null) void refresh()
        }, 3000)
        return () => {
          clearInterval(timer)
          clearInterval(bindTimer)
          clearInterval(retry)
          clearInterval(themeTimer)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', onVisible)
          if (unsubWorkspaces !== null) unsubWorkspaces()
          if (unsubSessions !== null) unsubSessions()
        }
      }
      const stop = start()
      ctx.effect(() => () => stop(), 'remote-deck: client store')

      const offs = []
      offs.push(ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'remote-deck', order: 20 }, Chip),
      ))
      offs.push(ctx.slots.inject('sidebar.session.row.hover', () =>
        ctx.slots.register({ name: 'sidebar.session.row.hover', id: 'remote-deck-hover', order: 5 }, SessionHoverExtra),
      ))
      offs.push(ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'remote-deck-recovery', order: 20 }, RecoveryDock),
      ))
      offs.push(ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'remote-deck-pill', order: -20 }, HeaderPill),
      ))
      offs.push(ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: 'remote-deck', order: 5, label: '远程开发' }, ConsoleIcon),
      ))
      offs.push(ctx.slots.inject('deliverables.file.actions', () =>
        ctx.slots.register({ name: 'deliverables.file.actions', id: 'remote-deck-download', order: 20 }, DeliverableDownloadAction),
      ))
      offs.push(ctx.slots.inject('deliverables.review.file.actions', () =>
        ctx.slots.register({ name: 'deliverables.review.file.actions', id: 'remote-deck-download', order: 20 }, DeliverableDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'remote-deck-download', order: 20 }, PreviewDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document.unpreviewable', id: 'remote-deck-download', order: 20 }, PreviewDownloadAction),
      ))
      offs.push(ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'remote-deck' }, Console),
      ))
      ctx.effect(() => () => {
        for (const off of offs) off()
      }, 'remote-deck: slots')

      ctx.effect(() => () => {
        const node = document.querySelector('style[data-remote-deck]')
        if (node) node.remove()
        const statusNode = document.querySelector('style[' + WORKSPACE_STATUS_STYLE_ATTR + ']')
        if (statusNode) statusNode.remove()
        workspaceStatusCss = ''
      }, 'remote-deck: styles')
    }

    return { inject: ['slots'], apply }
  },
})
