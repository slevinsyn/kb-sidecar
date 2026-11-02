# Report: 2026-11-02-graph-3d

_Written by `.phased/bin/phase.py report` on 2026-11-02T11:48._

| Phase | Title | Size | Model | Minutes | Test files | Review rounds | Bugs found and fixed | Retests | Commit |
|---|---|---|---|---|---|---|---|---|---|
| 13 | 3D layout maths - time axis, islands, layers, size, brightness | medium | sonnet | 2.4 | 2 | 1 | 0 | 0 | 226d0a616d |
| 14 | 3D graph logic - link filter and colours, shortest path, time-lapse, orbit maths | medium | sonnet | 1.9 | 2 | 1 | 0 | 0 | c6b72af243 |
| 15 | 3D look - shapes, fog, bloom, particles, legend, fit, auto-rotate, width | large | opus | 18.7 | 2 | 2 | 1 | 0 | 9d2df8908d |
| 16 | 3D wiring - time and island forces, labels, layers, time-lapse, path, camera | large | opus | 19.7 | 2 | 1 | 0 | 0 | f308bdd233 |

| Total | Value |
|---|---|
| Phases done | 4 of 4 |
| Time | about 43 minutes |
| Risk | Medium -> 1 person approves the merge |
| Old problems seen, not blocking | 1 |

## Problems met and how they were solved

- Phase 15: @types/three flagged as an unplanned package -> user approved it, change.md updated; three small nits fixed
- Phase 15: Node objects are rebuilt on every filter change because the graph library gets copied nodes -> stored node looks are cleared on each 3D filter and the wrong comment was corrected
- Phase 15: Bloom render targets were sized without the HiDPI pixel ratio -> the composer is resized after the bloom and output passes are added
- Phase 15: Node sizes were recomputed for every node on every filter change -> sizes are computed once per loaded graph and looked up by id
- Phase 16: Spec mentions forceZ but d3-force-3d is not a direct dependency, so custom x/y/z axis forces were written on the graph instance
- Phase 16: Filter changes re-create 3D nodes, so x/y/z and velocities are carried over by id to keep the time-lapse smooth
- Phase 16: Theme names are drawn on canvas or set via textContent, never innerHTML

## Suggested REVIEW.md lines (same bug type in 2+ phases)

- Check for: none
