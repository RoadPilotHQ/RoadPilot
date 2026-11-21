/**
 * DEVELOPMENT ONLY (Phase 2.4D B1, MapLibre lab): the planar coordinate convention of the lab.
 *
 * Source coordinates are SCS-style world units (X east, Z south; ADR-002). The display plane is
 * north up: display x = X, display y = −Z. Nothing here is geographic and nothing converts units.
 *
 * MapLibre's public API carries every position as a `LngLat`, which rejects |lat| > 90. Native
 * values (Z ≈ −70,000) cannot be passed through it unchanged, so positions cross the API as
 * "carrier" pairs: display coordinates divided by `CARRIER_SCALE` = 2¹¹. Division by a power of
 * two is exact in binary floating point, so the carrier introduces no rounding; it is not a
 * projection and it never reaches the CRS plane, which stays in native units (see `scsCrs`).
 *
 * Pure: no MapLibre import, so the unit tests run without WebGL.
 */

/** Name of the registered planar CRS (a custom name must contain a colon). */
export const SCS_CRS_NAME = 'roadpilot:scs'

/** Width of tile 0/0/0 in native units: 2¹⁸, covering ±131,072 on both axes (ADR-003). */
export const WORLD_EXTENT = 2 ** 18
/** Top-left corner of tile 0/0/0 in display coordinates (min x, max y). */
export const WORLD_ORIGIN: readonly [number, number] = [-(2 ** 17), 2 ** 17]

/** Native units per carrier unit. |native| ≤ 131,072 gives |carrier| ≤ 64, inside ±90. */
export const CARRIER_SCALE = 2 ** 11

/** MapLibre's world size at zoom 0, in CSS pixels (`tileSize` of its transform). */
export const MAPLIBRE_TILE_SIZE = 512

/** Definition string handed to the workers' projection handler (`scsProjection.worker.mjs`). */
export const SCS_DEFINITION = `${SCS_CRS_NAME};carrier=${CARRIER_SCALE}`

export type CrsChoice = 'scs' | 'identity'

export interface NativePoint {
  x: number
  z: number
}

/** Display plane: x = X, y = −Z. No scale, no offset. */
export function toDisplay(p: NativePoint): [number, number] {
  return [p.x, -p.z]
}

/** The `LngLat`-shaped carrier MapLibre's API needs: display / 2¹¹, exactly. */
export function toCarrier(p: NativePoint): [number, number] {
  return [p.x / CARRIER_SCALE, -p.z / CARRIER_SCALE]
}

export function fromCarrier(lng: number, lat: number): NativePoint {
  return { x: lng * CARRIER_SCALE, z: -lat * CARRIER_SCALE }
}

/** The CRS converter: carrier → CRS plane (display coordinates, native units) and back. */
export const scsConversion = {
  forward(position: number[]): number[] {
    return [position[0]! * CARRIER_SCALE, position[1]! * CARRIER_SCALE]
  },
  inverse(position: number[]): number[] {
    return [position[0]! / CARRIER_SCALE, position[1]! / CARRIER_SCALE]
  },
}

/** The shape of MapLibre's experimental `CRS` type, kept local so this module stays pure. */
export interface PlanarCrs {
  name: string
  projection: typeof scsConversion
  tileMatrixSet: { origin: [number, number]; extentAtZoom0: number }
  definition: string
}

export const scsCrs: PlanarCrs = {
  name: SCS_CRS_NAME,
  projection: scsConversion,
  tileMatrixSet: { origin: [WORLD_ORIGIN[0], WORLD_ORIGIN[1]], extentAtZoom0: WORLD_EXTENT },
  definition: SCS_DEFINITION,
}

/**
 * Native units covered by tile 0/0/0 for each CRS choice. The built-in `identity` CRS spans
 * −90..90 carrier units, i.e. 180 × 2¹¹ = 368,640 native units (not a power of two).
 */
export function worldExtentOf(crs: CrsChoice): number {
  return crs === 'scs' ? WORLD_EXTENT : 180 * CARRIER_SCALE
}

/** CSS pixels per native unit at a MapLibre zoom level. */
export function pixelsPerUnit(zoom: number, crs: CrsChoice = 'scs'): number {
  return (MAPLIBRE_TILE_SIZE * 2 ** zoom) / worldExtentOf(crs)
}

/** MapLibre zoom level for a scale in CSS pixels per native unit (inverse of `pixelsPerUnit`). */
export function zoomForScale(scale: number, crs: CrsChoice = 'scs'): number {
  return Math.log2((scale * worldExtentOf(crs)) / MAPLIBRE_TILE_SIZE)
}

/** A camera of the lab: native centre and a MapLibre zoom level of the chosen CRS. */
export interface PlanarCamera {
  center: NativePoint
  zoom: number
}

/** The production viewport shape (`domain/mapViewport.ts`): native centre, CSS px per unit. */
export interface PlanarViewport {
  cx: number
  cz: number
  scale: number
}

/**
 * Camera → viewport, for the M3 renderer and the production viewport helpers. B1.2 (F1): the scale
 * uses the CRS the zoom level belongs to; it used to assume `scs` whatever was selected.
 */
export function viewportOf(c: PlanarCamera, crs: CrsChoice): PlanarViewport {
  return { cx: c.center.x, cz: c.center.z, scale: pixelsPerUnit(c.zoom, crs) }
}

/** Viewport → camera, the inverse of `viewportOf` for the same CRS. */
export function cameraOf(vp: PlanarViewport, crs: CrsChoice): PlanarCamera {
  return { center: { x: vp.cx, z: vp.cz }, zoom: zoomForScale(vp.scale, crs) }
}

export interface ScreenSize {
  width: number
  height: number
}

/**
 * Where a native point must appear on screen (CSS pixels from the top-left of the map canvas),
 * computed independently of MapLibre: north up, +X right, +Z down (= display y up).
 */
export function expectedScreen(
  center: NativePoint,
  zoom: number,
  size: ScreenSize,
  p: NativePoint,
  crs: CrsChoice = 'scs',
): { x: number; y: number } {
  const s = pixelsPerUnit(zoom, crs)
  return { x: size.width / 2 + (p.x - center.x) * s, y: size.height / 2 + (p.z - center.z) * s }
}
