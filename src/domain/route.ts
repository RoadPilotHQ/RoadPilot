/**
 * Route information as the dashboard shows it. RoadPilot calculates no route: the in-game
 * Route Advisor is the authoritative source for remaining distance and time. A few values are
 * calculated from game values; they are approximate and labelled as such.
 *
 * Every value keeps its provenance:
 * - `game`: as reported by the game.
 * - `calculated`: derived by RoadPilot from game values (approximate).
 * - `unavailable`: no current value (its `Reading` says why: missing, invalid or no data).
 */
import { fieldsFromPaths, read, type Reading } from './reading'
import type { DashboardSnapshot, NavigationField } from './types'
import { dataCurrent, type Link } from './vehicle'

export type Provenance = 'game' | 'calculated' | 'unavailable'

export interface Sourced<T> {
  source: Provenance
  reading: Reading<T>
}

export type SpeedLimit = { kind: 'limit'; kmh: number } | { kind: 'none' }

export interface RouteView {
  /** Route Advisor distance to the current navigation target. */
  remainingDistanceKm: Sourced<number>
  /** Route Advisor time estimate. Its time scale (game or real time) is not confirmed. */
  remainingTimeMin: Sourced<number>
  speedLimit: Sourced<SpeedLimit>
  /** Planned distance of the active job, as reported by the game. */
  jobDistanceKm: Sourced<number>
  /** Calculated: job distance minus Route Advisor distance, at least 0. Approximate. */
  drivenDistanceKm: Sourced<number>
  /** Calculated: driven share of the job distance. Approximate. */
  progressPercent: Sourced<number>
  /** Progress values exist only for an active job. */
  jobActive: boolean
  /** The game reports a job state other than active (none, delivered, cancelled). */
  noActiveJob: boolean
  demo: boolean
}

function sourced<T>(origin: 'game' | 'calculated', reading: Reading<T>): Sourced<T> {
  return { source: reading.kind === 'value' ? origin : 'unavailable', reading }
}

/** The weakest input decides: no data, then invalid, then missing. */
function weakest(...readings: Reading<unknown>[]): Reading<never> | null {
  for (const kind of ['noData', 'invalid', 'missing'] as const)
    if (readings.some((r) => r.kind === kind)) return { kind }
  return null
}

export function routeView(snapshot: DashboardSnapshot, current: Link): RouteView {
  const isCurrent = dataCurrent(snapshot, current) && snapshot.navigation !== null
  const nav = snapshot.navigation
  const invalidNav = new Set(snapshot.telemetry?.invalidNavigationFields ?? [])
  const invalidJob = new Set(snapshot.telemetry?.invalidJobFields ?? [])
  const navRead = <K extends NavigationField>(field: K) =>
    read(nav?.[field], { current: isCurrent, invalid: invalidNav.has(field) })

  const distance = navRead('distanceKm')
  const time = navRead('etaMinutes')
  const shown = navRead('speedLimitShown')
  const limit = navRead('speedLimitKmh')
  const speedLimit: Reading<SpeedLimit> =
    weakest(shown) ??
    (shown.kind === 'value' && !shown.value
      ? { kind: 'value', value: { kind: 'none' } }
      : limit.kind === 'value'
        ? { kind: 'value', value: { kind: 'limit', kmh: limit.value } }
        : limit)

  const job = dataCurrent(snapshot, current) ? snapshot.job : null
  const jobActive = job?.state === 'active'
  const jobRead = (value: number | null, field: 'plannedDistanceKm' | 'progressPercent') =>
    read(jobActive ? value : null, { current: isCurrent, invalid: invalidJob.has(field) })
  const planned = jobRead(job?.plannedDistanceKm ?? null, 'plannedDistanceKm')
  const progress = jobRead(job?.progressPercent ?? null, 'progressPercent')
  const driven: Reading<number> =
    weakest(planned, distance) ??
    (planned.kind === 'value' && distance.kind === 'value'
      ? { kind: 'value', value: Math.max(0, planned.value - distance.value) }
      : { kind: 'missing' })

  return {
    remainingDistanceKm: sourced('game', distance),
    remainingTimeMin: sourced('game', time),
    speedLimit: sourced('game', speedLimit),
    jobDistanceKm: sourced('game', planned),
    drivenDistanceKm: sourced('calculated', driven),
    progressPercent: sourced('calculated', progress),
    jobActive,
    noActiveJob: job !== null && !jobActive,
    demo: snapshot.mode === 'demo',
  }
}

/** Telemetry wire paths (as reported in `invalidFields`) and the Route Advisor values. */
export const NAVIGATION_INVALID_TARGETS: Readonly<Record<string, readonly NavigationField[]>> = {
  'navigation.distanceM': ['distanceKm'],
  'navigation.timeS': ['etaMinutes'],
  'navigation.speedLimitMps': ['speedLimitKmh', 'speedLimitShown'],
}

export function invalidNavigationFields(wirePaths: readonly string[]): NavigationField[] {
  return fieldsFromPaths(NAVIGATION_INVALID_TARGETS, wirePaths)
}
