# WebGL 2 road renderer prototype (Phase 2.4C.5 M2, Phase 2.4C.7 M3)

An isolated prototype that draws synthetic road networks with WebGL 2 and, for comparison, with the production Canvas 2D painter. It answers whether WebGL 2 offers a measurable advantage over the Canvas 2D renderer optimised in M0 ([map.md](map.md#canvas-2d-in-the-desktop-application-phase-24c3-m0)).

> **Scope:** prototype only. The dashboard's road map (`RoadMapView.tsx`, `roadPainter.ts`) is unchanged and does not use any of this. No package, no telemetry, no backend command, no Rust or IPC change; synthetic data only. The lab page is served by the Vite dev server and is not an input of the production build.

> **M3 (Phase 2.4C.7)** validated the prototype inside RoadPilot's own WebView2 on both GPUs of the development machine and changed three things: overlaps are now combined by per-class **coverage** with MAX blending (the stencil modes remain for comparison), tiles are built and uploaded **incrementally**, and **software rendering** is detected from the renderer string. See [M3: WebView2, NVIDIA and reliability](#m3-webview2-nvidia-and-reliability-phase-24c7). The M2 sections below describe the M2 state and its Edge measurements; where M3 changed behaviour, the M3 section says so.

Statements are marked **FACT** (follows from code or specification), **MEASUREMENT** (measured here), **HYPOTHESIS** (plausible, not verified) and **RECOMMENDATION**.

## Layout

| Path                                                  | Role                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/ui/navigation/render/types.ts`                   | Shared renderer interface, status, failures, statistics                                       |
| `src/ui/navigation/render/WebGL2RoadRenderer.ts`      | WebGL 2 renderer: context, program, per-tile buffers, stencil groups, context loss            |
| `src/ui/navigation/render/shaders/road.vert`, `.frag` | Instanced segment quads; capsule distance, smoothed edge, rail dash, chord opacity            |
| `src/ui/navigation/render/shaders/roadCoverage.frag`  | M3: per-class coverage into two targets (MAX blended)                                         |
| `src/ui/navigation/render/shaders/composite.*`        | M3: one full-screen pass laying the classes over each other in draw order                     |
| `src/ui/navigation/render/gpuInfo.ts`                 | M3: HARDWARE / SOFTWARE / UNKNOWN / UNAVAILABLE from the WebGL renderer string                |
| `src/ui/navigation/render/geometryBuilder.ts`         | 24-byte instance buffer per tile, sorted into one range per road class                        |
| `src/ui/navigation/render/gpuBufferCache.ts`          | LRU of tile buffers within a byte budget (64 MiB)                                             |
| `src/ui/navigation/render/roadStyle.ts`               | Colours, widths, dash and draw order derived from the production `ROAD_STYLES`                |
| `src/ui/navigation/render/Canvas2DRoadRenderer.ts`    | Canvas 2D side and fallback: the unchanged production `drawRoads` behind the same interface   |
| `src/ui/navigation/render/createRoadRenderer.ts`      | Selection with fallback, and the host that owns the canvas and drives `requestAnimationFrame` |
| `src/dev/syntheticScenarios.ts`                       | Reproducible synthetic networks (fixed seed) and their tiles                                  |
| `src/dev/renderLab/`                                  | Developer test page (`/src/dev/renderLab/index.html` on the dev server)                       |

**FACT:** the renderers import only `domain` and the production painter's styles (`ui`); nothing from `backend` or `state`. ESLint layering is unchanged.

## Renderer interface

```ts
type RendererKind = 'webgl2' | 'canvas2d'
type RendererFailure =
  | 'webgl2_unavailable'
  | 'context_creation_failed'
  | 'shader_compile'
  | 'program_link'
  | 'context_lost_repeatedly'
  | 'context_restore_failed'
  | 'out_of_memory'
type RendererStatus =
  | { state: 'ready' }
  | { state: 'lost' }
  | { state: 'failed'; reason: RendererFailure; detail?: string }

interface RoadRenderer {
  readonly kind: RendererKind
  resize(width: number, height: number, dpr: number): void // CSS size
  setView(viewport: Viewport): void
  setTiles(tiles: readonly SyntheticTile[]): void
  render(): RenderStats
  dispose(): void // idempotent
}
```

All methods are synchronous; the renderer has no loop of its own. The host (`RoadRendererHost`) bundles any number of changes into one `requestAnimationFrame` and calls `render()` at most once per frame. View changes (`setView`: uniforms only) and tile changes (`setTiles`: cache, build, upload) are separate.

Deviations from M1, each needed by the implementation:

| Change                                                                           | Reason                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyntheticTile` = the production `MapTile`                                       | The synthetic generator already produces `MapTile`; the Canvas 2D side can then call the production painter unchanged.                      |
| Failure `context_restore_failed`                                                 | A lost context that never comes back (the browser does not restore it) is a separate case from repeated losses.                             |
| `detail` on `failed`                                                             | Carries the shader/link log or `major_performance_caveat`; diagnostics only.                                                                |
| `RenderStats` adds `buffers`, `vertexArrays`, `overBudget`, `budgetBytes`        | Required by the lab and by the budget rule ("report, never drop visible geometry").                                                         |
| `uploads` is cumulative                                                          | A pan or zoom without uploads shows as no growth.                                                                                           |
| One stencil group per **class**, chords in the class range after the solid roads | Halves the draw calls against one group per class and opacity. Chord and solid road of one class share a colour; a solid pixel stays solid. |

## Instance format

One instance per road segment, 24 bytes, little endian; coordinates relative to the tile origin.

| Offset | Field      | Type    |
| ------ | ---------- | ------- |
| 0      | x0, z0     | 2 × f32 |
| 8      | x1, z1     | 2 × f32 |
| 16     | dist0      | f32     |
| 20     | road class | u8      |
| 21     | road flags | u8      |
| 22     | padding    | 2 bytes |

`dist0` is the road length up to the segment start (world units), so the rail dash continues across joints. Instances are sorted per tile into one contiguous range per class in draw order (rail, minor, local, primary, motorway), solid roads before chords. Roads with fewer than two points, out-of-range indices or unknown classes are skipped, as are segments with non-finite ends and zero-length segments; a road of one repeated point becomes a dot. **FACT:** covered by `geometryBuilder.test.ts`.

Attributes: one vertex buffer per tile, one vertex array per tile and non-empty class (its pointers start at the class range, because WebGL 2 has no base instance); `vertexAttribDivisor(…, 1)` for all four attributes, `vertexAttribIPointer` for class and flags (`uvec2` of `UNSIGNED_BYTE`).

## Shaders

- **Vertex:** four vertices per instance (`gl_VertexID`, triangle strip) form a quad around the segment, extended by half the line width plus one pixel on every side. The tile origin is a uniform in device pixels computed on the CPU in double precision, so the f32 coordinates never carry large values. The fragment shader gets the position in segment space (along, across) in device pixels.
- **Fragment:** distance to the segment (a capsule: round caps and, through the overlapping caps of consecutive segments, round joins); coverage `clamp(halfWidth + 0.5 − distance)` gives a one-pixel smoothed edge. Rail: distance to the nearest dash, itself a capsule, which reproduces Canvas 2D's round-capped dash `[4, 3]`. Chords: alpha 0.6. Output premultiplied alpha, blended with `ONE, ONE_MINUS_SRC_ALPHA` over a transparent canvas, like the Canvas 2D view.
- **Widths and colours** come from the production `ROAD_STYLES`; the zoom bonus (+0.5 / +1.5 px) is computed inline by the production painter and therefore repeated in `roadStyle.ts`. `roadStyle.test.ts` checks the widths against what `drawRoads` actually strokes.

## Duplicate roads and the stencil

A road is listed, with all its points, in every tile it touches, and consecutive segments overlap at their caps. Without precautions such pixels are blended several times. Each class is a stencil group: `stencilFunc(NOTEQUAL, ref)`, `stencilOp(KEEP, KEEP, REPLACE)`, one reference value per class, cleared once per frame. Later classes have other references and draw over earlier ones, so real crossings of different classes stay visible.

**Finding:** the single pass proposed in M1 is flawed together with shader smoothing. The first fragment to reach a pixel claims it, also when it is only the faint edge of one segment and the next segment would cover the pixel fully. That leaves a light arc at every joint and at every same-class crossing.

The prototype therefore offers three modes (`stencilMode`):

| Mode                   | Passes per class                                                      | Result                                                                                                    |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `coreFringe` (default) | 1. fully covered fragments, stencilled; 2. edge fragments, stencilled | Edges can no longer cut into the core of a neighbouring segment. Remaining: edge against edge, first wins |
| `single` (M1)          | all covered fragments, stencilled                                     | Light arcs at joints and crossings                                                                        |
| `off`                  | all, no stencil (comparison only)                                     | Duplicate tiles, joints and crossings darken                                                              |

**MEASUREMENT** (pixel comparison in Edge: every WebGL mode against the Canvas 2D painter on the same tiles, view and size; share of road pixels whose colour differs by more than 24/255; "lighter" = WebGL lighter than Canvas 2D):

| Scenario and view                      | DPR | `coreFringe`     | `single` (M1)     | `off`            |
| -------------------------------------- | --- | ---------------- | ----------------- | ---------------- |
| crossings, overview                    | 1   | 0.46 % (lighter) | 1.44 % (lighter)  | 0.28 % (darker)  |
| crossings, zoom-in (zig-zag joins)     | 1   | 0.00 %           | 0.22 % (lighter)  | 0.14 % (darker)  |
| parallel and duplicate roads, close-up | 1   | 0.51 % (lighter) | 2.26 % (lighter)  | 17.69 % (darker) |
| chords, star of chords                 | 1   | 0.01 %           | 0.08 %            | 27.86 % (darker) |
| tile borders, close-up                 | 1   | 0.23 %           | 0.79 %            | 37.88 % (darker) |
| rail, close-up                         | 1   | 0.10 %           | 0.37 %            | 42.69 % (darker) |
| small map, whole map                   | 1   | 1.02 %           | 2.17 %            | 34.19 % (darker) |
| city, close-up                         | 1   | 0.66 %           | 2.31 %            | 19.93 % (darker) |
| city, whole city (thin lines)          | 1   | 8.68 % (lighter) | 18.52 % (lighter) | 14.30 % (darker) |
| city, whole city (thin lines)          | 1.5 | 4.31 % (lighter) | 14.48 % (lighter) | 9.86 % (darker)  |
| parallel, overview (1–4 units apart)   | 1   | 3.86 % (lighter) | 8.41 % (lighter)  | 1.30 %           |

Findings:

- **MEASUREMENT:** without a stencil, roads in several tiles, overlapping caps at joints and same-class crossings darken visibly (up to 43 % of road pixels). The stencil is needed.
- **MEASUREMENT:** the M1 single pass leaves the predicted light arcs (only "lighter" deviations), two to four times more than `coreFringe`.
- **MEASUREMENT:** `coreFringe` matches Canvas 2D within about 1 % of road pixels in most views; crossings of different classes stay visible. It still deviates for **thin, densely sampled lines** (whole city: 1.9 px wide, a joint every 2.7 px: 8.7 % at DPR 1, 4.3 % at 1.5) and for **sub-pixel parallel roads** (3.9 %). Below about 2 px almost every fragment is an edge fragment, and among edge fragments the first one still wins. Visible as faint light speckles along thin roads.
- **FACT:** an earlier shader version cut the rail dash hard, while Canvas 2D draws each dash with round caps (16 % deviation). The dash is now a capsule as well (0.10 %).

Alternatives for the remaining edge-against-edge error, not implemented (**RECOMMENDATION:** evaluate in M3): (a) per class, render coverage into an offscreen R8 target with `MAX` blending and composite it once with the class colour (exact union, one full-screen pass per class, no stencil); (b) a depth test on `1 − coverage` in the edge pass (needs a depth buffer, deviates from the M1 attributes, approximates the union); (c) joined polyline geometry per road, so that a road never overlaps itself and the stencil only handles duplicates and crossings; (d) an MSAA render target without shader smoothing.

## GPU buffer cache

- Key `contentId/level/x/z`: one buffer per package, level of detail and tile; known tiles are never uploaded twice. Buffers are created with `STATIC_DRAW` once and only deleted on eviction, content change or dispose.
- LRU within **64 MiB** of requested buffer bytes (not measured video memory). Only tiles not in the last `setTiles` are evicted, in one pass, so eviction always ends. When the visible tiles alone exceed the budget, they are all kept and drawn and `overBudget` is reported.
- Eviction deletes the buffer and every vertex array of the tile explicitly (`deleteBuffer`, `deleteVertexArray`). A different content id releases everything first; tiles of another package within one call are ignored. `dispose()` releases everything, deletes the program and, by default, drops the context through `WEBGL_lose_context`, so the GPU process can free it at once.
- `getError` is checked once per `setTiles` batch (it waits for the GPU process); `OUT_OF_MEMORY` fails the renderer with `out_of_memory`.
- Tiles entirely outside the canvas are skipped per frame, using the geometry bounds of each tile (a road may extend beyond its tile).

## Fallback

`createRoadRenderer` tries WebGL 2 with the M1 context attributes (`antialias: false`, `alpha`, `premultipliedAlpha`, no `preserveDrawingBuffer`, no depth, `stencil`, `powerPreference: 'default'`, `failIfMajorPerformanceCaveat: true`) and falls back to Canvas 2D when WebGL 2 does not exist, no context is created, or the program fails to compile or link. A canvas keeps the first context type it was given, so the fallback **always uses a new canvas element**; the host disposes the previous renderer and removes its canvas before the next one exists, so two renderers never draw the map at the same time.

When context creation fails, a throw-away canvas is probed without `failIfMajorPerformanceCaveat`; if that succeeds, `detail` is `major_performance_caveat`. This is a heuristic: it cannot tell a performance caveat from any other failure that only affects the first canvas (the lab's "No WebGL 2" switch, for example, is reported this way).

If the stencil buffer is missing, the renderer draws one unstencilled pass (reported in the diagnostics), it does not fail.

## Context loss

- `webglcontextlost`: `preventDefault()` (otherwise the browser never restores), status `lost`; the cache is forgotten without delete calls on dead handles; `render()` draws nothing.
- `webglcontextrestored`: program, GL state, buffers and vertex arrays are rebuilt from the CPU-side tiles of the last `setTiles` (tiles handed over while lost included); status `ready`, and the host requests a frame.
- A third loss within 60 s fails with `context_lost_repeatedly`; a loss not restored within 5 s fails with `context_restore_failed`; a failing program after the restore fails with its reason. On `failed` the host switches to Canvas 2D on a new canvas.
- `dispose()` during a loss clears the restore timer and removes the listeners; a later restore event has no effect.

## Synthetic scenarios

Seed `0x2c45` (mulberry32); the content id is a hash of scenario, size and seed. No game geometry, nothing derived from packages.

| Scenario      | Content                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `small`       | The existing synthetic test map (`syntheticMap.ts`), unchanged                                                                                      |
| `city`        | Six rotated town grids, minor roads, avenues and a ring road                                                                                        |
| `motorway`    | Motorways between 14 nodes, interchange loops, feeders                                                                                              |
| `crossings`   | Same-class crossings at 90° and 30°, different classes, star and T junctions, chords across chords and solids, zig-zag, a crossing on a tile corner |
| `parallel`    | Parallel pairs 1–32 units apart for every class, identical duplicates, collinear overlaps, parallel chords                                          |
| `rail`        | Straight, curved, zig-zag and crossing tracks, parallel tracks, a road across them                                                                  |
| `chords`      | Chord fans per class, a star of chords, chords spanning several tiles                                                                               |
| `tileBorders` | Roads exactly on tile borders, a diagonal through tile corners, a zig-zag across a border, a road over many tiles, a circle around a corner         |
| `large`       | Mixed network, exactly 100,000 segments (adjustable)                                                                                                |
| `stress`      | Mixed network, exactly 1,000,000 segments (adjustable)                                                                                              |

Tiles are built like the backend lists roads: a road appears with all its points in every tile its segments touch (segment bounding boxes, so conservative). Levels show the classes of the backend's levels; there is no simplification. `auto` chooses level and tiles like the dashboard (`chooseLevel`, at most 64 tiles); `full` draws level 0 and every tile in view. **FACT:** reproducibility, exact segment counts and decodability of the tiles by the production decoder are tested.

## Render lab

`npm run dev`, then `http://127.0.0.1:1420/src/dev/renderLab/index.html`. Renderer, stencil mode, scenario, segment count, detail, GPU budget, "No WebGL 2" switch; zoom (wheel, + / −), pan (drag), whole map; context loss and restore, release and remount; a pan + three zoom cycles benchmark. Statistics: renderer, status, fallback, GPU, stencil, DPR, canvas size, level and tiles, roads, segments, draw calls, uploads, buffers, vertex arrays, GPU bytes and budget, `render()` and `setTiles` time, build and upload time, FPS and frame gaps, context losses, JS heap. It changes no setting of RoadPilot and stores nothing.

`window.renderLab` is the interface of the desktop harness: `configure`, `run('pan' | 'zoom')`, `firstFrame`, `compare` (pixel comparison against Canvas 2D), `loseContext`, `restoreContext`, `release`, `remount`, `state`.

## Measurement method

- **Environment (FACT):** development laptop on mains power; AMD Radeon integrated GPU driving the 240 Hz panel (WebGL renderer string `ANGLE (AMD, AMD Radeon(TM) Graphics … Direct3D11)`; the NVIDIA RTX 3080 Laptop GPU is present but not chosen with `powerPreference: 'default'`); Windows 11; Microsoft Edge 158 (Chromium, the engine of WebView2). The desktop was otherwise idle; no game was running.
- **Harness:** Edge with its own profile, driven through the DevTools protocol (no input simulation), restarted for every run; emulated window 1280 × 900 CSS pixels (map area 980 × 900), DPR 1.0 or 1.5. The lab runs from the Vite dev server.
- **Run:** configure; first frame (renderer created empty, `setTiles`, `render`, one-pixel read-back to wait for the GPU); 3 s pan (a circle of 300 CSS px radius, the view changes every frame); three zoom cycles (×64 in and out, 3 s each, tiles follow the view); idle. WebGL and Canvas 2D alternate (A B B A A B); three runs per renderer, scenario and DPR; median (range).
- **Frame gaps** are the times between consecutive rendered frames (`requestAnimationFrame` timestamps; every frame renders during the animation); FPS = frames / time. `render()` time is CPU time of the call on the main thread; GPU time per frame was not measured.
- **Memory:** private bytes per Edge process type of the harness profile (`Win32_Process.PrivatePageCount`); dedicated and shared GPU usage of the GPU process (`\GPU Process Memory(pid_…)` counters), sampled about every 1.7 s (11–12 samples per run, so short peaks can be missed); JS heap through the DevTools protocol after a forced garbage collection. "Total" is the sum over all processes of the profile. The backend is not involved.
- **Scenarios measured:** `small`, `city`, `motorway` with the dashboard's level choice (`auto`); `large` (100,000 segments) and `stress` (1,000,000) with `full` detail, i.e. every segment of the map on screen at the whole map.
- **Not measurable:** no 60 Hz panel was available; GPU time per frame.

## Results

All values **MEASUREMENT**: median (range) of three runs, Edge 158 on the integrated AMD GPU, 240 Hz panel. 100k = `large`, 1M = `stress`, both with `full` detail.

### Frame rate and CPU time

| Measure                       | 100k 1.0 WebGL | 100k 1.0 Canvas | 100k 1.5 WebGL | 100k 1.5 Canvas | 1M 1.0 WebGL | 1M 1.0 Canvas | 1M 1.5 WebGL | 1M 1.5 Canvas |
| ----------------------------- | -------------- | --------------- | -------------- | --------------- | ------------ | ------------- | ------------ | ------------- |
| Pan FPS                       | 170            | 164             | 137            | 146             | 62           | 29            | 48           | 24            |
| Pan frame gap p50 / p95 (ms)  | 4.2 / 8.5      | 4.2 / 8.5       | 8.3 / 12.5     | 8.2 / 12.5      | 16.6 / 25.1  | 29.1 / 66.6   | 20.7 / 33.4  | 33.3 / 62.7   |
| Pan frame gap max (ms)        | 37.5           | 37.5            | 75.0           | 41.5            | 45.9         | 162           | 54.0         | 388           |
| `render()` p50 / p95 (ms)     | 0.6 / 1.1      | 3.0 / 5.9       | 0.7 / 1.3      | 3.3 / 6.3       | 0.4 / 0.9    | 23.2 / 50.4   | 0.4 / 0.7    | 26.1 / 47.8   |
| Zoom FPS, slowest cycle       | 194            | 163             | 156            | 177             | 169          | 113           | 130          | 122           |
| Zoom frame gap p95 / max (ms) | 8.4 / 29.1     | 12.5 / 70.7     | 12.5 / 37.5    | 8.6 / 70.8      | 12.6 / 62.4  | 20.8 / 400    | 20.8 / 95.9  | 20.9 / 383    |
| Draw calls per frame, max     | 1,324          | 29              | 1,324          | 29              | 800          | 271           | 800          | 271           |
| Segments drawn, max           | 293,468        | 100,000         | 293,468        | 100,000         | 1,513,384    | 1,000,000     | 1,513,384    | 1,000,000     |
| GPU buffer bytes, max (MiB)   | 6.7            | –               | 6.7            | –               | 34.6         | –             | 34.6         | –             |

WebGL segment counts include the duplicates of roads listed in several tiles (Canvas 2D draws each road once). The zoom cycles of these two scenarios (`full`) change no tiles and upload nothing; with `auto` (small, city, motorway) three zoom cycles uploaded 50–76 tiles, and `setTiles` took at most 2.7–7.5 ms (median).

Small maps (`small` 493, `city` 11,997, `motorway` 3,479 segments): both renderers run at or near the panel's 240 Hz, `render()` p95 ≤ 0.5 ms, frame gap p95 4.3–8.4 ms. No meaningful difference.

### First visible geometry and geometry building

| Case          | WebGL first frame (ms) | of which `setTiles` (build + upload) | Canvas 2D first frame (ms) |
| ------------- | ---------------------- | ------------------------------------ | -------------------------- |
| small, DPR 1  | 11.2 (5.9–11.3)        | 0.8 (0.8–1.6)                        | 19.6 (15.8–34.3)           |
| city, DPR 1   | 9.6 (9.1–10.0)         | 1.1                                  | 21.2 (12.6–43.8)           |
| 100k, DPR 1   | 72.3 (66.5–89.0)       | 36.6 (36.2–51.2)                     | 28.8 (27.2–35.0)           |
| 100k, DPR 1.5 | 68.0 (65.7–68.7)       | 36.3 (35.6–36.4)                     | 59.9 (38.8–105.3)          |
| 1M, DPR 1     | 447 (374–517)          | 173 (167–238)                        | 153 (146–175)              |
| 1M, DPR 1.5   | 368 (368–483)          | 163 (158–192)                        | 171 (153–190)              |

First frame: from handing the tiles to the renderer to the end of the first frame, including a one-pixel read-back. For 1M segments at once (80 tiles, 1.5M instances, 35 MiB) the GPU part of the first frame (200–290 ms, including the driver's first-use shader work) and the geometry building dominate.

One tile at the backend limits (30,000 roads, 120,000 points, 90,000 instances, 2.1 MB): geometry building median 10.8 ms, max 13.3 ms after warm-up, first (cold) call 19 ms; upload (`bufferData`) median 0.8 ms. In the scenarios the slowest tile took 0.8 ms (100k) and 3.4–6.0 ms (1M).

### Memory

| MiB, max per run          | small WebGL | small Canvas | 100k 1.0 WebGL | 100k 1.0 Canvas | 100k 1.5 WebGL | 100k 1.5 Canvas | 1M 1.0 WebGL | 1M 1.0 Canvas | 1M 1.5 WebGL | 1M 1.5 Canvas |
| ------------------------- | ----------- | ------------ | -------------- | --------------- | -------------- | --------------- | ------------ | ------------- | ------------ | ------------- |
| Total, all processes      | 485         | 466          | 538            | 883             | 565            | 926             | 676          | 923           | 714          | 999           |
| GPU process, private      | 276         | 306          | 294            | 684             | 329            | 729             | 362          | 661           | 390          | 717           |
| Renderer process, private | 122         | 66           | 138            | 112             | 134            | 112             | 223          | 281           | 228          | 240           |
| GPU dedicated (GPU proc.) | 83          | 80           | 68             | 78              | 75             | 76              | 93           | 92            | 102          | 99            |
| GPU shared (GPU proc.)    | 154         | 178          | 158            | 440             | 188            | 495             | 219          | 522           | 238          | 565           |
| JS heap after GC          | 1.1         | 1.1          | 3.2            | 3.1             | 3.2            | 3.1             | 19.0         | 19.0          | 19.0         | 19.0          |

`city` and `motorway` match `small` within a few MiB. The JS heap is the lab's synthetic data, the same for both renderers.

**Stability over three zoom cycles** (last sample after cycle 1 against after cycle 3, median): renderer process +0.3 % to +2.4 % in every configuration (single runs up to +6.6 %); JS heap +0.5 % to +12.5 % (the lab keeps every synthetic tile it built; at 1M +0.5 %). Total and GPU process mostly **fall** after the first cycle (−9 % to −28 %), for both renderers alike; one of three 1M/1.5 WebGL runs rose by 19 % (total) and 25 % (GPU process), while the other two fell by 10–17 %. With 11–12 samples per run these whole-process figures are noisy; no steady growth was seen. In a separate run of six zoom cycles (100k, `auto`) the JS heap went 3.4, 3.5, 3.5, 3.6, 3.6, 3.7 MiB.

### Functional desktop tests

| Test                                    | Result                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| WebGL 2 available                       | yes, with the requested attributes and a stencil buffer                                                                      |
| Renderer switch (5×)                    | each switch: a new canvas element, exactly one canvas in the map area, drawing continues                                     |
| Zoom, pan, whole map                    | level and tiles follow the view; back at the whole map, cached tiles are not uploaded again                                  |
| Resize 980×900 → 600×600 → 1620×1080    | backing store follows CSS size × DPR                                                                                         |
| Context loss and restore                | status `lost`; restored after 25 ms; the 4 visible buffers uploaded again; same segments drawn                               |
| Three losses in a row                   | Canvas 2D on a new canvas (`context_lost_repeatedly`)                                                                        |
| Loss without restore                    | Canvas 2D after 5.1 s (`context_restore_failed`)                                                                             |
| Release during a loss, release, remount | no errors, no canvas left after release                                                                                      |
| `--disable-webgl2`                      | Canvas 2D (`context_creation_failed`)                                                                                        |
| `--disable-gpu` (WARP software WebGL)   | Canvas 2D (`context_creation_failed`, `major_performance_caveat`)                                                            |
| `--use-angle=swiftshader` (forced)      | **WebGL 2 is created on SwiftShader**: `failIfMajorPerformanceCaveat` does not reject an explicitly forced software renderer |

### Against the M2 targets

| Target                          | Result                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Pan/zoom ≥ 58 FPS at 60 Hz      | Not measurable at 60 Hz. At 240 Hz WebGL reaches 137–234 FPS up to 100k and 48–62 FPS (pan) at 1M; Canvas 2D 24–29 FPS at 1M |
| Frame gap p95 ≤ 20 ms           | WebGL: met up to 100k (≤ 12.5 ms); at 1M 25–33 ms (pan), 13–21 ms (zoom). Canvas 2D at 1M: 63–67 ms (pan)                    |
| Max frame gap ≤ 33 ms           | Met by neither: WebGL 29–75 ms up to 100k (single outliers), 46–96 ms at 1M; Canvas 2D 37–71 ms up to 100k, 162–454 ms at 1M |
| `render()` ≤ 2 ms at 100k       | WebGL p95 1.1–1.3 ms: met. Canvas 2D 5.9–6.3 ms                                                                              |
| ≤ 15 ms geometry per full tile  | median 10.8 ms, max 13.3 ms warm: met; the cold first call took 19 ms                                                        |
| GPU buffer budget 64 MiB        | 34.6 MiB with 1M segments on screen; never over budget                                                                       |
| Memory ±5 % after 3 zoom cycles | renderer process within +2.4 % (median); whole-process totals fall after the first cycle and are noisy (see above)           |
| First geometry ≤ 100 ms         | met up to 100k (66–89 ms); not at 1M (368–517 ms; Canvas 2D 146–190 ms)                                                      |

### Relation to the M0 baseline

The M0 figures (WebView2 total 471–627 MiB, GPU process 317–459 MiB, GPU dedicated 127–142 MiB, JS heap 26–32 MiB) are historical measurements of the full dashboard with real packages in WebView2. They are **not comparable** with these numbers (synthetic data, lab page, Edge, other map area). Within this measurement both renderers saw the same data, window, DPR and camera.

## M3: WebView2, NVIDIA and reliability (Phase 2.4C.7)

M3 tested the isolated prototype inside RoadPilot's own WebView2, on both GPUs of the development machine, and fixed the three M2 problems (thin lines, first frame at 1M segments, software rendering). The dashboard's `RoadMapView` and `roadPainter` are still unchanged and do not use the prototype; there is no Rust, IPC, tile format, telemetry or dependency change. Synthetic data only.

### Environment

| Item                 | Value (**FACT**, read on the machine and through DevTools in the app)                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Machine              | ASUS ROG Zephyrus G15 (GA503RS), mains power                                                                               |
| OS                   | Windows 11 Home, build 26300                                                                                               |
| Runtime              | RoadPilot debug build (`tauri dev` equivalent, Vite dev server), Tauri 2.12, WebView2 Runtime 158.0.4370.33 (Chromium 158) |
| GPU 1 (default)      | AMD Radeon integrated (0x1681), driver 31.0.12024.2005; drives the internal panel                                          |
| GPU 2                | NVIDIA GeForce RTX 3080 Laptop GPU (8 GiB), driver 617.42 (32.0.16.1742)                                                   |
| Display              | 2560 × 1440, 240 Hz, Windows scaling 150 % (native DPR 1.5)                                                                |
| WebGL                | ANGLE on Direct3D 11, WebGL 2.0 (OpenGL ES 3.0), `MAX_DRAW_BUFFERS` 8, 33 extensions incl. `WEBGL_debug_renderer_info`     |
| WebView2 GPU feature | `webgl: enabled`, `gpu_compositing: enabled`, Skia Graphite on, `displayType: ANGLE_D3D11`                                 |

The previously documented target hardware (GTX 1070 Mobile, Intel HD 530, driver 580.178.04) is **not** this machine. The NVIDIA results below are for the RTX 3080 Laptop; **GTX 1070 and Intel HD 530: NOT TESTED.**

**Harness (FACT):** the real `roadpilot.exe` is started once per run with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` set only in that child process (`--remote-debugging-port`, and per test `--force_high_performance_gpu`, `--use-angle=…`, `--disable-gpu`, …; Tauri's own WebView2 arguments are kept). The lab is opened in the app's window through DevTools (no mouse or keyboard input) and the app is closed with a normal window close. No system or driver setting was changed. Memory is sampled from `roadpilot.exe` and the WebView2 processes of RoadPilot's user data folder only. The window is emulated at 1280 × 900 CSS px, DPR 1 (map area 980 × 900), as in M2, unless stated. Occlusion throttling is switched off for the test process so a covered window keeps rendering. Before every start the harness refuses to run when the NVIDIA GPU is busy; measurements were paused once because a game had been started, and continued on an idle desktop.

### Overlaps: coverage instead of stencil (M3-C)

**Problem (M2):** with a stencil, the first fragment to reach a pixel wins. Below about 2 px nearly every fragment is a smoothed edge fragment, so a faint edge can claim a pixel that the next segment would cover fully: light speckles and gaps on thin roads.

**Change:** `coverage` mode (now the default). One pass draws every visible tile with one draw call; each fragment writes its coverage (same capsule distance, rail dash and chord opacity as before) into the channel of its class: rail, minor, local and primary into an RGBA8 target, motorway into an R8 target (two draw buffers). Blending is `MAX`, so overlapping fragments of one class keep the largest coverage: duplicates in several tiles, joints and same-class crossings neither darken (no sum) nor lighten (no first-wins). A full-screen composite pass then lays the five classes over each other in draw order with their colours, as Canvas 2D strokes one class after another. No stencil buffer is used.

- Draw calls: tiles + 1 (100k: 141 instead of 1,324; 1M: 81 instead of 800).
- Extra memory: the target, 5 bytes per device pixel (980 × 900: 4.2 MiB; at DPR 2: 16.8 MiB), not part of the buffer budget; reported as `targetBytes`.
- If the coverage programs fail to compile or the target is incomplete, the renderer uses `coreFringe` and reports `coverageFallback`.
- Trade-off: `MAX` approximates the union of two partial coverages from below (two half-covered edges give 0.5, Canvas 2D's analytic union gives about 0.75). Within one class this is the remaining deviation; it is small and never a gap.

**Test set (FACT):** new scenario `thin`, fixed shapes and seed, one band per class: straight and shallow (4°) lines, a sine curve sampled every 40 units and a circle every 30 (a joint every 1–2 px), zig-zags with joint angles of 20, 45, 90, 135 and 160°, a 5 × 5 grid of same-class crossings, a chord across a solid road, roads exactly on tile borders, a pair 2 units apart, and diagonals of other classes crossing every band. Views at scale 0.03 and 0.045 (no zoom bonus: 1–3 CSS px), 0.1 and 0.5, each at DPR 0.5, 1, 1.5 and 2, so the device widths cover 0.5, 0.7, 1, 1.1, 1.4, 1.5, 2, 2.1, 2.8, 3 px and wider. Comparison against the unchanged Canvas 2D painter as in M2, plus two continuity counts: **missing** = a clear road pixel in Canvas 2D (more than 48 from the background) that WebGL leaves empty, and the reverse.

**MEASUREMENT** (WebView2 in RoadPilot, AMD GPU; road pixels differing by more than 24/255):

| Cases                         | `coverage` (M3)           | `coreFringe` (M2)           | `single` (M1)               | `off`               |
| ----------------------------- | ------------------------- | --------------------------- | --------------------------- | ------------------- |
| `thin`, 20 views × DPR        | max 1.71 %, median 0.35 % | max 19.79 %, median 4.95 %  | max 25.05 %, median 13.79 % | max 64.6 % (darker) |
| `thin`, missing pixels, total | **0**                     | 5,460 (max 823 in one view) | 8,262                       | 0                   |
| M2 views, 20 cases            | max 0.68 %, median 0.03 % | max 8.68 %, median 0.36 %   | max 18.53 %, median 1.63 %  | max 42.7 % (darker) |
| M2 views, missing pixels      | **0**                     | 2,702                       | 5,418                       | 0                   |

Worst `coverage` cases are the 0.5–0.7 px lines (overview at DPR 0.5: 1.28–1.71 %); every other view is below 0.7 %. The M2 figures for `coreFringe` reproduce exactly in WebView2 (city whole view 8.68 % at DPR 1, 4.31 % at 1.5), so the engines draw the same. The diff images show `coreFringe`'s light speckles along every thin diagonal, curve and grid; `coverage` leaves only sub-threshold edge differences.

**Performance impact (MEASUREMENT,** CPU + GPU per frame: `render()` and a one-pixel read-back, 60 frames, whole map, AMD**):** 100k: `coverage` 2.5 ms median (p95 2.9), `coreFringe` 4.1 (5.8), `single` 2.4 (4.7). 1M: `coverage` 9.1 (10.5), `coreFringe` 13.2 (15.4), `single` 7.1 (8.7). Coverage is faster than M2's default and about 2 ms slower than the single pass at 1M (two render targets and the composite).

**Decision:** `coverage` is the default. It removes the thin-line error without giving up continuity and is cheaper than `coreFringe`. The stencil modes stay in the lab for comparison.

### Incremental initialization (M3-D)

**Change (FACT):**

- `setTiles` only records the wanted tiles; tiles already cached are drawn at once. New tiles are built and uploaded at the start of `render()`, at most `uploadBudgetMs` per frame (default 6 ms, at least one tile per frame so loading always progresses), on-screen tiles nearest the view centre first, ordered by the view of that frame. `uploadBudgetMs: Infinity` restores the M2 behaviour (everything in `setTiles`).
- A tile is drawn only when complete; nothing is dropped. `RenderStats.pending` counts tiles still missing; the host requests frames until it is 0 and the lab shows "Loading: n tiles pending". Queued tiles that are no longer wanted leave the queue; after a context restore the visible tiles are queued again.
- `buildTileGeometry` was rewritten without a `hypot` call and a closure per segment and without searching the class lists per road. Same instances, order, groups and bounds; `dist0` sums `sqrt(dx² + dz²)`, equal to M2's `hypot` up to float rounding (a test compares both builders on five scenarios and malformed input). **MEASUREMENT:** one tile at the backend limits (90,000 instances) 6.9 → 2.75 ms median, max 8.3 → 4.2 ms.

**MEASUREMENT** (fresh app per run, 3 runs alternating, median (range), `full` detail at the whole map, DPR 1; "first" = from `setTiles` to the first frame with geometry, with a one-pixel read-back; "full" = until nothing is pending; "longest frame" = longest `render()` during the load, the first frame including its read-back):

| Case                   | AMD first        | AMD full                   | AMD longest frame | NVIDIA first       | NVIDIA full               | NVIDIA longest frame |
| ---------------------- | ---------------- | -------------------------- | ----------------- | ------------------ | ------------------------- | -------------------- |
| 100k, incremental      | 18.6 (17.6–19.4) | 35.2 (34.1–36.1), 2 fr.    | 18.5              | 10.0 (9.8–20.6)    | 25.3 (23.2–48.0), 2 fr.   | 9.9                  |
| 100k, synchronous (M2) | 23.1 (22.2–25.2) | = first, one task          | 23.1              | 34.4 (34.4–34.9)   | = first, one task         | 34.4                 |
| 100k, Canvas 2D        | 19.6 (15.7–20.6) | –                          | 19.0              | 28.8 (18.9–31.7)   | –                         | 28.4                 |
| 1M, incremental        | 22.8 (21.2–26.6) | 116.5 (115.0–123.3), 5 fr. | 22.7              | 18.7 (10.0–19.7)   | 111.5 (81.1–114.6), 5 fr. | 18.7                 |
| 1M, synchronous (M2)   | 91.0 (83.4–91.1) | = first, one task          | 91.0              | 105.3 (62.5–107.0) | = first, one task         | 105.3                |
| 1M, Canvas 2D          | 99.4 (98.5–99.7) | –                          | 95.1              | 188.2 (91.3–194.2) | –                         | 184.7                |

At 1M the first frame shows about 150,000 of 1.51 million instances (the tiles around the view centre); the rest follows within five frames. Frame gaps during the load: at most 21 ms (AMD) and 26.5 ms (NVIDIA). Against M2 (Edge, AMD, first frame 447 ms at 1M), the first visible geometry is about 20× sooner and the full map is complete in about a quarter of the time; the synchronous path alone went from 447 to about 90 ms through the faster builder. Geometry building is still the largest part of a full load at 1M (about 47 ms); building in a worker is not done (**RECOMMENDATION** for later, together with real packages).

### Software rendering detection (M3-E)

`gpuInfo.ts` reads the renderer and vendor strings (unmasked through `WEBGL_debug_renderer_info` where offered, else plain `RENDERER` / `VENDOR`) and classifies:

| State         | When                                                                                                                                                       | Renderer choice                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `HARDWARE`    | the string names a GPU vendor or family (NVIDIA, GeForce, AMD, Radeon, Intel, Iris, Apple M, Adreno, Mali, …), and no software name                        | WebGL 2                                             |
| `SOFTWARE`    | the string names a software rasterizer: SwiftShader, Microsoft Basic Render Driver (WARP), llvmpipe, softpipe, lavapipe, Apple Software Renderer           | Canvas 2D (`software_renderer`)                     |
| `UNKNOWN`     | no string, a masked string ("WebKit WebGL"), an unrecognised string, or a context only without `failIfMajorPerformanceCaveat` whose string is not software | WebGL 2 (or Canvas 2D if the context itself failed) |
| `UNAVAILABLE` | no WebGL 2 context at all                                                                                                                                  | Canvas 2D                                           |

A missing extension is never taken as software. When the main context fails because of `failIfMajorPerformanceCaveat`, the throw-away probe context is classified by its own string; only a software string makes it `SOFTWARE`. The lab can allow software rendering for comparisons (`allowSoftwareRenderer`) and can simulate a browser that masks the strings.

**MEASUREMENT** (inside RoadPilot, per-process WebView2 arguments):

| Variant                                 | WebGL 2 context                                     | Class       | Result                         |
| --------------------------------------- | --------------------------------------------------- | ----------- | ------------------------------ |
| normal                                  | AMD (ANGLE D3D11)                                   | HARDWARE    | WebGL 2                        |
| `--use-angle=swiftshader` (2 flag sets) | **created** on SwiftShader (caveat does not reject) | SOFTWARE    | Canvas 2D, `software_renderer` |
| `--use-angle=d3d11-warp`                | created on WARP                                     | SOFTWARE    | Canvas 2D                      |
| `--disable-gpu`                         | refused (caveat); probe: WARP                       | SOFTWARE    | Canvas 2D                      |
| `--disable-webgl2`, `--disable-3d-apis` | none                                                | UNAVAILABLE | Canvas 2D                      |
| masked strings (lab switch), normal GPU | AMD                                                 | UNKNOWN     | WebGL 2 kept                   |
| masked strings with forced SwiftShader  | SwiftShader                                         | UNKNOWN     | WebGL 2 (**limitation**)       |

**Limitation:** where a browser masks the renderer string (WebKitGTK does, see Linux) and `failIfMajorPerformanceCaveat` does not reject the context, software rendering cannot be detected; it is reported as `UNKNOWN`, not as hardware. WebView2 offers the unmasked string, so on Windows all tested software paths are detected.

### Functional tests in the app (M3-A, M3-B)

All **MEASUREMENT**, in RoadPilot's WebView2, on the AMD GPU and again on the NVIDIA GPU, with the same result unless noted:

| Test                                          | Result                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start, WebGL 2 context                        | App start to DevTools 0.3–1.6 s; context with the M1 attributes and a stencil buffer; mode `coverage`                                                                                                                                                                                                    |
| 100k / 1M segments                            | 293,468 / 1,513,384 instances drawn, nothing pending, 6.7 / 34.6 MiB buffers, never over budget                                                                                                                                                                                                          |
| Renderer switch (5×), overlap modes (5×)      | a new canvas each time, exactly one canvas, drawing continues; every mode used as asked                                                                                                                                                                                                                  |
| Zoom, pan, whole map                          | level and tiles follow; back at the whole map nothing is uploaded again                                                                                                                                                                                                                                  |
| Resize 980×900 → 600×600 → 1620×1080          | backing store and coverage target follow                                                                                                                                                                                                                                                                 |
| DPR 1 → 1.25 → 1.5 → 2 → 0.75 → 1, native 1.5 | backing store and target follow every change (the lab now also checks DPR after each frame: WebView2 fires no resolution media-query event for a DevTools emulation change)                                                                                                                              |
| Context loss and restore                      | restored after 17 ms (both GPUs), same buffers and segments, mode `coverage`                                                                                                                                                                                                                             |
| Three losses in a row                         | Canvas 2D on a new canvas, `context_lost_repeatedly` (see the bug below)                                                                                                                                                                                                                                 |
| Loss without restore                          | Canvas 2D after 5.0 s, `context_restore_failed`                                                                                                                                                                                                                                                          |
| Release during a loss, remount, release       | no errors, no canvas left                                                                                                                                                                                                                                                                                |
| Simulated missing WebGL 2                     | Canvas 2D (`context_creation_failed`, class UNKNOWN, `major_performance_caveat` from the probe)                                                                                                                                                                                                          |
| Buffer budget at 1M, two zoom cycles (auto)   | at most 26.9 MiB of 64 MiB                                                                                                                                                                                                                                                                               |
| Shutdown                                      | normal window close in every run (about 110 starts): exit code 0, all WebView2 processes gone after 0.8–2.0 s                                                                                                                                                                                            |
| Console                                       | no shader or WebGL error. Present: `favicon.ico` 404 (dev server), Tauri "callback id" / "IPC custom protocol failed" warnings from the dashboard's backend events and calls when the window is navigated to the lab (not from the lab or the renderer), `getImageData` read-back hints from the harness |

**Bug found and fixed (FACT):** in WebView2, `WEBGL_lose_context.loseContext()` loses the context at once, but `webglcontextlost` arrives a few milliseconds later. A frame in between took the coverage path, failed to create its target on the dead context, then failed to compile the stencil program on it, and reported `shader_compile` instead of a loss. Now nothing is created or drawn while `isContextLost()` is true, a failure on a lost context is never reported as a shader or target failure, and a restore event arriving on an already lost context is ignored. A fake-context test reproduces the sequence.

**GPU selection (M3-B, MEASUREMENT, 3 restarts each):** by default RoadPilot's WebView2 runs on the **AMD** iGPU in every start; the context attribute `powerPreference: 'high-performance'` does **not** change that (the whole GPU process uses one adapter). With `--force_high_performance_gpu` for the test process, every start runs on the **RTX 3080** (renderer string and `nvidia-smi` agree). Selection was stable across restarts. On the NVIDIA GPU, context loss and restore, the fallback paths and the budget behave as on AMD. **FACT:** using the NVIDIA GPU in production would need RoadPilot to pass this argument to WebView2 (or a Windows per-app preference); that is a product decision, not part of M3.

### Performance and memory (M3-F)

**MEASUREMENT:** fresh app per run, 3 runs per renderer alternating (A B B A A B), `full` detail at the whole map, DPR 1, 240 Hz panel; `coverage` and incremental uploads; method otherwise as in M2 (3 s pan, three zoom cycles). Median (range in the raw data).

| Measure                            | 100k WebGL AMD   | 100k Canvas AMD    | 1M WebGL AMD      | 1M Canvas AMD   | 100k WebGL NV    | 100k Canvas NV     | 1M WebGL NV      | 1M Canvas NV    |
| ---------------------------------- | ---------------- | ------------------ | ----------------- | --------------- | ---------------- | ------------------ | ---------------- | --------------- |
| First visible / full (ms)          | 19.9 / 35.8      | 15.0               | 21.6 / 118.7      | 94.1            | 9.8 / 23.5       | 34.7               | 19.2 / 137       | 97.1            |
| Pan FPS                            | 233              | 30.8               | 143               | 5.2             | 235              | 30.5               | 239              | 5.1             |
| Pan frame gap p50 / p95 / max (ms) | 4.2 / 4.3 / 12.5 | 29.1 / 54.2 / 62.5 | 8.3 / 12.5 / 16.6 | 162 / 313 / 325 | 4.2 / 4.3 / 13.5 | 29.2 / 58.3 / 66.7 | 4.2 / 4.3 / 14.5 | 167 / 333 / 333 |
| `render()` p50 / p95 (ms)          | 0.2 / 0.3        | 1.6 / 3.4          | 0.1 / 0.2         | 16.2 / 28.2     | 0.1 / 0.3        | 1.7 / 3.7          | 0.1 / 0.3        | 15.8 / 28.9     |
| Zoom gap p95 / max, worst cycle    | 4.3 / 16.7       | 37.5 / 62.4        | 8.4 / 16.6        | 62.5 / 306      | 4.3 / 15.8       | 41.6 / 62.6        | 4.3 / 16.8       | 62.5 / 317      |
| Zoom cycles with a gap > 50 ms     | 0 of 3           | 3 of 3             | 0 of 3            | 3 of 3          | 0 of 3           | 3 of 3             | 0 of 3           | 3 of 3          |
| Draw calls per frame               | 141              | 29                 | 81                | 271             | 141              | 29                 | 81               | 271             |
| GPU buffers (MiB)                  | 6.7              | –                  | 34.6              | –               | 6.7              | –                  | 34.6             | –               |
| Total memory (MiB)                 | 519              | 439                | 677               | 685             | 393              | 462                | 613              | 739             |
| GPU process, private (MiB)         | 354              | 285                | 388               | 407             | 256              | 319                | 330              | 483             |
| Renderer process, private (MiB)    | 101              | 93                 | 221               | 241             | 78               | 91                 | 217              | 222             |
| GPU dedicated / shared (MiB)       | 49 / 179         | 40 / 198           | 144 / 196         | 101 / 144       | 121 / 72         | 121 / 71           | 179 / 83         | 143 / 140       |
| JS heap after GC (MiB)             | 3.6              | 3.2                | 19.4              | 19.3            | 3.4              | 3.2                | 19.4             | 19.1            |

"Total" is `roadpilot.exe` (about 6 MiB) plus RoadPilot's WebView2 processes. On NVIDIA the dedicated memory is on the RTX 3080; the panel is driven by the AMD GPU, so frames cross adapters.

**Findings:**

- **MEASUREMENT:** WebGL 2 meets every frame target on both GPUs up to 1M segments: `render()` p95 ≤ 0.3 ms, frame gap p95 ≤ 12.5 ms, no gap above 21 ms in pan or zoom. At 1M on the integrated AMD GPU the GPU limits pan to 143 FPS (8.3 ms per frame); the RTX 3080 holds the panel's 240 Hz.
- **MEASUREMENT, new in WebView2:** Canvas 2D is far slower in RoadPilot's WebView2 than it was in Edge in M2: 100k pans at 31 FPS (Edge M2: 164) although `render()` itself takes only 1.6–3.4 ms; the time is spent after the call (rasterising and compositing the canvas), on both GPUs. At 1M Canvas 2D pans at 5 FPS with 300 ms gaps. **HYPOTHESIS:** Skia Graphite (on in WebView2 158) handles the large path stroke differently from Edge's build; not investigated further, since the production renderer is out of scope.
- **Memory:** WebGL 2 uses less total memory than Canvas 2D at 1M on both GPUs (677 vs 685 AMD, 613 vs 739 NVIDIA) and less on NVIDIA at 100k; on AMD at 100k WebGL is 80 MiB higher (two of three runs at 519–523 MiB, one at 431). The buffer cache stayed at 6.7 and 34.6 MiB, below the 64 MiB budget.
- **Stability over zoom cycles:** three-cycle runs show steps of the dedicated GPU memory on AMD (one run 83 → 105 → 144 MiB, one flat), so a longer run was made. **MEASUREMENT** (1M, one app session): AMD, 8 cycles: dedicated 89, 93, 93, 98, 102, 102, 102, 103 MiB; GPU process 306 → 337 MiB, flat from cycle 6; renderer process 105–110 MiB; JS heap 19.4–19.8 MiB. NVIDIA, 6 cycles: dedicated 193, 176, 168, 168, 168, 167 MiB; GPU process 322 → 293 MiB; renderer 126–128 MiB. No uploads during these cycles. The memory settles after a few cycles instead of growing with every cycle.

### Against the M3 targets

| Target                                         | Result                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| WebGL `render()` p95 ≤ 2 ms at 100k            | 0.3 ms (AMD and NVIDIA): met                                                               |
| Frame gap p95 ≤ 20 ms at 100k                  | 4.3 ms: met (1M: 12.5 AMD, 4.3 NVIDIA)                                                     |
| No recurring stalls > 50 ms in pan/zoom        | WebGL: none (max 21 ms). Canvas 2D: in every zoom cycle                                    |
| GPU buffer cache ≤ 64 MiB                      | at most 34.6 MiB                                                                           |
| No repeated GPU memory growth over zoom cycles | settles after 3–5 cycles on AMD, falls on NVIDIA; no growth per cycle afterwards           |
| Stable context restoration                     | 17 ms on both GPUs; repeated and failed restores fall back correctly (after the fix above) |
| First visible geometry ≤ 100 ms at 100k        | 18.6 ms AMD, 10.0 ms NVIDIA: met                                                           |
| 1M initialization better than M2               | first visible 447 → 22.8 ms (AMD); full 116.5 ms                                           |
| Thin roads                                     | ≤ 1.71 % differing road pixels, no missing pixel (M2: 19.8 % and 5,460 missing)            |
| Software rendering reported correctly          | SwiftShader, WARP and `--disable-gpu` detected; masked strings stay UNKNOWN                |

### Linux (WebKitGTK): NOT TESTED

No Linux system was available in this environment, and the user's Ubuntu 26.04.1 / COSMIC / GTX 1070 system was not touched. Nothing Linux-specific was added. Known from public sources (**FACT** as documented there, **not verified here**):

- WebGL 2 in WebKitGTK runs on its ANGLE backend and has been on by default since about 2.39/2.40; Ubuntu 26.04's WebKitGTK is newer.
- WebKitGTK masks the WebGL renderer string. The prototype then reports `UNKNOWN` and keeps WebGL 2; it cannot tell software rendering (llvmpipe) from hardware there, unless `failIfMajorPerformanceCaveat` refuses the context.
- Tauri documents blank or white windows with NVIDIA's proprietary driver and WebKitGTK's DMA-BUF renderer; the documented workaround is `WEBKIT_DISABLE_DMABUF_RENDERER=1` (at the cost of a slower path), on Wayland possibly `__NV_DISABLE_EXPLICIT_SYNC=1` instead. COSMIC is a Wayland desktop.

**RECOMMENDATION:** run the lab once on that system before any decision that relies on WebGL 2 on Linux (renderer string, `pending` reaching 0, pixel comparison, context loss).

## Limitations and open problems

- **Hardware coverage:** measured on one machine: AMD integrated GPU and RTX 3080 Laptop, 240 Hz, Windows 11. GTX 1070 Mobile, Intel HD 530, a 60 Hz panel and Linux / WebKitGTK are NOT TESTED.
- **Default GPU:** RoadPilot's WebView2 renders on the integrated GPU unless started with `--force_high_performance_gpu`; `powerPreference` has no effect. Choosing the GPU is a product decision outside the prototype.
- **Canvas 2D in WebView2** is much slower than in Edge (31 FPS pan at 100k, 5 FPS at 1M); not investigated, production code was out of scope.
- **Coverage:** `MAX` slightly underestimates the union of two partial edges of one class (≤ 1.71 % of road pixels, worst at 0.5–0.7 px lines); costs 5 bytes per device pixel for the target and about 2 ms more than a single pass at 1M on the integrated GPU.
- **Full load at 1M** still takes 112–137 ms in five frames; geometry building (about 47 ms) runs on the main thread in 6 ms slices. A worker is not used.
- **Software detection** depends on the renderer string; where it is masked, software rendering stays `UNKNOWN`.
- **Synthetic data only**, no simplification in coarse levels; real packages are not part of M3.
- **Draw calls** in the stencil modes still grow with tiles × classes; `coverage` needs one per tile.
- **Shader output** is covered by the pixel comparison in the app, not by automatic tests.
- **Harness artefacts:** one-pixel read-backs inside measurements, DevTools emulation for size and DPR, occlusion throttling off.
