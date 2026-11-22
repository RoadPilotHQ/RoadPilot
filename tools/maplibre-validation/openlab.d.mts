/** Types of `openlab.mjs` (B1.5.1, for the unit tests in src/dev/mapLibreLab/tests). */
export type Stage =
  'startup' | 'target' | 'appNavigation' | 'navigation' | 'labReady' | 'initialConfig'

export declare const STAGES: readonly Stage[]
export declare const DEFAULT_TIMEOUTS: Readonly<{
  target: number
  appNavigation: number
  navigation: number
  labReady: number
  initialConfig: number
  command: number
  poll: number
}>
export declare const DEFAULT_ATTEMPTS: number

export interface CdpMessage {
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface LabPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(listener: (msg: CdpMessage) => void): void
  onClose?(listener: (error: Error) => void): void
  close(): void
}

export interface LabApp {
  port: number
  startMs?: number
  proc?: { pid?: number }
  exited(): number | null
}

export interface Target {
  type: string
  url: string
  id?: string
  webSocketDebuggerUrl: string
}

export interface OpenLabDeps<App extends LabApp = LabApp, Page extends LabPage = LabPage> {
  launch(): Promise<App>
  close(app: App): Promise<unknown>
  processes(): { app: number[]; webview: number[] }
  listTargets(port: number): Promise<Target[]>
  connect(webSocketDebuggerUrl: string): Promise<Page>
  instrument(page: Page): Promise<unknown>
  devServer(): Promise<unknown>
  save(name: string, data: Record<string, unknown>, pngBase64: string | null): string
  now(): number
  sleep(ms: number): Promise<unknown>
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export interface OpenLabOptions {
  labUrl: string
  devOrigin: string
  dpr?: number
  label?: string
  attempts?: number
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>
}

export interface AttemptFailure {
  attempt: number
  stage: Stage | string
  error: string
  refusal: boolean
  diagnosticsFile: string | null
  diagnosticsSaveError?: string
  cleanup: {
    clean: boolean
    close?: unknown
    processes?: { app: number[]; webview: number[] } | null
    error?: string | null
    note?: string
  } | null
}

export declare class StageError extends Error {
  stage: string
  detail: unknown
  transient?: boolean
  constructor(stage: string, message: string, detail?: unknown)
}

export declare class OpenLabError extends Error {
  stage: string | null
  attempts: AttemptFailure[]
  constructor(attempts: AttemptFailure[], reason?: string)
}

export declare function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage: string,
  what: string,
  deps: Pick<OpenLabDeps, 'setTimeout' | 'clearTimeout'>,
): Promise<T>

export declare function openLab<App extends LabApp, Page extends LabPage>(
  deps: OpenLabDeps<App, Page>,
  options: OpenLabOptions,
): Promise<{
  app: App
  page: Page
  inst: unknown
  navT: number
  initial: Record<string, unknown>
  stages: { stage: string; ms: number }[]
  events: { t: number; event: string; [k: string]: unknown }[]
  attempt: number
  failedAttempts: AttemptFailure[]
}>
