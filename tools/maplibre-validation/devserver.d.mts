/** Types of `devserver.mjs` (B1.5.4B, for the unit tests in src/dev/mapLibreLab/tests). */
export type DevStage =
  'preflight' | 'spawn' | 'listening' | 'ownership' | 'http' | 'labRoute' | 'modules'

export declare const DEV_STAGES: readonly DevStage[]
/** B1.5.4E: the stage after `modules` with `options.placeholder`. */
export declare const PLACEHOLDER_STAGE: 'placeholder'
export declare const DEV_TIMEOUTS: Readonly<{
  preflight: number
  listening: number
  ownership: number
  http: number
  labRoute: number
  modules: number
  placeholder: number
  request: number
  shutdown: number
  endpointDown: number
  poll: number
}>
export declare const DEV_LIMITS: Readonly<{ maxModules: number; maxPasses: number }>

export interface ServerMessage {
  type: string
  pid?: number
  urls?: { local?: string[] }
  error?: string
  [k: string]: unknown
}

export interface ServerHandle {
  pid: number
  messages(): ServerMessage[]
  output(): string
  exitInfo(): { code: number | null; signal: string | null } | null
  /** Sends the IPC `shutdown`; false if the channel is closed. */
  requestShutdown(): boolean
  /** B1.5.4E: sends the IPC `placeholder`; false if the channel is closed. */
  requestPlaceholder?(): boolean
}

/** B1.5.4E: result of the `placeholder` stage. */
export interface PlaceholderResult {
  active: true
  marker: string
  ackMs: number
  ms: number
  app: { status: number; marker: string | null; scripts: number }
  lab: { scripts: number; modules: number }
}

export interface ProcessEntry {
  pid: number
  ppid?: number
  name?: string
  cmd?: string
}

export interface HttpAnswer {
  status: number
  contentType: string | null
  text: string
}

export interface DevServerDeps<H extends ServerHandle = ServerHandle> {
  spawn(): Promise<H>
  fetch(url: string, timeoutMs: number): Promise<HttpAnswer>
  portOwners(port: number): Promise<number[]>
  descendants(pid: number): Promise<ProcessEntry[]>
  isAlive(pid: number): boolean
  save(name: string, data: Record<string, unknown>): string
  now(): number
  sleep(ms: number): Promise<unknown>
}

export interface DevServerOptions {
  origin: string
  appPath?: string
  labPath: string
  labMarker: string
  requiredModules?: string[]
  label?: string
  timeouts?: Partial<typeof DEV_TIMEOUTS>
  limits?: Partial<typeof DEV_LIMITS>
  /** B1.5.4E: switch `/` to the placeholder after readiness (stage `placeholder`). */
  placeholder?: boolean
}

export interface RunningServer<H extends ServerHandle = ServerHandle> {
  pid: number
  origin: string
  appUrl: string
  labUrl: string
  handle: H
  descendants: ProcessEntry[]
  stages: { stage: string; ms: number }[]
  events: { t: number; event: string; [k: string]: unknown }[]
  modules: {
    count: number
    urls: string[]
    passes: { pass: number; ms: number; modules: number; failures: unknown[] }[]
  }
  /** True once every readiness stage passed (before the optional `placeholder` stage). */
  ready: boolean
  labScripts: string[]
  requiredModuleUrls: string[]
  placeholder?: PlaceholderResult
}

export interface StopResult {
  pid: number
  alreadyExited: boolean
  shutdownRequested: boolean
  exit: { code: number | null; signal: string | null } | null
  closedMessage: boolean
  graceful: boolean
  httpDown: boolean | null
  portFree: boolean | null
  descendants: ProcessEntry[]
  leftoverDescendants: ProcessEntry[]
  processAlive?: boolean
  descendantsNow?: unknown
  portOwnersAfter?: number[]
  verdict: 'PASS' | 'FAIL'
  reason: string
  ms: number
  error?: string
}

export declare class DevServerError extends Error {
  stage: string
  diagnosticsFile: string | null
  diagnosticsSaveError: string | null
  cleanup: StopResult | null
  pid: number | null
  /** B1.5.4E: `activatePlaceholder` refused before sending anything. */
  refused?: boolean
}

export declare function activatePlaceholder<H extends ServerHandle>(
  deps: DevServerDeps<H>,
  server: Partial<RunningServer<H>> & Pick<RunningServer<H>, 'pid' | 'handle'>,
  options?: {
    labMarker?: string
    timeouts?: Partial<typeof DEV_TIMEOUTS>
    limits?: Partial<typeof DEV_LIMITS>
  },
): Promise<PlaceholderResult>

export declare function moduleScripts(html: string, pageUrl: string): string[]
export declare function moduleImports(code: string, moduleUrl: string): string[]
export declare function startDevServer<H extends ServerHandle>(
  deps: DevServerDeps<H>,
  options: DevServerOptions,
): Promise<RunningServer<H>>
export declare function stopDevServer<H extends ServerHandle>(
  deps: DevServerDeps<H>,
  server: Pick<RunningServer<H>, 'pid' | 'origin' | 'handle'> &
    Partial<Pick<RunningServer<H>, 'appUrl' | 'descendants'>>,
  options?: { timeouts?: Partial<typeof DEV_TIMEOUTS> },
): Promise<StopResult>
