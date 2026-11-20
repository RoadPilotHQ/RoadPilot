# WebGL 2 road renderer prototype (Phase 2.4C.5, M2)

An isolated prototype that draws synthetic road networks with WebGL 2 and, for comparison, with the production Canvas 2D painter. It answers whether WebGL 2 offers a measurable advantage over the Canvas 2D renderer optimised in M0 ([map.md](map.md#canvas-2d-in-the-desktop-application-phase-24c3-m0)).

> **Scope:** prototype only. The dashboard's road map (`RoadMapView.tsx`, `roadPainter.ts`) is unchanged and does not use any of this. No package, no telemetry, no backend command, no Rust or IPC change; synthetic data only. The lab page is served by the Vite dev server and is not an input of the production build.

Statements are marked **FACT** (follows from code or specification), **MEASUREMENT** (measured here), **HYPOTHESIS** (plausible, not verified) and **RECOMMENDATION**.

## Layout

| Path                                                  | Role                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/ui/navigation/render/types.ts`                   | Shared renderer interface, status, failures, statistics                                       |
| `src/ui/navigation/render/WebGL2RoadRenderer.ts`      | WebGL 2 renderer: context, program, per-tile buffers, stencil groups, context loss            |
| `src/ui/navigation/render/shaders/road.vert`, `.frag` | Instanced segment quads; capsule distance, smoothed edge, rail dash, chord opacity            |
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

## Limitations and open problems

- **Stencil:** `coreFringe` still loses coverage where two edge fragments of one class meet (thin lines below about 2 px, sub-pixel parallel roads); see the alternatives above. The M1 single pass is worse and should not be used with shader smoothing.
- **First frame at 1M segments** (368–517 ms) is slower than Canvas 2D: everything is built and uploaded in one synchronous `setTiles`. **RECOMMENDATION:** build in a worker or spread uploads over frames, and warm the shader up before the first map frame.
- **Draw calls** grow with tiles × classes × 2 passes (1,324 at 100k with 140 tiles). CPU time stayed near 1 ms here; weaker GPUs or drivers need checking (merged buffers or `WEBGL_multi_draw`).
- **Software rendering:** a forced SwiftShader is not rejected by `failIfMajorPerformanceCaveat`. **RECOMMENDATION:** also check the unmasked renderer string (SwiftShader, Basic Render Driver) before choosing WebGL.
- **Renderer process memory** is 25–55 MiB higher with WebGL on small and medium maps (122 against 66 MiB on the small map), while the GPU process and shared GPU memory are much lower (−390 MiB GPU process at 100k). **HYPOTHESIS:** command-buffer and WebGL client state in the renderer process.
- **Caveat detail** (`major_performance_caveat`) is a heuristic, see Fallback.
- **Measured in Edge, not in RoadPilot's WebView2**, with synthetic data, on one machine with an integrated AMD GPU. The RTX GPU, a 60 Hz panel and real packages were not part of M2.
- **No simplification** in the synthetic coarse levels; real tiles of coarse levels have fewer points.
- **Shader output is not covered by automatic tests**; it was checked by the pixel comparison above.
