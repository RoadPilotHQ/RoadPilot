/**
 * PROTOTYPE (M3): what kind of GPU renders a WebGL context. Used by the WebGL 2 renderer to
 * refuse software rendering, and by the render lab for diagnostics. Pure apart from the
 * `getExtension` / `getParameter` reads in `readGpuInfo`.
 *
 * The browser does not say directly whether WebGL runs on a GPU. The only evidence is the
 * renderer string (unmasked through `WEBGL_debug_renderer_info` where the browser offers it)
 * and whether a context with `failIfMajorPerformanceCaveat` can be created. The classes are
 * deliberately conservative:
 *
 * - `SOFTWARE` only when a renderer string names a known software rasterizer.
 * - `HARDWARE` only when a renderer string names a known GPU vendor or product family.
 * - `UNKNOWN` for everything else: no string, a masked string ("WebKit WebGL"), an
 *   unrecognised one. A missing diagnostic extension is never taken as software.
 * - `UNAVAILABLE` when no WebGL 2 context could be created at all.
 */

export type GpuClass = 'HARDWARE' | 'SOFTWARE' | 'UNKNOWN' | 'UNAVAILABLE'

export type GpuEvidence =
  /** The renderer string names a software rasterizer. */
  | 'software_renderer_string'
  /** The renderer string names a GPU vendor or product. */
  | 'hardware_renderer_string'
  /** The browser hides the renderer ("WebKit WebGL" and the like). */
  | 'masked_renderer_string'
  /** A renderer string that matches neither list. */
  | 'unrecognised_renderer_string'
  /** No renderer string could be read. */
  | 'no_renderer_string'
  /** A context only exists without `failIfMajorPerformanceCaveat`, and its string is not software. */
  | 'major_performance_caveat'
  /** No WebGL 2 context at all. */
  | 'no_context'

export interface GpuInfo {
  gpuClass: GpuClass
  evidence: GpuEvidence
  /** Unmasked renderer string when available, else the plain `RENDERER`, else null. */
  renderer: string | null
  vendor: string | null
  /** Whether `WEBGL_debug_renderer_info` was available. */
  unmasked: boolean
}

/**
 * Software rasterizers as their renderer strings name them: SwiftShader (Chromium, ANGLE
 * Vulkan or legacy), WARP (`Microsoft Basic Render Driver`, Direct3D without a GPU driver),
 * Mesa llvmpipe / softpipe / lavapipe (Linux, WebKitGTK and Chromium), Apple's software
 * renderer and generic "software rasterizer" names.
 */
const SOFTWARE_PATTERNS: readonly RegExp[] = [
  /swiftshader/i,
  /basic render driver/i,
  /\bllvmpipe\b/i,
  /\bsoftpipe\b/i,
  /\blavapipe\b/i,
  /software rasteri[sz]er/i,
  /apple software renderer/i,
  /mesa offscreen/i,
]

/** GPU vendors and product families. Checked after the software patterns. */
const HARDWARE_PATTERNS: readonly RegExp[] = [
  /\bnvidia\b/i,
  /\bgeforce\b/i,
  /\bquadro\b/i,
  /\b(amd|ati)\b/i,
  /\bradeon\b/i,
  /\bintel\b/i,
  /\biris\b/i,
  /\b(uhd|hd) graphics\b/i,
  /\bapple (m\d|gpu)\b/i,
  /\badreno\b/i,
  /\bmali\b/i,
  /\bpowervr\b/i,
  /\bqualcomm\b/i,
]

/** Strings a browser reports instead of the real renderer. */
const MASKED_PATTERNS: readonly RegExp[] = [/^webkit webgl$/i, /^mozilla$/i, /^webkit$/i]

export function classifyRenderer(
  renderer: string | null,
  vendor: string | null = null,
): { gpuClass: GpuClass; evidence: GpuEvidence } {
  const text = [renderer, vendor].filter((s): s is string => !!s && s.trim() !== '').join(' ')
  if (!text) return { gpuClass: 'UNKNOWN', evidence: 'no_renderer_string' }
  if (SOFTWARE_PATTERNS.some((p) => p.test(text)))
    return { gpuClass: 'SOFTWARE', evidence: 'software_renderer_string' }
  if (HARDWARE_PATTERNS.some((p) => p.test(text)))
    return { gpuClass: 'HARDWARE', evidence: 'hardware_renderer_string' }
  const masked = [renderer, vendor].every((s) => !s || MASKED_PATTERNS.some((p) => p.test(s)))
  return {
    gpuClass: 'UNKNOWN',
    evidence: masked ? 'masked_renderer_string' : 'unrecognised_renderer_string',
  }
}

const RENDERER = 0x1f01
const VENDOR = 0x1f00

/** Reads the renderer and vendor strings of a live context and classifies them. */
export function readGpuInfo(gl: WebGL2RenderingContext): GpuInfo {
  let renderer: string | null = null
  let vendor: string | null = null
  let unmasked = false
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (ext) {
      unmasked = true
      renderer = str(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      vendor = str(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
    }
    renderer ??= str(gl.getParameter(gl.RENDERER ?? RENDERER))
    vendor ??= str(gl.getParameter(gl.VENDOR ?? VENDOR))
  } catch {
    // A context lost during the query: whatever was read stays, the rest is unknown.
  }
  return { ...classifyRenderer(renderer, vendor), renderer, vendor, unmasked }
}

export const UNAVAILABLE_GPU: Readonly<GpuInfo> = Object.freeze({
  gpuClass: 'UNAVAILABLE',
  evidence: 'no_context',
  renderer: null,
  vendor: null,
  unmasked: false,
})
