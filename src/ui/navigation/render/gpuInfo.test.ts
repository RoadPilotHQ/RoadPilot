import { describe, expect, it } from 'vitest'
import { classifyRenderer } from './gpuInfo'

describe('classifyRenderer', () => {
  it.each([
    // Chromium / WebView2 on Windows (ANGLE, Direct3D 11).
    [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU (0x0000249C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'HARDWARE',
    ],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'HARDWARE'],
    [
      'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'HARDWARE',
    ],
    [
      'ANGLE (Intel, Intel(R) HD Graphics 530 (0x0000191B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'HARDWARE',
    ],
    // Linux (WebKitGTK, Chromium on OpenGL).
    ['NVIDIA GeForce GTX 1070/PCIe/SSE2', 'HARDWARE'],
    ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'HARDWARE'],
    ['AMD Radeon RX 6800 (radeonsi, navi21, LLVM 15.0.7, DRM 3.49)', 'HARDWARE'],
    ['Apple M2', 'HARDWARE'],
    ['Adreno (TM) 650', 'HARDWARE'],
    // Software rasterizers.
    [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'SOFTWARE',
    ],
    ['Google SwiftShader', 'SOFTWARE'],
    [
      'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'SOFTWARE',
    ],
    ['llvmpipe (LLVM 17.0.6, 256 bits)', 'SOFTWARE'],
    ['softpipe', 'SOFTWARE'],
    ['Apple Software Renderer', 'SOFTWARE'],
  ])('%s is %s', (renderer, expected) => {
    expect(classifyRenderer(renderer).gpuClass).toBe(expected)
  })

  it('never classifies a masked or missing string as software', () => {
    expect(classifyRenderer('WebKit WebGL', 'WebKit')).toEqual({
      gpuClass: 'UNKNOWN',
      evidence: 'masked_renderer_string',
    })
    expect(classifyRenderer(null, null)).toEqual({
      gpuClass: 'UNKNOWN',
      evidence: 'no_renderer_string',
    })
    expect(classifyRenderer('', '  ')).toMatchObject({ gpuClass: 'UNKNOWN' })
    expect(classifyRenderer('Some Future GPU 9000')).toEqual({
      gpuClass: 'UNKNOWN',
      evidence: 'unrecognised_renderer_string',
    })
  })

  it('checks software names before hardware names', () => {
    expect(classifyRenderer('ANGLE (NVIDIA, SwiftShader Device)').gpuClass).toBe('SOFTWARE')
  })

  it('uses the vendor string too', () => {
    expect(classifyRenderer('Unknown device', 'NVIDIA Corporation').gpuClass).toBe('HARDWARE')
  })
})
