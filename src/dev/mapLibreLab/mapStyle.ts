/**
 * DEVELOPMENT ONLY (Phase 2.4D B1): the MapLibre style of the lab. Inline, with no URL of any
 * kind: no `glyphs` URL (MapLibre then draws every glyph locally with TinySDF from the font
 * stack below, the same stack as the app's theme), no `sprite` (sprite images are decoded through
 * `blob:` URLs, which the production CSP's `img-src` does not allow), and GeoJSON sources whose
 * data is set from memory.
 *
 * Widths follow the production `ROAD_STYLES` and the zoom bonus of `roadPainter.ts` (through
 * `roadStyle.ts`), converted to MapLibre zoom levels, so MapLibre and the M3 prototype draw the
 * same widths in the comparison.
 */
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl'
import { ROAD_STYLES } from '@/ui/navigation/roadPainter'
import { SCS_CRS_NAME, zoomForScale, type CrsChoice } from './coordinates'
import { THIN_WIDTHS, type LabRoadClass } from './syntheticData'

/** RoadPilot's design language (theme.css): creme beige background, orange accent. */
export const COLORS = {
  background: '#f2e8d8',
  motorway: '#e8792e',
  motorwayCasing: '#b65d22',
  primary: '#a8927a',
  secondary: '#bba891',
  local: '#cdbda8',
  minor: '#dccfbf',
  text: '#292724',
  textMuted: '#77716a',
  halo: '#f6ede0',
  probe: '#c95348',
} as const

/** The app's font stack (theme.css), drawn locally by MapLibre. */
export const FONT_REGULAR = ['Segoe UI', 'system-ui', 'Arial']
export const FONT_SEMIBOLD = ['Segoe UI Semibold', 'system-ui', 'Arial']

/** Base widths in CSS pixels: production values; `secondary` lies between primary and local. */
export const BASE_WIDTH: Record<LabRoadClass, number> = {
  motorway: ROAD_STYLES.motorway.width,
  primary: ROAD_STYLES.primary.width,
  secondary: 1.8,
  local: ROAD_STYLES.local.width,
  minor: ROAD_STYLES.minor.width,
}

/** Bottom to top, as the production painter (most important on top). */
export const DRAW_ORDER: readonly LabRoadClass[] = [
  'minor',
  'local',
  'secondary',
  'primary',
  'motorway',
]

/** Production zoom bonus thresholds (px per unit 0.05 → +0.5 px, 0.4 → +1.5 px) as zoom levels. */
export function widthExpression(cls: LabRoadClass, crs: CrsChoice): ExpressionSpecification {
  const w = BASE_WIDTH[cls]
  return ['step', ['zoom'], w, zoomForScale(0.05, crs), w + 0.5, zoomForScale(0.4, crs), w + 1.5]
}

export interface StyleOptions {
  crs: CrsChoice
  /** Scenario D: every road uses its own `w` width, unchanged by zoom. */
  thin: boolean
  labels: boolean
  probes: boolean
}

const EMPTY = { type: 'FeatureCollection', features: [] } as const

/** Minimum zoom of a road class's labels, in px per unit converted to zoom. */
const LABEL_MIN_SCALE: Partial<Record<LabRoadClass, number>> = {
  motorway: 0.004,
  primary: 0.02,
  secondary: 0.08,
  local: 0.4,
}

export function buildStyle(o: StyleOptions): StyleSpecification {
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': COLORS.background } },
  ]
  for (const cls of DRAW_ORDER) {
    if (cls === 'motorway' && !o.thin) {
      layers.push({
        id: 'road-motorway-casing',
        type: 'line',
        source: 'roads',
        filter: ['==', ['get', 'c'], 'motorway'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': COLORS.motorwayCasing,
          'line-width': [
            'step',
            ['zoom'],
            BASE_WIDTH.motorway + 1,
            zoomForScale(0.05, o.crs),
            BASE_WIDTH.motorway + 1.5,
            zoomForScale(0.4, o.crs),
            BASE_WIDTH.motorway + 2.5,
          ],
        },
      })
    }
    layers.push({
      id: `road-${cls}`,
      type: 'line',
      source: 'roads',
      filter: ['==', ['get', 'c'], cls],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': COLORS[cls],
        'line-width': o.thin ? ['coalesce', ['get', 'w'], 1] : widthExpression(cls, o.crs),
      },
    })
  }
  if (o.labels) {
    for (const cls of ['motorway', 'primary', 'secondary', 'local'] as const) {
      layers.push({
        id: `label-${cls}`,
        type: 'symbol',
        source: 'roads',
        minzoom: Math.max(0, zoomForScale(LABEL_MIN_SCALE[cls]!, o.crs)),
        filter: ['all', ['==', ['get', 'c'], cls], ['has', 'n']],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'n'],
          'text-font': FONT_REGULAR,
          'text-size': cls === 'motorway' ? 12 : 11,
          'symbol-spacing': 400,
          'text-max-angle': 30,
        },
        paint: {
          'text-color': cls === 'motorway' ? COLORS.motorwayCasing : COLORS.textMuted,
          'text-halo-color': COLORS.halo,
          'text-halo-width': 1.5,
        },
      })
    }
    layers.push({
      id: 'label-city',
      type: 'symbol',
      source: 'cities',
      filter: [
        'any',
        ['==', ['get', 'r'], 1],
        ['all', ['==', ['get', 'r'], 2], ['>=', ['zoom'], zoomForScale(0.01, o.crs)]],
        ['all', ['==', ['get', 'r'], 3], ['>=', ['zoom'], zoomForScale(0.05, o.crs)]],
      ],
      layout: {
        'text-field': ['get', 'n'],
        'text-font': FONT_SEMIBOLD,
        'text-size': ['match', ['get', 'r'], 1, 16, 2, 14, 12],
        'symbol-sort-key': ['get', 'r'],
        'text-padding': 4,
      },
      paint: {
        'text-color': COLORS.text,
        'text-halo-color': COLORS.halo,
        'text-halo-width': 2,
      },
    })
  }
  if (o.probes) {
    layers.push({
      id: 'probe',
      type: 'circle',
      source: 'probes',
      paint: { 'circle-color': COLORS.probe, 'circle-radius': 3, 'circle-blur': 0 },
    })
  }
  return {
    version: 8,
    name: 'RoadPilot MapLibre lab (synthetic)',
    projection: { type: o.crs === 'scs' ? SCS_CRS_NAME : 'identity' },
    sources: {
      roads: { type: 'geojson', data: EMPTY },
      cities: { type: 'geojson', data: EMPTY },
      probes: { type: 'geojson', data: EMPTY },
    },
    layers,
  }
}

/** Widths drawn by scenario D, for the documentation and the tests. */
export const THIN_RANGE: readonly [number, number] = [THIN_WIDTHS[0], THIN_WIDTHS.at(-1)!]
