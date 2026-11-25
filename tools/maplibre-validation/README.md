# MapLibre B1 runtime validation harness

Development tooling for Phase 2.4D B1. **B1.5 and B1.5.2 were run and stopped (NO-GO). B1.5.4 ran in RoadPilot's WebView2 (CONDITIONAL GO), and B1.5.4A passed 10 of 10 forced worker replacements. B1.5.4B corrected three harness defects. B1.5.4C ran the corrected harness in WebView2 (CONDITIONAL GO: an app-to-lab navigation race in one of five starts), and B1.5.4E adds app-page isolation against it, which has not run in WebView2 yet.** See [docs/maplibre-validation.md](../../docs/maplibre-validation.md) for the environment, invocation, result format and acceptance thresholds.

| File                 | Role                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `run.mjs`            | Driver: `functional`, `perf`, `cycles` (one session each, need `--confirm-runtime`), `report` (offline) |
| `report.mjs`         | Pure evaluation: thresholds and PASS / FAIL / INVALID / NOT_TESTED verdicts                             |
| `lifecycle.mjs`      | B1.5.4B: one session, preflight → own dev server → measurement → RoadPilot closed → dev server stopped  |
| `devserver.mjs`      | B1.5.4B: dev server readiness stages, ownership checks, graceful stop (pure)                            |
| `devserver-node.mjs` | B1.5.4B: real fork, HTTP, port owner and process tree, by PID only; no kill function                    |
| `viteserver.mjs`     | B1.5.4B: the forked dev server (Vite JS API, `vite.config.ts`), IPC `listening` / `shutdown` / `closed` |
| `evidence.mjs`       | B1.5.4B: screenshot recorder: `<test>-<seq>-<scenario>-<view>-<tag>.png`, never overwrites             |
| `placeholder.mjs`    | B1.5.4E: empty, marked placeholder at `/` after readiness, so the app page never loads before the lab  |
| `negativecontrol.mjs` | B1.5.4G: `control --negative-control`: reproduces the app-page race on purpose; never a measurement |
| `openlab.mjs`        | Staged, bounded lab opening with failure diagnostics (B1.5.1); one attempt by default (B1.5.4B)        |
| `cdp.mjs`            | App start and close, DevTools connection, request and worker instrumentation                           |
| `*.d.mts`            | Types of the modules above for the unit tests in `src/dev/mapLibreLab/tests/`                          |
| `sampler.ps1`        | Read-only memory sampler (RoadPilot's own processes only)                                              |
| `workerorder.mjs`    | B1.5.3: synthetic worker-ordering check in headless Edge against a running dev server (no app)         |

Port 1420 must be free: `run.mjs` starts and stops its own Vite dev server and refuses to start beside `npm run dev`.

Results go to `out/<session>/` (ignored by Git; `--session=<name>`, by default a new timestamped folder) unless `--out` names another folder. Existing results are never overwritten. The B1.5 evidence stays in the `out/` root.
