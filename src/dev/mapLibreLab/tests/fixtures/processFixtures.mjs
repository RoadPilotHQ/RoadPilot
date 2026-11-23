/* global process */
/**
 * B1.5.4B test helpers for devServerProcess.test.ts (typed in processFixtures.d.mts). The test
 * owns every process started here and ends exactly those PIDs in its teardown; the harness under
 * test has no such function.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// Vitest runs from the repository root (`import.meta.url` is not a file URL in its jsdom runs).
export const CWD = process.cwd()
export const FAKE_SERVER = join(
  CWD,
  'src',
  'dev',
  'mapLibreLab',
  'tests',
  'fixtures',
  'fakeDevServer.mjs',
)
export const IS_WINDOWS = process.platform === 'win32'

/** A Node process that has nothing to do with the harness (stands for the user's other Node apps). */
export function spawnUnrelatedNode() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  return p.pid
}

/** Test teardown only: ends a process this test started itself (by its PID). */
export function endTestOwnedProcess(pid) {
  try {
    process.kill(pid)
  } catch {
    // Already gone.
  }
}

/** A port in a range the app and Vite never use. */
export function testPort() {
  return 21_000 + Math.floor(Math.random() * 8_000)
}
