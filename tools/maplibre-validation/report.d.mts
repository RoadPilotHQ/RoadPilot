/** Types of `report.mjs` (B1 runtime validation; for the unit tests in src/dev/mapLibreLab/tests). */
export type Verdict = 'PASS' | 'FAIL' | 'INVALID' | 'NOT_TESTED'

export interface Evaluation {
  verdict: Verdict
  reason: string
  detail?: unknown
  metrics?: Record<string, unknown>
  checks?: Record<string, Verdict>
  [key: string]: unknown
}

export declare const VERDICTS: readonly Verdict[]
export declare const THRESHOLDS: Readonly<
  Record<
    'urban' | 'stress',
    Readonly<{ segments: number; firstVisibleMs: number; gapP95Ms: number; gapMaxMs: number }>
  >
>
export declare const ACCURACY_TOLERANCE_PX: number
export declare const MIN_RUNS: number
export declare const MEMORY: Readonly<{
  status: 'provisional'
  cycles: number
  steadyFrom: number
  growthLimit: number
}>

export declare function combine(verdicts: readonly Verdict[]): Verdict
export declare function evaluateAccuracy(acc: unknown): Evaluation
export declare function worstProbe(acc: unknown): Record<string, unknown> | null
export declare function evaluateNetwork(input?: {
  requests?: unknown
  pageOrigin?: unknown
  cspViolations?: unknown
  maplibreRequests?: unknown
}): Evaluation
export declare function evaluateContextLoss(result: unknown): Evaluation
export declare function evaluateRelease(result: unknown): Evaluation
export declare const NO_HANDLER_WARNING: RegExp
export declare function evaluateWorkerProjection(wp: unknown, consoleEntries?: unknown): Evaluation
export declare function evaluatePerfRun(run: unknown, scenario: string): Evaluation
export declare function aggregatePerf(runs: unknown, scenario: string): Evaluation
export declare function evaluateMemoryCycles(result: unknown): Evaluation
export declare function evaluateScreenshots(records: unknown): Evaluation
export declare function evaluateStartup(runs: unknown): Evaluation
export declare function evaluateLifecycle(record: unknown): Evaluation
/** B1.5.4E: paths only the RoadPilot app page loads. */
export declare const APP_ONLY_PATHS: readonly string[]
export declare const IPC_ORIGIN: string
export declare const CALLBACK_WARNING: string
/** B1.5.4E: input as recorded by run.mjs (`appPageIsolation` of a result file). */
export interface AppPageIsolationEvidence {
  expectedMarker: string
  pageOrigin: string
  navT?: number
  probe: { marker: string | null; resources: string[]; [k: string]: unknown } | null
  requests: { url: string; t?: number; session?: string; type?: string }[]
  console: { type?: string; text?: string; session?: string }[]
}
export declare function evaluateAppPageIsolation(evidence: unknown): Evaluation
/** B1.5.4G */
export declare const CONTAMINATION_REASONS: readonly string[]
export declare function evaluateNegativeControl(result: unknown): Evaluation & {
  verdict: 'INVALID'
  control: true
  outcome: 'detected' | 'inconclusive' | 'detector_failed'
}
export declare function buildReport(input?: {
  functional?: unknown
  perf?: unknown
  cycles?: unknown
  lifecycle?: unknown
  negativeControl?: unknown
}): {
  control?: true
  thresholds: typeof THRESHOLDS
  accuracyTolerancePx: number
  minRuns: number
  memoryRule: typeof MEMORY
  criteria: Record<string, Evaluation>
  overall: Verdict
}
