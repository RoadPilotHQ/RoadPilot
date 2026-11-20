# Architecture decision records (RoadPilot application)

Decisions about the RoadPilot desktop application. Decisions about map package generation live in RoadPilot-Map (`docs/adr/`, numbered `0001`, `0002`, …); those numbers are a separate series. ADR-001 is not assigned in this repository; the map-related records start at 002 as planned in Phase 2.4D.

| ADR                                           | Title                                         | Status                          |
| --------------------------------------------- | --------------------------------------------- | ------------------------------- |
| [ADR-002](ADR-002-coordinate-system.md)       | Coordinate system for the in-game map         | Proposed                        |
| [ADR-003](ADR-003-map-rendering.md)           | Map rendering: MapLibre, WebGL 2, Canvas 2D   | Proposed (B1 experiment only)   |
| [ADR-004](ADR-004-map-data-formats.md)        | Map data formats: package, RPMT, MVT, PMTiles | Proposed                        |

Status values follow RoadPilot-Map: **Proposed** (under discussion, not binding), **Accepted**, **Deprecated**, **Superseded by ADR-NNN**. All three were written in Phase 2.4D B0 (2026-11-21), a read-only audit: no application code was changed for them.

Statements are marked **FACT** (follows from code, data or an official source), **MEASUREMENT** (measured, with the data named), **HYPOTHESIS** (plausible, not verified) and **RECOMMENDATION**. Nothing here is legal advice.
