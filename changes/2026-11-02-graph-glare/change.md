# Change: Tame the 3D glare and make the hover names readable

Date: 2026-11-02 · Requested by: Sarthak Bhatt · Status: draft
Client: Internal
Linked: changes/2026-11-02-graph-3d/change.md (the 3D look this fixes; same branch)

## Why
Sarthak: the 3D graph is too bright, the names shown on hover are hard to read, and after selecting
a node the brightness becomes enormous. Causes found in the code: the glow filter picks up almost
every pixel (threshold 0.15, strength 0.9), every node also lights itself up on top of that, and a
selected node adds white links, four particles per link and a white ring, all of which the glow then
multiplies. The hover name is the library's default plain text with no background, so it sinks into
the glow.

## Must work
- Glow levels are capped: a node's self-light never goes above 0.25 (today up to 0.75), a dim node has 0.
- Selecting a node does not make it brighter: selected light = normal light for the same node; it stands out through full opacity and a white ring instead.
- Brightness still carries data: a more recent node (brightness 1) is lighter than an old one (0.25), by a small, visible step.
- Out-of-range or missing brightness (below 0, above 1, NaN) is treated as the nearest valid value (NaN -> 0.5), so the light never exceeds the cap.
- Bloom is gentler: threshold 0.6 (only the brightest spots glow), strength 0.35, radius 0.4.
- Links touching the selected node are a soft white (about 55% opacity), not pure white; particles are fewer (2) and thinner.
- Hover name: dark panel, light text, readable size, shows the name and the type (for example "Billing API - topic"); the name is still escaped.
- 2D map, panels, path, time-lapse, orbit and layers behave as before.

## Steps
| Phase | What it delivers | Size |
|---|---|---|
| 17 | `explorer/src/scene3d.ts`: capped, pure glow levels (self-light, opacity, ring) per node state | S |
| 18 | App shell: use the glow levels, gentler bloom, softer selected links and particles, readable hover panel | M |

## Risk: Low
Look-only change in the explorer, no data, no dependency, no `graph.json` or ingest change.

## Undo
Revert the two phase commits.

## Not in this change
- New controls (a brightness slider), new packages, changes to `analysis.ts`, `insights.ts`, the 2D drawing.

## Assumptions
- Same branch `build/graph-3d`; the commits are added to the open pull request.
- The exact numbers above (0.25 cap, 0.6 threshold, 0.35 strength, 2 particles) are a first tune; they live in named constants so they are easy to adjust after a look.
- "Descriptions" means the hover name in 3D; the side details panel is already readable and stays.

## Still open
