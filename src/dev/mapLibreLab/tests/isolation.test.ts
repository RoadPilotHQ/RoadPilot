/**
 * B1 isolation guards: the MapLibre lab runs under the production CSP, MapLibre stays a pinned
 * development dependency, and nothing outside `src/dev/` imports MapLibre or the lab.
 */
import { describe, expect, it } from 'vitest'
import pkg from '../../../../package.json'
import tauriConf from '../../../../src-tauri/tauri.conf.json'
import appHtml from '../../../../index.html?raw'
import viteConfig from '../../../../vite.config.ts?raw'
import labHtml from '../index.html?raw'

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx,mts,mjs,css,html}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('MapLibre lab isolation', () => {
  it('the lab page carries the production CSP verbatim', () => {
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(labHtml)
    expect(meta?.[1]).toBe(tauriConf.app.security.csp)
  })

  it('maplibre-gl is an exactly pinned development dependency only', () => {
    expect((pkg.devDependencies as Record<string, string>)['maplibre-gl']).toBe('6.19.0')
    expect((pkg.dependencies as Record<string, string>)['maplibre-gl']).toBeUndefined()
  })

  it('nothing outside src/dev imports MapLibre or the lab', () => {
    const paths = Object.keys(sources)
    expect(paths.length).toBeGreaterThan(50)
    const offenders = paths
      .filter((p) => !p.startsWith('/src/dev/'))
      .filter((p) => /maplibre|mapLibreLab/i.test(sources[p]!))
    expect(offenders).toEqual([])
    expect(appHtml).not.toMatch(/maplibre|mapLibreLab/i)
  })

  it('the production build has a single input, the app page', () => {
    expect(viteConfig).not.toMatch(/rollupOptions|rolldownOptions|input\s*:/)
    expect(viteConfig).not.toMatch(/maplibre|mapLibreLab/i)
  })

  it('the lab sources name no external host', () => {
    const allowed = ['http://asset.localhost', 'http://ipc.localhost', 'ws://127.0.0.1:1420']
    const lab = Object.keys(sources).filter(
      (p) => p.startsWith('/src/dev/mapLibreLab/') && !p.includes('/tests/'),
    )
    expect(lab.length).toBeGreaterThanOrEqual(8)
    for (const p of lab) {
      let text = sources[p]!
      for (const a of allowed) text = text.replaceAll(a, '')
      expect(text, p).not.toMatch(/(https?|wss?):\/\//)
    }
  })
})
