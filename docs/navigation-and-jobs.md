# Current job, route information and navigation area

Phase 2, steps 2.1–2.3. These dashboard sections are a **display only**: they read the existing telemetry path ([telemetry.md](telemetry.md)), add no control path and send nothing to the game. Control stays in dry run with the supervisor disabled ([control.md](control.md)).

> **Status:** implemented and covered by automated tests with synthetic data. **Not verified in a running game.** No map data is used: RoadPilot-Map, map packages, road rendering, calculated routes, destination markers, turn-by-turn directions and map matching are not part of these steps.

## Layout

From top to bottom: control, overview (autopilot, speed), **Current Job**, the **Navigation** area with **Route Information** beside it, then the Vehicle Data section and the remaining cards. The navigation area takes about two thirds of the width and at least 300 px (up to about half the window height). Below 1000 px window width the route information moves under the navigation area; below 720 px everything is one column without horizontal scrolling.

The former Current Job, Route Progress and Navigation cards and the overview tiles for the job and the remaining distance were removed, so no job or route value appears twice.

## Current Job (step 2.1)

`src/domain/job.ts` derives a `JobView` from the snapshot; `src/ui/job/CurrentJob.tsx` shows it.

| Status      | From the game                                                        | Shown                                                   |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `active`    | `job.state = active`                                                 | All job values                                          |
| `delivered` | `job.delivered` event; stays until the next job                      | Job values and the revenue                              |
| `cancelled` | `job.cancelled` event; stays until the next job                      | Job values and the penalty; never interpreted as failed |
| `none`      | The game reports no active job                                       | "No active job"                                         |
| `unknown`   | No job information (schema 1, not sent yet), or no current telemetry | "Unavailable" with the reason                           |

There is **no "job available"** state (the SCS SDK reports no job offers) and **no "job failed"** state (the telemetry does not report why a job was cancelled, nor late deliveries).

Values: start and destination city and company (names as localized by the game; RoadPilot has no ids for them), cargo and whether it is loaded, weight (kg, or lb with US units), income / revenue / penalty, deadline with the time left or late in **game time**, cargo damage, job type (`jobMarket`; the documented tokens are named, others shown as sent).

**Currency.** The game decides it: EUR in ETS2, USD in ATS. An amount whose currency does not belong to the current game is shown as invalid, never with a wrong symbol.

`cargoLoaded` and `jobMarket` were already decoded and validated by `roadpilot-telemetry-client`; they are now passed through `telemetry::normalize` unchanged.

## Route Information (step 2.2)

`src/domain/route.ts` derives a `RouteView`; `src/ui/route/RouteInfo.tsx` shows it. Every value carries its provenance, shown as a tag:

| Value                  | Provenance   | Source                                                                                                  |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Remaining distance     | `game`       | Route Advisor                                                                                           |
| Remaining driving time | `game`       | Route Advisor estimate; **whether it counts game or real time is not confirmed**                        |
| Speed limit            | `game`       | Route Advisor; "None shown" when the game shows no limit (interpretation unconfirmed, see telemetry.md) |
| Job distance           | `game`       | Planned distance of the active job                                                                      |
| Driven distance        | `calculated` | Job distance − remaining distance, at least 0. Approximate (`≈`)                                        |
| Progress               | `calculated` | Driven share of the job distance. Approximate (`≈`)                                                     |

A value without a current reading has the provenance `unavailable`; its text says why (not available, invalid value, no data). A calculated value is no better than its weakest input: if an input is invalid, the result is invalid. Route Advisor values are shown even without a job (they describe the current navigation target); job distance, driven distance and progress need an active job and say "No active job" otherwise.

RoadPilot **calculates no route and gives no directions**, and it derives **no arrival time**, because the time scale of the Route Advisor estimate is not confirmed.

## Navigation area (step 2.3)

`src/ui/navigation/NavigationArea.tsx` shows the **path the truck has traveled**, traced from telemetry positions. It is labelled "Traveled path · not a map": no roads, no map package, no route, no destination, and no claim of geographic accuracy.

- **Recording** (`src/domain/path.ts`, `src/state/pathStore.ts`): every snapshot is offered to the trace, whatever is on screen. Only live, connected (or paused) frames with a position count; demo data, interrupted or stale links add nothing. A point is stored after at least 2 m of movement. A move of more than 1,000 m between two samples (ferry, train, teleport, new session) starts a new segment instead of drawing a line. Positions that are not finite or beyond ±10,000 km are skipped and counted.
- **Limits:** above 4,000 points every second point is dropped, keeping the start and the end, so memory and drawing stay bounded on long drives (checked with 50,000 samples). Adding a point costs O(1).
- **Game switch:** when the game changes (ETS2 ↔ ATS, already while connecting), the trace is cleared. Coordinates of different games are never mixed. Job and route values come from the current frame only, so nothing carries over either.
- **Coordinates:** telemetry world space in metres, unchanged (X east, Z south), drawn north up with one scale for both axes. No map unit or scaling is involved. The scale bar uses m/km, or ft/mi with US units.
- **Views:** _Follow truck_ (1,500 m around the last position) or _Whole path_.
- **Staleness:** when the link is not current, the path stays visible in grey, the marker is drawn hollow, and a label shows the age of the last position.
- **Canvas:** sized to its container with `ResizeObserver` (window resize as fallback), sharp on high-density screens, redrawn only when the trace, the size, the view or the staleness changes.

## Tests

All offline with synthetic data; no game was started.

- `domain/job.test.ts`, `ui/job/CurrentJob.test.tsx`: active, none, delivered, cancelled (not failed), unknown; missing cargo and company; EUR/USD and a currency of the wrong game; invalid values from the reader and at the UI boundary; late deliveries; stale data; paused game; demo labelling; game switch.
- `domain/route.test.ts`, `ui/route/RouteInfo.test.tsx`: game and calculated values with their provenance; missing data; no active job versus missing job information; invalid inputs and their dependent calculations; no negative driven distance; no limit shown; stale data; miles and mph for ATS; the unconfirmed time scale; demo labelling.
- `domain/path.test.ts`, `ui/navigation/pathView.test.ts`, `ui/navigation/NavigationArea.test.tsx`: empty and valid histories; demo, stale and missing positions add nothing; invalid and non-finite coordinates; jumps; a 50,000-sample drive stays bounded with start and end; game switch clears the trace; north-up projection with one scale; follow and whole-path views; resizing with and without `ResizeObserver`; drawing with a recording canvas context (segments, start, heading, stale style); layout rules and section order.

The canvas drawing was checked with a fake drawing context; jsdom has no canvas. The layout was checked in a headless browser at 1280 and 500 px with demo data, where the navigation area shows its empty state.
