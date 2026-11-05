// Host-side terminal smoke test: open a PTY, stream output, send a command.
//   node scripts/term-test.mjs <apiPort> <token> <connectionId>
const [port, token, connectionId] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
const headers = { 'x-dsh-remote-token': token, 'content-type': 'application/json' }

const created = await (await fetch(`${base}/terminals`, { method: 'POST', headers, body: JSON.stringify({ connectionId, cols: 100, rows: 24 }) })).json()
console.log('opened', created.id)

const controller = new AbortController()
const response = await fetch(`${base}/terminals/${created.id}/stream`, { headers: { 'x-dsh-remote-token': token }, signal: controller.signal })
const reader = response.body.getReader()
const decoder = new TextDecoder()
let output = ''
let pending = ''
const consume = (async () => {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let index
    while ((index = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, index)
      pending = pending.slice(index + 2)
      const line = frame.split('\n').find((row) => row.startsWith('data: '))
      if (!line) continue
      const event = JSON.parse(line.slice(6))
      if (event.type === 'data') output += Buffer.from(event.b64, 'base64').toString('utf8')
    }
  }
})()

await new Promise((resolve) => setTimeout(resolve, 800))
const sent = await (await fetch(`${base}/terminals/${created.id}/input`, { method: 'POST', headers, body: JSON.stringify({ data: 'echo REMOTE-DECK-OK\n' }) })).json()
console.log('input accepted', sent.ok)
await new Promise((resolve) => setTimeout(resolve, 1500))
controller.abort()
await consume.catch(() => {})
console.log('--- output ---')
console.log(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
await fetch(`${base}/terminals/${created.id}`, { method: 'DELETE', headers: { 'x-dsh-remote-token': token } })
