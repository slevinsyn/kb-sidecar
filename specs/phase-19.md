# Phase 19: Neuron maths - cell per theme, branch spots, axon curves

## Intent
Pure functions that decide which node is the cell body of each theme, where the other nodes of a
theme sit around it, and how links between themes curve, so the 3D view can look like neurons.

## Complexity
M - small pure maths with ties, empty inputs and determinism to get right.

## Scope
- In scope: add to `explorer/src/scene3d.ts` (pure, unit-tested).
- Out of scope: rendering, DOM, `three`, forces (phase 20).

## Interface contract
Tests import from `../src/scene3d`. No DOM, no `three`. `Analysis`, `GraphLink` are the existing types (`communities[].id/topics`, `rank: Map<string, number>`, `communityOf: Map<string, number>`); link ends are read with the existing `linkEnd`.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `CELL_SCALE` | `scene3d.ts` | `export const CELL_SCALE = 2.2` | - |
| `AXON_CURVATURE` | same | `export const AXON_CURVATURE = 0.3` | - |
| `BRANCH_BASE_RADIUS` | same | `export const BRANCH_BASE_RADIUS = 60` | - |
| `BRANCH_RADIUS_STEP` | same | `export const BRANCH_RADIUS_STEP = 4` | - |
| `cellBodies` | same | `export function cellBodies(a: Analysis): Map<number, string>` (community id -> cell node id) | - |
| `branchOffset` | same | `export function branchOffset(index: number, count: number): { x: number; y: number }` | - |
| `branchOffsets` | same | `export function branchOffsets(a: Analysis, nodeIds: readonly string[]): Map<string, { x: number; y: number }>` | - |
| `axonCurve` | same | `export function axonCurve(link: GraphLink, a: Analysis): { curvature: number; rotation: number }` | - |

## Behaviour
1. `cellBodies`: for each community in `a.communities` with at least one entry in `topics`, the topic with the highest `a.rank` value (missing rank = 0); ties go to the smaller id (plain `<` string order). Communities with no topics are absent from the map.
2. `branchOffset(i, n)`: position of branch `i` of `n` around a cell, in x/y. Ring `r = floor(i / 12)`, slot `s = i % 12`; radius = `BRANCH_BASE_RADIUS + BRANCH_RADIUS_STEP * r`; angle = `2 * PI * s / 12 + r * PI / 12` (each outer ring is turned half a slot). Result `{ x: radius * cos(angle), y: radius * sin(angle) }`. If `i` or `n` is not a finite integer, `i < 0` or `i >= n`, the result is `{ x: BRANCH_BASE_RADIUS, y: 0 }`.
3. `branchOffsets(a, ids)`: for every id in `ids` that has a community in `a.communityOf` and is not that community's cell body, a spot `branchOffset(k, count)`, where the qualifying ids of one community are sorted by id (plain `<` order) and `k` is the position in that sorted list and `count` its length. Cell bodies, ids with no community and ids repeated in `ids` (counted once) behave as stated; no entry for cell bodies or ids without a community. The same call gives the same result; no two entries of one community are equal.
4. `axonCurve(link, a)`: if both ends have a community in `a.communityOf` and the communities differ: `{ curvature: AXON_CURVATURE, rotation }`, where `rotation` is in `[0, 2*PI)` and comes from a deterministic hash of `source + '>' + target` (same link -> same rotation). Otherwise (same community, or an end without a community) `{ curvature: 0, rotation: 0 }`.

## Acceptance criteria
- AC-19-01: `cellBodies` picks the highest-ranked topic of each community and, on equal rank, the smaller id; a community with no topics has no entry; an empty analysis gives an empty map.
- AC-19-02: `branchOffset(0, 5)` is `{ x: 60, y: 0 }`; `branchOffset(3, 20)` is at radius 60 and angle PI/2; `branchOffset(12, 20)` is at radius 64 and angle PI/12.
- AC-19-03: `branchOffset` with `i` negative, `i >= n`, a fraction, `NaN` or `Infinity` gives `{ x: 60, y: 0 }`.
- AC-19-04: `branchOffsets` skips the cell body, ids with no community and unknown ids; gives every other node of a community its spot by sorted id order; the spots of one community are all different; two calls give equal results.
- AC-19-05: `axonCurve` gives curvature 0.3 and a rotation in `[0, 2*PI)` for a link between two themes, the same rotation for the same link twice, and `{ curvature: 0, rotation: 0 }` for a link inside one theme or with an end that has no theme; link ends given as objects `{ id }` work like strings.

## External systems to mock
- None (pure functions).

## Dependencies on earlier phases
- Phase 13 (same module `scene3d.ts`), phase 10 (`Analysis`).
