/** Types of `devserver-node.mjs` (B1.5.4B, for the process tests in src/dev/mapLibreLab/tests). */
import type { DevServerDeps, HttpAnswer, ProcessEntry, ServerHandle } from './devserver.mjs'

export declare function portOwners(port: number): Promise<number[]>
export declare function descendants(pid: number): Promise<ProcessEntry[]>
export declare function isAlive(pid: number): boolean
export declare function httpGet(url: string, timeoutMs: number): Promise<HttpAnswer>
export declare function spawnServer(options: {
  script: string
  args?: string[]
  cwd: string
  logFile?: string | null
  env?: Record<string, string | undefined>
}): ServerHandle
export declare function nodeDevServerDeps(options: {
  script: string
  args: string[]
  cwd: string
  logFile?: string | null
  save(name: string, data: Record<string, unknown>): string
}): DevServerDeps
