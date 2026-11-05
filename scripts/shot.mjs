// Headless verification helper: capture a real rendered screenshot over CDP.
//
//   node scripts/shot.mjs <url> <out.png> [width] [height] [waitMs] [port]
//
// Expects a Chrome started with --remote-debugging-port=<port> (default 9222)
// and an already open page target. Writes a PNG at device scale 2.
import { writeFileSync } from 'node:fs'

const [url, out, width = '1440', height = '900', waitMs = '4000', port = '9222', clickText = '', preScript = '', hoverScript = ''] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [w] [h] [waitMs] [port]')
  process.exit(2)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target on the debugging port')
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 0

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 2,
  mobile: false,
})
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, Number(waitMs)))

if (clickText) {
  await send('Runtime.evaluate', {
    expression: `(() => { const label = ${JSON.stringify(clickText)}; const hit = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label); if (hit) { hit.click(); return true } return false })()`,
    returnByValue: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 800))
}

if (preScript) {
  const result = await send('Runtime.evaluate', { expression: preScript, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails) {
    console.error('preScript failed:', JSON.stringify(result.result.exceptionDetails).slice(0, 400))
  }
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

if (hoverScript) {
  const point = await send('Runtime.evaluate', { expression: hoverScript, returnByValue: true })
  const pt = point.result?.result?.value
  if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 })
    await new Promise((resolve) => setTimeout(resolve, 1200))
  } else {
    console.error('hoverScript returned no point')
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (!shot.result || !shot.result.data) {
  console.error('capture failed', JSON.stringify(shot).slice(0, 500))
  process.exit(4)
}
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`captured ${out} (${Number(width)}x${Number(height)} @2x)`)

const errors = await send('Runtime.evaluate', {
  expression: 'window.__rdErrors ? JSON.stringify(window.__rdErrors) : "[]"',
  returnByValue: true,
})
console.log('page errors:', errors.result?.result?.value ?? '[]')
socket.close()
