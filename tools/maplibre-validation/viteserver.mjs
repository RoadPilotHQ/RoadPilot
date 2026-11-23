/* global process */
/**
 * B1.5.4B: the validation harness's Vite dev server. Forked by `devserver-node.mjs` with an IPC
 * channel; never started by hand. Runs Vite through its documented JS API with the repository's
 * `vite.config.ts` (the same config `npm run dev` uses) on the host and port given as arguments
 * (from `src-tauri/tauri.conf.json` `build.devUrl`).
 *
 *   node viteserver.mjs <repoRoot> <host> <port>      (only as a forked child)
 *
 * IPC protocol (this process → harness):
 *   { type: 'listening', pid, urls, vite }   after `server.listen()` resolved
 *   { type: 'error', stage, error }          listen failed (e.g. port taken); the process exits 1
 *   { type: 'closed', reason }               after `server.close()` resolved, right before exiting
 * harness → this process:
 *   { type: 'shutdown' }                     close the server and exit
 *
 * Shutdown is `server.close()` (closes the HTTP and WebSocket servers, the file watcher and the
 * dependency optimiser), then the IPC channel is closed and the process exits on its own once its
 * event loop is empty (exit code 0). There is no `process.exit()` that could cut work short. If the
 * harness disappears (IPC disconnect), the server closes itself the same way, so it cannot stay
 * behind as an orphan.
 */
import { createServer, version } from 'vite'

const [root, host, portArg] = process.argv.slice(2)
const port = Number(portArg)
const send = (m) => {
  try {
    if (process.connected) process.send(m)
  } catch {
    // The harness is gone; nothing to report to.
  }
}
if (!process.send) throw new Error('viteserver.mjs runs only as a forked child with IPC')
if (!root || !host || !Number.isInteger(port)) throw new Error('usage: <root> <host> <port>')

let server = null
let closing = null

function shutdown(reason) {
  closing ??= (async () => {
    try {
      if (server) await server.close()
      send({ type: 'closed', reason })
    } catch (e) {
      send({ type: 'error', stage: 'close', error: String(e?.stack ?? e) })
      process.exitCode = 1
    } finally {
      if (process.connected) process.disconnect()
    }
  })()
  return closing
}

process.on('message', (m) => {
  if (m?.type === 'shutdown') void shutdown('ipc')
})
process.on('disconnect', () => void shutdown('harness-disconnected'))

try {
  process.chdir(root)
  server = await createServer({
    root,
    server: { host, port, strictPort: true },
  })
  await server.listen()
  send({ type: 'listening', pid: process.pid, urls: server.resolvedUrls, vite: version })
} catch (e) {
  send({ type: 'error', stage: 'listen', error: String(e?.message ?? e) })
  process.exitCode = 1
  await shutdown('listen-failed')
}
