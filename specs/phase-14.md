# Phase 14: 3D graph logic - link filter and colours, shortest path, time-lapse, orbit maths

## Intent
Pure helpers behind the clutter-free links, the "how did X lead to Y?" path, the month-by-month
time-lapse and the camera orbit around a theme.

## Complexity
M - a BFS with deterministic ties plus small formulas.

## Scope
- In scope: add to `explorer/src/scene3d.ts` (pure, unit-tested).
- Out of scope: rendering, DOM, timers, `three`.

## Interface contract
Tests import from `../src/scene3d` and may use `parseGraph`. No DOM, no `three`.
Link types in graph.json: `in_project`, `has_topic`, `touched_file`, `used_tool`.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `NOISE_LINK_TYPES` | `explorer/src/scene3d.ts` | `export const NOISE_LINK_TYPES: readonly string[] = ['used_tool', 'touched_file']` | - |
| `defaultLinkFilter` | same | `export function defaultLinkFilter(g: GraphData, showNoise?: boolean): GraphData` | - |
| `LINK_OPACITY` | same | `export const LINK_OPACITY = 0.15` | - |
| `linkRgba` | same | `export function linkRgba(type: string, alpha?: number): string` | - |
| `shortestPath` | same | `export function shortestPath(g: GraphData, from: string, to: string): string[] \| null` | - |
| `nextMonth` | same | `export function nextMonth(months: readonly string[], current: string \| null): string \| null` | - |
| `Point3` | same | `export interface Point3 { x: number; y: number; z: number }` | - |
| `clusterBounds` | same | `export function clusterBounds(points: readonly Point3[]): { center: Point3; radius: number }` | - |
| `orbitPosition` | same | `export function orbitPosition(center: Point3, radius: number, angle: number): Point3` | - |

## Behaviour
1. `defaultLinkFilter(g, showNoise = false)`: returns a new graph with the same nodes; unless
   `showNoise`, links whose `type` is in `NOISE_LINK_TYPES` are removed. Endpoints returned as
   strings; input not mutated; link order kept.
2. `linkRgba(type, alpha = LINK_OPACITY)`: `rgba(r, g, b, alpha)` with a fixed colour per type:
   `in_project` 247,201,107 · `has_topic` 122,162,247 · `touched_file` 158,206,106 ·
   `used_tool` 187,154,247; any other type 138,143,152. `alpha` printed as given (`0.15`).
3. `shortestPath(g, from, to)`: breadth-first over undirected links whose two ends are both
   session or topic nodes (project, file, tool nodes and their links are ignored). Returns the node
   ids from `from` to `to` inclusive. `from === to` and the node exists -> `[from]`. Either id
   missing from `g.nodes` -> `null`. Unreachable -> `null`. Neighbours are visited in ascending
   id order so ties give the same path every time.
4. `nextMonth(months, current)`: `current === null` -> `months[0]` (or `null` if empty);
   `current` found -> the following month, `null` at the last one; `current` not found -> `null`.
5. `clusterBounds(points)`: empty -> `{center: {0,0,0}, radius: 120}`. Otherwise `center` is the
   mean point and `radius = max(80, farthest distance from center + 40)`.
6. `orbitPosition(center, radius, angle)`: `{x: cx + radius*sin(angle), y: cy, z: cz + radius*cos(angle)}`.

## Acceptance criteria
- AC-14-01: `defaultLinkFilter` drops `used_tool` and `touched_file` links by default, keeps all nodes, and keeps them with `showNoise = true`.
- AC-14-02: `defaultLinkFilter` returns string endpoints, keeps order, and does not mutate the input (`{id}` ends accepted).
- AC-14-03: `linkRgba` returns the fixed colour per link type with alpha 0.15 by default, the fallback grey for unknown types, and honours an explicit alpha.
- AC-14-04: `shortestPath` returns the shortest topic-session-topic chain between two topics, inclusive of both ends.
- AC-14-05: `shortestPath` returns `[id]` for identical nodes, `null` for a missing id or an unreachable pair, and never routes through project, file or tool nodes.
- AC-14-06: `shortestPath` gives the same path on every call when two shortest paths exist (lowest ids first).
- AC-14-07: `nextMonth` steps from null to the first month, month to month, to null after the last, null for an unknown month or empty list.
- AC-14-08: `clusterBounds` gives the mean centre and a radius of at least 80 (farthest distance plus 40), and the default for no points.
- AC-14-09: `orbitPosition` keeps y, sits `radius` away from the centre on the x-z plane, and angle 0 is straight along +z.

## External systems to mock
- None (pure functions).

## Dependencies on earlier phases
- Phase 13 (same module `scene3d.ts`). Phase 07: `graph.ts`.
