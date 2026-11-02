# Report: 2026-11-02-graph-neurons

_Written by `.phased/bin/phase.py report` on 2026-11-02T17:55._

| Phase | Title | Size | Model | Minutes | Test files | Review rounds | Bugs found and fixed | Retests | Commit |
|---|---|---|---|---|---|---|---|---|---|
| 19 | Neuron maths - cell per theme, branch spots, axon curves | medium | sonnet | 5.4 | 2 | 1 | 0 | 0 | 3753ea547f |
| 20 | 3D neuron look - cells, branches, axons | medium | sonnet | 19.8 | 2 | 1 | 0 | 0 | 6629192075 |

| Total | Value |
|---|---|
| Phases done | 2 of 2 |
| Time | about 25 minutes |
| Risk | Low -> no human approval once every check passes |
| Old problems seen, not blocking | 0 |

## Problems met and how they were solved

- Phase 19: Spec left the rotation hash open; used 32-bit FNV-1a of source>target scaled into [0, 2*PI) so it is deterministic and never reaches 2*PI.
- Phase 19: A community with no topics has no cell body, so all its nodes become branches.
- Phase 19: branchOffsets numbers spots from the ids it is given; phase 20 should pass the full unfiltered id list so nodes do not jump when filters change.
- Phase 20: Branch spots would jump when filters or the time-lapse change the visible nodes -> branchOffsets is computed once per loaded graph from the full unfiltered node ids.
- Phase 20: Bigger cells must not make the picture brighter -> the halo is forced on for cells, but ring and emissive levels still come from glowLevels, so the caps are unchanged.
- Phase 20: The 3D graph library only rebuilds node objects and curves when the accessors are set again -> the tick-box handler clears the node looks, re-sets nodeThreeObject, linkCurvature and linkCurveRotation, reinstalls the forces, then calls d3ReheatSimulation.
- Phase 20: Browser check (AC-20-02 to AC-20-04) not run in this session; needs a manual look in the preview.
