# MapLibre B1 runtime validation (harness)

How the runtime criteria of the MapLibre prototype ([maplibre-prototype.md](maplibre-prototype.md)) will be measured.

> **Status: prepared, not run.** The harness has been written and its evaluation logic unit-tested (B1.4). It has **never** started RoadPilot, a browser or any measurement. Every runtime criterion of B1 is still NOT TESTED. Running it needs a separate approval.

## Location

`tools/maplibre-validation/` in this repository:

| File           | Role                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`      | Driver. Collects data only; every verdict comes from `report.mjs`                                                           |
| `report.mjs`   | Pure evaluation: thresholds and verdict rules (no I/O). Unit-tested in `src/dev/mapLibreLab/tests/validationReport.test.ts` |
| `report.d.mts` | Types of `report.mjs` for the tests                                                                                         |
| `cdp.mjs`      | Starts and closes RoadPilot's debug build, DevTools connection, request / console / worker instrumentation, heaps           |
| `sampler.ps1`  | Read-only memory sampler of RoadPilot's own processes (matched by the app identifier)                                       |
| `out/`         | Results, memory samples, screenshots and reports (ignored by Git)                                                           |

All paths derive from the repository. The app identifier and the dev-server URL are read from `src-tauri/tauri.conf.json`.

## Required environment

- Windows with WebView2 (PowerShell, `taskkill`, the `GPU Process Memory` performance counters). Linux / WebKitGTK is not supported by this harness.
- `npm run dev` running (Vite on the `devUrl` of `tauri.conf.json`, `127.0.0.1:1420`).
- A current debug build: `src-tauri/target/debug/roadpilot.exe`.
- An idle desktop. Before every start the harness refuses to run when NVIDIA utilisation exceeds 25 % (if `nvidia-smi` exists) or when `amtrucks` / `eurotrucks2` (or processes named with `--busy=`) are running. It never stops any process. The harness does not start a game, telemetry or input of any kind; RoadPilot's settings are not touched.
- Node ≥ 22.12 (built-in `fetch` and `WebSocket`).

## Invocation (later, after approval)

```
node tools/maplibre-validation/run.mjs functional --confirm-runtime            # AMD (default GPU)
node tools/maplibre-validation/run.mjs perf --confirm-runtime                  # 100k and 1M, MapLibre and M3, 3 runs each, A B B A A B
node tools/maplibre-validation/run.mjs perf --confirm-runtime --kinds=maplibre-nolabels,m3
node tools/maplibre-validation/run.mjs cycles --confirm-runtime --only=stress  # 8 zoom cycles, memory
node tools/maplibre-validation/run.mjs functional --confirm-runtime --nv       # RTX via --force_high_performance_gpu
node tools/maplibre-validation/run.mjs report                                  # offline: report-amd.json, report-nv.json
```

Without `--confirm-runtime`, `functional`, `perf` and `cycles` print a notice and exit with code 2 without starting anything; `launchApp` itself also refuses without confirmation. `report` reads saved files only. Options: `--out=<dir>`, `--only=urban|stress`, `--kinds=a,b` (`maplibre`, `maplibre-nolabels`, `m3`), `--runs=n` (fewer than 3 makes the report INVALID), `--kind=` for `cycles`, `--tag=amd|nv` for `report`.

Every run is a fresh app start with WebView2 arguments set only in that child process (`--remote-debugging-port`, occlusion throttling off, optionally `--force_high_performance_gpu`), window emulated at 1280 × 900 CSS px (map area 980 × 900), DPR 1 (DPR 1.5 for one accuracy pass). The app is closed with a normal window close.

## Verdicts and failure states

`report.mjs` assigns every criterion one of:

| Verdict      | Meaning                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`       | Recorded evidence meets the criterion                                                                                                                          |
| `FAIL`       | Recorded evidence violates the criterion                                                                                                                       |
| `INVALID`    | The run cannot decide: missing or malformed data, an infrastructure error, a step that threw, too few runs, a broken request log. Repeat the run; never a pass |
| `NOT_TESTED` | No data for this criterion in the report                                                                                                                       |

Combination: any `FAIL` → `FAIL`; else any `INVALID` → `INVALID`; else any `NOT_TESTED` → `NOT_TESTED`; `PASS` only when everything passes. Labels always stay `NOT_TESTED` (visual review of the screenshots), so the overall verdict is never an automatic `PASS`. Memory criteria also stay `NOT_TESTED` while their threshold is provisional (see [Memory growth](#memory-growth-provisional-diagnostic)); only missing or broken memory data changes them (to `INVALID`).

Rules that prevent a silent pass:

- A functional step that throws is recorded in `failedSteps` and the run continues; its criterion is `INVALID`, and `functionalSteps` is `INVALID`.
- A perf run that throws (for example a `LoadTimeoutError` from the lab) is saved with `error` and the series continues; the criterion over its runs is then `INVALID`.
- Accuracy: an `infrastructure_error` from the lab (probe layer or source missing, nothing measured, non-finite values) is `INVALID`, never a rendering failure and never a pass. The harness also checks the lab's `withinTolerance` against the numbers, rejects a tolerance other than 0.5 px, and never assumes `results` exists.
- Network: if the log contains no request for the lab page itself, the instrumentation did not work → `INVALID`. Without a CSP log → `INVALID`.
- A MapLibre run whose first-visible frame had no road pixel, or an M3 run that drew no segment, is `INVALID`.

## Criteria and thresholds

From the B1 brief (section 9 and 10) and ADR-003, unchanged:

| Criterion              | 100k (`urban`)                                                                 | 1M (`stress`)                 | Evidence used                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------- |
| First visible geometry | ≤ 100 ms                                                                       | ≤ 500 ms                      | Cold load (fresh app) `firstMs`                                                        |
| Frame gap p95          | ≤ 20 ms                                                                        | ≤ 33 ms                       | Worst of the 3 s pan and the three zoom cycles                                         |
| Frame gap maximum      | ≤ 50 ms                                                                        | ≤ 75 ms                       | Worst of the same four phases                                                          |
| Pan responsive         | covered by the two gap limits                                                  | covered by the two gap limits | Pan phase                                                                              |
| External requests      | 0                                                                              | 0                             | Functional run and every perf run (page and workers)                                   |
| Runs                   | ≥ 3 valid, every run passing                                                   | ≥ 3 valid, every run passing  | A criterion over runs passes only if no run is invalid and every run meets every limit |
| Positional error       | ≤ 0.5 CSS px                                                                   |                               | `scs` at three sizes, `identity`, `scs` at DPR 1.5; no missing probe dot               |
| CSP                    | 0 violations                                                                   |                               | Lab's violation log plus DevTools log entries                                          |
| Context loss           | drawn pixels after restore, no map error                                       |                               | `contextLoss()`                                                                        |
| Release / remount      | 0 canvases, 0 listeners, 0 pending waits after release; 1 canvas after remount |                               | `release()`, `state()`, `remount()`                                                    |
| WebGL errors           | `gl.getError()` = 0 after every phase                                          |                               | `run()`                                                                                |
| Memory                 | **no approved threshold**; see below (always `NOT_TESTED` or `INVALID`)        |                               | `cycles` mode                                                                          |

### Memory growth (provisional diagnostic)

The B1 brief asks for "no continuous memory growth" and gives no number. **No numeric memory acceptance criterion has been approved.**

The harness computes one **provisional diagnostic threshold** (B1.4 proposal, B1.4.1 status):

- 8 zoom cycles in one app session after one warm-up cycle; cycles 1–4 count as settling (M3 saw memory settle within 3–5 cycles).
- Growth from cycle 5 to cycle 8 for each series: total, GPU process, renderer process, dedicated GPU memory, main-thread heap, worker heaps after GC.
- Each series is flagged when it grows by more than 5 % (the ±5 % memory target of M2).

Status and effect in `report.mjs` (`MEMORY.status = 'provisional'`):

- The 5 % value is a **diagnostic, not an independently approved production acceptance criterion.**
- `evaluateMemoryCycles` reports the calculation as `diagnostic` (`growthLimit`, `growth` per series, `over`, and `within_provisional_limit` / `above_provisional_limit`).
- The criterion's verdict is always `NOT_TESTED`, with reason `provisional_threshold_not_approved`. The diagnostic can never produce a `PASS` or a `FAIL`, and it cannot contribute to an overall `PASS`.
- Missing cycles, missing series or a failed run are still `INVALID`.
- Memory becomes an acceptance criterion only after an explicit approval of a threshold and a matching change to `evaluateMemoryCycles` and its tests.

**Measured and diagnostic values.** Acceptance values are only those in the table. Everything else is recorded as a diagnostic: warm-load first visible (same data, new renderer), complete geometry, idle, `setData` time, data preparation, render CPU time, FPS, settle time after zoom, medians over runs, memory maxima per run, the memory growth above, label counts, screenshots (labels, thin roads, urban), the `apiChecks()` results (orientation, picking, `fitBounds`, rotation). M3 runs use the same harness, data, window and camera, and each renderer is evaluated against the same thresholds on its own. The report does not compute a MapLibre-versus-M3 comparison. For first visible geometry the two measurements are **not** equivalent (see [Comparison with M3](#comparison-with-m3-b141)).

## First visible geometry (B1.4 definition)

**The first rendered frame containing at least one pixel of the road line layers.**

Method (`src/dev/mapLibreLab/roadPixels.ts`, used by `loadMapLibreData`):

1. From `setData` on, every MapLibre `render` event after the first road tile arrived is examined.
2. A one-pixel read-back waits for the GPU (as in M3); the time is taken then.
3. The whole drawing buffer is read back and every pixel classified. A pixel is road geometry when each channel is within ±4 of the colour of a **detectable** road layer.
4. A road layer is detectable when its colour lies more than 4 · √3 (Euclidean RGB) away from the convex hull of all non-road colours the mounted style draws: background, and with labels the halo, both text colours and the motorway label colour, and with probes the probe colour. Every antialiased, halo, SDF-edge or alpha-blended pixel of those layers is a mix of these colours, so it lies in that hull and can never match. Controls and overlays are DOM elements outside the drawing buffer.
5. The detectable set is computed from the style colours, not hard-coded, and recorded with each load as `roadDetectionLayers`.

Result for the current style (FACT, unit test):

| Style content                    | Detectable road layers                  |
| -------------------------------- | --------------------------------------- |
| Labels on (perf kind `maplibre`) | motorway fill only                      |
| Labels off (`maplibre-nolabels`) | every road fill and the motorway casing |

With labels on, the beige fills of the other classes can also be produced by mixing halo, text and background. So first visible geometry with labels is detected from motorway pixels, about 3 % of the segments of B and C. A frame whose only road pixels belong to other classes is not counted, which can only make the reported time later, never earlier. The `maplibre-nolabels` runs measure with every road layer. Probes do not change either set (unit test); perf runs use `probes: false`.

### Comparison with M3 (B1.4.1)

Static review of `loadMapLibreData` and `loadM3Data` (`src/dev/mapLibreLab/main.ts`), `WebGL2RoadRenderer.drawCoverage` and `run.mjs` (`CONFIGS`, `perfRun`).

Which road pixels can be detected:

| Run kind            | Labels drawn              | Road pixels that count                                | Road pixels that cannot count                                      |
| ------------------- | ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `maplibre`          | yes                       | motorway fill interior (±4 per channel)               | primary, secondary, local, minor fills; motorway casing; all edges |
| `maplibre-nolabels` | no                        | every road fill interior and the motorway casing (±4) | antialiased edges (mixes with the background)                      |
| `m3`                | none (M3 draws no labels) | **no pixel classification.** M3 counts drawn segments | —                                                                  |

What each method measures (FACT, source):

| Aspect                 | MapLibre (`loadMapLibreData`)                                                                                                                                  | M3 (`loadM3Data`)                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clock start            | after GeoJSON preparation, immediately before `setData`                                                                                                        | immediately before `setTiles`; tile building ran earlier in `mountM3`, outside the timed load                                                    |
| Work inside the window | `setData`, worker tiling of the GeoJSON, tile transfer, rendering                                                                                              | upload within the upload budget (`DEFAULT_UPLOAD_BUDGET_MS`, 6 ms) and rendering of the first frame                                              |
| Which frame            | the first MapLibre `render` event, after the first road tile arrived, whose read-back contains ≥ 1 detectable road pixel                                       | always the first `render()` call, made synchronously after `setTiles`                                                                            |
| Evidence of geometry   | `countRoadPixels` over the whole drawing buffer (`firstRoadPixels`)                                                                                            | `stats.segments`: the instance count submitted in draw calls (`drawCoverage`: `segments += e.instances`), not pixels on screen (`firstSegments`) |
| GPU synchronisation    | one-pixel read-back, time taken, then the full read-back                                                                                                       | one-pixel read-back, time taken                                                                                                                  |
| Same in both           | dataset (`toM3Scenario`, identical coordinates), window 1280 × 900, map area 980 × 900, DPR 1, camera, CRS `scs`, `probes: false`, fresh app per run, same GPU |                                                                                                                                                  |

Conclusions:

- **The detection methods are not equivalent.** MapLibre requires classified road pixels in the read-back; M3 requires a non-zero count of submitted segment instances. Submitted instances do not prove that a pixel was drawn (segments of a visible tile may lie outside the viewport).
- **The timed work is not equivalent.** M3's time excludes tiling (as in the M3 lab). MapLibre's time includes its worker tiling, because tiling only starts with `setData`, and excludes the GeoJSON build.
- **Label configuration.** A fair comparison needs the same label configuration and rendering conditions. M3 draws no labels, so only `maplibre-nolabels` matches M3. The `maplibre` kind (labels on, motorway-only detection) must not be compared with M3 for first visible geometry; it is evaluated against the thresholds on its own.
- **Equivalence cannot be established statically.** Any MapLibre-versus-M3 statement about first visible geometry, including `maplibre-nolabels` against `m3`, is marked **REQUIRES RUNTIME VERIFICATION**. Neither the acceptance thresholds nor the per-renderer verdicts change. Both renderers are still evaluated against the same limits.

## Result format

Files in `out/`, with `<tag>` = `amd` or `nv`:

- `functional-<tag>.json`: `env` (WebView2 version, GPU, screen, initial lab error), `steps` (`accuracyScs`, `accuracyIdentity`, `accuracyScsDpr15` as the lab's B1.2 summary plus `worst`; `apiScs`, `apiIdentity`, `labels`, `contextLoss`, `releaseRemount`, `urbanLabelsZ10`, `finalState`), `failedSteps`, `network` (requests since navigation, page origin, CSP violations, MapLibre requests), `console`, `exceptions`, `workers`, `close`.
- `accuracy-<key>-<tag>.json`: the full accuracy result, including every probe.
- `perf-<kind>-<scenario>-<n>-<tag>.json`: `cold` and `warm` load results, `datasetSegments`, `pan`, `zoom[3]`, `heap`, `memory`, `memoryAfterLoad`, `network`, `exceptions`, `errors`, `close`, `error` if the run failed, `samples`.
- `cycles-<kind>-<scenario>-<tag>.json`: per cycle frame gaps, heaps and memory; `error` if failed.
- `report-<tag>.json` (`report` mode): thresholds, tolerance, `minRuns`, the memory rule (`memoryRule.status = 'provisional'`), every criterion with `verdict`, `reason`, `metrics` / `checks` / per-run details (memory criteria: `diagnostic`), and `overall`.

## Open runtime questions

Everything in the [acceptance matrix](maplibre-prototype.md#acceptance-matrix) marked NOT TESTED. In addition, for the harness itself:

- Whether it works end to end. The DevTools, worker auto-attach and sampler code paths were used in M3 but have not run in this form.
- Whether the lab's first configuration on page load finishes before the harness's first `configure` call. The harness waits for it, up to 80 s.
- Whether `state().listeners` and `pendingWaits` are 0 after `release()` in a real browser.
- Whether MapLibre's line interiors are drawn exactly in the style colours, which the ±4 tolerance assumes (opaque lines on an opaque background, no colour management in WebGL).
- Whether first visible geometry of `maplibre-nolabels` and `m3` can be compared at all, given the different detection methods and timed work ([Comparison with M3](#comparison-with-m3-b141)). One way to check this at runtime would be to apply the same pixel classification to M3's first frame. That is not implemented.
- Which numeric memory growth limit, if any, is approved as an acceptance criterion.
