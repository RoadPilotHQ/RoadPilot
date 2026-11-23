/* global setTimeout, clearTimeout */
/**
 * B1.5.4B (defect A): screenshot evidence of one harness run. Pure logic; file access comes in
 * through `exists` and `write`, so it is unit-tested without a browser
 * (`src/dev/mapLibreLab/tests/screenshotEvidence.test.ts`).
 *
 * Root cause of B1.5.4's collision: `run.mjs` built names from scenario and view only
 * (`A-basic-${name}-${tag}`), and the functional sequence captured view `whole` twice (the opening
 * shot and the first label view). The second write met the no-overwrite rule (`wx`), threw, and
 * the whole label step was recorded as a failed functional step.
 *
 * Naming: `<test>-<seq>-<scenario>-<view>-<adapter>.png`, `seq` = three-digit capture number of
 * this recorder (001, 002, …). The sequence number alone makes every name of one run unique and
 * deterministic (same run order, same names); the other parts say what the picture shows.
 *
 * Rules:
 * - never overwrite: a name that exists on disk is not written (status `failed`, reason `exists`),
 *   and `write` must itself refuse existing files (`wx`);
 * - a duplicate name inside one run is a harness defect: refused and recorded, never written;
 * - `capture` never throws: a failed capture or write is recorded with its stage and error, so it
 *   cannot fail the functional step around it. `report.mjs` judges the records separately
 *   (criterion `screenshots`).
 */

const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i

export const CAPTURE_TIMEOUT_MS = 10_000

const errorText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/** The file name of one capture; throws for parts that would make it ambiguous. */
export function screenshotName({ test, seq, scenario, view, adapter }) {
  for (const [k, v] of Object.entries({ test, scenario, view, adapter }))
    if (typeof v !== 'string' || !TOKEN.test(v)) throw new Error(`invalid screenshot ${k}: ${v}`)
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) throw new Error(`invalid sequence ${seq}`)
  return `${test}-${String(seq).padStart(3, '0')}-${scenario}-${view}-${adapter}.png`
}

/**
 * @param {object} o
 * @param {string} o.test      test name (`functional`)
 * @param {string} o.adapter   adapter tag (`amd`, `nv`)
 * @param {(name: string) => boolean} o.exists     whether a file of that name exists in the session
 * @param {(name: string, png: Buffer) => void} o.write  writes; must refuse existing files (`wx`)
 * @param {(b64: string) => Buffer} o.decode
 * @param {number} [o.timeoutMs]
 */
export function createScreenshotRecorder({
  test,
  adapter,
  exists,
  write,
  decode,
  timeoutMs = CAPTURE_TIMEOUT_MS,
}) {
  const records = []
  const used = new Set()
  let seq = 0
  return {
    /**
     * Captures one screenshot through `grab()` (resolves to base64 PNG). Never throws; returns the
     * record ({ seq, name, scenario, view, status: 'saved' | 'failed', stage, error }).
     */
    async capture({ scenario, view }, grab) {
      seq++
      const rec = { seq, name: null, scenario, view, status: 'failed', stage: 'name', error: null }
      records.push(rec)
      try {
        rec.name = screenshotName({ test, seq, scenario, view, adapter })
        if (used.has(rec.name)) throw new Error(`duplicate screenshot name ${rec.name}`)
        used.add(rec.name)
        if (exists(rec.name)) throw new Error(`exists: ${rec.name} (not overwritten)`)
        rec.stage = 'capture'
        let timer
        const data = await Promise.race([
          Promise.resolve().then(grab),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`capture did not answer within ${timeoutMs} ms`)),
              timeoutMs,
            )
          }),
        ]).finally(() => clearTimeout(timer))
        if (typeof data !== 'string' || data.length === 0) throw new Error('empty capture')
        rec.stage = 'write'
        const png = decode(data)
        write(rec.name, png)
        rec.bytes = png.length
        rec.status = 'saved'
        rec.stage = null
      } catch (e) {
        rec.error = errorText(e)
      }
      return { ...rec }
    },
    records: () => records.map((r) => ({ ...r })),
  }
}
