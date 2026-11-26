# MapLibre B1 runtime validation (harness)

How the runtime criteria of the MapLibre prototype ([maplibre-prototype.md](maplibre-prototype.md)) will be measured.

> **Status (B1.5.5, 2026-11-26): harness validated in RoadPilot's WebView2 (AMD); B1 not passed.** The B1.5.4F positive series (20 of 20 valid functional sessions) and the B1.5.4F negative control (`detected`) are GO for the harness and the app-page isolation gate. The positional accuracy criteria still FAIL in every run and are unresolved; perf, memory/cycles, labels and the NVIDIA GPU are NOT TESTED. See [B1.5.4 runtime results](#b154-runtime-results-b154b154f).
>
> **History:** B1.5 (2026-11-22, AMD only) ran the harness, found two defects (workers without the projection handler; lab pages that did not open after app start) and was stopped (NO-GO). B1.5.1 corrected both statically ([B1.5.1 corrections](#b151-corrections)); B1.5.2 and B1.5.3 followed. B1.5.4B corrected three harness defects ([B1.5.4B](#b154b-harness-reliability-correction)), B1.5.4E added app-page isolation ([B1.5.4E](#b154e-app-page-isolation)), B1.5.4G the negative-control mode ([B1.5.4G](#b154g-negative-control-mode)). All three have since run in WebView2 (B1.5.4C, B1.5.4F). The B1.5 results stay in `out/` unchanged.

## Location

`tools/maplibre-validation/` in this repository:

| File                  | Role                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`             | Driver. Collects data only; every verdict comes from `report.mjs`                                                           |
| `report.mjs`          | Pure evaluation: thresholds and verdict rules (no I/O). Unit-tested in `src/dev/mapLibreLab/tests/validationReport.test.ts` |
| `report.d.mts`        | Types of `report.mjs` for the tests                                                                                         |
| `openlab.mjs`         | B1.5.1: staged, bounded lab opening with failure diagnostics and safe retry. Unit-tested in `tests/openLab.test.ts`         |
| `openlab.d.mts`       | Types of `openlab.mjs` for the tests                                                                                        |
| `cdp.mjs`             | Starts and closes RoadPilot's debug build, DevTools connection, request / console / worker instrumentation, heaps           |
| `lifecycle.mjs`       | B1.5.4B: one session, preflight to cleanup (`tests/sessionLifecycle.test.ts`)                                               |
| `devserver.mjs`       | B1.5.4B: the session's own Vite dev server: readiness stages, ownership, graceful stop (`tests/devServer.test.ts`)          |
| `devserver-node.mjs`  | B1.5.4B: its real process, HTTP, port-owner and process-tree access, by PID only (`tests/devServerProcess.test.ts`)         |
| `viteserver.mjs`      | B1.5.4B: the forked dev server (Vite JS API, `vite.config.ts`), IPC `listening` / `shutdown` / `closed`                     |
| `evidence.mjs`        | B1.5.4B: screenshot recorder, unique deterministic names, never overwrites (`tests/screenshotEvidence.test.ts`)             |
| `placeholder.mjs`     | B1.5.4E: the app-page placeholder switch of the harness-owned dev server (`tests/placeholder.test.ts`)                      |
| `negativecontrol.mjs` | B1.5.4G: the explicit negative-control mode: command-line checks and names (`tests/negativeControl.test.ts`)                |
| `*.d.mts`             | Types of the modules above for the tests                                                                                    |
| `sampler.ps1`         | Read-only memory sampler of RoadPilot's own processes (matched by the app identifier)                                       |
| `out/`                | Results (ignored by Git). B1.5 evidence in the root; every later run in its own session folder `out/<session>/`             |

All paths derive from the repository. The app identifier and the dev-server URL are read from `src-tauri/tauri.conf.json`.

## Required environment

- Windows with WebView2 (PowerShell, `taskkill`, the `GPU Process Memory` performance counters). Linux / WebKitGTK is not supported by this harness.
- The `devUrl` port of `tauri.conf.json` (`127.0.0.1:1420`) **free**. Since B1.5.4B the harness starts, checks and stops its own Vite dev server; do not run `npm run dev` beside it (a session refuses to start when the port is owned or answers).
- A current debug build: `src-tauri/target/debug/roadpilot.exe`.
- An idle desktop. Before every start the harness refuses to run when NVIDIA utilisation exceeds 25 % (if `nvidia-smi` exists) or when `amtrucks` / `eurotrucks2` (or processes named with `--busy=`) are running. It never stops any process. The harness does not start a game, telemetry or input of any kind; RoadPilot's settings are not touched.
- Node ≥ 22.12 (built-in `fetch` and `WebSocket`).

## Invocation (later, after approval)

```
node tools/maplibre-validation/run.mjs functional --confirm-runtime --session=b16            # AMD (default GPU)
node tools/maplibre-validation/run.mjs perf --confirm-runtime --session=b16 --kinds=maplibre,maplibre-nolabels,m3
node tools/maplibre-validation/run.mjs cycles --confirm-runtime --session=b16 --only=stress  # 8 zoom cycles, memory
node tools/maplibre-validation/run.mjs functional --confirm-runtime --session=b16 --nv       # RTX via --force_high_performance_gpu
node tools/maplibre-validation/run.mjs report --session=b16                                  # offline: report-amd.json, report-nv.json
```

Without `--confirm-runtime`, `functional`, `perf` and `cycles` print a notice and exit with code 2 without starting anything; `launchApp` itself also refuses without confirmation. `report` reads saved files only and needs `--session` or `--out`. Options: `--session=<name>` (folder `out/<name>/`; default for runtime modes: a new `run-<timestamp>` folder), `--out=<dir>`, `--only=urban|stress`, `--kinds=a,b` (`maplibre`, `maplibre-nolabels`, `m3`), `--runs=n` (fewer than 3 makes the report INVALID), `--kind=` for `cycles`, `--tag=amd|nv` for `report`, `--attempts=n` (app starts per lab opening; B1.5.4B: default 1, and a retry makes the `startup` criterion `INVALID`).

**No overwriting (B1.5.1).** A runtime mode refuses to start, before launching anything, when a result file it would write already exists in its folder. Results, screenshots and diagnostics are written with `wx` (an existing file is an error, never replaced). A rebuilt report that would replace a report gets a timestamped name instead.

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
- B1.5.1, worker projection: a MapLibre perf run is `INVALID` unless its cold load verified the handler in every worker (`cold.workerProjection.verified`), no workers were recreated during the load or the run, and MapLibre logged no "no projection handler is set in the workers" warning. The B1.5 result format has no such field, so B1.5 MapLibre runs can no longer pass. The functional criterion `workerProjection` is `FAIL` on that warning or a failed registration and `INVALID` when the state is missing, unfinished or saw a recreation.
- B1.5.1, lab opening: a functional run whose lab never opened is saved with `failedSteps: [{name: 'openLab', stage, attempts}]` and is `INVALID`; a perf or cycles run keeps `error` and `openLab`.
- B1.5.4B, `startup`: every run must open the lab at its first attempt. A failed attempt followed by a successful one is `INVALID` (`failed_attempt_before_success`), never hidden; a lab that never opened is `INVALID`.
- B1.5.4B, `screenshots`: a missing screenshot (capture, name or write failed) is `INVALID` (`screenshots_missing`) in this criterion only. It does not fail the functional step it was taken in and does not touch any measured criterion. Duplicate names are `INVALID`.
- B1.5.4B, `sessionLifecycle`: `FAIL` when cleanup failed (RoadPilot still running, or the dev server did not stop gracefully); `INVALID` when a session stage failed or did not run (preflight, dev server readiness, the measurement); `PASS` only when every stage passed.

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
- `openlab-failure-<label>-<tag>-a<n>.json` / `.png` (B1.5.1): diagnostics of every failed lab opening (see [Defect B](#defect-b-lab-page-not-opening-after-app-start)).
- B1.5.1 additions: MapLibre load results carry `workerProjection`; `state()` carries `workerProjection` (state, generation, attempts, recreations, events); perf and cycles results carry `warnings`; functional results carry `env.openLab` (attempt, failed attempts, stage timings).
- `report-<tag>.json` (`report` mode): thresholds, tolerance, `minRuns`, the memory rule (`memoryRule.status = 'provisional'`), every criterion with `verdict`, `reason`, `metrics` / `checks` / per-run details (memory criteria: `diagnostic`), and `overall`.
- B1.5.4B additions (session folders):
  - screenshots `functional-<seq>-<scenario>-<view>-<tag>.png` (replacing `A-…`, `B-…`, `D-…`), and `screenshots` in `functional-<tag>.json`: one record per capture (`seq`, `name`, `scenario`, `view`, `status`, failing `stage`, `error`);
  - `session-lifecycle-<mode>-<tag>.json`: the session's stages with verdicts and timings, the dev server (PID, readiness stage timings, child processes, module passes) and the cleanup result;
  - `vite-dev-<mode>-<tag>.log`: the dev server's own output;
  - `devserver-failure-<mode>-<tag>.json` on a failed dev server start;
  - `perf-*` and `cycles-*` carry `openLabAttempt` (attempt, failed attempts).

## B1.5.1 corrections

Static corrections of the two defects found in B1.5. Nothing was run; the tests use fakes.

### Defect A: MapLibre workers without the projection handler

**B1.5 evidence:** 8 worker sessions in one functional run, 5 MapLibre warnings "GeoJSON sources are drawn in the wrong place: no projection handler is set in the workers", one `AbortError: The workers were terminated while a message was in flight` during the handler import; the same warning during MapLibre perf runs (Vite log).

**Mechanism (FACT, MapLibre 6.19.0 source):**

- Removing the last map releases the global worker pool, which terminates its workers (`WorkerPool.release`). The lab removed its map on every `configure`. `workerCount` is 1 outside Safari, so each configuration got a new worker. The typings say the same: "Removing the last map terminates them unless `prewarm()` holds them".
- `importScriptInWorkers` remembers its url and the global dispatcher sends it to every new worker (`GlobalDispatcher.buildActors`). So the handler was **not** "registered only once"; the B1.5 description is corrected here.
- In the worker the import is an asynchronous module import (`_importScript`), and the worker handles other messages meanwhile. A GeoJSON load that runs first finds no handler: `createWorkerCRSHelper` warns once and returns `undefined`. Nothing in MapLibre makes data loads wait for an imported script.
- Unknown worker message types are answered with `null`.

**Correction (`src/dev/mapLibreLab/workerProjection.ts`, `scsProjection.worker.mjs`, `main.ts`):**

1. `prewarm()` (public, documented) holds the pool, so removing a map no longer terminates the workers.
2. _(Superseded in [B1.5.3](#b153-worker-entry-correction): the handler is no longer imported; workers start from the lab's own worker entry.)_ Registration awaits `importScriptInWorkers` (resolves after every current worker finished the import), then broadcasts a status message through `getGlobalDispatcher().broadcast` (public). The worker script answers it only after `setProjectionHandler` was really called. Every current worker must answer; a `null`, an empty answer list, or workers recreated during the check fail the attempt.
3. Attempts are bounded (3 × 15 s), concurrent callers share one registration, a failure is not cached, and every failed attempt (stage, generation, error) stays in `state().workerProjection.attempts`.
4. Every `workerscreate` increases the worker generation. Workers recreated after registration (with `prewarm()` only possible through `WorkerPool.restart`) make the state `stale`; the lab registers again and reloads its road and city data.
5. Every map mount and every data load waits for the registration. A failure fails that load with `WorkerProjectionError`; there is no fallback. Each MapLibre load result carries `workerProjection: {verified, generation, workers, recreatedDuringLoad}`.
6. The SCS transform and the `/2048` API carrier are unchanged.

**Limitation:** the worker-side status answer uses `self.worker.actor.registerMessageHandler`. MapLibre documents actor message handlers as an extension point of `importScriptInWorkers`, but names `self.actor`, which does not exist in 6.19.0; the worker exposes its actor as `self.worker.actor`. The script tries both. The handler only reports state and changes nothing in MapLibre. If MapLibre removes both, verification fails loudly; it cannot pass silently. Not a monkey patch: no MapLibre function is replaced.

**Not verified:** that real WebView2 workers behave like the fake (import timing, `prewarm()` keeping the worker across `map.remove()`, the status answer). This needs the next runtime run.

### Defect B: lab page not opening after app start

**B1.5 evidence:** 6 of 10 app starts ended in "lab page did not load" after 30 s; the dev server answered in 0.2 s; one separate start opened the lab in 2 s, with the page target already at `http://127.0.0.1:1420/` when the harness connected. The failed starts saved no URL, events, console or screenshot.

**Possible mechanism (source, not proven):** wry 0.57.1 (`src/webview2/mod.rs`, `new_in_hwnd`) creates the WebView2 environment (browser process and debugging port) and the controller (the page target) before it calls `webview.Navigate(devUrl)` at the end of `init_webview`. The old harness connected to the first `page` target, whatever its URL, and navigated at once; a navigation sent in that window is replaced by wry's own. Whether this caused the B1.5 failures cannot be shown from the saved evidence.

**Correction (`tools/maplibre-validation/openlab.mjs`, `cdp.mjs`, `run.mjs`):**

| Stage           | Condition                                                                                   | Deadline |
| --------------- | ------------------------------------------------------------------------------------------- | -------- |
| `startup`       | `launchApp` (confirmation, busy-desktop guard, debugging port)                              | 30 s     |
| `target`        | a `page` target exists (and the app has not exited); connected; requests logged             | 15 s     |
| `appNavigation` | the main frame has committed a URL on the dev server (wry's navigation done)                | 30 s     |
| `navigation`    | `Page.navigate` without `errorText`; the main frame committed the lab URL                   | 20 s     |
| `labReady`      | lab URL, `readyState` complete, `window.mapLibreLab` present; leaving the lab fails at once | 30 s     |
| `initialConfig` | the lab's first configuration has a result or an error                                      | 80 s     |

- Stages poll a condition every 100 ms against their deadline; each DevTools command is bounded to 5 s. No fixed sleep decides anything.
- A failure keeps its original stage and error. Diagnostics are captured afterwards, each part bounded and optional: stage timings, navigation and target events with timestamps, console, page exceptions, the initial target, final URL (page, frame tree, target list), navigation history, page state, screenshot, dev-server status, app port/pid/exit code, RoadPilot's process list. They are saved as `openlab-failure-<label>-a<n>.json` (+ `.png`) with unique names. A capture problem is recorded in `captureErrors` and never replaces the failure.
- Retry: up to `--attempts` (default 2; **B1.5.4B: default 1**, and the report marks any retry `INVALID`), only after the app was closed **and** no RoadPilot or RoadPilot WebView2 process is left; otherwise no retry. Refusals (no confirmation, busy desktop, app already running) are never retried and save nothing.
- A DevTools connection that closes rejects every pending and later command (`TargetClosedError`) instead of leaving it waiting.

**Not verified:** the real start-up timing of RoadPilot's WebView2 and whether the `appNavigation` stage removes the B1.5 failures. This needs the next runtime run; its diagnostics would now show the failure stage if it happens again.

## B1.5.2 revalidation (stopped)

2026-11-22, HEAD `892e16f`, WebView2 158.0.4370.33, AMD iGPU, evidence in `out/b152-20261122-175040/` (not in Git). **MEASUREMENT.**

- **Test A, lab opening:** PASS, 5 of 5 app starts (8.2–8.8 s each). The page target was already at the dev URL in every start, so the wry race window of defect B did not occur and the B1.5 cause stays unproven.
- **Test B, worker projection:** FAIL. Release, remount, four reconfigurations and the M3 round trip ran on one worker (generation 1) with no warning and every load verified. After a forced `GlobalDispatcher.workerPool.restart()` with a concurrent reconfiguration, the new worker logged MapLibre's "no projection handler" warning once. The lab detected the recreation and registered again 89 ms later, and its own reload was verified (generation 2), but the geometry MapLibre itself had sent to the new worker in between was tiled without the handler.
- Tests C–F were not run (stop rule).

## B1.5.3 worker entry correction

Correction of the B1.5.2 Test B failure. Not a runtime validation: B1.5.4 must prove it in RoadPilot's WebView2.

### Root cause

**FACT (MapLibre 6.19.0 source):** `WorkerPool.restart()` terminates the workers, starts new ones and fires `restart`, after which every map reloads its sources into the new workers on its own (`Map._handleWorkersRestarted`). B1.5.1 put the handler into a worker with `importScriptInWorkers`: the dispatcher sends the url as an `IS` message to every new worker, and the worker loads it with an asynchronous `import()` (`_importScript`) while it keeps handling other messages. MapLibre's own reload is not ordered after that import. A tile message handled first finds no handler (`createWorkerCRSHelper`: warning, no CRS helper). The lab cannot hold MapLibre's internal reload back, so no amount of waiting on the main thread (`prewarm()`, verification, data reload) can close this window; those only detect it and repair the lab's own data afterwards.

### Architecture

| Part                                           | Role                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/dev/mapLibreLab/scsWorkerEntry.mjs`       | The worker script MapLibre starts (`setWorkerUrl`). Static imports: `scsWorkerProbe.mjs`, then `/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs`, then `scsProjection.worker.mjs`; its body is the single call `bootstrapScsWorker(self, probe)`                       |
| `src/dev/mapLibreLab/scsProjection.worker.mjs` | Handler and status answer; no side effect any more. `installScsProjection` is idempotent; `bootstrapScsWorker` closes the worker and throws when it cannot install (never a silent fallback)                                                                                 |
| `src/dev/mapLibreLab/scsWorkerProbe.mjs`       | First `message` listener of the worker; counts message events before the installation (runtime evidence for the ordering), reported as `messagesBeforeInstall`                                                                                                               |
| `src/dev/mapLibreLab/workerProjection.ts`      | Sets the entry as MapLibre's worker URL before the first worker starts, then `prewarm()`; secondary verification of every worker of every generation; generation tracking, recreation listener, bounded retried attempts, worker errors; no `importScriptInWorkers` any more |
| `src/dev/mapLibreLab/main.ts`                  | Binds the port (`setWorkerUrl`, `getWorkerUrl`, `prewarm`, `getGlobalDispatcher().broadcast / on('workerscreate') / on('error')`); data reload after a recreation kept as a safety net                                                                                       |

### MapLibre APIs used

| API                                                                       | Status in 6.19.0 (FACT, `maplibre-gl.d.ts` and source)                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setWorkerUrl(url)`, `getWorkerUrl()`                                     | Public, exported. Only set `config.WORKER_URL`. `workerFactory` reads it each time it creates a worker: a same-origin URL not ending in `.cjs` becomes `new Worker(url, {type: 'module'})`, no `blob:`                             |
| `prewarm()`                                                               | Public. Starts the pool and holds it across map removal                                                                                                                                                                            |
| `getGlobalDispatcher()` `broadcast`, `on('workerscreate')`, `on('error')` | Public, typed (`GlobalDispatcherEventType`). `error` fires "Worker failed to load" on a worker `error` event                                                                                                                       |
| `dist/maplibre-gl-worker.mjs` as an importable module                     | **Not a documented API.** The package exports `./dist/*`. The file has no imports, no top-level `await`, exports only `default` (the worker class), and its last statement is `if (isWorker(self)) self.worker = new Worker(self)` |
| `self.setProjectionHandler`                                               | Documented for scripts in the workers (custom CRS guide); typed `@experimental` on `WorkerGlobalScopeInterface`. **Not exported** by the worker module; set by the worker class constructor                                        |
| `self.worker.actor.registerMessageHandler`                                | Internal (B1.5.1 justification unchanged; used only for the status answer)                                                                                                                                                         |
| `GlobalDispatcher.workerPool.restart()`                                   | Internal; used only by the browser check below to force the B1.5.2 failure path, never by the lab                                                                                                                                  |

The pinned worker bundle is held by a unit test to SHA-256 `c8564c4a…3d5b2` (the inspected file): a MapLibre update fails the test until the facts above are inspected again.

### Ordering guarantee

**No message can be handled by a worker before its handler is installed**, for these reasons:

1. **Module evaluation (FACT, ECMAScript):** an entry's static imports are evaluated depth first in order, then its body. Without a top-level `await` in the graph, the whole evaluation is one synchronous job: no event of the worker can be dispatched in it. **Checked by parsing (acorn) the files actually served by the Vite dev server:** the entry, the probe, the projection module, the served MapLibre worker bundle, `/@vite/client` (which Vite injects into the bundle, see below) and its `env.mjs`: zero top-level `await` in all of them.
2. **MapLibre's actor (FACT, source):** in a worker, `Actor.receive` only queues a message and handles it in a later task (`ThrottledInvoker`: `MessageChannel` and `setTimeout(0)`). Even a message event dispatched right after the actor exists would not be handled in the same task.
3. **Messages posted before the worker script ran** (MapLibre posts to new workers at once) are not dispatched before the script has been evaluated. This is the browser's behaviour for module workers (HTML "run a worker"); **verified in Chromium 158 by the browser check below**, not proven for other engines.

Every worker started from the entry therefore has the handler in every generation: first pool, `prewarm()`, `WorkerPool.restart`, and a new pool after a release.

**Secondary verification (main thread):** a status answer counts only with `source: 'worker-entry'` and `messagesBeforeInstall: 0`. A worker started from another script answers `null`; a worker whose entry failed closed itself and never answers (the attempt times out, and MapLibre's "Worker failed to load" is recorded in `workerErrors`). Both fail the registration loudly; the B1.5.1 answer format (no `source`) no longer passes.

### Vite dev server findings (MEASUREMENT, Vite 8.3.5)

- A bare `import 'maplibre-gl/dist/maplibre-gl-worker.mjs'` in the entry made Vite pre-bundle the worker at request time (`[optimizer] bundling dependencies...`, then "dependency optimized"): a 2.3 MB re-bundled file instead of the inspected 550 KB one, plus a dependency re-optimisation that can reload the lab page. The entry therefore imports the root-absolute dev-server path, the same URL `maplibre-gl/dist/maplibre-gl-worker.mjs?url` yields (unit test). `optimizeDeps.exclude` was not used: `vite.config.ts` must not name MapLibre (isolation test).
- Vite serves the package file with one added first line, `import { injectQuery } from "/@vite/client"` (the bundle contains a dynamic `import()`), and an inline source map; the code is otherwise unchanged. This also explains the `[vite] connecting...` lines in the B1.5.2 worker consoles. `/@vite/client` has no top-level `await` (see above).
- **Production builds: not applicable and NOT TESTED.** The lab is not a build input; the root-absolute `/node_modules/...` import exists only on the dev server. A production integration (not part of B1) would have to bundle the entry (for example Vite `?worker&url` with an ES worker format) and repeat this inspection.

### CSP and offline (FACT unless marked)

- Same-origin module worker started directly from its URL; no `blob:`, no `data:`, no `fetch`, no `eval`. Allowed by `script-src 'self'` (no `worker-src`). Production CSP unchanged; the lab page still carries it verbatim (test).
- The entry and its imports are same-origin; no external host in any lab or harness source (tests).
- **MEASUREMENT (headless Edge, below):** 0 CSP violations, 0 requests to another origin, 0 `blob:`/`data:` workers.

### Test coverage

| Level                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/scsWorkerEntry.test.ts` (13)   | Import order and a body that is one synchronous call (no `await`, `import()`, `then`, timers); the MapLibre import equals the package's `?url`; the pinned bundle hash and its last statement; **the real MapLibre 6.19.0 worker bundle evaluated through the entry** in a simulated worker scope (jsdom posing as `WorkerGlobalScope`): handler installed once during evaluation, probe count 0, and the first message handled through MapLibre's own `Actor` answers the entry status; install/bootstrap: duplicate install changes nothing, failures close the worker and throw, late install is reported and rejected; `(X, −Z)` and the `/2048` carrier |
| `tests/workerProjection.test.ts` (17) | Entry URL set before `prewarm()` and before any worker; multiple workers; workers from another script, an unsettable worker URL, a failed entry (timeout + worker error) and a late install all fail loudly; recreation, five repeated generations, late creation, release/remount, reconfiguration, renderer switch, termination during verification, recreation during verification, concurrent initialisation, retry after failure, attempt timeout, answer validation                                                                                                                                                                                    |
| Unchanged                             | `coordinates.test.ts` (transform and carrier), `isolation.test.ts`, `lifecycle.test.ts`, `validationReport.test.ts` (adds `workerorder.mjs` to the harness file list); acceptance thresholds unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Browser check (synthetic, not B1.5.4)

`tools/maplibre-validation/workerorder.mjs`: headless Microsoft Edge with a throwaway profile against the dev server's lab page (production CSP). It does not start RoadPilot, WebView2, a game or any input simulation. It runs the initial load, release/remount and the M3 round trip, then _n_ cycles of MapLibre's own `WorkerPool.restart()`. In the same synchronous turn it sends a status broadcast, which reaches the new worker before its module script has loaded, and starts a concurrent lab reconfiguration: the B1.5.2 failure path.

**MEASUREMENT, 2026-11-23, Edge `Edg/158.0.4370.33` (the Chromium build of the B1.5.2 WebView2), headless:**

| Run                                      | Result                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1.5.3 code, 10 cycles (twice)           | **PASS.** 11 workers, all from `scsWorkerEntry.mjs`. Every early broadcast was answered by the entry status with `messagesBeforeInstall: 0` (73–88 ms after the restart). Generation +1 per cycle, every load verified, no `recreatedDuringLoad`. 0 projection warnings, 0 CSP violations, 0 foreign requests, 0 exceptions |
| Negative control: B1.5.1 code, 10 cycles | 10 of 10 early broadcasts answered `null`: each new worker handled a message while it had no handler. This is the race window of B1.5.2, reproduced every time. MapLibre's projection warning did **not** appear in this run, so the warning alone is a weak detector; the early status probe is the sensitive check        |

### Verification status

| Statement                                                                                      | Status                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Root cause (asynchronous import vs. MapLibre's own reload)                                     | Verified by source inspection; race window reproduced in Chromium (negative control)                                    |
| `setWorkerUrl` makes every worker generation start from the entry                              | Source inspection; automated tests (fake pool); Chromium (11 of 11 workers)                                             |
| Handler installed before any message is handled                                                | Source inspection (module semantics, actor queue); real bundle in a simulated scope; Chromium (10 of 10 early messages) |
| Messages posted before a module worker's script ran are not dispatched before it               | Chromium 158 only                                                                                                       |
| No CSP violation, offline, no `blob:`                                                          | Source inspection; Chromium under the production CSP                                                                    |
| RoadPilot's WebView2 runtime (Tauri app), the RTX 3080, real worker termination by the browser | **Still unverified (B1.5.4)**                                                                                           |
| Production bundling of the entry                                                               | **Not applicable to B1; unverified**                                                                                    |

### Remaining runtime risks

- WebView2 inside RoadPilot could differ from headless Edge of the same build (process model, GPU, start-up), although the worker and module code paths are the same Chromium.
- The B1.5.2 warning came from one restart; the browser check shows the window closed under the same path, not under every possible pool event (for example a browser-initiated worker kill on return to the foreground, which MapLibre handles through the same `restart`).
- The internal pieces (`dist/maplibre-gl-worker.mjs` as a module, `self.worker.actor`) can change with any MapLibre release; the pinned hash forces a re-inspection.
- The Vite dev server's injection of `/@vite/client` into the worker could change with a Vite update (it would need a top-level `await` to matter; the probe would then report it and verification would fail loudly).

**B1 runtime validation is not PASS.** B1.5.4 must repeat B1.5.2 Test B (and continue with C–F) in RoadPilot's WebView2.

## B1.5.4B harness reliability correction

Test infrastructure only. The worker entry, projection registration, coordinates, the `/2048` carrier, rendering and every acceptance threshold are unchanged. Evidence of the phases that found the defects stays untouched: B1.5.4 in `out/b154-20261123-154840/`, B1.5.4A in `out/b154a-20261123-170102/` (B1.5.4A: 10 of 10 forced worker replacements PASS in WebView2).

### Root causes

| Defect                  | Evidence                                                                                                                            | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: screenshot collision | B1.5.4 functional run: `EEXIST` on `A-basic-whole-amd.png`, label step recorded as failed, `functionalSteps` INVALID                | `run.mjs` named screenshots by scenario and view only. The opening shot and the first label view were both `A-basic-whole-<tag>`; the second write met the (correct) `wx` rule and threw inside the label step                                                                                                                                                                                                                          |
| B: Vite cold start      | B1.5.4A attempt 1: `Page.navigate` no answer in 5 s; the dev server, started seconds earlier, did not answer the lab URL within 3 s | The dev server was started by hand and only its first answer was awaited. **MEASUREMENT (2026-11-23, Vite 8.3.5, two fresh starts through the new harness, no app):** the first complete request pass over the app and lab modules took 31–32 s, one request (`scsWorkerEntry.mjs`) did not answer within 10 s, while the optimiser logged `scanning dependencies...`; the next passes took 0.2 s. RoadPilot started inside that window |
| C: Vite shutdown        | B1.5.4A: stopping the background task left the Vite process running; it needed `Stop-Process`                                       | `npm run dev` on Windows is a tree (shell → `npm-cli` node → `cmd.exe` → vite node). **MEASUREMENT:** stopping the root left all three running. Windows has no signal that asks such a console tree to exit gracefully                                                                                                                                                                                                                  |

### Screenshot naming (A)

`evidence.mjs`: `<test>-<seq>-<scenario>-<view>-<adapter>.png`, for example `functional-002-basic-labels-whole-amd.png`. `seq` is the three-digit capture number of the run, so names are unique within a run and identical across runs in the same order. Parts must be plain tokens (`a-z`, `0-9`, `-`). The `wx` rule stays: a name that exists in the session folder is not written, and a duplicate name within a run is refused. `capture` never throws. Each capture is recorded (`saved` or `failed` with its stage `name`, `capture` or `write`, and the error), and a capture that does not answer within 10 s is failed. `report.mjs` judges the records in their own criterion `screenshots`, separate from `functionalSteps` and from every measurement.

### Dev server readiness (B)

A runtime mode starts **its own** dev server (`viteserver.mjs`, forked with an IPC channel; Vite's JS API `createServer` / `listen` with the repository's `vite.config.ts` and the `devUrl` host and port, `strictPort`). RoadPilot starts only after every stage passed:

| Stage       | Condition                                                                                                                                                                                                                               | Deadline                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `preflight` | no socket listens on the port and nothing answers at the origin                                                                                                                                                                         | —                       |
| `spawn`     | the server process exists; its PID is recorded                                                                                                                                                                                          | —                       |
| `listening` | the server's own IPC `listening` message, from that PID, for exactly the origin (a console line such as Vite's "ready" is not used)                                                                                                     | 30 s                    |
| `ownership` | the port's listening socket belongs to that PID and to no other                                                                                                                                                                         | 10 s                    |
| `http`      | `/` answers 200 with an HTML page that has a module script                                                                                                                                                                              | 15 s                    |
| `labRoute`  | the lab URL answers 200 **and** contains the lab marker (Vite's SPA fallback answers wrong routes with the app page and 200)                                                                                                            | 15 s                    |
| `modules`   | every module of both pages (static and literal dynamic imports, same origin, transitively; package files fetched, not parsed) and the worker entry answer 200 with JavaScript, in two consecutive complete passes with the same URL set | 120 s, at most 3 passes |

Each HTTP request is bounded (10 s, no keep-alive). A server exit at any point fails the current stage at once. A failed start saves `devserver-failure-<label>.json` (stage, error, stage timings, events, PID, exit, IPC messages, output tail, port owners, child processes), stops the server it started (below) and stops the session. Nothing is retried.

### Process ownership and shutdown (C)

- The harness owns exactly one process: the forked server (no npm or `cmd.exe` wrapper). Its PID is recorded at the spawn and checked against the `listening` message and the port owner. Its child processes are recorded at readiness. Measured: one `conhost.exe`, the console host Windows gives every forked Node process; Vite 8 itself starts no child process.
- Lookups use PIDs only: the server's PID, the owner of the listening socket, the descendants of the server's PID. There is no lookup by process name, and the harness code has no kill function.
- Shutdown: the IPC message `shutdown` makes the server call `server.close()` (Vite's documented close: HTTP and WebSocket servers, watcher, optimiser) and send `closed`. It then disconnects and exits on its own with code 0. If the harness disappears, the server closes itself the same way.
- After the exit (bounded at 20 s; measured 0.1–0.9 s): the endpoint must refuse connections, the port must have no socket of that PID, and every recorded child process must have exited (bounded at 5 s).
- On a timeout or any failed check, cleanup is `FAIL` with the process identities, and **nothing is force-terminated**. The session reports it and stops; the leftover process must be checked by hand.

### Session lifecycle

`lifecycle.mjs`: `preflight` (result files, idle desktop, RoadPilot not running) → `devServer` (readiness above) → `body` (RoadPilot start and the openlab stages `startup`, `target`, `appNavigation`, `navigation`, `labReady`, `initialConfig`, then the tests and the RoadPilot close) → `appClosed` (no RoadPilot or RoadPilot WebView2 process left; not killed if there is one) → `stopDevServer`.

- A failed stage marks every dependent stage `NOT_TESTED`.
- The dev server is stopped after every outcome.
- Nothing is retried, and the lab opening defaults to one attempt.
- Each session writes `session-lifecycle-<mode>-<tag>.json` once, into a session folder it never overwrites.

### Regression tests (automated, `src/dev/mapLibreLab/tests/`)

| File                         | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screenshotEvidence.test.ts` | Reproduces the B1.5.4 collision with the old names; the functional sequence gets 15 unique deterministic names; the same view twice does not collide; no overwrite (existing name, `wx` refusal); old evidence names are never produced; failed, empty and hanging captures are recorded, not thrown; report criterion separate from `functionalSteps`; `run.mjs` names no screenshot itself                                                                                                                                                          |
| `devServer.test.ts`          | Fakes: normal start (stage order, app, lab and worker-entry modules); cold start (504 and a new `?v=`); delayed readiness; listening without HTTP; startup timeout; process exit during readiness; server error; wrong process or port (owned port, answering origin, other origin, other PID, shared socket); invalid lab route (SPA fallback, 404); modules that never settle. Shutdown: normal, children, a child left behind, delayed, already exited, timeout without kill, not graceful, endpoint still up, unrelated processes never looked up |
| `devServerProcess.test.ts`   | Real processes (Windows): full readiness against a fixture server; a second start on an owned port refused with the owner's PID; graceful stop with a child process; delayed stop; already exited; shutdown timeout leaves the process running; an unrelated Node process survives                                                                                                                                                                                                                                                                    |
| `sessionLifecycle.test.ts`   | Stage order, the app only after readiness, refused preflight, failed dev server (diagnostics and cleanup kept), failed body still stops the server, RoadPilot left running and a failed stop are FAIL, no retry, save errors reported; `startup` and `sessionLifecycle` verdicts; one attempt by default                                                                                                                                                                                                                                              |
| `openLab.test.ts`            | Retries only with an explicit `attempts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The real Vite path (`viteserver.mjs` with the repository's config, through `devserver.mjs`) was run twice without RoadPilot: both times ready after about 40 s (the cold pass above), then stopped gracefully, with the port free and no process left.

### Lint scope

`npm run lint` no longer scans `tools/maplibre-validation/out/`, the git-ignored evidence that includes one-off scripts of earlier sessions (the same exclusion as `.prettierignore`). Tracked harness files are linted with Node globals.

### Remaining runtime risks

- _(Resolved in B1.5.4C and B1.5.4F, see [B1.5.4 runtime results](#b154-runtime-results-b154b154f).)_ Sessions passed readiness, the lab opening, the tests and the cleanup in one go in WebView2 (5 of 5 in B1.5.4C, 20 of 20 in B1.5.4F).
- The `modules` stage proves that the server has settled for the modules it can see statically. A module that the lab loads only through a computed URL would not be warmed.
- A cold start now takes about 40 s before RoadPilot starts. The 120 s `modules` deadline leaves margin on this machine only.
- `Get-NetTCPConnection` and `Get-CimInstance` (PowerShell) are needed for ownership checks, and each call takes about 1–2 s.
- A cleanup `FAIL` leaves a process for a person to check. That is intended, and the next session refuses to start while the port is taken.

## B1.5.4E app-page isolation

Harness only. RoadPilot's application code, its Tauri configuration, the production build, `npm run dev`, the lab and every acceptance threshold are unchanged.

**Race (B1.5.4C session 5, investigated in B1.5.4D).** RoadPilot's debug build always opens the app page (`/`) first; `openlab.mjs` then navigates the same webview to the lab. `src/app/main.tsx` creates its telemetry, control and map sources at module level, and each one calls `listen` and `invoke` at once. When `main.tsx` ran before the lab committed, the outgoing page made six IPC calls (three `plugin:event|listen`, `telemetry_snapshot`, `control_status`, `map_status`). Tauri 2.12.5 keeps JavaScript event listeners per webview label and removes them only when the webview is destroyed, so the `control:status` listener (emitted every 200 ms) called a dead callback in the lab: 138 "[TAURI] Couldn't find callback id" warnings. Sessions 1–4 had none. `network` stayed PASS because it allows RoadPilot's IPC by design.

### Containment: placeholder at `/` (`placeholder.mjs`)

- After every readiness stage passed, `devserver.mjs` runs one more stage, `placeholder` (only with `options.placeholder`, which `run.mjs` sets):
  1. IPC `placeholder` to the forked server;
  2. `placeholder-active` from the server's own PID with the expected marker;
  3. one GET of `/`: 200 HTML with the marker `<meta name="roadpilot-harness-placeholder" content="roadpilot-b154e-app-page-isolation-v1">` and no script;
  4. one GET of the lab page: still the lab, with the same module scripts;
  5. one pass over the lab modules and the worker entry: every URL answers 200 with JavaScript and belongs to the stable readiness set.
- The placeholder has no script, stylesheet or other resource: neither the app, nor Vite's client, nor any module loads. Only `/` and `/index.html` are replaced; every other URL, including the app modules themselves, is served unchanged.
- The switch is one-way for the life of the server process.
- `activatePlaceholder` refuses before readiness (`refused: true`, nothing sent). The server refuses before it listens (`placeholder-refused`).
- A failed stage saves `devserver-failure-<label>.json`, stops the server gracefully and fails the session's `devServer` stage, so RoadPilot never starts. Nothing is retried, and there is no fallback to the real app page.
- `openlab.mjs` (`appPlaceholderMarker`) checks the committed app page right before `Page.navigate` (`APP_PROBE_EXPRESSION`: marker, `document.readyState`, script count, Resource Timing entries). A missing or different marker fails `appNavigation` with diagnostics, and that failure is never retried (`noRetry`), whatever `--attempts` says.
- The session record keeps the switch result in `devServer.placeholder`.

### Detection: `appPageIsolation` (`report.mjs`)

`run.mjs` records `appPageIsolation` in every functional, perf and cycles result: the probe and every request and console entry the instrumentation logged in the run, before and after the lab navigation. `null` means the lab never opened.

| Verdict | Reason                                                                                                                                                         | Condition                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| INVALID | `no_isolation_evidence`, `incomplete_evidence:*`, `no_request_log`, `no_console_log`, `no_app_probe`, `no_resource_list`, `instrumentation_saw_no_lab_request` | Evidence missing or incomplete                                                                                               |
| INVALID | `placeholder_not_confirmed`                                                                                                                                    | The probe did not find the placeholder marker                                                                                |
| INVALID | `ipc_requests`                                                                                                                                                 | Any request to `http://ipc.localhost` (or `ipc:`) in the run; the lab and the placeholder make none                          |
| INVALID | `app_resources_requested`                                                                                                                                      | A request for an app-only module (`/src/app/`, `/src/backend/`; B1.5.4C: the lab never requests these)                       |
| INVALID | `ipc_in_app_page_resources`, `app_resources_in_app_page`                                                                                                       | The outgoing page's resource list has an IPC entry or any same-origin resource (the placeholder loads none)                  |
| INVALID | `callback_warnings`                                                                                                                                            | Tauri's "Couldn't find callback id" in the console; corroborating only, since the request and probe checks decide without it |
| PASS    | `isolated`                                                                                                                                                     | None of the above                                                                                                            |

- **perf and cycles:** a run with isolation evidence that is not `isolated` is INVALID (`app_page_not_isolated`). That makes its perf aggregate INVALID, and its memory criterion INVALID instead of NOT_TESTED. Results without the field (before B1.5.4E) are judged as before.
- **When the criterion appears:** for every run of a report that has a session record, or whose results carry the field. A B1.5.4B or B1.5.4C session therefore reports it as INVALID (`no_isolation_evidence`); older results get no criterion.
- **`network`:** unchanged.

### Regression tests

| File                       | Covers                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeholder.test.ts`      | The placeholder is empty and marked, its only link is the inline `data:,` icon that suppresses the automatic `/favicon.ico` request (B1.5.4F); inactive until switched; refused before listening; only `/` and `/index.html` replaced (GET, HEAD), lab, modules, POST and favicon pass through; other IPC messages ignored          |
| `devServer.test.ts`        | App page before the switch, placeholder after it; lab route and modules unchanged; no switch without the option; refused before readiness (nothing sent); missing, refused, foreign-PID and wrong-marker acknowledgements; an acknowledged switch that still serves the app; a lab that changed; graceful shutdown after the switch |
| `devServerProcess.test.ts` | Real processes: readiness, the real IPC switch through `spawnServer`, `/` and `/index.html` are the placeholder, lab and modules served, graceful stop                                                                                                                                                                              |
| `openLab.test.ts`          | Probe right before `Page.navigate`; resource list passed on; missing or different marker fails `appNavigation` once, with diagnostics and cleanup, no retry even with `attempts: 3`; no probe without the option                                                                                                                    |
| `validationReport.test.ts` | s1-like PASS; s5-like INVALID; IPC without warnings INVALID; app resources in the resource list or the request log INVALID, shared lab folders not; marker missing; warning alone; ten missing-evidence cases; `network` unchanged; perf, aggregate and cycles invalidation; criterion presence rules                               |

### Remaining runtime risks

- _(Resolved in B1.5.4F, see [B1.5.4 runtime results](#b154-runtime-results-b154b154f).)_ In WebView2 the probe found the marker in 20 of 20 starts with no IPC request or callback warning, and the negative control (placeholder off) was `detected`.
- Tauri's initialization scripts still run in the placeholder document. In B1.5.4C they made no IPC call on their own (lab pages 1–4: none).
- `/src/app/` and `/src/backend/` as app-only paths depend on the lab's imports. A lab import from those folders would make every run INVALID, which is loud rather than silent.

## B1.5.4G negative-control mode

Harness only. This mode lets a separately authorized runtime test reproduce the app-page race on purpose and show that `appPageIsolation` classifies it as INVALID. The race reproduced in only 1 of 5 normal starts (B1.5.4C), so one normal run could not prove the detector.

```
node tools/maplibre-validation/run.mjs control --negative-control --confirm-runtime --session=<new-name>
```

- **Command line** (`negativecontrol.mjs` `validateRunArgs`):
  - Both tokens are required: mode `control` and the flag `--negative-control`.
  - Refused, with exit code 2, before any file, process or server is touched:
    - the flag with any other mode (`functional`, which includes labels; `perf`; `cycles`, which is memory; `report`);
    - mode `control` without the flag;
    - the flag with `--kinds`, `--only`, `--runs`, `--kind`, `--out`, or with `--attempts` other than 1.
  - The session folder defaults to `out/negative-control-<timestamp>/`. A folder that is not empty is refused.
- **Session:** the normal lifecycle (preflight, the harness's own dev server with every readiness stage, body, app closed, graceful stop), with two differences:
  1. the dev server does **not** switch to the placeholder (`placeholder: !NEGATIVE_CONTROL`);
  2. `openlab.mjs` runs with `negativeControl` instead of `appPlaceholderMarker`. It waits until the real app page has rendered (`APP_RENDER_EXPRESSION`: `#root` has element children, so `main.tsx` ran and made its IPC calls), takes the same outgoing-page probe without requiring a marker, and only then navigates. If the page doesn't render within 30 s, `appNavigation` fails with diagnostics and is never retried.
- **Body:** it opens the lab, records the GPU, holds the lab for 2 s (about ten `control:status` emissions), reads `L.state()` and closes RoadPilot. There is no functional, label, accuracy, perf, memory or cycles step, and no screenshot.
- **Evidence:** the same `appPageIsolation` evidence as every run (probe, every request, every console entry), plus `appRender`, `network`, `console`, `exceptions` and `workers`.
- **Files:** the result goes to `negative-control-<tag>.json` with `control: { kind: 'negative-control', placeholder: false, waitForAppRender: true, holdMs }`. The session record is `session-lifecycle-negative-control-<tag>.json` and the server log `vite-dev-negative-control-<tag>.log`.
- **Evaluation** (`report.mjs` `evaluateNegativeControl`): the verdict is always INVALID (`control: true`), because a control is never a measurement. Its `outcome` is:
  - `detected` only when `appRender.rendered` is true **and** `appPageIsolation` is INVALID with at least one contamination reason (`CONTAMINATION_REASONS`: IPC requests, app resources requested, IPC or app resources in the outgoing page, callback warnings). A missing marker alone is not contamination.
  - `inconclusive` for everything else: no or incomplete control record, placeholder active, lab not opened, render not confirmed, isolation evidence missing or incomplete, contamination not reproduced. A clean control proves nothing.
  - `detector_failed` if the render was confirmed but isolation is PASS.
  - `run.mjs` prints the outcome and ends with exit code 4 unless it is `detected`.
- **Report:** a report with a control carries `control: true`, the `negativeControl` criterion and `appPageIsolation`, and its overall verdict is INVALID. A result that carries a `control` field but is passed as a functional, perf or cycles measurement adds `controlSession` INVALID.
- **Unchanged:** default runs (placeholder and marker check), `appPageIsolation`, `network` and every threshold.
- **Tests:**
  - `negativeControl.test.ts`: command-line acceptance and refusals; detected, inconclusive and INVALID outcomes; a control can never pass; the report guards; unchanged `appPageIsolation` and `network`; source checks of the `run.mjs` wiring.
  - `openLab.test.ts`: waits for the render before the probe and the navigation; a page that never renders fails closed without a retry; conflicting options are refused before launch; default runs never wait for a render.

## B1.5.4 runtime results (B1.5.4–B1.5.4F)

**MEASUREMENT.** RoadPilot's WebView2 158 on the AMD iGPU (`ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11)`), synthetic data, Dry Run active; no game, no driving, no input simulation. The NVIDIA GPU was not used. Evidence folders are under `tools/maplibre-validation/out/` (ignored by Git) and are kept unchanged.

| Phase       | Date       | Evidence                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                              |
| ----------- | ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| B1.5.4      | 2026-11-23 | `b154-20261123-154840`                                                     | Test A (lab opening) 5/5 PASS. Test B (worker projection) PASS: handler installed about 4 ms after the entry started, 0 messages before installation, 6/6 workers; a failing worker URL fails loudly and recovers. Test C: accuracy FAIL at zoom 1/3 (scs 8.287 px), bit-identical to B1.5; the functional steps INVALID through the screenshot name collision. Test E not run (stop rule) | CONDITIONAL GO                       |
| B1.5.4A     | 2026-11-23 | `b154a-20261123-170102`                                                    | Test E alone: 10 forced `WorkerPool.restart()` cycles, 10/10 PASS, 11 workers, generation 11, 0 CSP violations or external requests. A cold Vite server made attempt 1 fail in `openLab` (fixed in B1.5.4B)                                                                                                                                                                                | GO (worker stability only)           |
| B1.5.4C     | 2026-11-25 | `b154c-20261125-155200-s1` … `-s5`, `-meta`                                | Corrected harness, 5 functional sessions: lifecycle PASS, lab opened at the first attempt, 15/15 screenshots unique, network offline, 0 CSP violations, exceptions or projection warnings, graceful Vite stop (about 1.2 s). Session 5: the app page ran during the lab navigation (6 IPC calls, 144 Tauri callback warnings), not flagged by the harness of that time                     | CONDITIONAL GO                       |
| B1.5.4D     | 2026-11-25 | none (read-only)                                                           | Cause of the session 5 race confirmed from source: `src/app/main.tsx` creates its sources at module level, and Tauri keeps JS listeners per webview, not per document. Led to B1.5.4E                                                                                                                                                                                                      | investigation                        |
| B1.5.4F     | 2026-11-25 | `b154f-negative-control-20261125-172603`                                   | Negative control (B1.5.4G mode): outcome **`detected`**: 13 IPC requests, 5 app modules, 67 outgoing-page resources, app render 273 ms. No callback warnings in the 2 s hold                                                                                                                                                                                                               | detector works (never a measurement) |
| B1.5.4F     | 2026-11-25 | `b154f-positive-20261125-172745-r01` … `-r10`                              | r01–r09 isolated; r10 INVALID `app_resources_in_app_page`, caused only by the browser's automatic `/favicon.ico` request of the placeholder (detector false positive). Series stopped; fixed in `3231a33` (inline `data:,` icon, criteria unchanged)                                                                                                                                       | NO-GO (for `bf79137`)                |
| B1.5.4F     | 2026-11-26 | `b154f-positive-20261126-170742-r01`, `b154f-positive-20261126-171038-r01` | Both refused by the session preflight (`DESKTOP BUSY: NVIDIA utilisation 99 %`); nothing was started. Stopped attempts, not counted                                                                                                                                                                                                                                                        | INVALID (not counted)                |
| **B1.5.4F** | 2026-11-26 | `b154f-positive-20261126-172223-r01` … `-r20`                              | `3231a33`, normal `functional` mode, WebView2 `Edg/158.0.4370.45`: **20 of 20 valid.** See below                                                                                                                                                                                                                                                                                           | **GO**                               |

**B1.5.4F series (20 runs, identical in every run):** PASS for every session stage (preflight, dev server, body, app closed, graceful dev-server stop in 1140–1226 ms), `network` (offline), `contextLoss` (restored), `releaseRemount` (clean), `workerProjection` (verified), `screenshots` (all saved), `startup` (first attempt), `appPageIsolation` (isolated) and `sessionLifecycle` (complete). The placeholder probe listed 0 resources; 0 IPC requests, 0 app-module requests, 0 callback warnings and 0 exceptions. Each run still logs one `/favicon.ico` 404, always after the lab navigation: it comes from the lab page, which declares no icon, not from the placeholder.

**Excluded from the verdict, and unresolved or untested:**

- `accuracyScs`, `accuracyIdentity`, `accuracyScsDpr15`: FAIL (`error_above_tolerance`) in all 20 runs, with bit-identical results. Collected, but excluded from the verdict by the authorization of the run. Unresolved, see [maplibre-prototype.md, positional accuracy](maplibre-prototype.md#positional-accuracy-unresolved).
- `labels`: NOT TESTED (`visual_review_required`).
- `perf`, `memory`: NOT TESTED (perf and cycles modes not run).
- NVIDIA (`--nv`), the GTX 1070 and the Intel HD 530: NOT TESTED.

The harness's own `OVERALL` line is FAIL in every run, only because it includes the accuracy criteria.

## Open runtime questions

Everything in the [acceptance matrix](maplibre-prototype.md#acceptance-matrix) marked NOT TESTED. In addition, for the harness itself:

- Whether the `perf` and `cycles` modes and the sampler work end to end; they have not run in this form. _(The `functional` and `control` modes, DevTools and worker auto-attach ran end to end in WebView2 in B1.5.4C and B1.5.4F.)_
- _(Answered in B1.5.4F: the lab's first configuration finished before the harness's first `configure` call, `initialConfig` about 1 s; and `releaseRemount` was `clean`, which includes 0 listeners and 0 pending waits after `release()`, in 20 of 20 runs.)_
- Whether MapLibre's line interiors are drawn exactly in the style colours, which the ±4 tolerance assumes (opaque lines on an opaque background, no colour management in WebGL).
- Whether first visible geometry of `maplibre-nolabels` and `m3` can be compared at all, given the different detection methods and timed work ([Comparison with M3](#comparison-with-m3-b141)). One way to check this at runtime would be to apply the same pixel classification to M3's first frame. That is not implemented.
- Which numeric memory growth limit, if any, is approved as an acceptance criterion.
