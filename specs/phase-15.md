# Phase 15: 3D look - shapes, fog, bloom, particles, legend, fit, auto-rotate, width

## Intent
Make the 3D view readable and match 2D: a shape per node type, depth fog and a soft glow, faint
coloured links without file and tool clutter, particles on the selected node's links, a legend,
a camera that fits after loading and drifts slowly when idle, and a view that starts right of the panels.

## Complexity
L - several rendering features on `three` and `3d-force-graph` that interact, checked only by build and in the browser.

## Scope
- In scope: `explorer/src/main.ts`, `explorer/index.html`, `explorer/package.json` (add `three` at `^0.179.0`, the lowest version `3d-force-graph` accepts; keep `package-lock.json` in step), using the helpers in `scene3d.ts`.
- Out of scope: time/island forces, layers, time-lapse, path, orbit (phase 16); changing `scene3d.ts` behaviour.

## Interface contract
App shell, not unit-tested. Checked by `npm run build`, `npx tsc --noEmit` and the existing tests.

| Item | Location | Shape | Errors |
|---|---|---|---|
| `three` dependency | `explorer/package.json` | `"three": "^0.179.0"` under dependencies | - |
| Legend | `explorer/index.html` + `main.ts` | `<div id="legend">` bottom-left of the graph area: sphere = session, cube = project, octahedron = topic, plus link colours from `linkRgba` | - |

## Behaviour
- Node shapes in 3D (`nodeThreeObject`): `SphereGeometry` for sessions, `BoxGeometry` for
  projects, `OctahedronGeometry` for topics (files/tools sphere). Colour from the theme colour
  (`communityColor`) or the dim colour when not highlighted; scale from `nodeSize`; opacity/emissive
  intensity from `brightnessMap`; bridge nodes (`bridgeIds`) get a ring (torus) halo.
- Fog: `scene().fog = new THREE.Fog(BACKGROUND, near, far)` tuned so the far side is clearly dimmer.
- Bloom: `UnrealBloomPass` (from `three/examples/jsm/postprocessing/UnrealBloomPass.js`) added
  through `postProcessingComposer()`, modest strength; the app must still render if it is unavailable.
- Links: `linkColor` uses `linkRgba(type)` (about 15% opacity), white when touching the selected node, dim otherwise; the graph data passed to the 3D view goes through `defaultLinkFilter` (file/tool links hidden unless the file/tool type boxes are ticked).
- Particles: `linkDirectionalParticles` = 4 for links touching the selected node, 0 otherwise, with width 2.
- Camera: after the first data load call `zoomToFit` once the layout has settled; `controls().autoRotate = true` at a slow speed, switched off while the user is dragging or a node is selected, back on after about 5 seconds idle.
- Width: the 3D container is placed at `left: 324px` and sized `window.innerWidth - 324` (also in the resize handler), matching 2D.
- Legend visible only in 3D mode; labels escaped as elsewhere.
- Existing 2D, panels, search, details, filters unchanged.

## Acceptance criteria
- AC-15-01: `npm run build` succeeds with `three` listed in `explorer/package.json` dependencies.
- AC-15-02: `npx tsc --noEmit` passes and the existing unit tests still pass.
- AC-15-03: In the browser the 3D view shows spheres, cubes and octahedrons, fog, glow and a legend, with the view starting right of the left panel.
- AC-15-04: Selecting a node shows particles flowing on its links and the camera stops auto-rotating; it resumes after idle.
- AC-15-05: File and tool links are hidden by default and appear when those types are ticked.

## External systems to mock
- None; visual check in the browser preview.

## Dependencies on earlier phases
- Phase 13 and 14 (`nodeSize`, `brightnessMap`, `bridgeIds`, `defaultLinkFilter`, `linkRgba`). Phase 12 app shell.
