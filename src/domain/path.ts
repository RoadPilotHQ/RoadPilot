/**
 * The path the truck has traveled, traced from telemetry positions. This is not a map: no
 * roads, no route, no geographic claim. Coordinates stay in the telemetry convention (SDK
 * world space in metres: X east, Z south); nothing is scaled or transformed.
 *
 * Pure and deterministic: the caller passes snapshots and the time.
 */
import type { DashboardSnapshot, GameId } from './types'
import { link } from './vehicle'

export interface PathPoint {
  /** Metres east. */
  x: number
  /** Metres south. */
  z: number
}

export interface PathTrace {
  /** The game the trace belongs to; a different game starts a new trace. */
  game: GameId | null
  /** Continuous pieces. A jump (ferry, train, teleport, new session) starts a new one. */
  segments: readonly (readonly PathPoint[])[]
  /** The newest accepted position, with its heading and receive time. */
  last: (PathPoint & { headingDeg: number; atUnixMs: number }) | null
  points: number
  /** Positions skipped because they were not finite or out of range. */
  rejected: number
  /** Increases with every change, for cheap change detection. */
  version: number
}

export const PATH_LIMITS = {
  /** A new point is stored only after the truck moved this far (metres). */
  minStepM: 2,
  /** A move longer than this between two samples is a jump, not driving (metres). */
  jumpM: 1000,
  /** When the trace grows beyond this, every second point is dropped (start and end stay). */
  maxPoints: 4000,
  /** Positions beyond this are not plausible game coordinates (metres). */
  maxAbsCoordinateM: 10_000_000,
} as const

export const EMPTY_TRACE: PathTrace = {
  game: null,
  segments: [],
  last: null,
  points: 0,
  rejected: 0,
  version: 0,
}

const plausible = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= PATH_LIMITS.maxAbsCoordinateM

/** Keeps the first and the last point and every second one in between. */
function halve(points: readonly PathPoint[]): PathPoint[] {
  if (points.length <= 2) return [...points]
  const kept = points.filter((_, i) => i % 2 === 0)
  const end = points[points.length - 1]!
  if (kept[kept.length - 1] !== end) kept.push(end)
  return kept
}

/**
 * Adds one snapshot to the trace and returns the new trace, or the same object when nothing
 * changed. Only live, current positions are recorded: demo data, stale or interrupted links
 * and missing positions add nothing.
 */
export function addToTrace(
  trace: PathTrace,
  snapshot: DashboardSnapshot,
  nowUnixMs: number,
): PathTrace {
  // Never mix games: a different game discards everything of the previous one.
  if (snapshot.game !== null && trace.game !== null && snapshot.game !== trace.game) {
    trace = { ...EMPTY_TRACE, version: trace.version + 1 }
  }
  if (snapshot.mode !== 'live' || link(snapshot, nowUnixMs).state !== 'connected') return trace
  const p = snapshot.position
  if (!p || !snapshot.telemetry) return trace
  if (!plausible(p.x) || !plausible(p.z) || !Number.isFinite(p.headingDeg)) {
    return {
      ...trace,
      game: snapshot.game,
      rejected: trace.rejected + 1,
      version: trace.version + 1,
    }
  }

  const point = { x: p.x, z: p.z }
  const last = {
    ...point,
    headingDeg: p.headingDeg,
    atUnixMs: snapshot.telemetry.receivedAtUnixMs,
  }
  // Segments are append-only: a new point is pushed onto the open segment instead of copying
  // it, so a long drive costs O(1) per point. Every change still returns a new trace object;
  // only the newest trace is ever read.
  const segments = trace.segments.slice() as PathPoint[][]
  const current = segments[segments.length - 1]
  const tail = current?.[current.length - 1]
  const step = tail ? Math.hypot(point.x - tail.x, point.z - tail.z) : Infinity
  let points = trace.points

  if (!current || !tail || step > PATH_LIMITS.jumpM) {
    segments.push([point])
    points += 1
  } else if (step >= PATH_LIMITS.minStepM) {
    current.push(point)
    points += 1
  } else if (
    trace.last &&
    trace.last.x === last.x &&
    trace.last.z === last.z &&
    trace.last.headingDeg === last.headingDeg
  ) {
    // Standing still (or paused): nothing new.
    return trace.game === snapshot.game ? trace : { ...trace, game: snapshot.game }
  }

  let kept = segments
  if (points > PATH_LIMITS.maxPoints) {
    kept = segments.map(halve).filter((s) => s.length > 0)
    points = kept.reduce((n, s) => n + s.length, 0)
  }
  return {
    game: snapshot.game,
    segments: kept,
    last,
    points,
    rejected: trace.rejected,
    version: trace.version + 1,
  }
}

/** Axis-aligned bounds of the trace in metres, or `null` when it is empty. */
export function traceBounds(
  trace: PathTrace,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  let b: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null
  for (const s of trace.segments)
    for (const p of s) {
      if (!b) b = { minX: p.x, maxX: p.x, minZ: p.z, maxZ: p.z }
      else {
        b.minX = Math.min(b.minX, p.x)
        b.maxX = Math.max(b.maxX, p.x)
        b.minZ = Math.min(b.minZ, p.z)
        b.maxZ = Math.max(b.maxZ, p.z)
      }
    }
  return b
}
