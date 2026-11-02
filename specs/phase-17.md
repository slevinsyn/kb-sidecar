# Phase 17: Glow levels - capped, pure, selection never brighter

## Intent
One small pure function decides how much a node lights itself, how opaque it is and how strong its
ring is, so the 3D view can no longer blow out: the self-light has a low cap and selecting a node
does not raise it.

## Complexity
S - one small function with clamping and three states.

## Scope
- In scope: add to `explorer/src/scene3d.ts` (pure, unit-tested).
- Out of scope: rendering, DOM, `three`, bloom settings (phase 18).

## Interface contract
Tests import from `../src/scene3d`. No DOM, no `three`.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `MAX_EMISSIVE` | `explorer/src/scene3d.ts` | `export const MAX_EMISSIVE = 0.25` | - |
| `NodeState` | same | `export type NodeState = 'normal' \| 'selected' \| 'dim'` | - |
| `GlowLevels` | same | `export interface GlowLevels { emissive: number; opacity: number; ring: number }` | - |
| `glowLevels` | same | `export function glowLevels(brightness: number, state: NodeState): GlowLevels` | - |

## Behaviour
1. `b` = `brightness` clamped to 0..1; `NaN` -> 0.5.
2. `normal`: `emissive = 0.05 + 0.2 * b` (so 0.05 to `MAX_EMISSIVE`), `opacity = 0.4 + 0.6 * b`, `ring = 0.45 + 0.4 * b`.
3. `selected`: `emissive` equals the `normal` value for the same `b` (never higher), `opacity = 1`, `ring = 1`.
4. `dim`: `emissive = 0`, `opacity = 0.3`, `ring = 0.2`, whatever `b` is.
5. Results never exceed `MAX_EMISSIVE` for `emissive`, and never exceed 1 for `opacity` and `ring`.

## Acceptance criteria
- AC-17-01: `glowLevels(1, 'normal').emissive` is `MAX_EMISSIVE` (0.25) and `glowLevels(0, 'normal').emissive` is 0.05; opacity is 1 and 0.4; ring is 0.85 and 0.45.
- AC-17-02: a more recent node (brightness 1) has higher emissive than an old one (0.25) in `normal`, by at least 0.03.
- AC-17-03: `selected` emissive equals `normal` emissive for the same brightness (0, 0.25, 0.5, 1) and `selected` opacity and ring are 1.
- AC-17-04: `dim` gives emissive 0, opacity 0.3, ring 0.2 for any brightness.
- AC-17-05: brightness below 0 or above 1 behaves like 0 or 1; `NaN` behaves like 0.5; emissive never exceeds `MAX_EMISSIVE` in any state.

## External systems to mock
- None (pure function).

## Dependencies on earlier phases
- Phase 13 (same module `scene3d.ts`).
