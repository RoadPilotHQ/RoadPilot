/**
 * B1.5.4G: the explicit negative-control mode of run.mjs (pure; tests:
 * `src/dev/mapLibreLab/tests/negativeControl.test.ts`).
 *
 *   node tools/maplibre-validation/run.mjs control --negative-control --confirm-runtime
 *
 * A negative control deliberately reproduces the B1.5.4D app-page race, to show at runtime that
 * report.mjs `appPageIsolation` classifies it INVALID: the dev server does NOT switch `/` to the
 * placeholder, openlab.mjs does NOT require the marker but waits until the RoadPilot app page has
 * rendered (its React root has children, so `src/app/main.tsx` ran and made its IPC calls) and only
 * then navigates to the lab; the session then holds the lab for `CONTROL_HOLD_MS`. All isolation
 * evidence is collected as in every other mode.
 *
 * A control session is never a measurement: it runs no functional, label, perf, memory or cycles
 * step, its result file and session record are named `negative-control-*`, it carries
 * `control.kind = 'negative-control'`, and report.mjs judges it only as a control
 * (`negativeControl`, always INVALID as a measurement; `outcome` says whether the detector caught
 * the contamination).
 */

export const NEGATIVE_CONTROL_FLAG = '--negative-control'
/** The run.mjs mode of the control; accepted only together with the flag. */
export const CONTROL_MODE = 'control'
/** `control.kind` of the result, and the file / label prefix. */
export const CONTROL_KIND = 'negative-control'
/** How long the lab stays open after it is ready (`control:status` is emitted every 200 ms). */
export const CONTROL_HOLD_MS = 2_000

/** Options that select or repeat measurements; none of them is valid for a control. */
const REFUSED_WITH_CONTROL = Object.freeze(['kinds', 'only', 'runs', 'kind', 'out'])

/** Default session folder of a control: always its own, never a measurement folder. */
export const controlSessionName = (stamp) => `${CONTROL_KIND}-${stamp}`

/**
 * Checks the command line before anything starts.
 * @returns {{ ok: true, negativeControl: boolean } | { ok: false, error: string }}
 */
export function validateRunArgs(mode, args) {
  const list = Array.isArray(args) ? args : []
  const negativeControl = list.includes(NEGATIVE_CONTROL_FLAG)
  if (mode === CONTROL_MODE && !negativeControl)
    return {
      ok: false,
      error: `mode "${CONTROL_MODE}" runs only with the explicit ${NEGATIVE_CONTROL_FLAG} flag`,
    }
  if (!negativeControl) return { ok: true, negativeControl: false }
  if (mode !== CONTROL_MODE)
    return {
      ok: false,
      error: `${NEGATIVE_CONTROL_FLAG} is only allowed with mode "${CONTROL_MODE}", not "${mode ?? ''}" (a control is never a functional, perf, memory, labels or cycles measurement)`,
    }
  const refused = REFUSED_WITH_CONTROL.filter((o) => list.some((a) => a.startsWith(`--${o}=`)))
  if (refused.length)
    return {
      ok: false,
      error: `${NEGATIVE_CONTROL_FLAG} does not accept ${refused.map((o) => `--${o}`).join(', ')}`,
    }
  const attempts = list.find((a) => a.startsWith('--attempts='))
  if (attempts !== undefined && attempts !== '--attempts=1')
    return { ok: false, error: `${NEGATIVE_CONTROL_FLAG} runs exactly one attempt (no retries)` }
  return { ok: true, negativeControl: true }
}
