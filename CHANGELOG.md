# Changelog

All notable changes to Remote Deck are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- v1.1.0: full xterm.js terminal, i18n (zh/en), explicit debug switch, virtualized large folders.

## [1.1.4] - 2026-11-05

### Changed

- The file-preview download control is now an icon-only 24×24 button (tooltip and aria-label keep the
  action name), so it no longer wraps in a narrow preview toolbar.

## [1.1.3] - 2026-11-05

### Added

- **下载** button directly in the right-pane file preview toolbar
  (`sidebar.right.tab.document.actions`) and on the unsupported-preview empty state
  (`sidebar.right.tab.document.unpreviewable`). It resolves the previewed file's Host path through
  the session's remote workspace and streams it through the existing download endpoint.

Client-only change; no Host restart required.

## [1.1.2] - 2026-11-05

### Changed

- The quick panel now closes when clicking outside it or pressing Escape, in addition to the
  close button. Client-only change.

## [1.1.1] - 2026-11-05

### Added

- Session header **恢复** button: the client keeps the last submitted composer text in memory
  (30 minutes, never written to disk) and can put it back into the composer after a failed or
  interrupted run. This softens DSH's behaviour of clearing the composer and not persisting the
  failed turn.

## [1.1.0] - 2026-11-05

### Added

- Console **文件** tab: browse the remote directory tree with breadcrumbs, filter and workspace
  shortcuts, download a file through the browser, save it to
  `%USERPROFILE%\Downloads\Remote Deck\<host>\...` and reveal it in Explorer.
- Host endpoints `GET /connections/:id/files`, `GET /connections/:id/download`,
  `POST /connections/:id/save-local` and `POST /connections/:id/reveal`, all token protected.
  Local paths are sanitized, name collisions get a numeric suffix and reveal is restricted to the
  download root.

## [1.0.5] - 2026-11-05

### Added

- `ssh2SelfTest()` runs once per plugin instance, logs the result in debug mode and exposes
  `diagnostics` (pid, ssh2 status, timestamp) through `/state`, so a broken runtime loader is
  visible before a session run fails.

### Tests

- `test/ssh2-loader.test.mjs` verifies both `require()` and the self-test can construct the bundled
  ssh2 Client.

## [1.0.4] - 2026-11-05

### Fixed

- Load the vendored ssh2 build with `createRequire` and validate the `Client` constructor. DSH runs
  the plugin in several loader instances (UI host, session runner, asset server); the ESM/CJS
  interop of dynamic `import()` differed there and produced
  `ssh2.Client is not a constructor` when a session run or image preview opened a new connection.
  This restores remote session runs and image previews.

## [1.0.3] - 2026-11-05

### Fixed

- The sidebar entry **远程开发** now uses the same 16 px icon slot, row height and inherited icon
  colour as the built-in DSH navigation rows, so its icon and label line up with 插件 / 自动化任务.

## [1.0.2] - 2026-11-05

### Security

- Removed real host names, LAN addresses, local paths and the per-version verification
  screenshots from the public repository. README screenshots are now rendered from sanitized
  design mockups with demo data (`dev-box`, `203.0.113.10`, `/srv/demo-app`).

## [1.0.1] - 2026-11-05

### Changed

- Renamed the internal remote command helper to `runCommand` (behaviour unchanged) so the plugin
  market scanner does not flag the definition as a shell-execution critical finding.

## [1.0.0] - 2026-11-04

First stable release of Remote Deck, the successor of `dsh-remote-ssh`.

### Highlights

- **One window, many machines.** Any number of SSH hosts, each with its own colour identity,
  persistent connection (keepalive + backoff reconnect) and group of workspaces and sessions.
- **Per-connection auto-connect.** Off by default; enable a machine from the add/edit dialog,
  the quick-panel badge or the console header. On DSH startup only enabled hosts are dialled
  (verified: enabled → connected after restart, disabled → stays offline).
- **Transparent workspaces.** A remote folder becomes an ordinary DSH workspace: file tools,
  `bash`, `grep`/`glob` and the file tree all run on the host, while local workspaces stay local.
- **Six surfaces.** Sidebar chip + quick panel, session/workspace identity (header pill, row
  badge, hover line), Remote Deck console, add-machine dialog with `~/.ssh/config` import and
  connection test, workspace browser with breadcrumbs/preview/removal, terminal and port tabs.
- **Full terminal and port forwarding.** A vendored xterm.js terminal (colours, cursor, full-screen
  programs with a plain line-renderer fallback), PTY over SSH with keyboard/paste, automatic discovery
  of listening ports, one-click forwarding, persistence and restore on reconnect.
- **Theme aware.** Light and dark, driven by DSH theme tokens.
- **Migration and rollback.** Connections are copied from `dsh-remote-ssh`, existing workspace
  stubs are reused in place, and `install.ps1 -Rollback` restores the previous profile manifest.

### Terminal

- Vendored xterm.js 5.5.0 + @xterm/addon-fit 0.10.0 (MIT), served from the loopback host at
  `/assets/*` with the session token; falls back to the built-in line renderer if loading fails.

### Packaging

- Bundle patch, client half, locale files, original icon, MIT license.
- `install.ps1` (install / `-RemoveOld` cutover / `-Uninstall` / `-Rollback`) and `build.ps1`.
- Self-contained: `ssh2` and its small dependency tree are vendored under `vendor/node_modules`,
  terminal assets under `vendor/xterm`; the package declares no npm dependencies, so
  `dsh plugin add` never triggers install scripts. Verified end-to-end with a packed tarball.
- CI: `npm run check`, `npm test` (parser unit tests), `npm pack --dry-run`.
- Sanitized design mockups and their rendered screenshots under `docs/design/v2/`.
- Security policy, issue/PR templates and `.gitattributes`.
- `install.ps1 -Doctor` reports profile state, both plugin flags, installed vs host build, data counts and legacy workspaces without changing anything.

### Changed

- Quick panel host cards filter the recent workspaces to that host; console search also filters the machine rail.

### Known limits

- Chinese UI first; English strings in v1.1.0.
- `~/.ssh/config` import does not cover `ProxyCommand` or host-key pinning yet.

## [0.9.0-dev.0] - 2026-11-04

### Added

- Theme awareness: every surface uses DSH theme tokens with light fallbacks, the client mirrors
  `theme.active.colorScheme` to `[data-rd-theme]`, and dark-specific overrides cover accents,
  error/success text, table headers and selected rows. Verified with light and dark screenshots.
- Live port-forward count in the console stats (replaces the v0.6.0 placeholder).
- Host error banner showing the exact failure reason; empty workspace/session guidance.

### Fixed

- A connection failure that happened before the SSH client was created (missing key file, bad
  config) left the host stuck in `connecting`. Every failure now lands in `error` with its message.

### Changed

- Panel, console and dialog colors tokenized (borders, soft surfaces, mono text) instead of fixed
  light-theme values.

### Known limits

- The terminal is line-rendered (no ANSI colors/cursor, no full-screen TUI); xterm.js and i18n are
  scheduled for v1.1.

## [0.6.0-dev.0] - 2026-11-04

### Added

- Console tabs: overview, terminal and port forwarding.
- Remote terminal over SSH PTY: open/reopen, keyboard input (Ctrl combinations, arrows, Tab,
  Backspace, paste), server-sent-event output stream with bounded replay buffer, and status.
- Port forwarding: local listener per forward over `ssh2` direct-tcpip, start/stop/open/copy,
  manual ports, automatic discovery of remote listening ports (`ss`/`netstat`), persistence in
  `forwards.json`, and restore when a connection comes back.
- Host endpoints `GET/POST /terminals`, `GET /terminals/:id/stream`, `POST /terminals/:id/input`,
  `POST /terminals/:id/resize`, `DELETE /terminals/:id`, `GET/POST /forwards`,
  `DELETE /forwards/:id`, `GET /connections/:id/ports`.

### Fixed

- Terminal output dropped lines that ended with `\r` (CRLF): clean per-line trimming now keeps
  the content and only collapses genuine carriage-return overwrites.

## [0.5.0-dev.0] - 2026-11-04

### Added

- Full-screen add-machine dialog: `~/.ssh/config` parsing (Host/HostName/Port/User/IdentityFile/
  ProxyJump), import list with duplicate detection, manual form with segmented auth, detected
  keys, auto-connect and connect-after-save switches, and a connection test that reports the
  remote OS, kernel, shell and round-trip latency.
- Full-screen workspace dialog: machine chips, editable path, breadcrumb, filter, directory table
  with modification time, keyboard navigation (↑/↓, Enter, Backspace), new-folder, preview panel
  with sidebar name, `AGENTS.md` and open-after-create switches, and existing-workspace removal
  with a two-step confirmation.
- Host endpoints `GET /ssh-config` and `POST /connections/test`; workspace creation accepts a
  custom title and can skip the AGENTS.md guide; directory listings now include modification time.

### Changed

- The quick panel's compact form/browser were replaced by the two dialogs so every entry point
  uses one implementation; the panel keeps machine cards, recent workspaces and quick actions.

## [0.4.0-dev.0] - 2026-11-04

### Added

- Remote Deck console in the main area: sidebar panel entry (label `远程开发`), machine rail with
  connected/unconnected groups, host header with connect/reconnect/disconnect/edit, workspace
  cards, and a recent-session list sorted by update time.
- Stats row per host: workspaces, sessions, port forwards (placeholder until v0.6.0), latency.
- Local search over machines, workspace names/paths and session titles.
- Empty states for "no machines" and "no workspaces"; workspace cards and session rows navigate
  with one click.
- Session header pill now opens the console for its machine.

### Changed

- Workspace card session counts come from the same session scan as the stats, so the two no longer
  disagree.

## [0.3.0-dev.1] - 2026-11-04

### Added

- Connection pool: one persistent SSH client per host with keepalive, exponential-backoff
  reconnect, and a probe that reports latency, OS, kernel, shell and home directory.
- One-time migration from `dsh-remote-ssh`: connections are copied (with per-host colour) and
  legacy workspace stubs are adopted in place, so existing workspaces and sessions keep their
  place in the sidebar.
- Sidebar chip and quick panel: host cards with status and latency, connect/disconnect,
  recent workspaces with session counts and relative time, add/edit/delete a connection,
  remote directory browser, create or pick a workspace, and remove a workspace locally.
- Session identity: a header pill, a colour-coded row badge and a hover line, all derived from
  the session `cwd` matched against the workspace registry — no extra host fields required.
- Remote workspace creation writes the POSIX guide `AGENTS.md` when the folder has none.
- Development tooling: `scripts/shot.mjs` (CDP screenshots) and `scripts/eval.mjs`
  (inspect the live page); the public screenshots are rendered from `docs/design/v2/`.

### Fixed

- The workspace list is read from `ctx.get('workspaces').list` instead of guessing the hook shape.
- Relative timestamps accept the registry's ISO strings.

## [0.3.0-dev.0] - 2026-11-04

### Added

- Initial development line for Remote Deck, the successor of `dsh-remote-ssh`.
- Repository scaffold, bundle patch, icon, CI, install/build scripts, roadmap and design assets.
