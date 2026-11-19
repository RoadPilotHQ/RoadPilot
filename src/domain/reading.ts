/**
 * How a displayed telemetry value is read. Shared by the vehicle, job and route views so that
 * every section treats missing, invalid and stale data the same way.
 */

/**
 * One displayed value:
 * - `value`: current and valid.
 * - `missing`: supported by RoadPilot, but this game, plugin or frame did not provide it.
 * - `invalid`: provided, but rejected as invalid (non-finite or implausible).
 * - `noData`: there is no current telemetry at all (not connected, interrupted or stale).
 */
export type Reading<T> =
  { kind: 'value'; value: T } | { kind: 'missing' } | { kind: 'invalid' } | { kind: 'noData' }

export function read<T>(
  value: T | null | undefined,
  { current, invalid }: { current: boolean; invalid: boolean },
): Reading<NonNullable<T>> {
  if (!current) return { kind: 'noData' }
  if (invalid) return { kind: 'invalid' }
  return value == null ? { kind: 'missing' } : { kind: 'value', value: value as NonNullable<T> }
}

/**
 * Checks values at the UI boundary. The telemetry reader already removed invalid values; this
 * is a second line of defence: a value of the wrong type or outside its range is added to
 * `invalid` and returned as `null`, never shown as a number.
 */
export function boundaryChecks<F extends string>(invalid: Set<F>) {
  const reject = (field: F) => {
    invalid.add(field)
    return null
  }
  const num = (field: F, value: unknown, ok: (n: number) => boolean = () => true) =>
    value == null
      ? null
      : typeof value === 'number' && Number.isFinite(value) && ok(value)
        ? value
        : reject(field)
  const flag = (field: F, value: unknown) =>
    value == null ? null : typeof value === 'boolean' ? value : reject(field)
  const text = (field: F, value: unknown) =>
    value == null ? null : typeof value === 'string' ? value : reject(field)
  return { num, flag, text, reject }
}

export const nonNegative = (n: number) => n >= 0
export const count = (n: number) => Number.isInteger(n) && n >= 0

/** Maps reported wire paths to the fields they feed. */
export function fieldsFromPaths<F extends string>(
  targets: Readonly<Record<string, readonly F[]>>,
  wirePaths: readonly string[],
): F[] {
  const fields = new Set<F>()
  for (const path of wirePaths) targets[path]?.forEach((f) => fields.add(f))
  return [...fields]
}
