/** Types of `lifecycle.mjs` (B1.5.4B, for the unit tests in src/dev/mapLibreLab/tests). */
export type SessionStage = 'preflight' | 'devServer' | 'body' | 'appClosed' | 'stopDevServer'
export declare const SESSION_STAGES: readonly SessionStage[]

export interface StageRecord {
  stage: SessionStage
  verdict: 'PASS' | 'FAIL' | 'NOT_TESTED'
  ms?: number
  error?: string
  blockedBy?: SessionStage
  [k: string]: unknown
}

export interface SessionRecord<R = unknown> {
  label: string
  t0: number
  t1: number
  stages: StageRecord[]
  devServer: Record<string, unknown> | null
  cleanup: { verdict: string; reason?: string | null; [k: string]: unknown } | null
  bodyResult: R | undefined
  verdict: 'PASS' | 'FAIL' | 'INVALID'
  file?: string
  saveError?: string
}

export interface SessionDeps<S> {
  preflight(): Promise<{ ok: boolean; checks?: unknown }>
  startDevServer(): Promise<S>
  stopDevServer(server: S): Promise<{ verdict: string; reason?: string | null; ms?: number | null }>
  appProcesses(): { app: number[]; webview: number[] }
  save(name: string, data: Record<string, unknown>): string
  now(): number
}

export declare function runSession<S, R>(
  deps: SessionDeps<S>,
  options: { label: string },
  body: (ctx: { server: S }) => Promise<R>,
): Promise<SessionRecord<R>>
