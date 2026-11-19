/**
 * The road map viewport: centre, scale, zoom, pan, visible tiles and level of detail. Pure.
 *
 * Map coordinates are the package's world space (X east, Z south, world units). North is up:
 * X goes right, Z goes down. The physical size of a world unit is unconfirmed, so nothing
 * here converts to metres.
 */

export interface Viewport {
  /** Centre in map world units. */
  cx: number
  cz: number
  /** Pixels per world unit. */
  scale: number
}

export interface Size {
  width: number
  height: number
}

export type Bounds = [minX: number, minZ: number, maxX: number, maxZ: number]

/** About 16 km per pixel at most zoomed out, 5 pixels per unit at most zoomed in. */
export const MIN_SCALE = 1 / 16_384
export const MAX_SCALE = 5
/** Most tiles requested for one view; the level gets coarser instead. */
export const MAX_VISIBLE_TILES = 64
/** Scale (px per unit) from which a level is detailed enough. */
const LEVEL_MIN_SCALE = [0.4, 0.05, 0.008, 0]

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

export function fitBounds(bounds: Bounds, size: Size, padding = 16): Viewport | null {
  const [minX, minZ, maxX, maxZ] = bounds
  if (![minX, minZ, maxX, maxZ].every(Number.isFinite) || size.width <= 0 || size.height <= 0)
    return null
  const w = Math.max(maxX - minX, 1)
  const h = Math.max(maxZ - minZ, 1)
  const scale = clampScale(
    Math.min(Math.max(size.width - 2 * padding, 1) / w, Math.max(size.height - 2 * padding, 1) / h),
  )
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, scale }
}

export function toScreen(vp: Viewport, size: Size, x: number, z: number) {
  return { x: size.width / 2 + (x - vp.cx) * vp.scale, y: size.height / 2 + (z - vp.cz) * vp.scale }
}

export function toWorld(vp: Viewport, size: Size, px: number, py: number) {
  return {
    x: vp.cx + (px - size.width / 2) / vp.scale,
    z: vp.cz + (py - size.height / 2) / vp.scale,
  }
}

/** Moves the view by a pointer drag of `dx`, `dy` pixels (the map follows the pointer). */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, cx: vp.cx - dx / vp.scale, cz: vp.cz - dy / vp.scale }
}

/** Zooms by `factor`, keeping the map point under `(px, py)` in place. */
export function zoomAt(vp: Viewport, size: Size, factor: number, px: number, py: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  if (scale === vp.scale) return vp
  const anchor = toWorld(vp, size, px, py)
  return {
    scale,
    cx: anchor.x - (px - size.width / 2) / scale,
    cz: anchor.z - (py - size.height / 2) / scale,
  }
}

export function visibleBounds(vp: Viewport, size: Size): Bounds {
  const hw = size.width / 2 / vp.scale
  const hh = size.height / 2 / vp.scale
  return [vp.cx - hw, vp.cz - hh, vp.cx + hw, vp.cz + hh]
}

export interface TileId {
  x: number
  z: number
}

/** Tiles covering `bounds`, with a margin of one tile, nearest to the centre first. */
export function tilesFor(bounds: Bounds, tileSize: number, margin = 1): TileId[] {
  const [minX, minZ, maxX, maxZ] = bounds
  const x0 = Math.floor(minX / tileSize) - margin
  const x1 = Math.floor(maxX / tileSize) + margin
  const z0 = Math.floor(minZ / tileSize) - margin
  const z1 = Math.floor(maxZ / tileSize) + margin
  const tiles: TileId[] = []
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) tiles.push({ x, z })
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  return tiles.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))
}

/**
 * The level to draw at this scale: the most detailed level that is detailed enough and needs
 * at most `MAX_VISIBLE_TILES` tiles.
 */
export function chooseLevel(
  vp: Viewport,
  size: Size,
  tileSizes: readonly number[],
  mapBounds: Bounds | null = null,
): { level: number; tiles: TileId[] } {
  let bounds = visibleBounds(vp, size)
  if (mapBounds) {
    // Outside the map every tile is empty: never ask for those.
    const clipped: Bounds = [
      Math.max(bounds[0], mapBounds[0]),
      Math.max(bounds[1], mapBounds[1]),
      Math.min(bounds[2], mapBounds[2]),
      Math.min(bounds[3], mapBounds[3]),
    ]
    if (clipped[0] > clipped[2] || clipped[1] > clipped[3]) {
      const level = Math.max(
        0,
        LEVEL_MIN_SCALE.findIndex((min) => vp.scale >= min),
      )
      return { level: Math.min(level, tileSizes.length - 1), tiles: [] }
    }
    bounds = clipped
  }
  let level = LEVEL_MIN_SCALE.findIndex((min) => vp.scale >= min)
  level = Math.min(Math.max(level, 0), tileSizes.length - 1)
  // The margin of one tile never reaches beyond the map: those tiles are empty.
  const inMap = (t: TileId, size: number) =>
    !mapBounds ||
    (t.x >= Math.floor(mapBounds[0] / size) &&
      t.x <= Math.floor(mapBounds[2] / size) &&
      t.z >= Math.floor(mapBounds[1] / size) &&
      t.z <= Math.floor(mapBounds[3] / size))
  const tilesAt = (l: number) =>
    tilesFor(bounds, tileSizes[l]!).filter((t) => inMap(t, tileSizes[l]!))
  let tiles = tilesAt(level)
  while (tiles.length > MAX_VISIBLE_TILES && level < tileSizes.length - 1) {
    level += 1
    tiles = tilesAt(level)
  }
  return { level, tiles: tiles.slice(0, MAX_VISIBLE_TILES * 2) }
}

/** A round length for a scale bar of about a quarter of the width, in world units. */
export function scaleBarUnits(vp: Viewport, width: number): { units: number; px: number } {
  const target = width / 4 / vp.scale
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const units = [5, 2, 1].map((m) => m * magnitude).find((v) => v <= target) ?? magnitude
  return { units, px: units * vp.scale }
}
