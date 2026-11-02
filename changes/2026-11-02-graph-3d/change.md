# Change: Give the third dimension a job - time, themes, layers, paths in the 3D map

Date: 2026-11-02 · Requested by: Sarthak Bhatt · Status: draft
Client: Internal
Linked: changes/2026-11-01-graph-map/change.md (the 2D map, merged then reverted on the base branch)

## Why
Today 3D is just a worse 2D. Sarthak wants depth to carry meaning: sessions placed by date so
flying through the graph reads as a history, themes as separate islands with names floating above,
size and brightness that carry data, a layers mode, a time-lapse, insights tabs that steer the
camera, and a path between two topics ("how did X lead to Y?"). The look also needs work: shapes
per type, fog, glow, faint coloured links, less clutter, and a view that starts to the right of the panels.

## Must work
- Time as depth: sessions get z from `started_at` (earliest at -300, latest at +300, all same date
  or one dated session -> 0); a topic or project floats at the average z of its dated sessions;
  undated sessions are left free.
- Islands: each theme gets a centre on a circle (radius 200, one theme -> centre); nodes are pulled
  towards their theme centre; theme names float above each island using `clusterLabels()`.
- Size and glow: session size from turns, other nodes from rank (3 to 15); brightness from how
  recent the work is (1 for the newest, down to 0.25 after 180 days); bridge topics get a ring.
- Layers mode (optional switch): projects at z -200, sessions 0, topics +200, overriding the time axis.
- Time-lapse: a button steps the month filter from the first month to the last, one month per step,
  then stops; pressing it again while running stops it.
- Insights tabs: clicking a theme, bridge or roadmap item selects the node, orbits the camera
  around that cluster and fades everything else.
- Path: pick two topics and the shortest chain topic - session - topic ... is highlighted; no
  route -> a plain message "No path between these topics".
- Look: sphere for sessions, cube for projects, octahedron for topics; depth fog; soft bloom; links
  at about 15% opacity coloured by link type; particles flow along the selected node's links;
  session-tool and session-file links hidden by default; camera fitted after loading, slow
  auto-rotate when idle; legend of shapes and colours; the 3D view starts 324 px from the left.
- 2D map and insights panel (restored from the reverted part) keep working.

## Steps
| Phase | What it delivers | Size |
|---|---|---|
| 13 | `explorer/src/scene3d.ts` layout maths: time axis, island centres, layer z, size, brightness, bridge set | M |
| 14 | Same module, graph logic: link filter and colours, shortest path, time-lapse stepping, cluster orbit maths | M |
| 15 | 3D look in the app shell: shapes, fog, bloom, particles, legend, fit and auto-rotate, width fix; add `three` | L |
| 16 | Wiring: time and island forces, theme labels, layers switch, time-lapse button, path picker, tabs drive the camera | L |

## Risk: Medium
Normal product change to the explorer, runs only in the browser on private data and sends nothing
out. Adds one dependency (`three`, already installed through `3d-force-graph`), so `package.json` changes.

## Undo
Revert the phase commits. The 2D map comes back with the first commit on this branch; revert that too to drop it.

## Not in this change
- Changing graph.json, `kb ingest`, `kb context`, `analysis.ts` or `insights.ts`.
- Any other new package, any online service, saving camera views.

## Assumptions
- This branch undoes the revert on the base branch, so the pull request also restores the 2D map (answered: "Bring 2D back too").
- `three` is added at the version `3d-force-graph` already uses (>=0.179, installed 0.187). Theme labels are drawn on canvas sprites, no font package.
- The new logic is pure and unit-tested in `scene3d.ts`; rendering and wiring in `main.ts` and `index.html` are checked by `npm run build`, `tsc --noEmit` and a look in the browser.
- "Recent" is measured from the latest session in the graph, not the clock.
- Link types are the ones graph.json already has: `in_project`, `has_topic`, `touched_file`, `used_tool`.
- One change with four phases (answered).

## Still open
