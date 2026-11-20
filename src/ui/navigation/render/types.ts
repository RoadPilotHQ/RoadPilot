/**
 * PROTOTYPE (Phase 2.4C.5, M2; M3 additions marked): the shared interface of the experimental road renderers.
 * Used only by the developer render lab (`src/dev/renderLab`), never by the dashboard's
 * `RoadMapView`. See docs/webgl-prototype.md.
 */
import type { MapTile } from '@/domain/mapTile'
import type { Viewport } from '@/domain/mapViewport'

export type RendererKind = 'webgl2' | 'canvas2d'

export type RendererFailure =
  | 'webgl2_unavailable'
  | 'context_creation_failed'
  | 'shader_compile'
  | 'program_link'
  | 'context_lost_repeatedly'
  /** Addition to M1: the context was lost and not restored within the time limit. */
  | 'context_restore_failed'
  | 'out_of_memory'
  /** Addition in M3: the context renders in software (SwiftShader, WARP, llvmpipe). */
  | 'software_renderer'

export type RendererStatus =
  | { state: 'ready' }
  | { state: 'lost' }
  /** `detail` (addition to M1) carries a diagnostic such as a shader log; never shown as UI. */
  | { state: 'failed'; reason: RendererFailure; detail?: string }

/**
 * A tile as the renderers take it. The synthetic tiles of the lab are complete `MapTile`
 * objects, so the renderers would accept decoded production tiles without a conversion.
 */
export type SyntheticTile = MapTile

export interface RenderStats {
  /** Road entries drawn; a road listed in several tiles counts once per tile. */
  roads: number
  /** Segments drawn (instances for WebGL, unique segments for Canvas 2D). */
  segments: number
  drawCalls: number
  /** Buffer uploads since the renderer was created (cumulative, so pans show as 0 growth). */
  uploads: number
  /** Bytes requested with `bufferData` for the cached tiles (not measured video memory). */
  gpuBytes: number
  /** Additions to M1, needed by the lab and the tests: */
  buffers: number
  vertexArrays: number
  /** The visible tiles alone need more than the budget; nothing visible was dropped. */
  overBudget: boolean
  budgetBytes: number
  /**
   * Addition in M3: tiles handed over but not uploaded yet (incremental uploads). While above
   * zero the frame is incomplete and the host requests another one; never silently dropped.
   */
  pending: number
}

export interface RoadRenderer {
  readonly kind: RendererKind
  /** CSS size of the canvas and device pixel ratio. */
  resize(width: number, height: number, dpr: number): void
  setView(viewport: Viewport): void
  setTiles(tiles: readonly SyntheticTile[]): void
  /** Draws one frame. Called by the host, at most once per animation frame. */
  render(): RenderStats
  /** Releases every resource. Safe to call more than once. */
  dispose(): void
}

export const EMPTY_STATS: Readonly<RenderStats> = Object.freeze({
  roads: 0,
  segments: 0,
  drawCalls: 0,
  uploads: 0,
  gpuBytes: 0,
  buffers: 0,
  vertexArrays: 0,
  overBudget: false,
  budgetBytes: 0,
  pending: 0,
})
