/* global URL */
/**
 * B1.5.4E: the app-page placeholder of the harness-owned dev server (B1.5.4D race).
 *
 * RoadPilot's debug build always opens the app page (`/`, `src/app/main.tsx`) first; the harness
 * then navigates the same webview to the lab. When `main.tsx` ran before the lab committed, it
 * registered Tauri event listeners (`telemetry:update`, `control:status`, `map:status`) that Tauri
 * keeps per webview, not per document; `control:status` then called a dead callback in the lab
 * every 200 ms (B1.5.4C session 5).
 *
 * After the dev server passed readiness, the harness switches `/` (and `/index.html`) to this
 * empty, marked page, so the app page never loads in a measurement webview. The page has no
 * script, no stylesheet and no other resource: it loads neither the RoadPilot app, nor Vite's
 * client, nor any module, and its inline `data:` icon suppresses the automatic favicon request. Every other URL (the lab page, its modules, the app modules themselves)
 * is served unchanged. The switch is one-way for the life of the server process.
 *
 * Pure: shared by `viteserver.mjs` (real Vite) and the process-test fixture server.
 */

/** `<meta name>` of the placeholder's marker. */
export const PLACEHOLDER_META = 'roadpilot-harness-placeholder'

/** Unique, stable marker content; checked by devserver.mjs, openlab.mjs and report.mjs. */
export const PLACEHOLDER_MARKER = 'roadpilot-b154e-app-page-isolation-v1'

/**
 * B1.5.4F: the inline, empty icon that keeps the browser from requesting `/favicon.ico`. Without
 * it the browser's automatic favicon request (404 from the dev server) can land in the
 * placeholder's resource list and trip `app_resources_in_app_page` (B1.5.4F positive run r10).
 * A `data:` URL causes no network request.
 */
export const PLACEHOLDER_ICON = '<link rel="icon" href="data:,">'

/** The placeholder document: no script, no image, no other resource; only the inline icon. */
export const PLACEHOLDER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  `<meta name="${PLACEHOLDER_META}" content="${PLACEHOLDER_MARKER}">` +
  PLACEHOLDER_ICON +
  '<title>RoadPilot harness placeholder</title></head><body></body></html>'

/** The app document paths that the switch replaces. */
export const APP_DOCUMENT_PATHS = Object.freeze(['/', '/index.html'])

const pathOf = (url) => {
  try {
    // Only the path matters; the base resolves a request's relative URL (`/`, `/index.html?x`).
    return new URL(String(url ?? ''), 'http://127.0.0.1').pathname
  } catch {
    return null
  }
}

/**
 * One switch per server process.
 * - `middleware(req, res, next)`: connect-style; while active, answers GET/HEAD of the app
 *   document with the placeholder, and passes everything else on unchanged.
 * - `handleMessage(message, { listening, pid, send })`: handles the IPC message
 *   `{ type: 'placeholder' }`. Before the server listens it answers `placeholder-refused`
 *   (nothing changes); afterwards it activates and answers `placeholder-active` with its PID and
 *   the marker. Returns false for every other message.
 */
export function createPlaceholderSwitch() {
  let active = false
  return {
    isActive: () => active,
    middleware(req, res, next) {
      const method = req?.method ?? 'GET'
      if (
        active &&
        (method === 'GET' || method === 'HEAD') &&
        APP_DOCUMENT_PATHS.includes(pathOf(req?.url))
      ) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('x-roadpilot-harness-placeholder', PLACEHOLDER_MARKER)
        res.end(method === 'HEAD' ? undefined : PLACEHOLDER_HTML)
        return
      }
      next()
    },
    handleMessage(message, { listening, pid, send }) {
      if (message?.type !== 'placeholder') return false
      if (!listening) {
        send({ type: 'placeholder-refused', pid, reason: 'not_listening' })
        return true
      }
      active = true
      send({ type: 'placeholder-active', pid, marker: PLACEHOLDER_MARKER })
      return true
    },
  }
}
