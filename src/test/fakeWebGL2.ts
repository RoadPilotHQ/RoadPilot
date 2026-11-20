/**
 * A fake WebGL 2 context for the renderer tests (jsdom has no WebGL). It records objects,
 * uploads and draws, and can fail shader compilation, linking or allocation, and lose and
 * restore the context through `WEBGL_lose_context` (events are dispatched synchronously).
 */

export interface FakeGlOptions {
  failCompile?: 'vertex' | 'fragment'
  failLink?: boolean
  stencil?: boolean
  /** `getError` reports OUT_OF_MEMORY after this many `bufferData` calls. */
  outOfMemoryAfter?: number
  /** Shader compilation fails after the next restore. */
  failCompileAfterRestore?: boolean
}

interface Obj {
  id: number
  kind: 'buffer' | 'vao' | 'shader' | 'program'
}

export class FakeWebGL2 {
  readonly ARRAY_BUFFER = 0x8892
  readonly STATIC_DRAW = 0x88e4
  readonly FLOAT = 0x1406
  readonly UNSIGNED_BYTE = 0x1401
  readonly VERTEX_SHADER = 0x8b31
  readonly FRAGMENT_SHADER = 0x8b30
  readonly COMPILE_STATUS = 0x8b81
  readonly LINK_STATUS = 0x8b82
  readonly TRIANGLE_STRIP = 0x0005
  readonly COLOR_BUFFER_BIT = 0x4000
  readonly STENCIL_BUFFER_BIT = 0x0400
  readonly DEPTH_TEST = 0x0b71
  readonly CULL_FACE = 0x0b44
  readonly BLEND = 0x0be2
  readonly STENCIL_TEST = 0x0b90
  readonly ONE = 1
  readonly ONE_MINUS_SRC_ALPHA = 0x0303
  readonly KEEP = 0x1e00
  readonly REPLACE = 0x1e01
  readonly NOTEQUAL = 0x0205
  readonly NO_ERROR = 0
  readonly OUT_OF_MEMORY = 0x0505
  readonly RENDERER = 0x1f01

  private nextId = 1
  private lost = false
  private shaderTypes = new Map<number, number>()
  private restored = 0
  readonly live = new Map<number, Obj>()
  readonly calls: { name: string; args: unknown[] }[] = []
  bufferDataCalls = 0
  uploadedBytes = 0
  deletedBuffers = 0
  deletedVaos = 0
  deletedPrograms = 0
  draws: { count: number; vao: unknown; pass: number; stencilRef: number }[] = []
  private pass = -1
  private stencilRef = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: FakeGlOptions = {},
  ) {}

  get drawingBufferWidth() {
    return this.canvas.width
  }
  get drawingBufferHeight() {
    return this.canvas.height
  }

  liveCount(kind: Obj['kind']): number {
    return [...this.live.values()].filter((o) => o.kind === kind).length
  }

  private record(name: string, args: unknown[]) {
    this.calls.push({ name, args })
  }

  private create(kind: Obj['kind']): Obj | null {
    if (this.lost) return null
    const o = { id: this.nextId++, kind }
    this.live.set(o.id, o)
    return o
  }

  private remove(o: unknown, kind: Obj['kind']) {
    if (this.lost || !o) return
    const obj = o as Obj
    if (!this.live.has(obj.id)) throw new Error(`${kind} ${obj.id} deleted twice or unknown`)
    this.live.delete(obj.id)
  }

  isContextLost() {
    return this.lost
  }

  getContextAttributes() {
    if (this.lost) return null
    return { stencil: this.options.stencil ?? true, alpha: true, antialias: false, depth: false }
  }

  getExtension(name: string) {
    if (name === 'WEBGL_lose_context')
      return { loseContext: () => this.loseContext(), restoreContext: () => this.restoreContext() }
    return null
  }

  getParameter(p: number) {
    return p === this.RENDERER ? 'Fake GPU' : null
  }

  getError() {
    const limit = this.options.outOfMemoryAfter
    return limit !== undefined && this.bufferDataCalls > limit ? this.OUT_OF_MEMORY : this.NO_ERROR
  }

  loseContext() {
    if (this.lost) return
    this.lost = true
    this.live.clear()
    this.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
  }

  restoreContext() {
    if (!this.lost) return
    this.lost = false
    this.restored++
    this.canvas.dispatchEvent(new Event('webglcontextrestored'))
  }

  // Shaders and programs.
  createShader(type: number) {
    const s = this.create('shader')
    if (s) this.shaderTypes.set(s.id, type)
    return s
  }
  shaderSource() {}
  compileShader() {}
  getShaderParameter(s: Obj) {
    if (this.lost) return null
    if (this.options.failCompileAfterRestore && this.restored > 0) return false
    const type = this.shaderTypes.get(s.id)
    if (this.options.failCompile === 'vertex' && type === this.VERTEX_SHADER) return false
    if (this.options.failCompile === 'fragment' && type === this.FRAGMENT_SHADER) return false
    return true
  }
  getShaderInfoLog() {
    return 'ERROR: 0:1: fake compile error'
  }
  deleteShader(s: unknown) {
    this.remove(s, 'shader')
  }
  createProgram() {
    return this.create('program')
  }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() {
    return this.lost ? null : !this.options.failLink
  }
  getProgramInfoLog() {
    return 'fake link error'
  }
  deleteProgram(p: unknown) {
    if (p && !this.lost) this.deletedPrograms++
    this.remove(p, 'program')
  }
  getUniformLocation(_p: unknown, name: string) {
    return this.lost ? null : { name }
  }
  useProgram() {}
  uniform1f() {}
  uniform1i(_l: unknown, v: number) {
    this.pass = v
  }
  uniform2f() {}
  uniform3f() {}
  uniform1fv() {}

  // Buffers and vertex arrays.
  createBuffer() {
    return this.create('buffer')
  }
  bindBuffer() {}
  bufferData(_t: number, data: ArrayBuffer) {
    if (this.lost) return
    this.bufferDataCalls++
    this.uploadedBytes += data.byteLength
  }
  deleteBuffer(b: unknown) {
    if (b && !this.lost) this.deletedBuffers++
    this.remove(b, 'buffer')
  }
  createVertexArray() {
    return this.create('vao')
  }
  private boundVao: unknown = null
  bindVertexArray(v: unknown) {
    this.boundVao = v
  }
  deleteVertexArray(v: unknown) {
    if (v && !this.lost) this.deletedVaos++
    this.remove(v, 'vao')
  }
  enableVertexAttribArray() {}
  vertexAttribPointer(...args: unknown[]) {
    this.record('vertexAttribPointer', args)
  }
  vertexAttribIPointer(...args: unknown[]) {
    this.record('vertexAttribIPointer', args)
  }
  vertexAttribDivisor(...args: unknown[]) {
    this.record('vertexAttribDivisor', args)
  }

  // State and drawing.
  viewport() {}
  clear() {}
  clearColor() {}
  clearStencil() {}
  enable() {}
  disable() {}
  blendFunc() {}
  stencilMask() {}
  stencilOp() {}
  stencilFunc(_f: number, ref: number) {
    this.stencilRef = ref
  }
  drawArraysInstanced(_mode: number, _first: number, _n: number, count: number) {
    if (this.lost) return
    this.draws.push({ count, vao: this.boundVao, pass: this.pass, stencilRef: this.stencilRef })
  }
}

/** A canvas whose `getContext('webgl2')` returns `gl` (or null) and nothing else. */
export function fakeCanvas(options: FakeGlOptions | null = {}, width = 800, height = 600) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const gl = options === null ? null : new FakeWebGL2(canvas, options)
  canvas.getContext = ((type: string) => (type === 'webgl2' ? gl : null)) as never
  return { canvas, gl }
}
