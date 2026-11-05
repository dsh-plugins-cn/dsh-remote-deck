/* Shared faux-DSH chrome for the v2 mockups: icon sprite + sidebar.
   The sidebar mirrors the shipped light UI (274px, 13px text) so mockups are
   read as product screens; the remote-specific marks are what we are designing. */
(function () {
  const SPRITE = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="i-server" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-msg" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/></symbol>
  <symbol id="i-plug" viewBox="0 0 24 24"><path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/></symbol>
  <symbol id="i-wand" viewBox="0 0 24 24"><path d="M15 4V2M15 10V8M10 6h2M18 6h2M4 20l10-10 2 2-10 10z"/></symbol>
  <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></symbol>
  <symbol id="i-sort" viewBox="0 0 24 24"><path d="M4 7h10M4 12h7M4 17h4M18 5v14M15 16l3 3 3-3"/></symbol>
  <symbol id="i-newfolder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v3"/><path d="M3 9v8a2 2 0 0 0 2 2h8"/><path d="M18 14v6M15 17h6"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
  <symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/></symbol>
  <symbol id="i-collapse" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></symbol>
  <symbol id="i-chevdown" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
  <symbol id="i-chevright" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
  <symbol id="i-arrowleft" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></symbol>
  <symbol id="i-arrowup" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></symbol>
  <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z"/></symbol>
  <symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
  <symbol id="i-term" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1"/></symbol>
  <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></symbol>
  <symbol id="i-cpu" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/></symbol>
  <symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></symbol>
  <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
  <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></symbol>
</defs></svg>`;

  const HOSTS = {
    blue: { cls: 'blue', mark: 'blue' },
    teal: { cls: 'teal', mark: 'teal' },
    violet: { cls: 'violet', mark: 'violet' },
  };

  function icon(name, cls) {
    return `<svg class="i ${cls || ''}"><use href="#i-${name}"/></svg>`;
  }

  function sessionRow(row) {
    const active = document.body.dataset.active === row.id;
    let mark;
    if (row.host) mark = `<span class="mark"><span class="hostmark ${row.host}">${icon('term')}</span></span>`;
    else if (row.state === 'dot') mark = `<span class="mark"><span class="dot"></span></span>`;
    else mark = `<span class="mark"></span>`;
    return `<div class="session ${active ? 'active' : ''}">
      ${mark}<span class="txt">${row.title}</span>${row.time ? `<span class="time">${row.time}</span>` : ''}
    </div>`;
  }

  function workspaceBlock(ws) {
    return `<div class="wsblock">
      <div class="wsrow ${ws.remote ? 'remote' : ''}">
        <span class="folder">${icon('folder')}</span>
        <span class="title">${ws.title}</span>
      </div>
      ${ws.sessions.map(sessionRow).join('')}
    </div>`;
  }

  function buildSidebar() {
    const connected = (document.body.dataset.connected || 'dev-box').split(',').filter(Boolean);
    const chipOn = connected.length > 0;
    const chipLabel = connected.length === 1 ? connected[0] : `${connected.length} 台在线`;
    const workspaces = [
      {
        title: 'dev-box · demo-app', remote: true,
        sessions: [
          { id: 'ssh-pool', title: '重构 SSH 连接池', host: 'blue' },
          { id: 'delete-fix', title: '修复工作区删除', host: 'blue' },
          { id: 'bench', title: '连接耗时基线', host: 'blue' },
        ],
      },
      {
        title: 'build-box · inference-api', remote: true,
        sessions: [{ id: 'vllm', title: '调优 vLLM 启动参数', host: 'teal' }],
      },
      {
        title: 'Deepseek Harness', remote: false,
        sessions: [{ id: 'env', title: '环境设置', state: 'dot' }],
      },
    ];
    return `<div class="brand">
        <span class="logo">DS</span><span class="name">deepseek</span><span class="tag">HARNESS</span>
        <span class="collapse">${icon('collapse')}</span>
      </div>
      <div class="newchat">${icon('plus', 'sm')} 新会话</div>
      <div class="navrow">${icon('plug')} 插件</div>
      <div class="navrow">${icon('wand')} 自动化任务</div>
      <div class="navrow">${icon('more')} 更多</div>
      <div class="wshead">工作区
        <span class="tools">${icon('search', 'sm')}${icon('sort', 'sm')}${icon('newfolder', 'sm')}</span>
      </div>
      ${workspaces.map(workspaceBlock).join('')}
      <div class="sidefoot">
        <span class="chip ${chipOn ? 'on' : ''}">
          <span class="hdot ${chipOn ? 'ok' : 'idle'}"></span>
          <span>SSH</span><span class="lat">${chipOn ? connected[0] : ''}</span>
          ${icon('chevdown', 'xs caret')}
        </span>
        <span class="iconbtn">${icon('gear')}</span>
      </div>`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const host = document.createElement('div');
    host.innerHTML = SPRITE;
    document.body.prepend(host.firstElementChild);
    const side = document.getElementById('side');
    if (side) side.innerHTML = buildSidebar();
  });
})();
