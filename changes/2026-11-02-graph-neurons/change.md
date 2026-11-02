# Change: Arrange the 3D graph like a collection of neurons

Date: 2026-11-02 · Requested by: Sarthak Bhatt · Status: draft
Client: Internal
Linked: changes/2026-11-02-graph-3d/change.md and changes/2026-11-02-graph-glare/change.md (same branch and pull request)

## Why
Sarthak: arrange the whole graph so it looks like a collection of neurons. Chosen look: "cells +
branches". Each theme becomes one neuron: a bigger cell body (the theme's top topic), its sessions
and other nodes branching around it, and long curved links between themes like axons. 3D view only.

## Must work
- Each theme (community) with at least one topic has exactly one cell body: its top-ranked topic (highest rank, ties by smaller id). A theme with no topic has none.
- A cell body is drawn 2.2 times larger than a normal node of the same data and keeps its soft halo on at all times.
- Every other node of a theme is placed around its cell on rings (12 per ring, outer rings turned half a slot) instead of one blob: the same node always gets the same spot, and no two spots of a theme coincide.
- A link between two different themes is an axon: curved (curvature 0.3), each with its own fixed bend direction. A link inside one theme stays straight.
- Nodes without a theme, and graphs with no themes at all, keep working with no curve and no branch spot.
- A "Neuron look" tick box (on by default) in the 3D controls turns the look off; off gives exactly today's 3D picture.
- 2D map, panels, path, time-lapse, orbit, layers and the glow caps behave as before.

## Steps
| Phase | What it delivers | Size |
|---|---|---|
| 19 | `explorer/src/scene3d.ts`: pure neuron maths - cell per theme, branch spots, axon curves | M |
| 20 | App shell: bigger glowing cells, branch forces, curved axon links, "Neuron look" tick box | M |

## Risk: Low
Look-only change in the explorer, no data, no dependency, no `graph.json` or ingest change.

## Undo
Untick "Neuron look", or revert the two phase commits.

## Not in this change
- Animated firing pulses, new packages, changes to `analysis.ts`, `insights.ts` or the 2D drawing.

## Assumptions
- Same branch `build/graph-3d`; commits go on the open pull request. You asked for "phase 19"; it is split in two (19 maths, 20 wiring) like the earlier changes so the maths can be tested on its own.
- Numbers (scale 2.2, curvature 0.3, branch radius 60 plus 4 per ring) are a first tune in named constants.
- Time (depth) still decides the z position; branches spread in x and y around the cell.
- The floating theme name stays on the node it is on today.

## Still open

