/* global self */
/**
 * DEVELOPMENT ONLY (Phase 2.4D B1.5.3): runtime evidence for the ordering of `scsWorkerEntry.mjs`.
 *
 * Imported first by the entry, so its listener is the first `message` listener of the worker
 * scope. It counts message events dispatched before `bootstrapScsWorker` sets `installed`. The
 * entry's whole module graph is evaluated in one synchronous step (no top-level `await` anywhere,
 * checked for MapLibre's worker bundle), so the count must be 0. A count above 0 would mean the
 * runtime dispatched messages between MapLibre's worker setup and the handler installation; the
 * worker reports it in its status answer and `workerProjection.ts` rejects such a worker.
 *
 * Only counts; it never reads, changes or consumes a message.
 */
export const probe = { messages: 0, installed: false }

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', () => {
    if (!probe.installed) probe.messages++
  })
}
