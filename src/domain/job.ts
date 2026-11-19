/**
 * The current job as the dashboard shows it, derived from the telemetry snapshot. Pure: the
 * link state is passed in. Nothing is filled in: every field is a `Reading`.
 *
 * The game reports four job states. RoadPilot shows exactly these, plus `unknown` when the
 * telemetry says nothing about jobs. There is no "job available" (the SDK reports no offers)
 * and no "job failed": a cancelled job is only cancelled.
 */
import { fieldsFromPaths, read, type Reading } from './reading'
import type { DashboardSnapshot, GameId, JobData, JobField } from './types'
import { dataCurrent, type Link } from './vehicle'

export type JobStatus = 'none' | 'active' | 'delivered' | 'cancelled' | 'unknown'

/** Why the status is `unknown`. */
export type JobUnknownReason =
  /** No current telemetry: disconnected, connecting, stale or failed. */
  | 'noData'
  /** Connected, but the telemetry carries no job information (schema 1, or not sent yet). */
  | 'notReported'

export interface JobView {
  status: JobStatus
  unknownReason: JobUnknownReason | null
  /** Sample values shown while no game is connected. */
  demo: boolean
  read<K extends JobField>(field: K): Reading<NonNullable<JobData[K]>>
}

/** The only currency each game uses (per the SCS SDK). */
export const GAME_CURRENCY: Record<GameId, string> = { ets2: 'EUR', ats: 'USD' }

export function jobView(snapshot: DashboardSnapshot, current: Link): JobView {
  const isCurrent = dataCurrent(snapshot, current)
  const job = isCurrent ? snapshot.job : null
  const status: JobStatus = job ? job.state : 'unknown'
  const invalid = new Set<JobField>(snapshot.telemetry?.invalidJobFields ?? [])
  // A currency that does not belong to the game is never shown with its amounts.
  const expected = snapshot.game ? GAME_CURRENCY[snapshot.game] : null
  if (job?.currency != null && expected != null && job.currency !== expected) {
    invalid.add('currency')
    invalid.add('income')
    invalid.add('deliveredRevenue')
    invalid.add('cancelPenalty')
  }
  function readJob<K extends JobField>(field: K): Reading<NonNullable<JobData[K]>> {
    return read(job?.[field], { current: job !== null, invalid: invalid.has(field) })
  }
  return {
    status,
    unknownReason: status !== 'unknown' ? null : isCurrent ? 'notReported' : 'noData',
    demo: snapshot.mode === 'demo',
    read: readJob,
  }
}

/**
 * Telemetry wire paths (as reported in `invalidFields`) and the job values they feed.
 * Calculated values depend on every input.
 */
export const JOB_INVALID_TARGETS: Readonly<Record<string, readonly JobField[]>> = {
  'job.cargo': ['cargo'],
  'job.cargoMassKg': ['cargoMassKg'],
  'job.cargoDamage': ['cargoDamagePercent'],
  'job.sourceCity': ['sourceCity'],
  'job.sourceCompany': ['sourceCompany'],
  'job.destinationCity': ['destinationCity'],
  'job.destinationCompany': ['destinationCompany'],
  'job.income': ['income'],
  'job.plannedDistanceKm': ['plannedDistanceKm', 'progressPercent'],
  'job.jobMarket': ['jobMarket'],
  'job.deliveredRevenue': ['deliveredRevenue'],
  'job.cancelPenalty': ['cancelPenalty'],
  'navigation.distanceM': ['progressPercent'],
}

export function invalidJobFields(wirePaths: readonly string[]): JobField[] {
  return fieldsFromPaths(JOB_INVALID_TARGETS, wirePaths)
}

/** Job market tokens documented for the SCS SDK; anything else is shown as sent. */
export const JOB_MARKETS = [
  'cargo_market',
  'quick_job',
  'freight_market',
  'external_contracts',
  'external_market',
] as const
export type JobMarket = (typeof JOB_MARKETS)[number]

export function knownJobMarket(token: string): JobMarket | null {
  return JOB_MARKETS.find((m) => m === token) ?? null
}
