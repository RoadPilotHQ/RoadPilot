/* global self */
/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.5.3): RoadPilot's MapLibre worker entry. `workerProjection.ts`
 * passes its URL to MapLibre's `setWorkerUrl`, so every worker MapLibre starts (first pool,
 * `prewarm()`, `WorkerPool.restart`, pool recreation after a release) runs this module instead of
 * the package's `maplibre-gl-worker.mjs`.
 *
 * Ordering (see docs/maplibre-validation.md, B1.5.3):
 * 1. `scsWorkerProbe.mjs` adds a counting `message` listener.
 * 2. MapLibre's worker bundle is evaluated: its last statement `self.worker = new Worker(self)`
 *    creates the worker actor (message listener) and sets `self.setProjectionHandler`.
 * 3. This module's body installs the SCS handler and the status answer.
 * Static imports are evaluated in this order, depth first, before this body, and none of the three
 * modules has a top-level `await`, so 1-3 run in one synchronous evaluation: no message event can
 * be dispatched in between. Independently, MapLibre's worker actor never handles a message in its
 * event: it queues it and handles it in a later task (`Actor.receive` → `ThrottledInvoker`).
 *
 * Do not add a top-level `await`, a dynamic `import()` or another import before step 3.
 * The file name must end in `.mjs` (any non-`.cjs` URL is started as a module worker).
 *
 * The MapLibre import is root-absolute on purpose: it is the URL the Vite dev server serves for
 * the package file itself (the same URL `maplibre-gl/dist/maplibre-gl-worker.mjs?url` yields). A
 * bare specifier makes Vite pre-bundle the worker at request time: a different, re-bundled file
 * than the one inspected, and a dependency re-optimisation that can reload the lab page.
 */
import { probe } from './scsWorkerProbe.mjs'
import '/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'
import { bootstrapScsWorker } from './scsProjection.worker.mjs'

bootstrapScsWorker(self, probe)
