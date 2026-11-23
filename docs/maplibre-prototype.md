# MapLibre identity projection prototype (Phase 2.4D B1)

An isolated, development-only experiment: can MapLibre GL JS draw RoadPilot's road map in a flat, non-Mercator plane, with synthetic SCS-like coordinates, fully offline and under the production CSP?

> **Scope:** prototype only. `RoadMapView.tsx`, `roadPainter.ts`, the Canvas 2D renderer, the M3 WebGL 2 prototype, the Rust MapService, RPMT, IPC, telemetry, SDK and Input Plugin are unchanged. Synthetic data only; no SCS geometry. Nothing in the app imports the lab, and the production build output is byte-identical to the build before B1.

## Status: B1 IMPLEMENTED – B1.5.2 REVALIDATION STOPPED (WORKER RACE) – B1.5.3 WORKER ENTRY CORRECTION, WEBVIEW2 RE-VALIDATION (B1.5.4) PENDING

| Area                      | State                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented               | Dev-only lab (`src/dev/mapLibreLab/`): registered planar CRS `roadpilot:scs`, worker projection handler, scenarios A–D, inline offline style, MapLibre / M3 side-by-side mounting, timing, accuracy, context-loss and request instrumentation                                           |
| Static checks passed      | `tsc -b`, ESLint, Prettier; static audit of the lab and of the MapLibre 6.19.0 sources (see [Static audit (B1.1)](#static-audit-b11)); the seven audit findings were addressed in [B1.2](#b12--reliability-fixes)                                                                       |
| Tests passed              | B1.5.3: 46 test files, 530 tests, including 157 lab and harness tests in 11 files (adds the worker entry, one test running the real MapLibre worker bundle in a simulated worker scope); CPU-only                                                                                       |
| Validation harness        | B1.4: prepared in `tools/maplibre-validation/`, documented in [maplibre-validation.md](maplibre-validation.md); B1.5: run once on AMD and stopped; B1.5.1: two defects corrected; B1.5.2: lab opening PASS, worker projection FAIL; B1.5.3: worker entry, checked in headless Edge only |
| Production isolation      | `maplibre-gl` 6.19.0 exact, dev-only (all 24 lockfile entries `dev: true`); no production import (test); production `dist` byte-identical to the build of `e1d2fe9`                                                                                                                     |
| Runtime criteria          | B1.5 (AMD only, stopped): every run that loaded was offline with no CSP violation; context loss and release/remount passed; rendered accuracy FAIL at zoom 1/3 and MapLibre perf numbers untrustworthy (defect A). See [B1.5](#b15--runtime-validation-stopped)                         |
| Why validation is stopped | B1.5.2 showed a new worker tiling GeoJSON before its handler import had finished (after `WorkerPool.restart`). B1.5.3 makes the handler part of the worker's own start; this still has to be shown in RoadPilot's WebView2 (B1.5.4)                                                     |
| Why no GO is possible     | B1's mandatory criteria (≤ 0.5 px accuracy, frame-time targets, three valid runs per scenario) have no valid evidence. A plausible design is not proof (the brief's own rule)                                                                                                           |

> **Status of the evidence (read first):** B1.5 and B1.5.2 ran the lab in RoadPilot's WebView2 on the AMD GPU and were stopped; their evidence is kept in `tools/maplibre-validation/out/` (not in Git). The B1.5.3 worker entry rests on MapLibre 6.19.0 source inspection, unit tests (one with the real worker bundle) and a synthetic check in headless Edge 158; it has not run in RoadPilot's WebView2. No runtime criterion is PASS for B1; a new runtime run needs separate approval.

Statements are marked **FACT** (follows from code, source or a test that ran), **MEASUREMENT** (measured here), **HYPOTHESIS** (plausible, not verified) and **RECOMMENDATION**.

## Layout

| Path                                           | Role                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/dev/mapLibreLab/index.html`               | Lab page; carries the production CSP verbatim as a meta tag                                                    |
| `src/dev/mapLibreLab/main.ts`                  | Lab UI, MapLibre and M3 mounting, load timing, benchmark driver, accuracy, context loss                        |
| `src/dev/mapLibreLab/coordinates.ts`           | Display convention, carrier conversion, registered CRS, expected screen positions                              |
| `src/dev/mapLibreLab/scsProjection.worker.mjs` | Projection handler for MapLibre's workers (GeoJSON in the registered CRS)                                      |
| `src/dev/mapLibreLab/scsWorkerEntry.mjs`       | B1.5.3: the lab's MapLibre worker entry; installs the handler while the worker starts                          |
| `src/dev/mapLibreLab/scsWorkerProbe.mjs`       | B1.5.3: counts worker messages before the handler installation (ordering evidence)                             |
| `src/dev/mapLibreLab/workerProjection.ts`      | B1.5.1/B1.5.3: sets the worker entry, keeps the pool, verifies every worker generation                         |
| `src/dev/mapLibreLab/syntheticData.ts`         | Scenarios A–D, GeoJSON conversion, conversion to the M3 `Scenario`                                             |
| `src/dev/mapLibreLab/mapStyle.ts`              | Inline style: no URL of any kind                                                                               |
| `src/dev/mapLibreLab/benchmark.ts`             | Frame-gap statistics and the M3 lab's pan/zoom camera paths                                                    |
| `src/dev/mapLibreLab/lifecycle.ts`             | B1.2: load session (timeouts, release, listener ownership), retryable global setup                             |
| `src/dev/mapLibreLab/accuracyReport.ts`        | B1.2: accuracy evaluation; infrastructure errors kept apart from rendering results                             |
| `src/dev/mapLibreLab/roadPixels.ts`            | B1.4: classifies road-layer pixels for first visible geometry                                                  |
| `src/dev/mapLibreLab/tests/`                   | Coordinates, synthetic data, style, isolation, lifecycle, accuracy, road pixels, validation report (109 tests) |
| `tools/maplibre-validation/`                   | B1.4: runtime validation harness and its evaluation ([maplibre-validation.md](maplibre-validation.md))         |
| `package.json`                                 | `maplibre-gl` `6.19.0`, exact, `devDependencies` only                                                          |

The lab is at `http://127.0.0.1:1420/src/dev/mapLibreLab/index.html` on the dev server (`npm run dev`). `window.mapLibreLab` is the harness interface: `configure`, `run('pan' | 'zoom')`, `settle`, `accuracy`, `apiChecks`, `labelStats`, `contextLoss`, `release`, `remount`, `gpuInfo`, `state`.

## Isolation strategy

- **FACT:** the lab is a separate HTML entry served only by the Vite dev server, like the M2/M3 render lab. `vite.config.ts` has no extra build input, so `vite build` bundles only `index.html` → `src/app/main.tsx`.
- **FACT:** `maplibre-gl` is in `devDependencies` with the exact version `6.19.0` (no range). Tauri ships the `dist` output, not `node_modules`.
- **FACT (test):** `tests/isolation.test.ts` fails if any file under `src/` outside `src/dev/` mentions MapLibre or the lab, if `index.html` or `vite.config.ts` does, if the dependency moves to `dependencies` or loses its pin, or if the lab's CSP differs from `tauri.conf.json`.
- **MEASUREMENT (build):** `npm run build` produces `dist/index.html`, `dist/assets/index-ChhnlOni.js` (333,306 bytes) and `dist/assets/index-DcGT5UkN.css` (17,266 bytes). A case-insensitive search for `maplibre`, `mapLibreLab`, `roadpilot:scs`, `setProjectionHandler` and `addProtocol` in `dist` finds nothing. The SHA-256 hashes of all three files are **identical** to a build of the unchanged HEAD `e1d2fe9`:

| File                             | SHA-256 (HEAD and B1)                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| `dist/index.html`                | `99e2fe6183cbe0d09676ff6219f1b69fe0906aeae846833661f87dfcad289ecc` |
| `dist/assets/index-ChhnlOni.js`  | `c6348743f76bee2b328ba6de1fd4e52eab839ca7a23bba94d25926c3bb62d83c` |
| `dist/assets/index-DcGT5UkN.css` | `24c365e01715377bee156dab9cd3d822d63f181e6c87a4091cd34d348049e9b9` |

## MapLibre version

`maplibre-gl` **6.19.0** (npm `latest` on 2026-11-21, the version researched in B0), BSD-3-Clause. The licence header is kept in the package's bundles. **Licence notices for a shipped product are not yet handled**, because nothing is shipped. `npm audit` reports 9 moderate findings, all of them already present before B1 (eslint / minimatch). None comes from MapLibre.

## Projection configuration and coordinate convention

### What MapLibre 6.19.0 offers (FACT, from its sources)

- `addProjection(crs)` registers a planar CRS: a `projection` converter between lng/lat and CRS coordinates, plus a square power-of-two `tileMatrixSet` (`origin`, `extentAtZoom0`). Tile content is not reprojected. The world does not wrap and has no copies. The API is marked **experimental**.
- The built-in `identity` CRS uses lng/lat degrees as CRS coordinates, and tile 0/0/0 spans −90..90 on both axes.
- **Every public position is a `LngLat`, and `LngLat` throws for |lat| > 90** (`src/geo/lng_lat.ts`). `CRSWorldCoordinateHelper.lngLatFromWorld` clamps latitude to ±90. A native value such as Z = −70,000 therefore **cannot** be passed through MapLibre's API unchanged.
- GeoJSON is tiled in the workers. With a registered CRS, the workers need the CRS `definition` string and a projection handler (`self.setProjectionHandler`). Without them, GeoJSON "draws in the wrong place" and MapLibre warns.

### What the lab does

| Layer         | Value                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Source        | Native SCS-style units: X east, Z south (ADR-002)                                                                             |
| Display plane | `x = X`, `y = −Z` (north up), no scale, no offset                                                                             |
| CRS           | `roadpilot:scs`: CRS coordinates = display plane in native units; tile 0/0/0 origin (−131,072, 131,072), extent 2¹⁸ = 262,144 |
| API carrier   | `lng = X / 2¹¹`, `lat = −Z / 2¹¹`; \|native\| ≤ 131,072 gives \|carrier\| ≤ 64                                                |
| Converter     | `forward([lng, lat]) = [lng · 2¹¹, lat · 2¹¹]`, `inverse` divides                                                             |
| Workers       | `scsProjection.worker.mjs` rebuilds the same converter from the definition `roadpilot:scs;carrier=2048`                       |
| Scale         | zoom 9 = 1 CSS px per native unit (`px/unit = 512 · 2^zoom / 262,144`)                                                        |
| Alternative   | built-in `identity`, same carrier; tile 0/0/0 = 368,640 native units (not a power of two); switchable in the lab              |

**Deviation from the brief:** the brief asked for no additional scaling. The CRS plane, the tile grid and the screen mapping have none. The **API carrier** is a fixed scale of 2⁻¹¹, which MapLibre's `LngLat` validation makes unavoidable. It is not a geographic conversion: no WGS84, no Mercator, and the same factor on both axes. Division by a power of two is exact in binary floating point, so the carrier adds **no** rounding (FACT, unit test: every test point makes a bit-exact round trip). It is documented here and in `coordinates.ts` rather than hidden. Whether this counts as acceptable is a review decision. It is reported as **PARTIAL** in the matrix.

### Coordinate tests that ran (FACT)

`tests/coordinates.test.ts` (unit level, no MapLibre runtime):

- Display = (X, −Z) for the origin, positive and negative X and Z, (−100,000, −70,000), ±131,072 and fractional values.
- Carrier round trip is bit-exact. |lat| ≤ 90 for all magnitudes.
- The CRS converter yields display coordinates in native units. It is linear: the step from carrier lat 63 to 64 equals the step from 0 to 1, so there is no Mercator stretch.
- The worker handler gives results identical to the main-thread converter and rejects unknown definitions.
- The tile matrix set is centred, 2¹⁸ wide, and its name contains a colon.
- Expected screen positions: east to the right, south down, equal scale on both axes, at zooms 0–13. They match the production `toScreen` (`domain/mapViewport.ts`) at the same scale.
- Zoom ↔ scale inverse; the identity CRS scale.

**Not tested:** whether MapLibre's `project` / `unproject` and the **rendered** pixels agree with these expectations (≤ 0.5 CSS px), at which zooms, centres and viewport sizes; whether the camera constrains the centre at low zoom near the edge of the world square; `queryRenderedFeatures`, `fitBounds` and rotation in the planar CRS; whether the style validator accepts `projection.type: 'roadpilot:scs'`. `main.ts` contains the code for all of these (`accuracy`, `apiChecks`), but it has never run.

## Synthetic datasets

Seed `LAB_SEED = 0xb1a5` (+ scenario index), mulberry32 (`seededRandom` from the M2/M3 lab). Names come from syllables and word lists. No real places and no SCS-derived geometry. Five classes: motorway, primary, secondary, local, minor.

| Scenario   | Content                                                                                                                                                                                                                        | Verified by unit tests (FACT)                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| A `basic`  | Hubs at (−100,000, −70,000), origin, (60,000, 40,000), (−60,000, 30,000), (40,000, −50,000); straight and curved motorways, a ring, primary crossings, a sine road, secondary radials, local grids, minor wiggles, city labels | reproducible hash; all classes; both signs on both axes; inside the world square                   |
| B `urban`  | Exactly 100,000 segments around (−100,000, −70,000): towns, rotated grids 25–60 units, parallel pairs 4–12 units apart, connectors of 1–3 segments of 10–30 units, motorways, primaries, secondaries                           | exact count; reproducible; centre near the SCS-like magnitude; all classes; > 100 short connectors |
| C `stress` | Exactly 1,000,000 segments, same generator over a larger area around (−80,000, −60,000), including the (−100,000, −70,000) region                                                                                              | exact count; reproducible; inside the world square                                                 |
| D `thin`   | Six rows with explicit widths 0.5, 0.75, 1, 1.5, 2, 3 px: straight, arc, zig-zag with sharp joins, six-road star, parallels 1–8 units apart, identical duplicates, collinear overlap                                           | widths exactly {0.5…3}; reproducible                                                               |

**FACT:** for the comparison with M3, `toM3Scenario` hands the **identical** coordinate arrays to the unchanged `ScenarioTiles` / `WebGL2RoadRenderer` (test: same arrays, same segment count; the M3 tiler builds tiles from them). The production classes have no `secondary`, so M3 draws it as `primary` (style only).

## Offline asset handling

| Resource                 | Handling                                                                                                                             | Evidence                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| MapLibre JS, CSS         | npm package, served by the dev server / bundled                                                                                      | FACT                                                                 |
| Workers                  | B1.5.3: `setWorkerUrl` → `scsWorkerEntry.mjs`, which imports the package's own `maplibre-gl-worker.mjs`; same origin, module worker  | FACT (source); MEASUREMENT (headless Edge: no CSP violation)         |
| Worker projection module | B1.5.3: statically imported by the worker entry (B1.5.1 used `importScriptInWorkers`)                                                | FACT (source); MEASUREMENT (headless Edge)                           |
| Style                    | Inline object                                                                                                                        | FACT (test: no `://`, no `http`)                                     |
| Glyphs                   | **No `glyphs` URL.** MapLibre then draws every glyph locally with TinySDF from the CSS font stack (`Segoe UI`, `system-ui`, `Arial`) | FACT (source: `GlyphManager._getAndCacheGlyphsPromise`, `!this.url`) |
| Sprites, icons           | **None** (see CSP)                                                                                                                   | FACT (test)                                                          |
| Data                     | GeoJSON built in memory, `setData` with objects (no URL, no fetch)                                                                   | FACT (source)                                                        |
| MapLibre's own requests  | Every request passes `transformRequest`, which the lab logs; the log is expected to stay empty                                       | instrumented, **NOT TESTED**                                         |

**FACT (test):** no lab source file (excluding tests) names an external host. The only hosts present are the three local entries of the CSP.

**Runtime request instrumentation was built but never run:** in the page, a `PerformanceObserver` log, the `securitypolicyviolation` log and the `transformRequest` log; in the harness, DevTools `Network` on the page and on every worker through flat auto-attach. **There is no request log**, so the acceptance criterion "zero external requests during startup, rendering, interaction and label loading" is **NOT TESTED**. The static evidence makes a pass plausible (HYPOTHESIS), but by the brief's own rule a successful build or plausible code is not sufficient.

## CSP and worker handling

Production CSP (`src-tauri/tauri.conf.json`, unchanged):
`default-src 'self'; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ipc: http://ipc.localhost ws://127.0.0.1:1420`

- **FACT (6.19.0 source, `util/web_worker.ts`):** a same-origin worker URL is started directly as `new Worker(url, {type: 'module'})`. MapLibre uses a `blob:` URL only for **cross-origin** worker URLs or pages with an opaque origin. B0's concern (default `blob:` workers) does not apply to 6.19.0 with a same-origin URL. Without `worker-src`, workers fall under `script-src 'self'`, which allows them. **HYPOTHESIS until run.**
- **FACT:** worker scripts imported with `importScriptInWorkers` are loaded with `import()` only if the URL ends in `.mjs`. Otherwise MapLibre fetches and evaluates them, which needs `connect-src 'self'` (absent) and `'unsafe-eval'` or `blob:` (absent). Since B1.5.3 the lab no longer uses `importScriptInWorkers`: the worker URL itself is the lab's entry (`.mjs`, started as a same-origin module worker, see [maplibre-validation.md, B1.5.3](maplibre-validation.md#b153-worker-entry-correction)).
- **FACT:** `connect-src` has no `'self'`, so any `fetch` to the page's own origin is blocked in production. The lab never fetches. A later data path must use IPC or a custom protocol (ADR-004).
- **FACT:** sprite images and raster image tiles are decoded through `URL.createObjectURL` → `img.src = blob:…` (`util/util.ts`, `arrayBufferToImage`). `img-src` has no `blob:`, so **sprites and icon images would be blocked** under the unchanged production CSP. The lab uses none.
- **Lab context:** `index.html` carries the production CSP verbatim (guarded by a test). The Vite dev server prepends its client script and the React Refresh preamble (an inline module script) **before** that meta tag, so those two dev-only scripts are outside the policy. Everything of the lab and MapLibre loads after it. In a production build these scripts do not exist.
- No production CSP change, no prototype-specific CSP relaxation.

## Labels

- Road labels on motorway, primary, secondary and (every third) local street, `symbol-placement: line`, shown from zoom thresholds derived from px/unit 0.004 / 0.02 / 0.08 / 0.4. City labels as points by rank (1 always, 2 from 0.01 px/unit, 3 from 0.05 px/unit), `symbol-sort-key` by rank.
- Collision: MapLibre default. No `text-allow-overlap` anywhere (FACT, test).
- **Limitations:**
  - **Glyphs are local, not bundled.** They are drawn at runtime from installed system fonts. No request is needed (FACT, source), but the look depends on the fonts installed (Segoe UI on Windows; other fonts on Linux, NOT TESTED). Truly bundled glyphs need a font file with a redistributable licence (for example OFL) through `font-faces` or pre-built PBFs. That is a product and licence decision, not part of B1. Fonts installed with Windows must not be converted and redistributed.
  - **No icons and no sprites** under the production CSP (see above). Possible later routes, unverified: `map.addImage` with `ImageData` (no `blob:`), or a production CSP change, which is outside B1's mandate.
  - `queryRenderedFeatures` in a planar CRS was listed upstream as Mercator-bound (B0 / PR #8287). Not tested.
- **Not tested:** that labels render at all, collision behaviour, visibility per zoom, the effect of labels on frame times.

## Interaction model

Mouse-wheel zoom and drag-pan (MapLibre defaults); zoom buttons (`NavigationControl`, no compass); a whole-map button computed with the production `fitBounds` (16 px padding). It does not use MapLibre's `fitBounds`, which B0 named as possibly Mercator-bound. North up: `dragRotate`, `pitchWithRotate`, `touchPitch`, `rollEnabled` off, `maxPitch` 0, touch and keyboard rotation disabled. A loading overlay and an error overlay. No vehicle marker, no navigation overlay. **Not tested** at runtime, including "no jumping" during pan and zoom (a bug of this kind was fixed upstream in 6.18.0).

## Performance, memory and comparison with M3

**NOT TESTED.** Nothing was measured.

Prepared and unused:

- The lab mounts either MapLibre or the unchanged M3 renderer (coverage mode, incremental uploads, 64 MiB budget) on the **same dataset, viewport and camera**.
- Same camera paths as the M3 lab: pan = 300 px circle, 1.5 s per turn, 3 s; zoom = ×64 in and out, 3 s per cycle.
- Same nearest-rank quantile. Frame gaps from `requestAnimationFrame` timestamps; MapLibre is driven with `jumpTo` + `redraw()` so that both renderers render once per frame.
- Load timing:
  - MapLibre: data preparation; `setData`; first visible geometry (B1.4: the first rendered frame containing at least one pixel of the road line layers, classified by road colour so that labels cannot count; see [maplibre-validation.md](maplibre-validation.md#first-visible-geometry-b14-definition)); complete geometry; idle.
  - M3: its `firstFrame` method (first frame with submitted segments; no pixel classification).
  - B1.4.1: the two first-visible measurements are **not** equivalent (detection method, timed work and labels differ). A comparison with M3 is meaningful at most for `maplibre-nolabels` and **requires runtime verification**; see [maplibre-validation.md](maplibre-validation.md#comparison-with-m3-b141).
- Harness (B1.4: `tools/maplibre-validation/`, see [maplibre-validation.md](maplibre-validation.md)): fresh app per run, A B B A A B, three runs per renderer and scenario; per-process memory sampler and GPU process counters as in M3; page and worker heaps after GC; 8 zoom cycles for memory growth (B1.4.1: 5 % growth limit is a **provisional diagnostic**, not an approved acceptance criterion; memory stays NOT TESTED in the report); `--force_high_performance_gpu` for the RTX 3080.

The environment would have been the M3 machine: AMD Ryzen 7 6800HS, AMD Radeon iGPU (driver 31.0.12024.2005) and RTX 3080 Laptop (32.0.16.1742), Windows 11 Home build 26300, WebView2 158.0.4370.33, 2560 × 1440 at 240 Hz, 150 % scaling, MapLibre 6.19.0. **No numbers are given for it.** The M3 results in [webgl-prototype.md](webgl-prototype.md) are **not** a MapLibre comparison and must not be read as one.

HYPOTHESIS, to be checked: GeoJSON at 1M segments (about 1.1M coordinate pairs, cloned to the workers and tiled by geojson-vt) is likely to miss the 500 ms first-visible target. A realistic production path would hand pre-cut vector tiles to MapLibre instead (ADR-004).

## Context loss, release, remount

**NOT TESTED.** `contextLoss()` (lose with `WEBGL_lose_context`, restore, count drawn pixels before and after) and `release()` / `remount()` (canvas count) exist but have not run. **FACT (source):** MapLibre handles `webglcontextlost` / `webglcontextrestored` by snapshotting and rebuilding its style. It has no Canvas 2D fallback and no software-renderer detection of its own (`failIfMajorPerformanceCaveat: false` by default), so RoadPilot would have to provide both (ADR-003 R6).

## Acceptance matrix

PASS = evidence recorded; PARTIAL = part verified or met with a documented deviation; FAIL = evidence of failure; NOT TESTED = no evidence.

### Brief (Phase 2.4D B1)

| #   | Criterion                                                                    | Result         | Evidence / reason                                                                                            |
| --- | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Repository preflight clean, `e1d2fe9` = `origin/main`                        | PASS           | `roadpilot-git.ps1 status`, `git status`, `rev-parse`                                                        |
| 2   | `maplibre-gl` 6.19.0 pinned, dev-only, no PMTiles, no extra libraries        | PASS           | `package.json`, isolation test                                                                               |
| 3   | Prototype reachable only through a dev-only entry, never imported by the app | PASS           | isolation test; no build input                                                                               |
| 4   | Excluded from `dist`; production build excludes MapLibre                     | PASS           | `dist` search empty; hashes identical to HEAD                                                                |
| 5   | Planar identity / custom projection, no Mercator, no WGS84                   | PASS (static)  | registered CRS, linear converter (unit tests); not observed at runtime                                       |
| 6   | Display X = X, Y = −Z, no additional scale or offset                         | PARTIAL        | exact in the CRS plane; the API needs a documented, exact 2⁻¹¹ carrier because `LngLat` rejects \|lat\| > 90 |
| 7   | Positional error ≤ 0.5 CSS px (zooms, sizes, magnitudes)                     | NOT TESTED     | unit-level expectations only; MapLibre `project` and rendered pixels never measured                          |
| 8   | East / north / no axis swap / no mirror / no hidden Mercator (rendered)      | NOT TESTED     | verified for the lab's own math only                                                                         |
| 9   | Scenarios A–D deterministic, ≥ 100k / ≥ 1M segments, no SCS data             | PASS           | unit tests (exact 100,000 / 1,000,000, reproducible hashes)                                                  |
| 10  | Road styles for five classes, RoadPilot design language                      | PARTIAL        | style built and tested (widths = production widths); never rendered                                          |
| 11  | Labels from local glyphs, collision, zoom visibility                         | NOT TESTED     | configuration tested; glyphs local but not bundled (see Labels)                                              |
| 12  | No external font / glyph / sprite / style URL                                | PASS (static)  | style and source tests                                                                                       |
| 13  | Interaction: wheel, drag, buttons, whole map, north-up, loading / error      | NOT TESTED     | implemented, never run                                                                                       |
| 14  | **Zero external network requests** (start, render, interaction, labels)      | **NOT TESTED** | instrumentation built; no log exists                                                                         |
| 15  | Production CSP unchanged and not weakened                                    | PASS           | `tauri.conf.json` unchanged; lab carries it verbatim (test)                                                  |
| 16  | Works under the production CSP (workers etc.)                                | NOT TESTED     | source analysis suggests yes (HYPOTHESIS); sprites / icons would be blocked (FACT)                           |
| 17  | First visible ≤ 100 ms (100k) / ≤ 500 ms (1M)                                | NOT TESTED     | —                                                                                                            |
| 18  | Frame gap p95 ≤ 20 ms (100k) / ≤ 33 ms (1M)                                  | NOT TESTED     | —                                                                                                            |
| 19  | Frame gap max ≤ 50 ms (100k) / ≤ 75 ms (1M)                                  | NOT TESTED     | —                                                                                                            |
| 20  | Pan responsive at 100k and 1M                                                | NOT TESTED     | —                                                                                                            |
| 21  | Comparison with M3 on identical data                                         | NOT TESTED     | identical-data path built and unit-tested                                                                    |
| 22  | Memory, GPU memory, no growth over repeated pan / zoom                       | NOT TESTED     | —                                                                                                            |
| 23  | No WebGL errors, crashes or context-loss loop                                | NOT TESTED     | —                                                                                                            |
| 24  | Test environment recorded                                                    | PARTIAL        | hardware, driver and WebView2 read on the machine; no run in it                                              |
| 25  | Production code, Rust, RPMT, IPC, telemetry, SDK, Input Plugin, M3 unchanged | PASS           | diff: only `package.json`, `package-lock.json`, `src/dev/mapLibreLab/`, this file                            |
| 26  | Typecheck, lint, format, tests, build                                        | PASS           | `npm run check` (43 files, 482 tests after B1.4); `npm run build`                                            |

### ADR-003 B1 criteria

| #   | Criterion                      | Result                                           |
| --- | ------------------------------ | ------------------------------------------------ |
| 1   | Offline start, 0 requests      | NOT TESTED                                       |
| 2   | CSP unchanged and working      | PARTIAL (unchanged: PASS; working: NOT TESTED)   |
| 3   | Coordinates and picking        | NOT TESTED (unit-level math only)                |
| 4   | Geometry 100k / 1M renders     | NOT TESTED                                       |
| 5   | Pan, zoom ×64, no jumping      | NOT TESTED                                       |
| 6   | Labels from bundled glyphs     | NOT TESTED; design deviates (local, not bundled) |
| 7   | Frame times                    | NOT TESTED                                       |
| 8   | First display                  | NOT TESTED                                       |
| 9   | Memory, 8 cycles               | NOT TESTED                                       |
| 10  | Context loss, release, remount | NOT TESTED                                       |
| 11  | Isolation                      | PASS                                             |

No criterion has a recorded FAIL. No threshold was changed.

## Static audit (B1.1)

A read-only review of `src/dev/mapLibreLab/` and of the installed MapLibre 6.19.0 sources. No code was changed by the audit, and nothing was run besides the static checks and unit tests.

### Confirmed from the MapLibre sources (FACT)

- **Silent Mercator fallback:** a `projection.type` that is not registered when the style loads falls back to Mercator with a one-time console warning only (`geo/projection/projection_factory.ts`, `default` case). A registered name used inside a projection **expression** falls back to globe. The lab uses a plain name and awaits `addProjection` (`ensureMapLibreGlobals`) before creating any map, so the order is correct. Only the runtime accuracy test can rule out a hidden fallback; it is designed to detect one (probes at carrier latitudes up to about ±34° would be visibly stretched under Mercator).
- **Style validation** accepts any string as a projection type (`validate_projectiondefinition.ts`), so `roadpilot:scs` passes validation.
- A registered CRS is drawn by `MercatorProjection` constructed with the CRS's `CRSWorldCoordinateHelper` (flat plane). The class name says Mercator, but the mapping is the CRS's.
- **Filters** may use `['zoom']` (style spec: filter parameters `zoom`, `feature`), so the city-label filter is valid.
- The worker global sets `setProjectionHandler` (`source/worker.ts`), which `scsProjection.worker.mjs` uses.
- `importScriptInWorkers` takes the `import()` path only for URLs ending in `.mjs`. The lab passes the Vite `?url` value of `scsProjection.worker.mjs`. That this value ends in `.mjs` is **inferred** from Vite's behaviour, not observed.

### Coordinate handling

- **Unit-tested (FACT):** display = (X, −Z); carrier = display / 2048, a bit-exact round trip; CRS converter linear and reversible; worker converter identical; expected screen positions equal the production `toScreen`.
- **Call sites (FACT, inspection):** every MapLibre input goes through `toCarrier`, and every output through `fromCarrier`: GeoJSON, initial centre, `jumpTo`, `project` / `unproject`, `getCenter`, `fitBounds` corners (south-west = (min X, max Z), north-east = (max X, min Z), correct for y = −Z). Screen expectations use `pixelsPerUnit(zoom, config.crs)`.
- **Inferred from source (HYPOTHESIS until run):** MapLibre's world square equals the tile matrix set, and `project` follows `CRSWorldCoordinateHelper` exactly.
- **Rendered positional accuracy:** NOT TESTED.

### Findings (as found in B1.1; all addressed in [B1.2](#b12--reliability-fixes))

**Correction to F1:** B1.1 stated the M3 scale error as "about 0.71 ×". The B1.2 unit test shows the opposite direction: reading an `identity` zoom with the `scs` scale gave 368,640 / 262,144 ≈ **1.41 ×** the intended scale, so M3 was zoomed **in**. 0.71 is the inverse ratio. The row below is kept as written in B1.1.

| #   | Location                                          | Finding                                                                                                                                                                                                      | Effect                                                                                                                                                                                                  | Proposed fix                                                                    |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| F1  | `main.ts`, `viewportOf` (line 167)                | **Coordinate inconsistency:** M3's scale always uses `pixelsPerUnit(zoom, 'scs')`, while `wholeCamera` (line 173) and `panCamera` use `config.crs`                                                           | Only the combination renderer = M3 with CRS = `identity`: M3's view is about 0.71 × the intended scale and the pan radius is wrong. The harness uses `scs` throughout; MapLibre paths are not affected  | Use `config.crs` in `viewportOf`                                                |
| F2  | `main.ts`, `mountMapLibre` and `loadMapLibreData` | No timeout: `waitFor(m, 'load')`, the `done` promise (first visible / complete) and `waitFor(m, 'idle')` wait forever if the style, a worker or a tile never loads (for example a worker blocked by the CSP) | `configure()` never settles, `busy` stays true, the overlay keeps showing "Loading…" instead of an error, and the `render` / `data` listeners stay attached. Map errors are still logged in `mapErrors` | A timeout that rejects with the collected `mapErrors` and removes the listeners |
| F3  | `main.ts`, `release()` during a load              | Removing the map while `loadMapLibreData` waits leaves its promise pending (same cause as F2)                                                                                                                | Lab-only; the removed map is garbage once unreferenced                                                                                                                                                  | Covered by F2                                                                   |
| F4  | `main.ts`, `ensureMapLibreGlobals`                | A rejected `importScriptInWorkers` is cached in `workersReady`. A retry would also throw in `addProjection` ("already exists")                                                                               | After one failure the page must be reloaded                                                                                                                                                             | Reset on failure and skip an already registered CRS                             |
| F5  | `main.ts`, `accuracy()`                           | Depends on the `probe` layer (`probes: true`); without it every dot is reported missing rather than as an error                                                                                              | Fails visibly (`missingDots`), never as a false pass                                                                                                                                                    | Throw when the layer is absent                                                  |
| F6  | `syntheticData.ts`, `urban` motorway walk         | Clamping at the area edge can repeat a point, giving zero-length segments that count toward the exact total                                                                                                  | Possible slight overstatement of drawable segments in B / C; not quantified                                                                                                                             | Skip a step that does not move                                                  |
| F7  | Memory interpretation                             | `GeoJSONSource` keeps the GeoJSON object passed to `setData` on the main thread, and the lab also keeps the dataset                                                                                          | The main-thread heap would include both copies at 1M segments; to be stated next to any heap figure                                                                                                     | Documentation only                                                              |

No accidental production import, no external URL, no `blob:` use, no `fetch`, no `eval` and no unnecessary dependency was found in the lab. The page-lifetime logs (`PerformanceObserver`, CSP violation listener) are intentional and small. Map and M3 cleanup in `release()` is complete for an idle lab: `map.remove()` releases the map's controls, handlers, style and WebGL context (FACT, source). MapLibre's worker pool is global and is **not** terminated by `remove()`, so the workers stay alive for the page's lifetime. M3 disposes its renderer and removes its canvas.

## B1.2 – Reliability fixes

Static fixes for the seven B1.1 findings, with CPU-only unit tests (fake emitters, fake timers, controlled promises; no browser, no GPU, no app start). The logic sits in two new MapLibre-free modules, `lifecycle.ts` and `accuracyReport.ts`, which `main.ts` uses. `main.ts` itself (DOM and MapLibre glue) still has no automated test and has never run.

| #   | Finding                                        | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Files                          | New tests                                                                                                                                                                                   |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | M3 viewport always used the `scs` scale        | `viewportOf(camera, crs)` and `cameraOf(viewport, crs)` in `coordinates.ts`; every M3 path and the whole-map camera use `config.crs`. The `/2048` carrier, the CRS and the MapLibre conversions are unchanged                                                                                                                                                                                                                                                            | `coordinates.ts`, `main.ts`    | `coordinates.test.ts`: both CRSs round-trip the whole-map viewport, equal scale, the same screen position through MapLibre's and M3's math, and the size of the old error (≈ 1.41 ×)        |
| F2  | Loading could wait forever                     | `LoadSession.wait` / `guard` with a timeout (`config.loadTimeoutMs`, default `DEFAULT_LOAD_TIMEOUT_MS` = 60,000 ms, settable through `configure({ loadTimeoutMs })`) for worker setup, style load, data until complete, idle and `setData`; M3 uploads check the same limit. A timeout rejects with `LoadTimeoutError` carrying the label and the last map errors; `configure()` then releases the failed map, shows the error overlay and records it in `state().error` | `lifecycle.ts`, `main.ts`      | `lifecycle.test.ts`: success, timeout with details, no effect of a timer after success, guard timeout, an error thrown while checking an event                                              |
| F3  | Release during a load left work pending        | `release()` releases the session first: every listener the lab attached is removed and every pending wait rejects with `ReleasedError`, then the map is removed or M3 disposed. `configure()` checks `throwIfReleased` after every `await` and only then writes results; a release is not shown as an error. Idempotent. `settle()` returns at once when nothing is mounted                                                                                              | `lifecycle.ts`, `main.ts`      | release during initialisation, deterministic settlement (no timer left), nothing attachable after release, late events and late promise results ignored, repeated release, listener cleanup |
| F4  | A failed worker setup was cached for ever      | `createRetryableInit`: concurrent callers share one attempt; a failure is not cached; a retry repeats only the steps that failed, so `setWorkerUrl` and `addProjection` run once (a second `addProjection` would throw) and the worker handler import is repeated only after it failed                                                                                                                                                                                   | `lifecycle.ts`, `main.ts`      | first success reused, fail-then-retry without duplicate registration, concurrent requests share one attempt, concurrent requests during a failing attempt                                   |
| F5  | A missing probe layer looked like missing dots | `checkProbeInfrastructure` before measuring and `summarizeAccuracy` after. Results are `infrastructure_error` (probe layer or source missing, nothing measured, non-finite value) or `measured`. `withinTolerance` is true only when every dot was found and every error is finite and ≤ 0.5 CSS px                                                                                                                                                                      | `accuracyReport.ts`, `main.ts` | `accuracyReport.test.ts`: probe present, layer and source missing, invalid results (five kinds), valid result within tolerance, the 0.5 px boundary, missing dots, API error, no cases      |
| F6  | Clamped motorway steps                         | The motorway walk reflects its heading at the area edge, so every motorway segment is exactly 250 units and inside the area. `Builder.add` also drops consecutive identical points before counting, in every scenario. The fixed seeds are unchanged; the final grid fill still reaches the exact totals                                                                                                                                                                 | `syntheticData.ts`             | `syntheticData.test.ts`: for A, B, C (1,000,000) and D: no zero-length segment, finite in-world points, valid classes, exact counts, determinism; small urban sizes; motorway step length   |
| F7  | Memory interpretation                          | Documented below; no code change                                                                                                                                                                                                                                                                                                                                                                                                                                         | this file                      | –                                                                                                                                                                                           |

**Effect on the datasets:** seeds, classes and segment counts are unchanged (FACT, tests). The geometry of B and C differs from B1 wherever a motorway reached the area edge, because the walk now turns back where it used to be clamped. Whether that happened in the default sizes, and whether the B1 generator produced any zero-length segment at all, was not checked before the fix. The new tests rule zero-length segments out now. Since nothing was measured with the B1 data, no recorded result depends on the old geometry.

**Known limitations of the fixes:**

- MapLibre's worker pool is global and lives as long as the page. Neither `release()` nor a timeout stops it or cancels work already sent to it; such work is only ignored when it comes back.
- A timeout ends the lab's wait. It does not abort MapLibre's internal loading.
- A worker-handler import that reached some workers before failing is broadcast again on retry. Module caching makes a second import of the same URL a no-op in a worker that already has it (FACT, ES module semantics), and `setProjectionHandler` replaces rather than adds.
- The 60 s default is a lab safeguard, not a performance target. It has no relation to the B1 acceptance thresholds.

### F7: what memory measurements would contain

No memory was measured. When the lab is measured later, the figures can only be read with the following in mind. There are no estimates here.

| Quantity                | Where it lives                                                      | Contains                                                                                                                                                                                        | Separable?                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Synthetic dataset       | Main-thread JS heap (`dataset`, kept between loads)                 | `Float64Array` points of every road, names, cities, probes                                                                                                                                      | Only by heap snapshot; not by `usedJSHeapSize`                                                                             |
| GeoJSON input           | Main-thread JS heap                                                 | The feature collections built for `setData` (about one small array per coordinate). `GeoJSONSource` keeps a reference to the last data passed, so this copy stays alive as long as the map does | Only by heap snapshot                                                                                                      |
| M3 tiles                | Main-thread JS heap (`ScenarioTiles` cache, M3 mode only)           | `Float32Array` tile points of the visible tiles                                                                                                                                                 | Only by heap snapshot                                                                                                      |
| MapLibre source data    | MapLibre's **worker** heaps                                         | A structured-clone copy of the GeoJSON, geojson-vt's index and the generated vector tiles                                                                                                       | Per worker through DevTools (`Runtime.getHeapUsage` per worker session); not split by purpose                              |
| Main-thread heap        | Renderer process                                                    | All of the above main-thread items, plus MapLibre's tiles, buckets and symbol data on the main thread, plus the lab                                                                             | Total only (`usedJSHeapSize` after GC)                                                                                     |
| Renderer-process memory | `msedgewebview2.exe --type=renderer`                                | The JS heaps of the page **and** its workers, DOM, canvas and other native allocations                                                                                                          | Total only (private bytes); the dashboard page is not loaded in the lab, but WebView2's own allocations are included       |
| GPU memory              | GPU process and driver (`\GPU Process Memory` counters per adapter) | MapLibre's vertex and index buffers, textures (glyph atlas, render targets), or M3's buffers and coverage target; the swap chain                                                                | By process and adapter only; not by buffer. "Shared" GPU memory is system RAM and also appears in some process counters    |
| Duplicates              | –                                                                   | At 1M segments the same geometry exists at least three times in JS (dataset, GeoJSON input, worker clone), plus once more in GPU buffers                                                        | The duplication is a property of this lab's GeoJSON path. A tile-based production path would not keep the first two copies |

So a heap or process figure from this lab is an upper bound for "MapLibre's" cost and overstates what a tile-fed production map would hold. MapLibre and M3 also keep different copies (M3: dataset plus tile arrays; MapLibre: dataset plus GeoJSON plus worker data), so a total-memory comparison of the two compares whole lab configurations, not renderers.

## B1.4 – Validation harness and first visible geometry

Static preparation for the B1 runtime validation, following the B1.3 readiness audit. Nothing was run.

- **O1 / O2, harness:** moved from a temporary folder into `tools/maplibre-validation/`. It now reads the B1.2 accuracy format and never assumes `results` exists. Evaluation lives in a pure module (`report.mjs`) with PASS / FAIL / INVALID / NOT_TESTED verdicts, and a failed step, a failed run, a broken request log or too few runs can never produce a pass. Repository-relative paths, an explicit `--confirm-runtime` gate, and a busy-desktop guard limited to the supported games and NVIDIA utilisation. Details: [maplibre-validation.md](maplibre-validation.md).
- **O3, first visible geometry:** now the first rendered frame with at least one pixel of the road line layers, classified against the style's road colours. Only colours that no background, label, halo or probe mix can produce are used. With labels this is the motorway fill alone; without labels every road layer. Labels can no longer stop the clock, and the definition can only report a later time, never an earlier one. Code: `roadPixels.ts`; result fields `firstRoadPixels` and `roadDetectionLayers`.
- **New tests:** `roadPixels.test.ts` (9) and `validationReport.test.ts` (33), CPU-only.
- **B1.4.1 review corrections:** the 5 % memory growth limit is a provisional diagnostic threshold. It is reported as `diagnostic` and never decides PASS or FAIL. The memory criterion stays NOT TESTED until a threshold is approved. The MapLibre and M3 first-visible measurements were reviewed statically and found not equivalent; any comparison between them requires runtime verification. Thresholds unchanged.

## B1.5 – Runtime validation (stopped)

2026-11-22, RoadPilot debug build in WebView2 158.0.4370.33, AMD Radeon iGPU (default GPU), Windows 11 build 26300, idle desktop; the RTX 3080 was not used. **MEASUREMENT** unless marked otherwise.

- Functional run (second start): network offline (0 external requests, 0 CSP violations), context loss PASS, release/remount PASS, API projection exact (error ≤ 7 × 10⁻¹⁰ px), `fitBounds` and rotation exact. Rendered accuracy FAIL: within 0.08 px at zoom 5–13, up to 8.3 px at zoom 1 and 3.
- MapLibre perf (one run per kind at 100k before the stop): first visible 387 ms (labels) and 257 ms (no labels), frame gaps within limits. Not valid: see defect A.
- M3 100k (one valid run): first visible 41 ms, p95 16.9 ms, max 33.3 ms.
- **Defect A (lab):** 5 of 8 MapLibre workers warned that no projection handler was set; one handler import was aborted by worker termination. MapLibre geometry, accuracy and timing of B1.5 are therefore not trustworthy.
- **Defect B (harness):** 6 of 10 app starts ended in "lab page did not load"; the failed starts kept no diagnostics.
- Verdict: **NO-GO**; the run was stopped under its failure rules.

## B1.5.1 – Runtime defect corrections (static)

Details, sources and limits: [maplibre-validation.md, B1.5.1 corrections](maplibre-validation.md#b151-corrections).

- **Defect A, mechanism (FACT, source):** removing the last map terminates MapLibre's workers; replacement workers do get the handler script again, but GeoJSON can be tiled before that asynchronous import has finished. **Correction:** `prewarm()` holds the worker pool; `workerProjection.ts` imports the handler, verifies it in every worker through a status message answered only after `setProjectionHandler` ran, registers again whenever MapLibre creates workers, and blocks every map mount and data load until then. A failure fails the load; there is no fallback. Load results and `state()` record the verification.
- **Defect B, mechanism (source, not proven as the B1.5 cause):** wry creates the WebView2 page target before it navigates to the dev server, so a lab navigation sent too early can be replaced. **Correction:** `openlab.mjs` opens the lab in six bounded stages (startup, target, app navigation, lab navigation, lab ready, initial configuration), saves diagnostics for every failed attempt (URL, events, console, exceptions, screenshot, dev server, processes, stage), and retries only after verified cleanup.
- **Evaluation:** a MapLibre perf run without verified worker projection, with a worker recreation, or with MapLibre's missing-handler warning is INVALID; the functional run has a new `workerProjection` criterion.
- **Evidence preservation:** runs write into session folders, refuse to start if their result files exist, and never overwrite; the B1.5 evidence is unchanged. The results folder is excluded from Prettier (raw evidence).
- **New tests:** `workerProjection.test.ts` (15), `openLab.test.ts` (13); `validationReport.test.ts` now 37. They test the logic against fakes and do not verify real worker or WebView2 behaviour.
- **Unchanged:** thresholds, SCS transform and `/2048` carrier, production renderer, CSP, telemetry and control code; `maplibre-gl` stays a dev dependency; the production build contains no lab code.

### Remaining runtime validation

Everything in the [acceptance matrix](#acceptance-matrix) needs a new run with the corrected lab and harness, including whether `prewarm()` keeps the workers across `map.remove()` in WebView2, whether the status check passes in real workers, and whether the staged opening removes the B1.5 start failures. B1.5 MapLibre results cannot be reused.

## B1.5.2 – Revalidation (stopped)

2026-11-22, WebView2 158, AMD. **MEASUREMENT.** Lab opening PASS in 5 of 5 starts. Worker projection FAIL: normal lifecycle (release, remount, reconfigurations, M3 round trip) clean on one worker, but after a forced `WorkerPool.restart()` the new worker tiled GeoJSON once without the handler, before the replayed import had finished; the lab re-registered 89 ms later. Tests C–F not run. Details: [maplibre-validation.md, B1.5.2](maplibre-validation.md#b152-revalidation-stopped).

## B1.5.3 – Worker entry correction

Details, APIs, ordering argument and verification status: [maplibre-validation.md, B1.5.3](maplibre-validation.md#b153-worker-entry-correction).

- **Root cause (FACT, source):** after `WorkerPool.restart`, MapLibre reloads every map's sources into the new workers by itself; the B1.5.1 handler arrived by an asynchronous `importScriptInWorkers` import that this reload does not wait for. Main-thread waiting cannot close that window.
- **Correction:** MapLibre starts every worker from `scsWorkerEntry.mjs` (`setWorkerUrl`). The entry statically imports MapLibre's worker bundle and installs the handler in the same synchronous module evaluation, so a worker has it before it can handle any message, in every generation. `prewarm()`, generation tracking, verification (now requiring an entry-installed status with no message before the installation), bounded retries, worker-error recording and the data reload after a recreation stay as secondary safety. A worker that cannot install closes itself and the registration fails loudly; there is no Mercator fallback.
- **Checked:** unit tests (one runs the real MapLibre 6.19.0 worker bundle through the entry), and a synthetic headless Edge 158 check under the production CSP: 10 of 10 forced restarts with the handler in place before the first message, while the B1.5.1 code failed 10 of 10 in the same check.
- **Unchanged:** SCS transform and `/2048` carrier, thresholds, production CSP and renderer, telemetry and control code; production `dist` byte-identical (the hashes above).
- **Not shown:** RoadPilot's WebView2 runtime. B1.5.4 must repeat B1.5.2 Test B there.

## Known limitations

- **Little runtime evidence.** B1.5 and B1.5.2 ran parts of the lab in WebView2 and stopped; B1.5.3 ran the worker path in headless Edge only. The lab code paths (style acceptance of the registered projection, worker startup, GeoJSON tiling in the CRS, accuracy and benchmark code) have never executed in a browser. Bugs in the lab itself are possible.
- The API carrier (×2⁻¹¹) is required by MapLibre's `LngLat` validation. Every RoadPilot call into MapLibre would have to convert.
- The planar CRS API is experimental (since 6.15, October 2026) and may change in a minor release. Planar `queryRenderedFeatures`, `fitBounds` and camera helpers are reported upstream as partly Mercator-bound (unverified here).
- Glyphs depend on installed fonts. No icons or sprites under the production CSP.
- No Canvas 2D fallback or software-rendering detection in MapLibre.
- The data path is GeoJSON in memory, not RPMT. A production path would need a tile conversion (ADR-004).
- Synthetic data only. Nothing here says anything about ATS or ETS2 maps, alignment or in-game accuracy.
- Linux / WebKitGTK, the GTX 1070 and the Intel HD 530: NOT TESTED.

## Recommendation

**Status: B1 IMPLEMENTED – STATIC RELIABILITY FIXES COMPLETE – RUNTIME VALIDATION PENDING.** No production integration is recommended, and no later phase is started.

**CONDITIONAL GO – for further isolated work only, limited to running the prepared B1 validation.** This is not a decision for MapLibre over the custom renderer.

- What supports it: the planar CRS can hold native SCS-magnitude coordinates exactly, with a documented, lossless API carrier. Static analysis of 6.19.0 shows an offline, CSP-compatible worker and glyph path that does not need `blob:` or any URL. The experiment stays fully out of production (byte-identical bundle).
- Conditions that remain open before anything else may be decided:
  1. Run the existing harness in RoadPilot's WebView2: zero external requests, CSP without violations, positional error ≤ 0.5 CSS px, labels, context loss.
  2. Measure the performance and memory targets against M3 on identical data, without changing thresholds.
  3. Accept or reject the API carrier, and decide on bundled fonts and the icon / CSP limitation.
- Should RoadPilot continue with MapLibre or keep the custom renderer? **Not decidable on this evidence.** Until B1 is completed, the custom renderer (Canvas 2D in production, M3 WebGL 2 as the reference) remains the baseline.
