# Vendored terminal assets

- `xterm.js`, `xterm.css` — xterm.js 5.5.0 (MIT), https://github.com/xtermjs/xterm.js
- `addon-fit.js` — @xterm/addon-fit 0.10.0 (MIT)
- `LICENSE.xterm`, `LICENSE.addon-fit` — the upstream licenses

These UMD builds are served by the plugin's loopback host at `/assets/*` and loaded on demand
when the terminal opens. They are not required for any other surface; if they fail to load the
terminal falls back to the built-in line renderer.
