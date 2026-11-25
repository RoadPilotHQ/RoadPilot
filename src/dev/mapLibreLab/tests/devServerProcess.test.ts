/**
 * B1.5.4B (defects B and C) with real processes: the harness's process handling
 * (tools/maplibre-validation/devserver-node.mjs) and devserver.mjs, against a tiny fixture server
 * that speaks viteserver.mjs's IPC protocol on a random local port. Windows only (PID lookups use
 * Windows' process and TCP tables, as the harness does); no Vite, no RoadPilot, no browser.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLACEHOLDER_STAGE,
  startDevServer,
  stopDevServer,
  type DevServerDeps,
  type ServerHandle,
} from '../../../../tools/maplibre-validation/devserver.mjs'
import {
  PLACEHOLDER_HTML,
  PLACEHOLDER_MARKER,
} from '../../../../tools/maplibre-validation/placeholder.mjs'
import {
  descendants,
  httpGet,
  isAlive,
  nodeDevServerDeps,
  portOwners,
  spawnServer,
} from '../../../../tools/maplibre-validation/devserver-node.mjs'
import {
  CWD,
  endTestOwnedProcess,
  FAKE_SERVER,
  IS_WINDOWS,
  spawnUnrelatedNode,
  testPort,
} from './fixtures/processFixtures.mjs'

const owned: number[] = []
afterEach(() => {
  // Only the processes these tests started themselves, by PID (e.g. the `hang` fixture).
  while (owned.length) endTestOwnedProcess(owned.pop()!)
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function listening(h: ServerHandle) {
  for (let i = 0; i < 100; i++) {
    if (h.messages().some((m) => m.type === 'listening')) return
    if (h.exitInfo())
      throw new Error(`fixture exited: ${JSON.stringify(h.exitInfo())} ${h.output()}`)
    await sleep(50)
  }
  throw new Error('fixture did not listen')
}

function deps(mode: string, port: number, saved: string[] = []): DevServerDeps {
  return nodeDevServerDeps({
    script: FAKE_SERVER,
    args: [mode, String(port)],
    cwd: CWD,
    logFile: null,
    save: (name) => {
      saved.push(name)
      return `memory:${name}`
    },
  })
}

/** Starts a fixture directly (no readiness checks) and returns what stopDevServer needs. */
async function fixture(mode: string) {
  const port = testPort()
  const h = spawnServer({ script: FAKE_SERVER, args: [mode, String(port)], cwd: CWD })
  owned.push(h.pid)
  await listening(h)
  const origin = `http://127.0.0.1:${port}`
  return {
    h,
    port,
    origin,
    server: { pid: h.pid, origin, handle: h, descendants: await descendants(h.pid) },
  }
}

const fast = { timeouts: { shutdown: 5_000, endpointDown: 3_000, poll: 100 } }

describe.runIf(IS_WINDOWS)('dev server processes (real, Windows)', { timeout: 90_000 }, () => {
  it('full readiness against a real server: exact PID owns the port, pages and modules served', async () => {
    const port = testPort()
    const d = deps('normal', port)
    const server = await startDevServer(d, {
      origin: `http://127.0.0.1:${port}`,
      labPath: '/lab.html',
      labMarker: 'FIXTURE LAB',
      requiredModules: ['/worker.js'],
      label: 'process-test',
    })
    owned.push(server.pid)
    expect(await portOwners(port)).toEqual([server.pid])
    expect(server.modules.urls).toEqual(
      ['/dep.js', '/lab.js', '/main.js', '/worker.js'].map((p) => `http://127.0.0.1:${port}${p}`),
    )
    const stop = await stopDevServer(d, server, fast)
    expect(stop).toMatchObject({
      verdict: 'PASS',
      reason: 'graceful',
      httpDown: true,
      portFree: true,
    })
    expect(isAlive(server.pid)).toBe(false)
    await expect(httpGet(`http://127.0.0.1:${port}/`, 1000)).rejects.toThrow()
  })

  it('B1.5.4E: the real IPC switch replaces `/` after readiness; lab and modules unchanged; graceful stop', async () => {
    const port = testPort()
    const base = `http://127.0.0.1:${port}`
    const d = deps('normal', port)
    const server = await startDevServer(d, {
      origin: base,
      labPath: '/lab.html',
      labMarker: 'FIXTURE LAB',
      requiredModules: ['/worker.js'],
      label: 'process-test',
      placeholder: true,
    })
    owned.push(server.pid)
    expect(server.stages.map((s) => s.stage).at(-1)).toBe(PLACEHOLDER_STAGE)
    expect(server.placeholder).toMatchObject({ active: true, marker: PLACEHOLDER_MARKER })
    const ack = server.handle.messages().find((m) => m.type === 'placeholder-active')
    expect(ack).toMatchObject({ pid: server.pid, marker: PLACEHOLDER_MARKER })
    const root = await httpGet(`${base}/`, 2000)
    expect(root.status).toBe(200)
    expect(root.text).toBe(PLACEHOLDER_HTML)
    expect((await httpGet(`${base}/index.html`, 2000)).text).toBe(PLACEHOLDER_HTML)
    const lab = await httpGet(`${base}/lab.html`, 2000)
    expect(lab.text).toContain('FIXTURE LAB')
    expect(lab.text).toContain('./lab.js')
    for (const p of ['/main.js', '/lab.js', '/dep.js', '/worker.js'])
      expect((await httpGet(`${base}${p}`, 2000)).status).toBe(200)
    const stop = await stopDevServer(d, server, fast)
    expect(stop).toMatchObject({
      verdict: 'PASS',
      reason: 'graceful',
      httpDown: true,
      portFree: true,
    })
    expect(isAlive(server.pid)).toBe(false)
  })

  it('wrong process or port: a second start on a port owned by another PID is refused, the first untouched', async () => {
    const first = await fixture('normal')
    const saved: string[] = []
    const d = deps('normal', first.port, saved)
    await expect(
      startDevServer(d, {
        origin: first.origin,
        labPath: '/lab.html',
        labMarker: 'FIXTURE LAB',
        label: 'second',
      }),
    ).rejects.toMatchObject({
      stage: 'preflight',
      message: expect.stringContaining(`PID ${first.h.pid}`),
    })
    expect(isAlive(first.h.pid)).toBe(true)
    expect(saved).toEqual(['devserver-failure-second'])
    expect((await stopDevServer(d, first.server, fast)).verdict).toBe('PASS')
  })

  it('normal shutdown with a child process: both exit, nothing is left', async () => {
    const f = await fixture('child')
    // The fixture's own Node child, plus Windows' console host of the forked process (conhost.exe).
    const node = f.server.descendants.filter((d) => d.name === 'node.exe')
    expect(node).toHaveLength(1)
    expect(node[0]!.cmd).toContain('grandchild')
    const all = f.server.descendants.map((d) => d.pid)
    expect(all.every(isAlive)).toBe(true)
    const stop = await stopDevServer(deps('child', f.port), f.server, fast)
    expect(stop).toMatchObject({ verdict: 'PASS', reason: 'graceful', leftoverDescendants: [] })
    expect(all.filter(isAlive)).toEqual([])
  })

  it('delayed shutdown inside the bound passes', async () => {
    const f = await fixture('slow')
    const stop = await stopDevServer(deps('slow', f.port), f.server, fast)
    expect(stop).toMatchObject({ verdict: 'PASS', reason: 'graceful' })
    expect(stop.ms).toBeGreaterThanOrEqual(1_400)
  })

  it('already exited server: reported, no shutdown sent', async () => {
    const f = await fixture('exit-early')
    for (let i = 0; i < 60 && !f.h.exitInfo(); i++) await sleep(50)
    const stop = await stopDevServer(deps('exit-early', f.port), f.server, fast)
    expect(stop).toMatchObject({
      verdict: 'PASS',
      reason: 'already_exited',
      shutdownRequested: false,
    })
  })

  it('shutdown timeout: cleanup FAIL, and the harness leaves the process running (no force kill)', async () => {
    const f = await fixture('hang')
    const stop = await stopDevServer(deps('hang', f.port), f.server, {
      timeouts: { shutdown: 1_500, poll: 100 },
    })
    expect(stop).toMatchObject({ verdict: 'FAIL', reason: 'shutdown_timeout', processAlive: true })
    expect(isAlive(f.h.pid)).toBe(true)
    expect((await httpGet(`${f.origin}/`, 2000)).status).toBe(200)
    // The test ends its own fixture in afterEach.
  })

  it('unrelated Node processes survive start and stop untouched', async () => {
    const other = spawnUnrelatedNode()
    owned.push(other)
    await sleep(300)
    expect(isAlive(other)).toBe(true)
    const f = await fixture('child')
    expect(f.server.descendants.map((x) => x.pid)).not.toContain(other)
    const stop = await stopDevServer(deps('child', f.port), f.server, fast)
    expect(stop.verdict).toBe('PASS')
    expect(isAlive(other)).toBe(true)
  })
})
