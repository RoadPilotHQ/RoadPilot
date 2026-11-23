# MapLibre B1 runtime validation harness

Development tooling for Phase 2.4D B1. **B1.5 and B1.5.2 were run and stopped (NO-GO). The B1.5.3 worker entry is unit-tested and checked in headless Edge (`workerorder.mjs`), not yet in RoadPilot's WebView2 (B1.5.4).** See [docs/maplibre-validation.md](../../docs/maplibre-validation.md) for the environment, invocation, result format and acceptance thresholds.

| File            | Role                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- |
| `run.mjs`       | Driver: `functional`, `perf`, `cycles` (start RoadPilot, need `--confirm-runtime`), `report` (offline) |
| `report.mjs`    | Pure evaluation: thresholds and PASS / FAIL / INVALID / NOT_TESTED verdicts             |
| `report.d.mts`  | Types of `report.mjs` for the unit tests                                               |
| `openlab.mjs`   | Staged, bounded lab opening with failure diagnostics and safe retry (B1.5.1)           |
| `openlab.d.mts` | Types of `openlab.mjs` for the unit tests                                              |
| `cdp.mjs`       | App start and close, DevTools connection, request and worker instrumentation           |
| `sampler.ps1`   | Read-only memory sampler (RoadPilot's own processes only)                              |
| `workerorder.mjs` | B1.5.3: synthetic worker-ordering check in headless Edge against the dev server (no app, no WebView2) |

Results go to `out/<session>/` (ignored by Git; `--session=<name>`, default a new timestamped folder) unless `--out` names another folder. Existing results are never overwritten. The B1.5 evidence stays in the `out/` root.
