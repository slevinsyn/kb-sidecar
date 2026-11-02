# Phase 18: 3D glare fix - gentler glow, soft selection, readable hover name

## Intent
Use the capped glow levels in the 3D view, make the bloom gentler, stop the selection from piling
white links and particles into the glow, and give the hover name a dark panel so it can be read.

## Complexity
M - rendering constants and a styled tooltip that interact with selection, paths and orbit, checked in the browser.

## Scope
- In scope: `explorer/src/main.ts`, `explorer/index.html`, using `glowLevels` from `scene3d.ts`.
- Out of scope: `scene3d.ts` behaviour, 2D drawing, new controls or packages.

## Interface contract
App shell, not unit-tested. Checked by `npm run build`, `npx tsc --noEmit`, the existing tests and a browser run.

| Item | Location | Shape | Errors |
|---|---|---|---|
| Bloom constants | `main.ts` | `BLOOM_STRENGTH = 0.35`, `BLOOM_RADIUS = 0.4`, `BLOOM_THRESHOLD = 0.6` | - |
| Selected particles | `main.ts` | `SELECTED_PARTICLES = 2`, `PARTICLE_WIDTH = 1.2` | - |
| Hover panel | `index.html` | CSS for `.scene-tooltip` (the library's tooltip class): dark background, light text, 12-13px, padding, radius | - |

## Behaviour
- `styleNode` takes emissive, opacity and ring from `glowLevels(brightness, state)`, with state `selected` for the selected node, `dim` when `isDimmed`, otherwise `normal`. The selected node is no longer lit more than others.
- Links touching the selected node use a soft white `rgba(255, 255, 255, 0.55)` instead of `#ffffff`.
- Path highlight colour and widths stay as they are.
- The 3D hover label (`nodeLabel`) shows the escaped name and, on a second line, the type (for example "topic"); it stays escaped. 2D hover is unchanged.
- The tooltip panel is readable on top of the scene: dark semi-opaque background, light text, no wrapping of short names, `pointer-events: none`.

## Acceptance criteria
- AC-18-01: `npm run build` and `npx tsc --noEmit` pass and the existing unit tests still pass.
- AC-18-02: In the browser the 3D view at rest is clearly less bright than before and colours are still distinguishable.
- AC-18-03: Selecting a node does not make the picture brighter overall; the node is marked by a white ring and its links by soft white lines with 2 thin particles.
- AC-18-04: The hover name shows on a dark panel, in light text, with the node type, and a label containing `<b>` is shown as plain text.

## External systems to mock
- None; visual check in the browser preview.

## Dependencies on earlier phases
- Phase 17 (`glowLevels`). Phases 15-16 (3D look and wiring).
