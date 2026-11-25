/* global process, Buffer */
/**
 * B1.5.4B: the real dependencies of `devserver.mjs` (Node, Windows). Every process lookup is by
 * PID: the server's own PID, the owner of the listening socket, the descendants of the server's
 * PID. Nothing here looks processes up by name and nothing here can terminate a process.
 */
import { execFileSync, fork } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { request } from 'node:http'

const OUTPUT_TAIL = 16_000

function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

/**
 * PIDs with a listening TCP socket on `port` (Windows). "No such socket" (ObjectNotFound) is an
 * empty list; any other error is thrown, so a failed lookup can never look like a free port.
 */
export async function portOwners(port) {
  if (!Number.isInteger(port)) throw new Error(`invalid port ${port}`)
  const out = ps(
    // `exit 0`: after a handled error `-Command` would still exit 1 ($? is false); a rethrown
    // error ends the script before it.
    `try { Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | ForEach-Object { $_.OwningProcess } } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }; exit 0`,
  )
  return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))]
}

/**
 * All processes below `pid` in the process tree (by parent PID), with name and command line.
 * A forked Node process on Windows has its own (hidden) `conhost.exe`; it is a real child and is
 * tracked like any other.
 */
export async function descendants(pid) {
  if (!Number.isInteger(pid)) throw new Error(`invalid pid ${pid}`)
  const json = ps(
    `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
  )
  const all = [].concat(json ? JSON.parse(json) : [])
  const out = []
  const walk = (p) => {
    for (const c of all.filter((x) => x.ParentProcessId === p && x.ProcessId !== p)) {
      out.push({
        pid: c.ProcessId,
        ppid: c.ParentProcessId,
        name: c.Name,
        cmd: String(c.CommandLine ?? '').slice(0, 400),
      })
      walk(c.ProcessId)
    }
  }
  walk(pid)
  return out
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0) // signal 0: existence check only, sends nothing
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * One GET without keep-alive (an idle keep-alive connection would hold up `server.close()`).
 * Resolves { status, contentType, text }; rejects on connection errors and after `timeoutMs`.
 */
export function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', agent: false, headers: { connection: 'close' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] ?? null,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Forks `script` with an IPC channel. The returned handle is what `devserver.mjs` calls `handle`.
 * stdout and stderr go to `logFile` (appended) and a bounded in-memory tail.
 */
export function spawnServer({ script, args = [], cwd, logFile = null, env = process.env }) {
  // The log exists even if the server prints nothing (a session always has its server log).
  if (logFile) appendFileSync(logFile, `[harness] fork ${script} ${args.join(' ')}\n`)
  const child = fork(script, args, {
    cwd,
    env,
    // A clean Node process: not the parent's flags (e.g. a test runner's loaders).
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  const messages = []
  let exit = null
  let tail = ''
  const out = (stream) => (chunk) => {
    const text = chunk.toString('utf8')
    tail = (tail + text).slice(-OUTPUT_TAIL)
    if (logFile) {
      try {
        appendFileSync(logFile, text.replace(/^/gm, `[${stream}] `))
      } catch {
        // The log file is a convenience; the tail stays in the diagnostics.
      }
    }
  }
  child.stdout.on('data', out('out'))
  child.stderr.on('data', out('err'))
  child.on('message', (m) => messages.push(m))
  child.on('exit', (code, signal) => (exit = { code, signal }))
  return {
    pid: child.pid,
    messages: () => messages.slice(),
    output: () => tail,
    exitInfo: () => exit,
    /** Sends `shutdown`; false if the IPC channel is already closed. */
    requestShutdown: () => {
      if (!child.connected) return false
      try {
        child.send({ type: 'shutdown' })
        return true
      } catch {
        return false
      }
    },
    /** B1.5.4E: sends `placeholder`; false if the IPC channel is already closed. */
    requestPlaceholder: () => {
      if (!child.connected) return false
      try {
        child.send({ type: 'placeholder' })
        return true
      } catch {
        return false
      }
    },
  }
}

/** All `devserver.mjs` dependencies for a forked server script. */
export function nodeDevServerDeps({ script, args, cwd, logFile, save }) {
  return {
    spawn: async () => spawnServer({ script, args, cwd, logFile }),
    fetch: (url, ms) => httpGet(url, ms),
    portOwners,
    descendants,
    isAlive,
    save,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => globalThis.setTimeout(r, ms)),
  }
}
