# ADR-003: Map rendering — MapLibre, WebGL 2 prototype, Canvas 2D

## 1. Status

**Proposed** (Phase 2.4D B0, 2026-11-21). Provisional recommendation: **CONDITIONAL GO for an isolated, synthetic-only B1 experiment** with MapLibre GL JS in a planar CRS; **no** decision to use MapLibre in production. Canvas 2D stays the production renderer; the WebGL 2 prototype stays the reference.

## 2. Context

- Production: Canvas 2D painter (`src/ui/navigation/roadPainter.ts`, `RoadMapView.tsx`) drawing RPMT tiles from the Rust MapService ([map.md](../map.md)).
- M2/M3: an isolated WebGL 2 prototype ([webgl-prototype.md](../webgl-prototype.md)), validated in RoadPilot's WebView2 on an AMD iGPU and an RTX 3080 (commit `129e0b4`): render p95 ≤ 0.3 ms, frame gap p95 4.3–12.5 ms up to 1.5 M instances, coverage shader for thin lines, incremental uploads, context-loss handling, software detection. Canvas 2D in WebView2 manages only 31 FPS panning at 100k segments.
- What neither renderer has: labels with collision handling, symbols and icons, a style language, feature picking, rotation and pitch, and the camera logic a navigation map needs. MapLibre offers these; the question is whether it can draw the native SCS plane (ADR-002) offline, inside Tauri, and reliably.

## 3. Requirements

- R1. Native SCS world coordinates, planar, north up (ADR-002); no WGS84.
- R2. Fully offline: no network request of any kind, local style, glyphs, sprites and tiles.
- R3. Works inside Tauri 2 / WebView2 with the app's CSP; data through RoadPilot's own channel (IPC or custom protocol).
- R4. Performance at least comparable to the WebGL 2 prototype at 100k segments; no recurring frame gaps above 50 ms; bounded memory.
- R5. RoadPilot's own vehicle and navigation overlays on top, in the same coordinates.
- R6. A defined fallback when WebGL 2 is unavailable or software-rendered.
- R7. Licence compatible with RoadPilot; no GPL code.

## 4. MapLibre GL JS: findings

Sources were read on 2026-11-21; see section 10. "Official" = MapLibre docs, repository or release notes.

| Topic                                         | Finding                                                                                                                                                                                                                                                                                                                                               | Source class                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Current stable                                | **6.19.0**, released 17 Nov 2026 (marked "Latest")                                                                                                                                                                                                                                                                                                    | Official (GitHub releases)                                                                                                     |
| Licence                                       | BSD-3-Clause (MapLibre contributors; includes the mapbox-gl-js v1.13 BSD-3 portion)                                                                                                                                                                                                                                                                   | Official (`LICENSE.txt`)                                                                                                       |
| Planar / custom CRS                           | Since **6.15.0** (18 Oct 2026): "experimental `addProjection`, `removeProjection`, a built-in `identity` projection and a `{bbox}` tile URL token"                                                                                                                                                                                                    | Official (release notes)                                                                                                       |
| What a CRS is                                 | "a planar coordinate reference system (CRS) together with the square, power-of-two quad tile grid laid over it"; tiles are used "as they are, without reprojecting their content"                                                                                                                                                                     | Official (API docs, `CRS` type, marked **Experimental**)                                                                       |
| Naming                                        | Custom names must contain a colon (`custom:floor-plan`); names without one (`mercator`, `globe`, `vertical-perspective`, `identity`) are reserved built-ins                                                                                                                                                                                           | Official (API docs)                                                                                                            |
| Selection                                     | `addProjection(definition)`, then `projection.type` in the style or `map.setProjection({type})`                                                                                                                                                                                                                                                       | Official (API docs)                                                                                                            |
| GeoJSON                                       | Needs the CRS `definition` (WKT/PROJ): "Without it, GeoJSON sources warn and draw in the wrong place"; 6.15.0 also projects GeoJSON in a registered CRS in the workers                                                                                                                                                                                | Official (API docs, release notes)                                                                                             |
| World behaviour                               | Non-wrapping world constrained to the world square, no world copies, no globe; one CRS per map                                                                                                                                                                                                                                                        | Official PR #8287 body (merged into the `projection` feature branch, 16 Sep 2026); third-party tutorial (makewithmaplibre.com) |
| Known gaps                                    | PR #8287: "sources, queries, terrain, hillshade and the camera helpers still assume mercator (next slice)". A follow-up (#8723) reportedly lists GeoJSON, custom layers, `within`/`distance`, `setStyle` and `setProjection` after load as unsupported; this list was **not** verified verbatim and partly conflicts with the 6.15.0 notes on GeoJSON | Official PR text; follow-up from a summary only (**unverified**)                                                               |
| Maturity                                      | Experimental, "the API can still change in a minor release"; a fix "Fix map jumping when dragging or zooming above or below the identity projection" landed in 6.18.0 (11 Nov 2026); 6.19.0 rewrote the camera state (#8694)                                                                                                                          | Third-party tutorial; official release notes                                                                                   |
| Rotation, pitch                               | Not addressed for planar CRS in the texts read                                                                                                                                                                                                                                                                                                        | **Unknown**                                                                                                                    |
| Labels, symbols, line layers, feature queries | Standard style layers; in a planar CRS, queries are among the "still assume mercator" items of #8287                                                                                                                                                                                                                                                  | Official (style spec); gaps per PR                                                                                             |
| Offline / local tiles                         | Tiles can come from any URL scheme registered with `addProtocol`; PMTiles uses exactly this (`maplibregl.addProtocol("pmtiles", protocol.tile)`)                                                                                                                                                                                                      | Official example "PMTiles source and protocol"; Protomaps docs                                                                 |
| WebGL                                         | MapLibre GL JS draws with WebGL 2 (WebGL 1 support was dropped with v3, per its v3 notes; **not re-read in B0**). No Canvas 2D fallback of its own                                                                                                                                                                                                    | Official (to be re-confirmed in B1)                                                                                            |

**Assessment of the identity projection (not production-ready):** it is weeks old, marked experimental in the API docs and release notes, its first slice left queries and camera helpers on Mercator assumptions, and it had a camera bug fixed one release before the current one. It is suitable for an experiment with a pinned version, not for a production dependency.

### Fit with RoadPilot's coordinates

- A custom CRS such as `roadpilot:scs` with an exact mapping `(x, y) = (X, −Z)` (ADR-002) and a square power-of-two tile grid over the game world (for example 2¹⁸ = 262,144 units wide, covering both games' known extents) keeps native coordinates. Whether the built-in `identity` (tile 0 over a lng/lat-sized square) or a registered CRS is the better fit is a B1 question.
- MapLibre does not reproject tiles in a planar CRS, so tiles must already be cut in that grid. RPMT tiles are cut in RoadPilot's own grid (1024 · 4ⁿ units); MapLibre's vector sources expect MVT (ADR-004).

### Tauri and offline specifics (FACT from RoadPilot's configuration, consequences HYPOTHESIS until B1)

- The CSP (`src-tauri/tauri.conf.json:25`) is `default-src 'self'; … script-src 'self'; connect-src ipc: http://ipc.localhost ws://127.0.0.1:1420`, with no `worker-src`. MapLibre's default bundle starts its workers from a `blob:` URL, which this CSP would block. MapLibre ships a CSP-friendly build with a separate worker file. B1 must show which variant works **without** loosening the production CSP.
- Text needs glyph PBFs (`glyphs` URL in the style), and icons a sprite. Both must be bundled and served locally (an `addProtocol` handler or a Tauri custom protocol), or labels cannot be drawn offline.
- Tile data can stay on RoadPilot's binary IPC (`map_tile`), wrapped by an `addProtocol` handler; no HTTP server is needed.

## 5. Options considered

|                                 | A. Canvas 2D (production)                        | B. WebGL 2 prototype (own renderer)           | C. MapLibre GL JS, planar CRS                                                                                        | D. Hybrid: MapLibre base map + RoadPilot overlays, Canvas 2D fallback |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Feasibility                     | In production                                    | Validated in WebView2 (M3)                    | Possible since 6.15, experimental                                                                                    | Depends on C                                                          |
| Performance                     | 31 FPS pan at 100k in WebView2, 5 FPS at 1M (M3) | 233–239 FPS at 100k, p95 ≤ 0.3 ms render (M3) | **Unmeasured**                                                                                                       | Unmeasured                                                            |
| Memory                          | Measured (M3)                                    | Measured, ≤ 34.6 MiB buffers at 1M            | Unmeasured; more JS and worker heap expected (HYPOTHESIS)                                                            | Two renderers' code, one active                                       |
| Labels, symbols, style, picking | None                                             | None (would have to be built)                 | Yes (standard), queries partly Mercator-bound in planar CRS                                                          | Yes                                                                   |
| Coordinates                     | Native                                           | Native                                        | Native through a planar CRS (experimental)                                                                           | Native                                                                |
| Offline                         | Yes                                              | Yes                                           | Yes in principle; glyphs, sprite and worker loading need local handling                                              | Same as C                                                             |
| Fallback                        | –                                                | Canvas 2D, software detection (M3)            | None built in; RoadPilot must provide it                                                                             | Canvas 2D                                                             |
| Overlays                        | Own                                              | Own, same transform                           | Own layers or a canvas above it in the same CRS; custom layers are reportedly unsupported in planar CRS (unverified) | Own                                                                   |
| Maintenance                     | Low                                              | Medium (own shaders, all features self-built) | Upstream API churn while experimental; pinned version                                                                | Highest                                                               |
| Licence                         | –                                                | –                                             | BSD-3                                                                                                                | BSD-3                                                                 |

## 6. Decision (provisional)

**CONDITIONAL GO** for the hybrid architecture **as a direction to test**, and only through B1:

- Rust MapService keeps managing local packages; RPMT stays the tile channel (ADR-004).
- MapLibre may become the base road-map renderer **only if** B1 shows, with a pinned version, offline operation under the production CSP, correct native coordinates, performance comparable to the WebGL 2 prototype and stable context handling.
- RoadPilot keeps its own vehicle and navigation overlays in the same coordinates.
- Canvas 2D stays the fallback (and production until a later, separate decision); the WebGL 2 prototype stays the reference and the alternative if MapLibre fails B1.

Conditions: the identity/custom CRS remains experimental upstream; B1 must not touch production code; no truck marker before the alignment work of ADR-002.

**Does MapLibre add enough value?** Only if labels, symbols, styling and interaction are wanted soon. For drawing roads alone, the WebGL 2 prototype already meets every frame and memory target, so MapLibre's value lies in the features, and B1 must show that they work in a planar CRS (labels and feature queries are exactly the parts named as gaps).

### B1 readiness

| Question                                                                                | Answer                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the native SCS coordinate system understood well enough for a planar-CRS experiment? | **Yes.** Axes and the ÷256 scale are format facts used consistently in code (ADR-002); the mapping to a planar CRS is the exact flip `(X, −Z)`. The physical unit and real-world alignment are not needed for a synthetic experiment.        |
| Can B1 use synthetic coordinates without claiming in-game accuracy?                     | **Yes**, and it must. The M2/M3 synthetic scenarios (fixed seed) can be placed at realistic magnitudes (for example around x ≈ −100,000, z ≈ −70,000) to test precision, without any game data and without any claim about alignment.        |
| Can MapLibre be tested fully offline?                                                   | **Yes in principle** (local bundle, inline style, `addProtocol` for tiles, bundled glyphs and sprite). Unproven until B1 shows zero external requests; glyphs and the worker setup are the known traps.                                      |
| Can the experiment stay isolated from production?                                       | **Yes**, like the render lab: a dev-server-only page under `src/dev/`, a pinned devDependency imported only there, and a production build checked to contain neither. Adding the dependency to `package.json` needs explicit approval at B1. |
| Legal blockers for a synthetic-only prototype?                                          | **None found.** MapLibre is BSD-3; no SCS data is used; no GPL code is involved.                                                                                                                                                             |

**Real-world alignment remains unverified (ETS2) or partly verified (ATS, one region), but a synthetic B1 experiment is feasible and does not depend on it.**

### B1 acceptance criteria (measurable)

All in RoadPilot's WebView2 (as in M3), synthetic data only, pinned MapLibre version, AMD and NVIDIA where practical:

| #   | Criterion                       | Pass if                                                                                                                                                                                                                                                        |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Offline start                   | The lab page starts and renders, and DevTools `Network` shows **0 requests** to any host other than the dev server's own origin and RoadPilot's IPC/custom protocol, during start, 100 pan/zoom steps and a context loss                                       |
| 2   | CSP                             | Works with the production CSP unchanged (only the lab's dev-server context may differ, and any difference is documented)                                                                                                                                       |
| 3   | Coordinates                     | Synthetic features at known native coordinates (including about −100,000 / −70,000) appear at the expected screen positions: error ≤ 0.5 device px at the closest zoom, north up, +X right; `queryRenderedFeatures` at a known point returns the right feature |
| 4   | Geometry                        | The M2/M3 `large` (100k) and `stress` (1M) scenarios render completely; road classes styled like `ROAD_STYLES`                                                                                                                                                 |
| 5   | Pan, zoom (rotation as a bonus) | Pan and zoom through ×64 work; no "jumping"; rotation tested and reported, not required                                                                                                                                                                        |
| 6   | Labels and symbols              | Labels on synthetic roads render from bundled glyphs, without collisions overlapping, at all zooms                                                                                                                                                             |
| 7   | Frame times                     | At 100k: frame gap p95 ≤ 20 ms, no gap > 50 ms in 3 pan + 3 zoom runs; reported next to the WebGL 2 prototype under the same harness                                                                                                                           |
| 8   | First display                   | 100k: first visible geometry ≤ 100 ms; 1M reported                                                                                                                                                                                                             |
| 9   | Memory                          | Total and GPU-process memory reported against the prototype; no growth over 8 equivalent zoom cycles after warm-up (same method as M3)                                                                                                                         |
| 10  | Stability                       | Context loss and restore leave a working map, or RoadPilot falls back to Canvas 2D; release/remount leave no canvas and no error                                                                                                                               |
| 11  | Isolation                       | No change outside `src/dev/` (plus the pinned devDependency and docs); production build output contains no MapLibre code; all existing checks pass                                                                                                             |

**B1 fails** if any of: an external request is unavoidable; the production CSP must be loosened; coordinates are off by more than the tolerance or features cannot be picked correctly in the planar CRS; labels cannot be drawn offline; frame gap p95 at 100k exceeds 20 ms or recurring gaps exceed 50 ms where the WebGL 2 prototype meets the targets; memory keeps growing over zoom cycles; a context loss leaves a blank map without fallback; or the experiment cannot be kept out of the production bundle.

## 7. Consequences

- B1 adds a pinned `maplibre-gl` dependency for a development-only page; the production bundle must not contain it (checked by build output, as for the render lab).
- If B1 passes, a later phase needs: an MVT encoder or a GeoJSON path from the MapService (ADR-004), local glyphs and sprites, a CSP-compatible worker setup, and the renderer switch with Canvas 2D fallback.
- If B1 fails, the WebGL 2 prototype becomes the base and labels would be built in-house (higher effort, lower dependency risk).

## 8. Risks

| Risk                                                            | Effect                             | Mitigation                                                      |
| --------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Experimental CRS API changes in a minor release                 | Breakage on update                 | Pin an exact version; upgrade only with a re-run of B1's checks |
| Mercator assumptions left in queries, camera helpers or GeoJSON | Wrong picking, bounds or positions | B1 tests each used feature against known synthetic coordinates  |
| CSP blocks workers                                              | Map does not start                 | Use the CSP build; never loosen the production CSP for it       |
| Glyph/sprite fetches                                            | Network requests or missing labels | Bundle locally; B1 asserts zero external requests               |
| Performance below the WebGL 2 prototype                         | Frame drops at large maps          | Compare in the same harness as M3                               |
| No Canvas 2D fallback in MapLibre                               | No map on systems without WebGL 2  | Keep RoadPilot's fallback and software detection                |
| Licence attribution                                             | Missing notices                    | Ship BSD-3 notices with the app                                 |

## 9. Open questions

1. Built-in `identity` or a registered `roadpilot:scs` CRS, and which tile grid?
2. Do rotation, pitch, `fitBounds`, `queryRenderedFeatures` and symbol placement behave correctly in the planar CRS of the pinned version?
3. Which worker setup satisfies the production CSP?
4. Memory and frame time of MapLibre against the WebGL 2 prototype on the same synthetic data.
5. Context loss and restore behaviour of MapLibre in WebView2.
6. Linux / WebKitGTK (not tested for any renderer).

## 10. Evidence and references

- MapLibre GL JS releases: https://github.com/maplibre/maplibre-gl-js/releases (6.15.0, 6.18.0, 6.19.0 notes)
- `CRS` API docs (Experimental): https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/CRS/
- PR #8287 "add addProjection and a planar projection for custom CRS tile grids": https://github.com/maplibre/maplibre-gl-js/pull/8287
- Licence: https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt
- Non-Mercator roadmap: https://maplibre.org/roadmap/maplibre-gl-js/non-mercator-projection/
- PMTiles example: https://maplibre.org/maplibre-gl-js/docs/examples/pmtiles-source-and-protocol/
- Third-party (not official): https://makewithmaplibre.com/projections/ (examples for 6.15)
- RoadPilot: [webgl-prototype.md](../webgl-prototype.md) (M2/M3 measurements), [map.md](../map.md), `src-tauri/tauri.conf.json:25` (CSP)
