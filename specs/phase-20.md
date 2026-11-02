# Phase 20: 3D neuron look - cells, branches, axons

## Intent
Use the neuron maths in the 3D view: each theme gets a bigger glowing cell body, its other nodes
branch around it, and links between themes are long curves, with a tick box to switch the look off.

## Complexity
M - rendering and force changes that interact with filters, selection, layers and the time-lapse, checked in the browser.

## Scope
- In scope: `explorer/src/main.ts`, `explorer/index.html`, using `cellBodies`, `branchOffsets`, `axonCurve`, `CELL_SCALE` from `scene3d.ts`.
- Out of scope: `scene3d.ts` behaviour, 2D drawing, new packages, pulse animation.

## Interface contract
App shell, not unit-tested. Checked by `npm run build`, `npx tsc --noEmit`, the existing tests and a browser run.

| Item | Location | Shape | Errors |
|---|---|---|---|
| Neuron tick box | `index.html` | `<input type="checkbox" id="neuron-look" checked />` with the text "Neuron look", next to the "Layers" tick box (id `layers-mode`) | - |
| Neuron state | `main.ts` | a boolean read from `#neuron-look`; changing it re-applies the 3D forces and styles and reheats the layout | - |

## Behaviour
- With the box ticked (default), in 3D only:
  - Cell bodies (from `cellBodies`) are drawn `CELL_SCALE` times larger than their normal size and their halo is always shown; the selected-state glow caps from `glowLevels` still apply (no brighter than before).
  - The x/y island force pulls each branch node toward its island centre plus its `branchOffsets` spot; cell bodies and nodes without a spot go to the island centre as today. Depth (time or layers) is unchanged.
  - Links get `linkCurvature` and `linkCurveRotation` from `axonCurve`; links inside a theme stay straight.
- With the box unticked, nodes, forces and links are exactly as before this phase.
- Toggling rebuilds the node objects and forces and reheats the layout; the 2D map is not touched.
- Selection, path, time-lapse, layers, orbit and hover keep working with the look on.

## Acceptance criteria
- AC-20-01: `npm run build` and `npx tsc --noEmit` pass and the existing tests still pass.
- AC-20-02: In the browser, with the look on, each theme shows one larger cell with its other nodes in rings around it, and links between themes are curved.
- AC-20-03: Unticking "Neuron look" gives the previous picture (no curved links, no bigger cells).
- AC-20-04: Selecting a node, running the path tool and layers mode still work with the look on, and the picture is not brighter than before.

## External systems to mock
- None; visual check in the browser preview.

## Dependencies on earlier phases
- Phase 19 (neuron maths). Phases 15-18 (3D look, wiring, glow).
