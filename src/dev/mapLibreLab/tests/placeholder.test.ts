/**
 * B1.5.4E: the app-page placeholder switch (tools/maplibre-validation/placeholder.mjs), shared by
 * the harness's Vite server and the process-test fixture. Pure: fake requests and responses.
 */
import { describe, expect, it } from 'vitest'
import {
  APP_DOCUMENT_PATHS,
  createPlaceholderSwitch,
  PLACEHOLDER_HTML,
  PLACEHOLDER_ICON,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_META,
} from '../../../../tools/maplibre-validation/placeholder.mjs'

function call(sw: ReturnType<typeof createPlaceholderSwitch>, method: string, url: string) {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    end(body?: string) {
      this.ended = true
      this.body = body
    },
  }
  let passed = false
  sw.middleware({ method, url }, res, () => {
    passed = true
  })
  return { res, passed }
}

describe('app-page placeholder switch (B1.5.4E)', () => {
  it('the placeholder is empty and marked: no script, no stylesheet, no resource', () => {
    expect(PLACEHOLDER_HTML).toContain(
      `<meta name="${PLACEHOLDER_META}" content="${PLACEHOLDER_MARKER}">`,
    )
    expect(PLACEHOLDER_HTML).not.toMatch(/<script\b|<img\b|<iframe\b|<style\b|src=|url\(/i)
    // The only link is the inline icon; every href is a data: URL (no network request).
    expect(PLACEHOLDER_HTML.match(/<link\b[^>]*>/gi)).toEqual([PLACEHOLDER_ICON])
    expect(PLACEHOLDER_HTML.match(/href="[^"]*"/gi)).toEqual(['href="data:,"'])
    expect(PLACEHOLDER_HTML).not.toContain('/@vite/client')
    expect(PLACEHOLDER_HTML).not.toContain('/src/')
    expect(PLACEHOLDER_MARKER).toMatch(/^[a-z0-9-]+$/)
    expect(APP_DOCUMENT_PATHS).toEqual(['/', '/index.html'])
  })

  it('B1.5.4F: declares an inline icon in <head>, so the browser does not request /favicon.ico', () => {
    expect(PLACEHOLDER_ICON).toBe('<link rel="icon" href="data:,">')
    const head = PLACEHOLDER_HTML.slice(
      PLACEHOLDER_HTML.indexOf('<head>'),
      PLACEHOLDER_HTML.indexOf('</head>'),
    )
    expect(head).toContain(PLACEHOLDER_ICON)
    expect(PLACEHOLDER_HTML).not.toMatch(/favicon/i)
  })

  it('inactive until switched: every request passes through to the normal server', () => {
    const sw = createPlaceholderSwitch()
    expect(sw.isActive()).toBe(false)
    for (const url of ['/', '/index.html', '/src/app/main.tsx'])
      expect(call(sw, 'GET', url)).toMatchObject({ passed: true, res: { ended: false } })
  })

  it('refuses the switch before the server listens; nothing changes', () => {
    const sw = createPlaceholderSwitch()
    const sent: Record<string, unknown>[] = []
    expect(
      sw.handleMessage(
        { type: 'placeholder' },
        { listening: false, pid: 9, send: (m) => sent.push(m) },
      ),
    ).toBe(true)
    expect(sent).toEqual([{ type: 'placeholder-refused', pid: 9, reason: 'not_listening' }])
    expect(sw.isActive()).toBe(false)
    expect(call(sw, 'GET', '/').passed).toBe(true)
  })

  it('after the switch: only the app document is the placeholder; lab and modules pass through', () => {
    const sw = createPlaceholderSwitch()
    const sent: Record<string, unknown>[] = []
    expect(
      sw.handleMessage(
        { type: 'placeholder' },
        { listening: true, pid: 9, send: (m) => sent.push(m) },
      ),
    ).toBe(true)
    expect(sent).toEqual([{ type: 'placeholder-active', pid: 9, marker: PLACEHOLDER_MARKER }])
    expect(sw.isActive()).toBe(true)
    for (const url of ['/', '/index.html', '/?x=1']) {
      const { res, passed } = call(sw, 'GET', url)
      expect(passed).toBe(false)
      expect(res).toMatchObject({ statusCode: 200, body: PLACEHOLDER_HTML, ended: true })
      expect(res.headers['content-type']).toMatch(/^text\/html/)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    expect(call(sw, 'HEAD', '/').res).toMatchObject({ statusCode: 200, body: undefined })
    for (const url of [
      '/src/dev/mapLibreLab/index.html',
      '/src/dev/mapLibreLab/main.ts',
      '/src/dev/mapLibreLab/scsWorkerEntry.mjs',
      '/src/app/main.tsx',
      '/@vite/client',
      '/favicon.ico',
    ])
      expect(call(sw, 'GET', url).passed).toBe(true)
    expect(call(sw, 'POST', '/').passed).toBe(true)
  })

  it('ignores every other IPC message', () => {
    const sw = createPlaceholderSwitch()
    const sent: unknown[] = []
    for (const m of [{ type: 'shutdown' }, null, 'placeholder', { type: 'other' }])
      expect(sw.handleMessage(m, { listening: true, pid: 9, send: (x) => sent.push(x) })).toBe(
        false,
      )
    expect(sent).toEqual([])
    expect(sw.isActive()).toBe(false)
  })
})
