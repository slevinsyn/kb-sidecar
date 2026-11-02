import ForceGraph from 'force-graph';
import ForceGraph3D from '3d-force-graph';
import type { ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import {
  GraphError,
  NODE_TYPES,
  linkEnd,
  neighbors,
  nodeDetails,
  parseGraph,
  searchNodes,
} from './graph';
import type { GraphData, GraphLink, GraphNode, NodeType } from './graph';
import { analyzeGraph } from './analysis';
import type { Analysis } from './analysis';
import { buildInsights, insightsMarkdown } from './insights';
import type { Insights } from './insights';
import {
  DEFAULT_VIEW_TYPES,
  UNASSIGNED_COLOR,
  clusterLabels,
  communityColor,
  monthRange,
  viewGraph,
} from './view';
import {
  bridgeIds,
  brightnessMap,
  clusterBounds,
  defaultLinkFilter,
  glowLevels,
  islandCenters,
  layerZ,
  linkRgba,
  nextMonth,
  nodeSize,
  orbitPosition,
  shortestPath,
  timeAxis,
} from './scene3d';
import type { NodeState, Point3 } from './scene3d';

const DIM_COLOR = '#2b3040';
const TOP_LABEL_COUNT = 30;
const LABEL_ZOOM = 1.6;
/** Both canvases start to the right of the left-hand panels (matches #graph2d/#graph3d in index.html). */
const LEFT_PANEL_PX = 324;
const graphWidth = (): number => Math.max(200, window.innerWidth - LEFT_PANEL_PX);
const MONTH_KEY = /^\d{4}-\d{2}$/;
const BACKGROUND = '#0b0e14';

// 3D look.
/** World units per unit of nodeSize (nodeSize is 3..15). */
const NODE_SCALE = 0.6;
const FALLBACK_NODE_SIZE = 3;
/** Alpha of a link that does not touch the selected node while something is selected. */
const DIM_LINK_ALPHA = 0.04;
const SELECTED_PARTICLES = 2;
const PARTICLE_WIDTH = 1.2;
/** Links touching the selected node: a soft white that does not pile into the bloom. */
const SELECTED_LINK_COLOR = 'rgba(255, 255, 255, 0.55)';
const AUTO_ROTATE_SPEED = 0.5;
const IDLE_RESUME_MS = 5000;
const BLOOM_STRENGTH = 0.35;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.6;
/** Fog starts a little in front of the graph centre and ends well behind it. */
const FOG_NEAR_FACTOR = 0.25;
const FOG_FAR_FACTOR = 1.5;
const DEFAULT_SCENE_RADIUS = 300;
// 3D wiring: forces, theme labels, time-lapse, camera orbit, path.
const TIME_STRENGTH = 0.4;
const ISLAND_STRENGTH = 0.15;
/** World height of a floating theme name, and its gap above the anchor node. */
const LABEL_WORLD_HEIGHT = 14;
const LABEL_GAP = 4;
const LABEL_FONT_PX = 48;
const LABEL_PAD_PX = 10;
const LABEL_MAX_CHARS = 48;
const TIMELAPSE_STEP_MS = 900;
const ORBIT_FLY_MS = 1000;
/** The camera orbits this many cluster radii away from the cluster centre, so the cluster fits. */
const ORBIT_DISTANCE = 2.6;
/** Radians per millisecond: one full turn in about 70 seconds. */
const ORBIT_SPEED = (2 * Math.PI) / 70_000;
const PATH_COLOR = '#ffd166';
const NO_PATH_TEXT = 'No path between these topics';
const LEGEND_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['●', 'sphere = session'],
  ['■', 'cube = project'],
  ['◆', 'octahedron = topic'],
  ['○', 'ring = bridge'],
];
const LEGEND_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['in_project', 'in project'],
  ['has_topic', 'has topic'],
  ['touched_file', 'touched file'],
  ['used_tool', 'used tool'],
];

type Mode = '2d' | '3d';
type Tab = 'summary' | 'themes' | 'bridges' | 'loose' | 'roadmap' | 'timeline';
type RenderNode = GraphNode & { x?: number; y?: number; z?: number };
/** A node as the d3 simulation sees it: position plus velocity. */
type SimNode = RenderNode & { vx?: number; vy?: number; vz?: number };

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

// Both graph libraries render label accessors as HTML; labels are untrusted conversation text.
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Builds an element whose text is set with textContent, so it can never be parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== '') node.textContent = text;
  if (className !== '') node.className = className;
  return node;
}

const container2d = el<HTMLDivElement>('graph2d');
const container3d = el<HTMLDivElement>('graph3d');
const searchBox = el<HTMLInputElement>('search');
const resultsList = el<HTMLUListElement>('results');
const filtersBox = el<HTMLDivElement>('filters');
const fromSelect = el<HTMLSelectElement>('from-month');
const toSelect = el<HTMLSelectElement>('to-month');
const statsBox = el<HTMLDivElement>('stats');
const modeButton = el<HTMLButtonElement>('mode-toggle');
const detailsBox = el<HTMLDivElement>('details');
const errorBox = el<HTMLDivElement>('error');
const errorText = el<HTMLParagraphElement>('error-text');
const filePicker = el<HTMLInputElement>('file');
const insightsBox = el<HTMLDivElement>('insights');
const tabsBox = el<HTMLDivElement>('tabs');
const tabBody = el<HTMLDivElement>('tab-body');
const copyButton = el<HTMLButtonElement>('copy-md');
const downloadButton = el<HTMLButtonElement>('download-md');
const exportStatus = el<HTMLSpanElement>('export-status');
const legendBox = el<HTMLDivElement>('legend');
const controls3dBox = el<HTMLDivElement>('controls3d');
const layersBox = el<HTMLInputElement>('layers-mode');
const timelapseButton = el<HTMLButtonElement>('timelapse');
const pathFromSelect = el<HTMLSelectElement>('path-from');
const pathToSelect = el<HTMLSelectElement>('path-to');
const pathButton = el<HTMLButtonElement>('path-go');
const pathResult = el<HTMLDivElement>('path-result');

let full: GraphData = { nodes: [], links: [] };
let visible: GraphData = full;
let analysis: Analysis | null = null;
let insights: Insights | null = null;
let markdown = '';
let mode: Mode = '2d';
let tab: Tab = 'summary';
let selectedId: string | null = null;
let highlighted = new Set<string>();
let topRanked = new Set<string>();
let anchors = new Map<number, string>();
let fromMonth = '';
let toMonth = '';
const activeTypes = new Set<NodeType>(DEFAULT_VIEW_TYPES);
let brightness = new Map<string, number>();
let bridges = new Set<string>();
/** 3D node sizes, computed once per loaded graph. */
let sizes = new Map<string, number>();
/** Theme name per anchor node id, for the floating 3D labels. */
let anchorLabels = new Map<string, { community: number; label: string }>();
/** Members of the cluster the 3D camera is focused on; everything else is faded. */
let clusterIds: Set<string> | null = null;
/** Nodes and links (keyed by linkKey) on the found path; everything else is dimmed. */
let pathNodes: Set<string> | null = null;
let pathLinks: Set<string> | null = null;

function colorOf(n: GraphNode): string {
  return communityColor(analysis?.communityOf.get(n.id));
}

function isDimmed(n: GraphNode): boolean {
  if (pathNodes !== null) return !pathNodes.has(n.id);
  if (clusterIds !== null) return !clusterIds.has(n.id);
  return selectedId !== null && !highlighted.has(n.id);
}

/** Direction-free key of a link, so a path step matches the link whichever way it points. */
function linkKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function onPath(l: GraphLink): boolean {
  return pathLinks !== null && pathLinks.has(linkKey(linkEnd(l.source), linkEnd(l.target)));
}

function inCluster(l: GraphLink): boolean {
  return clusterIds !== null && clusterIds.has(linkEnd(l.source)) && clusterIds.has(linkEnd(l.target));
}

function touchesSelected(l: GraphLink): boolean {
  return selectedId !== null && (linkEnd(l.source) === selectedId || linkEnd(l.target) === selectedId);
}

function linkColorOf(l: GraphLink): string {
  if (selectedId === null) return '#4a5266';
  return touchesSelected(l) ? '#ffffff' : DIM_COLOR;
}

function linkWidthOf(l: GraphLink): number {
  return touchesSelected(l) ? 2 : 0.5;
}

function radiusOf(n: GraphNode): number {
  return Math.min(14, 2 + Math.sqrt(n.size) * 1.5);
}

function shapePath(ctx: CanvasRenderingContext2D, n: RenderNode, r: number): void {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  ctx.beginPath();
  if (n.type === 'project') {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  } else if (n.type === 'topic') {
    ctx.moveTo(x, y - r * 1.2);
    ctx.lineTo(x + r * 1.2, y);
    ctx.lineTo(x, y + r * 1.2);
    ctx.lineTo(x - r * 1.2, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
}

// ---------- 2D view ----------

let graph2d: ForceGraph | null = null;
let fitPending = false;
let graph3d: ReturnType<typeof makeGraph3d> | null = null;

function makeGraph2d(): ForceGraph {
  const g = new ForceGraph(container2d)
    .backgroundColor(BACKGROUND)
    .nodeId('id')
    .width(graphWidth())
    .height(window.innerHeight)
    .nodeLabel((n) => escapeHtml((n as GraphNode).label))
    // The default link label reads link.name as HTML; links carry no label text, so show none.
    .linkLabel(() => '')
    .linkColor((l) => linkColorOf(l as GraphLink))
    .linkWidth((l) => linkWidthOf(l as GraphLink))
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject((obj, ctx, scale) => {
      const n = obj as RenderNode;
      const r = radiusOf(n);
      shapePath(ctx, n, r);
      ctx.fillStyle = isDimmed(n) ? DIM_COLOR : colorOf(n);
      ctx.fill();
      if (n.id === selectedId) {
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      const showName = n.id === selectedId || (scale >= LABEL_ZOOM && topRanked.has(n.id));
      if (showName && !isDimmed(n)) {
        const size = 11 / scale;
        ctx.font = `${size}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#e6e6e6';
        ctx.fillText(n.label, n.x ?? 0, (n.y ?? 0) + r + 2 / scale);
      }
    })
    .nodePointerAreaPaint((obj, color, ctx) => {
      const n = obj as RenderNode;
      shapePath(ctx, n, radiusOf(n) + 1);
      ctx.fillStyle = color;
      ctx.fill();
    })
    .onRenderFramePost((ctx, scale) => drawThemeLabels(ctx, scale))
    .cooldownTicks(250)
    .onEngineStop(() => {
      if (!fitPending) return;
      fitPending = false;
      graph2d?.zoomToFit(400, 80);
    })
    .onNodeClick((n) => select((n as GraphNode).id, false));
  return g;
}

function drawThemeLabels(ctx: CanvasRenderingContext2D, scale: number): void {
  if (!graph2d || anchors.size === 0 || !analysis) return;
  const byId = new Map<string, RenderNode>();
  for (const n of graph2d.graphData().nodes as RenderNode[]) byId.set(n.id, n);
  const labels = clusterLabels(analysis);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const size = Math.max(12 / scale, 3);
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 4;
  for (const label of labels) {
    const anchorId = anchors.get(label.community);
    const n = anchorId === undefined ? undefined : byId.get(anchorId);
    if (!n || n.x === undefined || n.y === undefined) continue;
    const y = n.y - radiusOf(n) - 3 / scale;
    ctx.strokeStyle = 'rgba(11, 14, 20, 0.9)';
    ctx.strokeText(label.label, n.x, y);
    ctx.fillStyle = communityColor(label.community);
    ctx.fillText(label.label, n.x, y);
  }
  ctx.restore();
}

// ---------- 3D view ----------

// One unit-sized geometry per shape; each node scales its own group.
const SPHERE = new THREE.SphereGeometry(1, 16, 12);
const CUBE = new THREE.BoxGeometry(1.6, 1.6, 1.6);
const OCTAHEDRON = new THREE.OctahedronGeometry(1.35);
const RING = new THREE.TorusGeometry(1.75, 0.08, 8, 40);

/** The materials of one rendered node, so selection changes can restyle it in place. */
interface NodeLook {
  node: GraphNode;
  body: THREE.MeshLambertMaterial;
  ring: THREE.MeshBasicMaterial;
  /** The halo mesh: shown for bridge nodes and for the selected node only. */
  halo: THREE.Mesh;
  /** The floating theme name, on theme anchor nodes only. */
  label: THREE.SpriteMaterial | null;
}

const nodeLooks = new Map<string, NodeLook>();

function geometryFor(type: NodeType): THREE.BufferGeometry {
  if (type === 'project') return CUBE;
  if (type === 'topic') return OCTAHEDRON;
  return SPHERE;
}

function styleNode(look: NodeLook): void {
  const dim = isDimmed(look.node);
  const color = dim ? DIM_COLOR : colorOf(look.node);
  const b = brightness.get(look.node.id) ?? 0.5;
  const state: NodeState = look.node.id === selectedId ? 'selected' : dim ? 'dim' : 'normal';
  const glow = glowLevels(b, state);
  look.body.color.set(color);
  look.body.emissive.set(color);
  look.body.emissiveIntensity = glow.emissive;
  look.body.opacity = glow.opacity;
  look.ring.color.set(dim ? DIM_COLOR : '#ffffff');
  look.ring.opacity = glow.ring;
  look.halo.visible = bridges.has(look.node.id) || look.node.id === selectedId;
  if (look.label) look.label.opacity = dim ? 0.25 : 1;
}

function nodeObject3d(obj: object): THREE.Object3D {
  const node = obj as GraphNode;
  const group = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ transparent: true });
  group.add(new THREE.Mesh(geometryFor(node.type), body));
  // Every node owns a halo so the selected node can show its white ring; styleNode hides it
  // unless the node is a bridge or the selected node.
  const ring = new THREE.MeshBasicMaterial({ transparent: true });
  const halo = new THREE.Mesh(RING, ring);
  // three.js raycasting ignores .visible: only let a shown halo be hovered or clicked.
  const pickHalo = THREE.Mesh.prototype.raycast;
  halo.raycast = (raycaster, hits) => {
    if (halo.visible) pickHalo.call(halo, raycaster, hits);
  };
  // Keep the halo facing the camera (the parent group is never rotated).
  halo.onBeforeRender = (_renderer, _scene, camera) => {
    halo.quaternion.copy(camera.quaternion);
  };
  group.add(halo);
  const scale = (sizes.get(node.id) ?? FALLBACK_NODE_SIZE) * NODE_SCALE;
  group.scale.setScalar(scale);
  let label: THREE.SpriteMaterial | null = null;
  const theme = anchorLabels.get(node.id);
  if (theme) {
    const sprite = themeSprite(theme.community, theme.label, scale);
    if (sprite) {
      group.add(sprite);
      label = sprite.material;
    }
  }
  const look: NodeLook = { node, body, ring, halo, label };
  styleNode(look);
  nodeLooks.set(node.id, look);
  return group;
}

function linkColor3d(l: GraphLink): string {
  if (pathLinks !== null) return onPath(l) ? PATH_COLOR : linkRgba(l.type, DIM_LINK_ALPHA);
  if (selectedId === null && clusterIds === null) return linkRgba(l.type);
  if (touchesSelected(l)) return SELECTED_LINK_COLOR;
  return inCluster(l) ? linkRgba(l.type) : linkRgba(l.type, DIM_LINK_ALPHA);
}

function linkWidth3d(l: GraphLink): number {
  if (pathLinks !== null) return onPath(l) ? 2.5 : 0.5;
  return linkWidthOf(l);
}

function linkParticles(l: GraphLink): number {
  if (pathLinks !== null) return onPath(l) ? SELECTED_PARTICLES : 0;
  return touchesSelected(l) ? SELECTED_PARTICLES : 0;
}

// ---------- 3D theme labels ----------

/**
 * Draws a theme name onto its own canvas texture. Each node object owns its texture: the graph
 * library disposes a node's materials and maps when the node object is removed.
 */
function labelTexture(community: number, raw: string): { texture: THREE.CanvasTexture; aspect: number } | null {
  const text = raw.length > LABEL_MAX_CHARS ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…` : raw;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const font = `600 ${LABEL_FONT_PX}px system-ui, sans-serif`;
  ctx.font = font;
  canvas.width = Math.max(1, Math.ceil(ctx.measureText(text).width) + 2 * LABEL_PAD_PX);
  canvas.height = LABEL_FONT_PX + 2 * LABEL_PAD_PX;
  // Resizing a canvas resets its state, so set the font again. fillText draws plain text: the
  // theme name is never parsed as HTML.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LABEL_FONT_PX / 6;
  ctx.strokeStyle = 'rgba(11, 14, 20, 0.9)';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = communityColor(community);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

/** A camera-facing theme name floating above its anchor node; a child of the node's group. */
function themeSprite(community: number, label: string, groupScale: number): THREE.Sprite | null {
  const made = labelTexture(community, label);
  if (!made) return null;
  const material = new THREE.SpriteMaterial({
    map: made.texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  // The parent group is scaled by the node size; undo that so every name has the same size.
  const s = groupScale > 0 ? groupScale : 1;
  sprite.center.set(0.5, 0);
  sprite.scale.set((LABEL_WORLD_HEIGHT * made.aspect) / s, LABEL_WORLD_HEIGHT / s, 1);
  sprite.position.set(0, 1.4 + LABEL_GAP / s, 0);
  sprite.renderOrder = 10;
  return sprite;
}

/** File and tool links are shown in 3D only when one of those node types is ticked. */
function showNoiseLinks(): boolean {
  return activeTypes.has('file') || activeTypes.has('tool');
}

// ---------- 3D forces: islands on x/y, time or layers on z ----------

type Axis = 'x' | 'y' | 'z';
const VELOCITY: Readonly<Record<Axis, 'vx' | 'vy' | 'vz'>> = { x: 'vx', y: 'vy', z: 'vz' };

/**
 * Pulls every node along one axis toward its own target, like d3's forceX/forceZ:
 * v += (target - position) * strength * alpha. Targets are worked out once per initialize.
 */
function axisForce(axis: Axis, target: (n: SimNode) => number, strength: number) {
  let nodes: SimNode[] = [];
  let targets: number[] = [];
  const v = VELOCITY[axis];
  const force = (alpha: number): void => {
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      const pos = n[axis] ?? 0;
      n[v] = (n[v] ?? 0) + (targets[i] - pos) * strength * alpha;
    }
  };
  force.initialize = (all: object[]): void => {
    nodes = all as SimNode[];
    targets = nodes.map((n) => {
      const t = target(n);
      return Number.isFinite(t) ? t : 0;
    });
  };
  return force;
}

/** Islands: each theme is pulled toward its own point on a ring; unassigned nodes to the origin. */
function installForces(g: Graph3D): void {
  const centers = analysis ? islandCenters(analysis) : new Map<number, { x: number; y: number }>();
  const centerOf = (n: SimNode): { x: number; y: number } | undefined => {
    const c = analysis?.communityOf.get(n.id);
    return c === undefined ? undefined : centers.get(c);
  };
  g.d3Force('x', axisForce('x', (n) => centerOf(n)?.x ?? 0, ISLAND_STRENGTH));
  g.d3Force('y', axisForce('y', (n) => centerOf(n)?.y ?? 0, ISLAND_STRENGTH));
  installDepthForce(g);
}

/** Depth is time (session date order) or, in layers mode, the node type's level. */
function installDepthForce(g: Graph3D): void {
  if (layersBox.checked) {
    g.d3Force('z', axisForce('z', (n) => layerZ(n.type), TIME_STRENGTH));
    return;
  }
  const z = timeAxis(visible);
  g.d3Force('z', axisForce('z', (n) => z.get(n.id) ?? 0, TIME_STRENGTH));
}

// ---------- 3D camera: fit, auto-rotate, fog ----------

type Graph3D = ForceGraph3DInstance;

/** The parts of OrbitControls this app uses; other control types lack autoRotate. */
interface RotatingControls {
  autoRotate: boolean;
  autoRotateSpeed: number;
  target?: THREE.Vector3;
  addEventListener(type: string, listener: () => void): void;
}

let fit3dPending = true;
let rebuild3d = false;
let dragging = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const sceneCenter = new THREE.Vector3();
let sceneRadius = DEFAULT_SCENE_RADIUS;

function rotatingControls(): RotatingControls | null {
  const c = graph3d?.controls() as Partial<RotatingControls> | undefined;
  if (!c || typeof c.autoRotate !== 'boolean' || typeof c.addEventListener !== 'function') return null;
  return c as RotatingControls;
}

function pauseRotation(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const c = rotatingControls();
  if (c) c.autoRotate = false;
}

/** Stops rotating now and starts again after IDLE_RESUME_MS without dragging or selecting. */
function resumeRotationWhenIdle(): void {
  pauseRotation();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // A cluster orbit drives the camera itself; auto-rotate stays off until it ends.
    if (dragging || orbiting) return;
    const c = rotatingControls();
    if (c) c.autoRotate = true;
  }, IDLE_RESUME_MS);
}

function measureScene(g: Graph3D): void {
  const box = g.getGraphBbox();
  if (!box) return;
  sceneCenter.set((box.x[0] + box.x[1]) / 2, (box.y[0] + box.y[1]) / 2, (box.z[0] + box.z[1]) / 2);
  const half = Math.hypot(box.x[1] - box.x[0], box.y[1] - box.y[0], box.z[1] - box.z[0]) / 2;
  sceneRadius = Number.isFinite(half) && half > 1 ? half : DEFAULT_SCENE_RADIUS;
}

function updateFog(g: Graph3D): void {
  const fog = g.scene().fog;
  if (!(fog instanceof THREE.Fog)) return;
  const d = g.camera().position.distanceTo(sceneCenter);
  fog.near = Math.max(1, d - FOG_NEAR_FACTOR * sceneRadius);
  fog.far = Math.max(fog.near + 1, d + FOG_FAR_FACTOR * sceneRadius);
}

/** Adds a soft glow. Any failure leaves the plain renderer in place. */
async function addBloom(g: Graph3D): Promise<void> {
  try {
    const [{ UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
      import('three/examples/jsm/postprocessing/OutputPass.js'),
    ]);
    const composer = g.postProcessingComposer();
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(graphWidth(), window.innerHeight),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    // Bloom becomes the last pass, so colour-space output has to be done by an OutputPass.
    const output = new OutputPass();
    composer.addPass(bloom);
    composer.addPass(output);
    // Size the new passes' render targets for the current pixel ratio (HiDPI).
    composer.setSize(graphWidth(), window.innerHeight);
    try {
      composer.render();
    } catch (e) {
      composer.removePass(output);
      composer.removePass(bloom);
      throw e;
    }
  } catch (e) {
    console.warn('Bloom is unavailable; the 3D view renders without glow.', e);
  }
}

function setUpScene3d(g: Graph3D): void {
  g.scene().fog = new THREE.Fog(BACKGROUND, 1, 2000);
  updateFog(g);
  const c = g.controls() as Partial<RotatingControls>;
  if (typeof c.autoRotate === 'boolean' && typeof c.addEventListener === 'function') {
    c.autoRotate = true;
    c.autoRotateSpeed = AUTO_ROTATE_SPEED;
    c.addEventListener('start', () => {
      dragging = true;
      // The user takes the camera: stop circling, but keep the cluster faded.
      stopOrbit();
      pauseRotation();
    });
    c.addEventListener('end', () => {
      dragging = false;
      resumeRotationWhenIdle();
    });
    c.addEventListener('change', () => updateFog(g));
  }
  void addBloom(g);
}

function makeGraph3d(): Graph3D {
  // Orbit controls are the ones that support autoRotate.
  const g = new ForceGraph3D(container3d, { controlType: 'orbit' })
    .backgroundColor(BACKGROUND)
    .nodeId('id')
    .width(graphWidth())
    .height(window.innerHeight)
    .nodeLabel((n) => `${escapeHtml((n as GraphNode).label)}<br>${escapeHtml((n as GraphNode).type)}`)
    .linkLabel(() => '')
    .nodeThreeObject(nodeObject3d)
    // linkRgba carries the opacity; keep the library from scaling it down further.
    .linkOpacity(1)
    .linkColor((l) => linkColor3d(l as GraphLink))
    .linkWidth((l) => linkWidth3d(l as GraphLink))
    .linkDirectionalParticles((l) => linkParticles(l as GraphLink))
    .linkDirectionalParticleWidth(PARTICLE_WIDTH)
    .cooldownTicks(250)
    .onEngineStop(() => {
      measureScene(g);
      if (fit3dPending) {
        fit3dPending = false;
        g.zoomToFit(800, 60);
      }
      updateFog(g);
    })
    .onNodeDrag(() => pauseRotation())
    .onNodeDragEnd(() => resumeRotationWhenIdle())
    .onNodeClick((n) => select((n as GraphNode).id, false))
    .onBackgroundClick(() => clearSelection());
  setUpScene3d(g);
  return g;
}

function buildLegend(): void {
  legendBox.replaceChildren();
  legendBox.append(h('div', 'Shapes', 'legend-title'));
  for (const [glyph, text] of LEGEND_SHAPES) {
    const row = h('div', '', 'legend-row');
    row.append(h('span', glyph, 'legend-glyph'), document.createTextNode(text));
    legendBox.append(row);
  }
  legendBox.append(h('div', 'Links', 'legend-title'));
  for (const [type, text] of LEGEND_LINKS) {
    const row = h('div', '', 'legend-row');
    const line = h('span', '', 'legend-line');
    line.style.background = linkRgba(type, 1);
    row.append(line, document.createTextNode(text));
    legendBox.append(row);
  }
}

// ---------- data and filters ----------

function activeGraph(): ForceGraph | ReturnType<typeof makeGraph3d> {
  if (mode === '2d') {
    graph2d ??= makeGraph2d();
    return graph2d;
  }
  graph3d ??= makeGraph3d();
  return graph3d;
}

function refreshColors(): void {
  if (mode === '2d') {
    // nodeCanvasObject reads the selection on every frame; only the link styles need a nudge.
    graph2d?.linkColor(graph2d.linkColor()).linkWidth(graph2d.linkWidth());
  } else {
    // Node materials are restyled in place; link accessors are set again to re-read the selection.
    for (const look of nodeLooks.values()) styleNode(look);
    graph3d
      ?.linkColor(graph3d.linkColor())
      .linkWidth(graph3d.linkWidth())
      .linkDirectionalParticles(graph3d.linkDirectionalParticles());
  }
}

function showError(message: string): void {
  errorText.textContent = message;
  errorBox.hidden = false;
}

function monthKeys(): string[] {
  // Timeline months come from the first 7 characters of started_at; keep only YYYY-MM keys.
  return analysis ? monthRange(analysis).filter((m) => MONTH_KEY.test(m)) : [];
}

function fillMonthSelect(select: HTMLSelectElement, blank: string, months: string[], value: string): void {
  select.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = blank;
  select.append(first);
  for (const m of months) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    select.append(o);
  }
  select.value = months.includes(value) ? value : '';
}

function buildMonthSelects(): void {
  const months = monthKeys();
  fillMonthSelect(fromSelect, 'Start', months, fromMonth);
  fillMonthSelect(toSelect, 'End', months, toMonth);
  fromMonth = fromSelect.value;
  toMonth = toSelect.value;
  const none = months.length === 0;
  fromSelect.disabled = none;
  toSelect.disabled = none;
}

function setGraph(data: GraphData): void {
  stopTimelapse();
  endFocus();
  clearPath();
  full = data;
  errorBox.hidden = true;
  selectedId = null;
  highlighted = new Set();
  detailsBox.hidden = true;
  // Analysis and insights are computed once per loaded graph, in the browser only.
  analysis = analyzeGraph(full);
  brightness = brightnessMap(full, analysis);
  bridges = bridgeIds(analysis);
  const a = analysis;
  sizes = new Map(full.nodes.map((n) => [n.id, nodeSize(n, a)]));
  // A new graph gets new sizes, rings and a fresh camera fit.
  fit3dPending = true;
  rebuild3d = true;
  insights = buildInsights(full, analysis);
  markdown = insightsMarkdown(insights);
  fromMonth = '';
  toMonth = '';
  buildMonthSelects();
  exportStatus.textContent = '';
  renderTabs();
  applyFilters();
  renderResults();
}

function bestVisibleSession(community: number): string | null {
  if (!analysis) return null;
  let best: string | null = null;
  let bestRank = -Infinity;
  for (const n of visible.nodes) {
    if (n.type !== 'session' || analysis.communityOf.get(n.id) !== community) continue;
    const r = analysis.rank.get(n.id) ?? 0;
    if (best === null || r > bestRank || (r === bestRank && n.id < best)) {
      best = n.id;
      bestRank = r;
    }
  }
  return best;
}

function computeViewState(): void {
  const rank = analysis?.rank ?? new Map<string, number>();
  topRanked = new Set(
    [...visible.nodes]
      .sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1))
      .slice(0, TOP_LABEL_COUNT)
      .map((n) => n.id),
  );
  anchors = new Map();
  anchorLabels = new Map();
  if (!analysis) return;
  const inView = new Set(visible.nodes.map((n) => n.id));
  for (const label of clusterLabels(analysis)) {
    const anchor = inView.has(label.nodeId) ? label.nodeId : bestVisibleSession(label.community);
    if (anchor === null) continue;
    anchors.set(label.community, anchor);
    // One floating name per node: the first theme to claim an anchor keeps it.
    if (!anchorLabels.has(anchor)) anchorLabels.set(anchor, { community: label.community, label: label.label });
  }
}

function applyFilters(): void {
  visible = viewGraph(full, { types: activeTypes, fromMonth, toMonth });
  // A filter change ends the cluster focus and any shown path.
  endFocus();
  clearPath();
  if (selectedId !== null && !visible.nodes.some((n) => n.id === selectedId)) {
    selectedId = null;
    highlighted = new Set();
    detailsBox.hidden = true;
  }
  computeViewState();
  fillPathSelects();
  const sessions = visible.nodes.filter((n) => n.type === 'session').length;
  statsBox.textContent =
    visible.nodes.length === 0
      ? 'Nothing to show for this selection.'
      : `${visible.nodes.length} nodes, ${visible.links.length} links, ${sessions} sessions`;
  fitPending = true;
  // Both libraries mutate the data they are given, so hand them copies.
  if (mode === '2d') {
    activeGraph().graphData({
      nodes: visible.nodes.map((n) => ({ ...n })),
      links: visible.links.map((l) => ({ ...l })),
    });
  } else {
    // 3D hides file/tool links unless one of those node types is ticked.
    const shown = defaultLinkFilter(visible, showNoiseLinks());
    const g = activeGraph() as Graph3D;
    // The nodes below are fresh copies, so the library builds a new object for every node
    // (nodeObject3d records its look again). Old looks belong to discarded objects.
    nodeLooks.clear();
    // Within one graph, nodes keep their place across filter steps (the time-lapse grows
    // smoothly); a new graph starts from scratch.
    const previous = new Map<string, SimNode>();
    if (rebuild3d) {
      // A new graph: set the accessor again so nothing built for the old graph is kept.
      rebuild3d = false;
      g.nodeThreeObject(nodeObject3d);
    } else {
      for (const n of g.graphData().nodes as SimNode[]) previous.set(n.id, n);
    }
    const nodes: SimNode[] = shown.nodes.map((n) => {
      const copy: SimNode = { ...n };
      const old = previous.get(n.id);
      if (old) {
        copy.x = old.x;
        copy.y = old.y;
        copy.z = old.z;
        copy.vx = old.vx;
        copy.vy = old.vy;
        copy.vz = old.vz;
      }
      return copy;
    });
    installForces(g);
    g.graphData({ nodes, links: shown.links.map((l) => ({ ...l })) });
  }
  if (selectedId !== null) select(selectedId, false);
}

function flyTo(id: string): void {
  if (mode === '2d') {
    const node = (graph2d?.graphData().nodes as RenderNode[] | undefined)?.find((n) => n.id === id);
    if (!graph2d || !node || node.x === undefined || node.y === undefined) return;
    graph2d.centerAt(node.x, node.y, 700);
    if (graph2d.zoom() < 2) graph2d.zoom(2, 700);
    return;
  }
  const node = (graph3d?.graphData().nodes as RenderNode[] | undefined)?.find((n) => n.id === id);
  if (!graph3d || !node || node.x === undefined || node.y === undefined || node.z === undefined) return;
  const distance = 120;
  const ratio = 1 + distance / (Math.hypot(node.x, node.y, node.z) || 1);
  graph3d.cameraPosition(
    { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
    { x: node.x, y: node.y, z: node.z },
    1000,
  );
}

function select(id: string, fly: boolean): void {
  const details = nodeDetails(visible, id);
  if (!details) return;
  if (id !== selectedId) {
    // A new selection stops the cluster orbit and drops the shown path.
    endFocus();
    clearPath();
  }
  selectedId = id;
  highlighted = new Set([id, ...neighbors(visible, id).nodes.map((n) => n.id)]);
  renderDetails(details.node, details.neighborsByType);
  refreshColors();
  // Selecting stops the 3D turn; it starts again after a quiet spell (never during an orbit).
  if (mode === '3d') resumeRotationWhenIdle();
  if (fly) flyTo(id);
}

/** Clicking the empty background clears the selection, the cluster focus and the path. */
function clearSelection(): void {
  endFocus();
  clearPath();
  selectedId = null;
  highlighted = new Set();
  detailsBox.hidden = true;
  refreshColors();
  if (mode === '3d') resumeRotationWhenIdle();
}

// ---------- 3D cluster orbit ----------

let orbitFrame: number | null = null;
let orbitFlyTimer: ReturnType<typeof setTimeout> | null = null;
/** True from the start of the fly-in until the orbit is stopped; auto-rotate stays off. */
let orbiting = false;

function stopOrbit(): void {
  if (orbitFrame !== null) cancelAnimationFrame(orbitFrame);
  if (orbitFlyTimer !== null) clearTimeout(orbitFlyTimer);
  orbitFrame = null;
  orbitFlyTimer = null;
  orbiting = false;
}

/** Ends a cluster focus: stops the orbit and un-fades the rest of the graph. */
function endFocus(): void {
  const wasFocused = orbiting || clusterIds !== null;
  stopOrbit();
  clusterIds = null;
  if (wasFocused) {
    refreshColors();
    if (mode === '3d' && graph3d) resumeRotationWhenIdle();
  }
}

/**
 * Flies the camera to a point on a circle around the cluster's members, then circles slowly
 * around them until the selection changes or is cleared. Auto-rotate is off meanwhile.
 */
function orbitCluster(ids: ReadonlySet<string>): void {
  stopOrbit();
  const g = graph3d;
  if (!g || mode !== '3d') return;
  const points: Point3[] = [];
  for (const n of g.graphData().nodes as SimNode[]) {
    if (!ids.has(n.id)) continue;
    if (Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)) {
      points.push({ x: n.x as number, y: n.y as number, z: n.z as number });
    }
  }
  if (points.length === 0) return;
  const { center, radius } = clusterBounds(points);
  const distance = radius * ORBIT_DISTANCE;
  const cam = g.camera().position;
  let angle = Math.atan2(cam.x - center.x, cam.z - center.z);
  pauseRotation();
  orbiting = true;
  g.cameraPosition(orbitPosition(center, distance, angle), center, ORBIT_FLY_MS);
  orbitFlyTimer = setTimeout(() => {
    orbitFlyTimer = null;
    let last = performance.now();
    const step = (now: number): void => {
      if (!orbiting || mode !== '3d') return;
      angle += Math.max(0, now - last) * ORBIT_SPEED;
      last = now;
      g.cameraPosition(orbitPosition(center, distance, angle), center, 0);
      updateFog(g);
      orbitFrame = requestAnimationFrame(step);
    };
    orbitFrame = requestAnimationFrame(step);
  }, ORBIT_FLY_MS);
}

// ---------- 3D path picker ----------

function clearPath(): void {
  const had = pathNodes !== null || pathLinks !== null;
  pathNodes = null;
  pathLinks = null;
  pathResult.textContent = '';
  if (had) refreshColors();
}

function fillTopicSelect(select: HTMLSelectElement, topics: GraphNode[]): void {
  const previous = select.value;
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Topic';
  select.append(blank);
  for (const t of topics) {
    const o = document.createElement('option');
    o.value = t.id;
    // textContent: topic names are untrusted text.
    o.textContent = t.label;
    select.append(o);
  }
  select.value = topics.some((t) => t.id === previous) ? previous : '';
}

/** Both path selects list the visible topics, by name. */
function fillPathSelects(): void {
  const topics = visible.nodes
    .filter((n) => n.type === 'topic')
    .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fillTopicSelect(pathFromSelect, topics);
  fillTopicSelect(pathToSelect, topics);
  const none = topics.length === 0;
  pathFromSelect.disabled = none;
  pathToSelect.disabled = none;
  pathButton.disabled = none;
}

/** Highlights the shortest chain between the two picked topics, or says there is none. */
function findPath(): void {
  const from = pathFromSelect.value;
  const to = pathToSelect.value;
  endFocus();
  clearPath();
  if (from === '' || to === '') {
    pathResult.textContent = 'Pick two topics.';
    return;
  }
  const path = shortestPath(visible, from, to);
  if (path === null) {
    pathResult.textContent = NO_PATH_TEXT;
    return;
  }
  pathNodes = new Set(path);
  pathLinks = new Set();
  for (let i = 1; i < path.length; i += 1) pathLinks.add(linkKey(path[i - 1], path[i]));
  const labelOf = new Map(visible.nodes.map((n) => [n.id, n.label]));
  // textContent: the chain of untrusted labels is never parsed as HTML.
  pathResult.textContent = path.map((id) => labelOf.get(id) ?? id).join(' → ');
  refreshColors();
}

/** In 3D, fades everything outside `ids` and orbits the camera around them. */
function focusCluster(ids: Set<string>): void {
  clusterIds = ids;
  refreshColors();
  orbitCluster(ids);
}

function swatch(color: string): HTMLSpanElement {
  const s = h('span', '', 'swatch');
  s.style.background = color;
  return s;
}

function renderDetails(node: GraphNode, byType: Record<NodeType, GraphNode[]>): void {
  detailsBox.replaceChildren();
  const title = h('h2', node.label);
  const type = h('div', `Type: ${node.type}`);
  const meta = h('pre', JSON.stringify(node.meta, null, 2));
  detailsBox.append(title, type, meta);
  for (const t of NODE_TYPES) {
    const group = byType[t];
    if (group.length === 0) continue;
    const heading = h('h3', `${t} (${group.length})`);
    const list = document.createElement('ul');
    for (const n of group) {
      const item = document.createElement('li');
      const link = h('a', n.label);
      link.addEventListener('click', () => select(n.id, true));
      item.append(link);
      list.append(item);
    }
    detailsBox.append(heading, list);
  }
  detailsBox.hidden = false;
}

function renderResults(): void {
  resultsList.replaceChildren();
  for (const n of searchNodes(visible, searchBox.value)) {
    const item = document.createElement('li');
    item.append(swatch(colorOf(n)), document.createTextNode(n.label));
    item.addEventListener('click', () => select(n.id, true));
    resultsList.append(item);
  }
}

function buildFilters(): void {
  for (const t of NODE_TYPES) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = activeTypes.has(t);
    box.addEventListener('change', () => {
      if (box.checked) activeTypes.add(t);
      else activeTypes.delete(t);
      applyFilters();
      renderResults();
    });
    const shape =
      t === 'project' ? ' (square)' : t === 'topic' ? ' (diamond)' : t === 'session' ? ' (circle)' : '';
    label.append(box, document.createTextNode(`${t}${shape}`));
    filtersBox.append(label);
  }
}

// ---------- insights panel ----------

const TABS: Array<{ id: Tab; title: string }> = [
  { id: 'summary', title: 'Summary' },
  { id: 'themes', title: 'Themes' },
  { id: 'bridges', title: 'Bridges' },
  { id: 'loose', title: 'Loose ends' },
  { id: 'roadmap', title: 'Roadmap' },
  { id: 'timeline', title: 'Timeline' },
];

function focusCommunity(community: number): void {
  const anchor = anchors.get(community) ?? bestVisibleSession(community);
  if (anchor === null) return;
  if (mode !== '3d') {
    select(anchor, true);
    return;
  }
  // select() ends any earlier focus, so the new cluster is set after it. The orbit does the flying.
  select(anchor, false);
  if (selectedId !== anchor) return;
  const a = analysis;
  const members = new Set(visible.nodes.filter((n) => a?.communityOf.get(n.id) === community).map((n) => n.id));
  members.add(anchor);
  focusCluster(members);
}

function focusNode(id: string): void {
  if (mode !== '3d') {
    select(id, true);
    return;
  }
  select(id, false);
  if (selectedId !== id) return;
  // A bridge's cluster is the node and its visible neighbours (highlighted by select).
  focusCluster(new Set(highlighted));
}

function emptyNote(text: string): HTMLParagraphElement {
  return h('p', text, 'muted');
}

function renderTabBody(): void {
  tabBody.replaceChildren();
  if (!insights || !analysis) {
    tabBody.append(emptyNote('Load a graph to see insights.'));
    return;
  }
  const a = analysis;
  const ins = insights;
  if (tab === 'summary') {
    tabBody.append(h('p', ins.headline, 'headline'));
    const list = document.createElement('ul');
    for (const line of ins.summary) list.append(h('li', line));
    tabBody.append(list);
  } else if (tab === 'themes') {
    if (ins.themes.length === 0) tabBody.append(emptyNote('No themes found.'));
    ins.themes.forEach((t, i) => {
      const community = a.communities[i];
      const row = h('div', '', 'row clickable');
      const color = community ? communityColor(community.id) : UNASSIGNED_COLOR;
      row.append(swatch(color), h('strong', t.label));
      row.append(h('div', `${t.sessions} sessions, ${t.share}%, last ${t.lastAt?.slice(0, 10) ?? '-'}`, 'muted'));
      if (community) row.addEventListener('click', () => focusCommunity(community.id));
      tabBody.append(row);
    });
  } else if (tab === 'bridges') {
    if (a.bridges.length === 0) tabBody.append(emptyNote('No bridges found.'));
    for (const b of a.bridges.slice(0, 10)) {
      const row = h('div', b.label, 'row clickable');
      row.append(h('div', `${b.type}, joins ${b.communities.length} themes`, 'muted'));
      row.addEventListener('click', () => focusNode(b.id));
      tabBody.append(row);
    }
  } else if (tab === 'loose') {
    if (ins.looseEnds.length === 0) tabBody.append(emptyNote('No loose ends.'));
    ins.looseEnds.forEach((line, i) => {
      const community = a.looseEnds[i];
      const row = h('div', line, community ? 'row clickable' : 'row');
      if (community) row.addEventListener('click', () => focusCommunity(community.id));
      tabBody.append(row);
    });
    if (ins.oneOffCount > 0) {
      tabBody.append(emptyNote(`${ins.oneOffCount} one-off topics were only mentioned once.`));
    }
  } else if (tab === 'roadmap') {
    if (ins.roadmap.length === 0) tabBody.append(emptyNote('No roadmap suggestions.'));
    ins.roadmap.forEach((m, i) => {
      const row = h('div', `${i + 1}. ${m.title}`, 'row clickable');
      row.append(h('div', m.detail, 'muted'));
      row.addEventListener('click', () => focusCommunity(m.community));
      tabBody.append(row);
    });
  } else {
    if (a.timeline.length === 0) tabBody.append(emptyNote('No dated sessions.'));
    const peak = Math.max(1, ...a.timeline.map((b) => b.sessions));
    for (const b of a.timeline) {
      const row = h('div', '', 'row');
      const bar = h('div', '', 'bar');
      bar.style.width = `${Math.max(2, Math.round((b.sessions / peak) * 100))}%`;
      row.append(h('span', `${b.month}  ${b.sessions}`, 'month'), bar);
      if (b.topTopics.length > 0) row.append(h('div', b.topTopics.join(', '), 'muted'));
      tabBody.append(row);
    }
  }
}

function renderTabs(): void {
  tabsBox.replaceChildren();
  for (const t of TABS) {
    const b = h('button', t.title, t.id === tab ? 'tab active' : 'tab');
    b.type = 'button';
    b.addEventListener('click', () => {
      tab = t.id;
      renderTabs();
    });
    tabsBox.append(b);
  }
  renderTabBody();
}

async function copyMarkdown(): Promise<void> {
  if (markdown === '') return;
  try {
    await navigator.clipboard.writeText(markdown);
    exportStatus.textContent = 'Copied.';
  } catch {
    const area = document.createElement('textarea');
    area.value = markdown;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    exportStatus.textContent = ok ? 'Copied.' : 'Copy failed. Use Download instead.';
  }
}

function downloadMarkdown(): void {
  if (markdown === '') return;
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'insights.md';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  exportStatus.textContent = 'Downloaded insights.md.';
}

// ---------- time-lapse ----------

let lapseTimer: ReturnType<typeof setInterval> | null = null;

function setMonths(from: string, to: string): void {
  fromMonth = from;
  toMonth = to;
  fromSelect.value = from;
  toSelect.value = to;
  applyFilters();
  renderResults();
}

/** Stops the time-lapse and leaves the month filter where it is. */
function stopTimelapse(): void {
  if (lapseTimer !== null) clearInterval(lapseTimer);
  lapseTimer = null;
  timelapseButton.textContent = 'Time-lapse';
}

/** Shows the first month, then widens the "to" month one step every TIMELAPSE_STEP_MS. */
function startTimelapse(): void {
  stopTimelapse();
  const months = monthKeys();
  const first = nextMonth(months, null);
  if (first === null) return;
  timelapseButton.textContent = 'Stop';
  setMonths(first, first);
  lapseTimer = setInterval(() => {
    const next = nextMonth(months, toMonth);
    if (next === null) {
      // The last month is shown: the full range stays.
      stopTimelapse();
      return;
    }
    setMonths(first, next);
  }, TIMELAPSE_STEP_MS);
}

// ---------- 2D / 3D toggle ----------

function setMode(next: Mode): void {
  mode = next;
  container2d.hidden = mode !== '2d';
  container3d.hidden = mode !== '3d';
  legendBox.hidden = mode !== '3d';
  controls3dBox.hidden = mode !== '3d';
  if (mode === '2d') {
    stopTimelapse();
    endFocus();
    clearPath();
  }
  modeButton.textContent = mode === '2d' ? '3D' : '2D';
  modeButton.title = mode === '2d' ? 'Switch to the 3D view' : 'Switch back to the 2D map';
  if (mode === '2d') graph3d?.pauseAnimation();
  else graph2d?.pauseAnimation();
  applyFilters();
  activeGraph().resumeAnimation();
}

// ---------- loading ----------

function load(text: string): void {
  try {
    setGraph(parseGraph(text));
  } catch (e) {
    showError(e instanceof GraphError ? e.message : `Could not load graph: ${String(e)}`);
  }
}

async function loadFromServer(): Promise<void> {
  try {
    const res = await fetch('/graph.json');
    if (!res.ok) {
      showError(`Could not fetch /graph.json (HTTP ${res.status}). Pick a graph.json file instead.`);
      return;
    }
    load(await res.text());
  } catch (e) {
    showError(`Could not fetch /graph.json: ${String(e)}. Pick a graph.json file instead.`);
  }
}

buildFilters();
buildMonthSelects();
renderTabs();
modeButton.addEventListener('click', () => setMode(mode === '2d' ? '3d' : '2d'));
fromSelect.addEventListener('change', () => {
  // A hand-picked month takes over from a running time-lapse.
  stopTimelapse();
  fromMonth = fromSelect.value;
  applyFilters();
  renderResults();
});
toSelect.addEventListener('change', () => {
  stopTimelapse();
  toMonth = toSelect.value;
  applyFilters();
  renderResults();
});
layersBox.addEventListener('change', () => {
  if (mode !== '3d' || !graph3d) return;
  installDepthForce(graph3d);
  graph3d.d3ReheatSimulation();
});
timelapseButton.addEventListener('click', () => {
  if (lapseTimer !== null) stopTimelapse();
  else startTimelapse();
});
pathFromSelect.addEventListener('change', () => clearPath());
pathToSelect.addEventListener('change', () => clearPath());
pathButton.addEventListener('click', findPath);
copyButton.addEventListener('click', () => void copyMarkdown());
downloadButton.addEventListener('click', downloadMarkdown);
searchBox.addEventListener('input', renderResults);
filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  if (!file) return;
  const read = file.text();
  filePicker.value = '';
  read.then(load, (e) => showError(`Could not read file: ${String(e)}`));
});
window.addEventListener('resize', () => {
  graph2d?.width(graphWidth()).height(window.innerHeight);
  graph3d?.width(graphWidth()).height(window.innerHeight);
});

buildLegend();
legendBox.hidden = true;
container3d.hidden = true;
graph2d = makeGraph2d();
void loadFromServer();
