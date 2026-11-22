# MapLibre B1 runtime validation harness

Development tooling for Phase 2.4D B1. **Not runtime-tested yet.** See [docs/maplibre-validation.md](../../docs/maplibre-validation.md) for the environment, invocation, result format and acceptance thresholds.

| File            | Role                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- |
| `run.mjs`       | Driver: `functional`, `perf`, `cycles` (start RoadPilot, need `--confirm-runtime`), `report` (offline) |
| `report.mjs`    | Pure evaluation: thresholds and PASS / FAIL / INVALID / NOT_TESTED verdicts             |
| `report.d.mts`  | Types of `report.mjs` for the unit tests                                               |
| `cdp.mjs`       | App start and close, DevTools connection, request and worker instrumentation           |
| `sampler.ps1`   | Read-only memory sampler (RoadPilot's own processes only)                              |

Results go to `out/` (ignored by Git) unless `--out` names another folder.
