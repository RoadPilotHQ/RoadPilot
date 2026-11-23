/* global process, setTimeout, setInterval, clearInterval, URL */
/**
 * B1.5.4B test fixture: a tiny HTTP server that speaks the IPC protocol of
 * tools/maplibre-validation/viteserver.mjs (`listening`, `closed`; `shutdown`). Used only by
 * devServerProcess.test.ts, on a random local port.
 *
 *   node fakeDevServer.mjs <mode> <port>
 *   modes: normal | child (has a child process) | slow (closes after 1.5 s) | hang (ignores
 *          shutdown) | exit-early (exits on its own 300 ms after listening) | grandchild (the child)
 */
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const [mode, portArg] = process.argv.slice(2)
const send = (m) => {
  if (process.connected) process.send(m)
}

if (mode === 'grandchild') {
  const keep = setInterval(() => {}, 1000)
  const bye = () => {
    clearInterval(keep)
    if (process.connected) process.disconnect()
  }
  process.on('message', (m) => m?.type === 'shutdown' && bye())
  process.on('disconnect', bye)
} else {
  const port = Number(portArg)
  const js = 'text/javascript'
  const pages = {
    '/': ['text/html', '<!doctype html><script type="module" src="/main.js"></script>'],
    '/lab.html': [
      'text/html',
      '<!doctype html><title>FIXTURE LAB</title><script type="module" src="./lab.js"></script>',
    ],
    '/main.js': [js, 'import "/dep.js";\nexport {}'],
    '/lab.js': [js, 'const later = () => import("./dep.js");\nexport {}'],
    '/dep.js': [js, 'export const dep = 1'],
    '/worker.js': [js, 'self.x = 1'],
  }
  const server = createServer((req, res) => {
    const page = pages[new URL(req.url, 'http://x').pathname]
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': page[0] }).end(page[1])
  })
  const child =
    mode === 'child'
      ? fork(fileURLToPath(import.meta.url), ['grandchild'], { stdio: 'ignore' })
      : null
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    server.close()
    server.closeAllConnections()
    const finish = () => {
      send({ type: 'closed', reason: 'ipc' })
      if (process.connected) process.disconnect()
    }
    if (child && child.exitCode === null) {
      child.once('exit', finish)
      child.send({ type: 'shutdown' })
    } else finish()
  }
  process.on('message', (m) => {
    if (m?.type !== 'shutdown' || mode === 'hang') return
    if (mode === 'slow') setTimeout(close, 1500)
    else close()
  })
  server.listen(port, '127.0.0.1', () => {
    send({ type: 'listening', pid: process.pid, urls: { local: [`http://127.0.0.1:${port}/`] } })
    if (mode === 'exit-early')
      setTimeout(() => {
        closing = true
        server.close()
        server.closeAllConnections()
        if (process.connected) process.disconnect()
      }, 300)
  })
}
