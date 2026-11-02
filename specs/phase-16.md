# Phase 16: 3D wiring - time and island forces, labels, layers, time-lapse, path, camera

## Intent
Give depth its job: sessions flow along Z by date, themes form islands with floating names, an
optional layers mode, a time-lapse button, a topic-to-topic path picker, and insights tabs that
fly the camera around a cluster and fade the rest.

## Complexity
L - force configuration, timers, camera animation and UI state that interact with filters and selection.

## Scope
- In scope: `explorer/src/main.ts`, `explorer/index.html`, using `scene3d.ts` helpers.
- Out of scope: changing `scene3d.ts` behaviour, `analysis.ts`, `insights.ts`.

## Interface contract
App shell, not unit-tested. Checked by `npm run build`, `npx tsc --noEmit`, the existing tests and a browser run.

| Item | Location | Shape | Errors |
|---|---|---|---|
| Layers switch | `index.html` | `<input type="checkbox" id="layers-mode">` with label "Layers" | - |
| Time-lapse button | `index.html` | `<button id="timelapse">Time-lapse</button>`, label toggles to "Stop" while running | - |
| Path picker | `index.html` | two `<select id="path-from">` / `<select id="path-to">` listing topics, `<button id="path-go">`, `<div id="path-result">` | - |

## Behaviour
- Time as depth: in 3D, `d3Force('z', forceZ(z => timeAxis(visible).get(id) ?? 0).strength(0.4))`; nodes with no entry are pulled toward 0.
- Islands: custom x/y forces pull each node toward `islandCenters(analysis).get(community)` (strength about 0.15); unassigned nodes toward the origin. Theme names (`clusterLabels`) are drawn as canvas-texture sprites floating above each island's anchor node, escaped text, always facing the camera, hidden in 2D.
- Layers mode: when the box is ticked the z force targets `layerZ(type)` instead of the time axis; unticking restores time; the simulation is reheated on change.
- Time-lapse: pressing the button sets the "from" month to the first month and steps the "to" month with `nextMonth` every ~900 ms starting from the first month (`#to-month`, applying filters each step); at the end it stops and the full range stays; pressing again while running stops it and leaves the filter where it is. Switching to 2D also stops it.
- Tabs drive the camera: `focusCommunity` and `focusNode` in 3D call a new `orbitCluster(ids)`: it computes `clusterBounds` of the members' current positions, flies to `orbitPosition(center, radius, angle)` and orbits slowly (angle advances per frame) until the selection changes or is cleared; all nodes outside the cluster are faded to the dim colour with lower opacity. Selecting a theme/bridge/roadmap item selects its node as before.
- Path: choosing two topics and pressing "Find path" runs `shortestPath(visible, from, to)`; the nodes and links on the path are highlighted (others dimmed), the result shows the chain labels (escaped) such as `A → session → B`; `null` shows "No path between these topics" and clears highlights. Changing either select or the filters clears the path.
- 2D keeps working; the new controls are shown only in 3D except the month filter.

## Acceptance criteria
- AC-16-01: `npm run build` and `npx tsc --noEmit` pass and the existing unit tests still pass.
- AC-16-02: In the browser, 3D sessions are spread along Z in date order and themes appear as separate clusters with floating theme names.
- AC-16-03: Ticking "Layers" puts projects, sessions and topics on three levels; unticking returns to the time axis.
- AC-16-04: The time-lapse button grows the graph month by month, stops at the last month, and a second press stops it early.
- AC-16-05: Clicking a theme, bridge or roadmap item in 3D orbits that cluster and fades the rest; clearing the selection stops the orbit.
- AC-16-06: Picking two connected topics highlights the shortest chain; two unconnected topics show "No path between these topics".

## External systems to mock
- None; behaviour checked in the browser preview.

## Dependencies on earlier phases
- Phases 13-15. Phase 12 app shell (filters, tabs, `focusCommunity`, `focusNode`).
