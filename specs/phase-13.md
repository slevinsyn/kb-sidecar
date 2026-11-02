# Phase 13: 3D layout maths - time axis, islands, layers, size, brightness

## Intent
Pure functions that decide where each node sits and how it looks in 3D, so depth carries meaning:
time along Z, one island per theme, optional layers, size and brightness that carry data.

## Complexity
M - several small formulas with edge cases (undated, empty, single item), no algorithms.

## Scope
- In scope: new `explorer/src/scene3d.ts` (pure, unit-tested).
- Out of scope: rendering, forces, DOM, `three`, link filtering and paths (phase 14).

## Interface contract
Tests import from `../src/scene3d` and may use `parseGraph` (`../src/graph`) and `analyzeGraph`
(`../src/analysis`). No DOM, no `three`, no `3d-force-graph`.
Session dates are `meta.started_at` ISO strings; unparseable or missing = undated. Links may use
string or `{id}` ends (`linkEnd` from `../src/graph`).

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `Z_SPAN` | `explorer/src/scene3d.ts` | `export const Z_SPAN = 600` | - |
| `ISLAND_RADIUS` | same | `export const ISLAND_RADIUS = 200` | - |
| `LAYER_Z` | same | `export const LAYER_Z: Readonly<Record<NodeType, number>>` = project -200, session 0, topic 200, file 0, tool 0 | - |
| `timeAxis` | same | `export function timeAxis(g: GraphData): Map<string, number>` | - |
| `islandCenters` | same | `export function islandCenters(a: Analysis): Map<number, { x: number; y: number }>` | - |
| `layerZ` | same | `export function layerZ(type: NodeType): number` | - |
| `nodeSize` | same | `export function nodeSize(n: GraphNode, a: Analysis): number` | - |
| `recency` | same | `export function recency(date: string \| undefined, latestAt: string \| null): number` | - |
| `brightnessMap` | same | `export function brightnessMap(g: GraphData, a: Analysis): Map<string, number>` | - |
| `bridgeIds` | same | `export function bridgeIds(a: Analysis): Set<string>` | - |

## Behaviour
1. `timeAxis(g)`: for each session with a valid `started_at`, `t` = its time in ms. With `tmin`,
   `tmax` over those sessions, `z = ((t - tmin) / (tmax - tmin) - 0.5) * Z_SPAN` (so earliest
   -300, latest +300); if `tmax === tmin` (or only one dated session) every z is 0. A topic or
   project gets the mean z of the dated sessions it is linked to (any link direction; each
   session counted once); with none it is absent from the map. Undated sessions, files and tools
   are absent. Input not mutated.
2. `islandCenters(a)`: for the communities in `a.communities` order, index `i` of `n`:
   `x = ISLAND_RADIUS * cos(2*PI*i/n)`, `y = ISLAND_RADIUS * sin(2*PI*i/n)`. `n === 1` ->
   `{x: 0, y: 0}`; no communities -> empty map. Keyed by community id.
3. `layerZ(type)` returns `LAYER_Z[type]`.
4. `nodeSize(n, a)`: a session whose `meta.turns` is a finite number `> 0` ->
   `min(15, 3 + 2 * log2(1 + turns))`. Anything else -> `3 + 12 * r / m` where `r` is
   `a.rank.get(n.id) ?? 0` and `m` is the largest rank in `a.rank` (`m <= 0` -> result 3).
   Result always in `[3, 15]`.
5. `recency(date, latestAt)`: `date` or `latestAt` missing/invalid -> `0.5`. Otherwise `age` in
   days = `(latestAt - date)` (negative -> 0); result `1 - 0.75 * min(1, age / 180)`. So newest
   = 1, 180 days or older = 0.25.
6. `brightnessMap(g, a)`: sessions use `recency` of their own date against `a.latestAt`; topics
   and projects use the most recent date of the sessions linked to them; nodes with no dated
   session (and files/tools) get 0.5. Every node in `g` has an entry.
7. `bridgeIds(a)`: the ids of `a.bridges`.

## Acceptance criteria
- AC-13-01: `timeAxis` puts the earliest dated session at -300 and the latest at +300, others proportional to time.
- AC-13-02: `timeAxis` gives 0 to all sessions when dates are equal or only one session is dated; undated sessions, files and tools are absent.
- AC-13-03: `timeAxis` places a topic or project at the mean z of its dated sessions, counting each session once, with `{id}` link ends handled; a topic with no dated session is absent.
- AC-13-04: `islandCenters` spreads n communities on a circle of radius 200 in order, one community at the origin, none -> empty.
- AC-13-05: `layerZ` / `LAYER_Z` return -200 for project, 0 for session, 200 for topic.
- AC-13-06: `nodeSize` uses turns for sessions (log scale, capped at 15) and rank otherwise, always within 3..15, and 3 when all ranks are 0.
- AC-13-07: `recency` is 1 for the latest date, 0.25 at 180 days or more, linear between, 0.5 when a date is missing or invalid.
- AC-13-08: `brightnessMap` covers every node, topics take their newest session's brightness, undated and unlinked nodes get 0.5.
- AC-13-09: `bridgeIds` returns exactly the bridge node ids; an empty analysis gives an empty set.

## External systems to mock
- None (pure functions).

## Dependencies on earlier phases
- Phase 10: `Analysis`, `analyzeGraph`. Phase 07: `graph.ts` types.
