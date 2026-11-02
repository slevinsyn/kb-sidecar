import ForceGraph3D from '3d-force-graph';
import {
  GraphError,
  NODE_TYPES,
  TYPE_COLORS,
  filterByTypes,
  linkEnd,
  neighbors,
  nodeDetails,
  parseGraph,
  searchNodes,
} from './graph';
import type { GraphData, GraphLink, GraphNode, NodeType } from './graph';

const DIM_COLOR = '#2b3040';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

// 3d-force-graph renders label accessors as HTML; labels are untrusted conversation text.
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const container = el<HTMLDivElement>('graph');
const searchBox = el<HTMLInputElement>('search');
const resultsList = el<HTMLUListElement>('results');
const filtersBox = el<HTMLDivElement>('filters');
const detailsBox = el<HTMLDivElement>('details');
const errorBox = el<HTMLDivElement>('error');
const errorText = el<HTMLParagraphElement>('error-text');
const filePicker = el<HTMLInputElement>('file');

let full: GraphData = { nodes: [], links: [] };
let visible: GraphData = full;
let selectedId: string | null = null;
let highlighted = new Set<string>();
const activeTypes = new Set<NodeType>(NODE_TYPES);

const graph = new ForceGraph3D(container)
  .backgroundColor('#0b0e14')
  .nodeId('id')
  .nodeLabel((n) => escapeHtml((n as GraphNode).label))
  // The default link label reads link.name as HTML; links carry no label text, so show none.
  .linkLabel(() => '')
  .nodeVal((n) => (n as GraphNode).size)
  .nodeColor((n) => {
    const node = n as GraphNode;
    if (selectedId !== null && !highlighted.has(node.id)) return DIM_COLOR;
    return TYPE_COLORS[node.type];
  })
  .linkColor((l) => {
    if (selectedId === null) return '#5a6378';
    const link = l as GraphLink;
    const touches = linkEnd(link.source) === selectedId || linkEnd(link.target) === selectedId;
    return touches ? '#ffffff' : DIM_COLOR;
  })
  .linkWidth((l) => {
    const link = l as GraphLink;
    return selectedId !== null &&
      (linkEnd(link.source) === selectedId || linkEnd(link.target) === selectedId)
      ? 2
      : 0.5;
  })
  .onNodeClick((n) => select((n as GraphNode).id, false));

function refreshColors(): void {
  graph.nodeColor(graph.nodeColor()).linkColor(graph.linkColor()).linkWidth(graph.linkWidth());
}

function showError(message: string): void {
  errorText.textContent = message;
  errorBox.hidden = false;
}

function setGraph(data: GraphData): void {
  full = data;
  errorBox.hidden = true;
  selectedId = null;
  highlighted = new Set();
  detailsBox.hidden = true;
  applyFilters();
  renderResults();
}

function applyFilters(): void {
  visible = filterByTypes(full, activeTypes);
  if (selectedId !== null && !visible.nodes.some((n) => n.id === selectedId)) {
    selectedId = null;
    highlighted = new Set();
    detailsBox.hidden = true;
  }
  // 3d-force-graph mutates the data it is given, so hand it copies.
  graph.graphData({
    nodes: visible.nodes.map((n) => ({ ...n })),
    links: visible.links.map((l) => ({ ...l })),
  });
  if (selectedId !== null) select(selectedId, false);
}

function flyTo(id: string): void {
  const node = (graph.graphData().nodes as Array<GraphNode & { x?: number; y?: number; z?: number }>)
    .find((n) => n.id === id);
  if (!node || node.x === undefined || node.y === undefined || node.z === undefined) return;
  const distance = 120;
  const ratio = 1 + distance / (Math.hypot(node.x, node.y, node.z) || 1);
  graph.cameraPosition(
    { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
    { x: node.x, y: node.y, z: node.z },
    1000,
  );
}

function select(id: string, fly: boolean): void {
  const details = nodeDetails(visible, id);
  if (!details) return;
  selectedId = id;
  highlighted = new Set([id, ...neighbors(visible, id).nodes.map((n) => n.id)]);
  renderDetails(details.node, details.neighborsByType);
  refreshColors();
  if (fly) flyTo(id);
}

function renderDetails(node: GraphNode, byType: Record<NodeType, GraphNode[]>): void {
  detailsBox.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = node.label;
  const type = document.createElement('div');
  type.textContent = `Type: ${node.type}`;
  const meta = document.createElement('pre');
  meta.textContent = JSON.stringify(node.meta, null, 2);
  detailsBox.append(title, type, meta);
  for (const t of NODE_TYPES) {
    const group = byType[t];
    if (group.length === 0) continue;
    const heading = document.createElement('h3');
    heading.textContent = `${t} (${group.length})`;
    const list = document.createElement('ul');
    for (const n of group) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.textContent = n.label;
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
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = TYPE_COLORS[n.type];
    item.append(swatch, document.createTextNode(n.label));
    item.addEventListener('click', () => select(n.id, true));
    resultsList.append(item);
  }
}

function buildFilters(): void {
  for (const t of NODE_TYPES) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      if (box.checked) activeTypes.add(t);
      else activeTypes.delete(t);
      applyFilters();
      renderResults();
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = TYPE_COLORS[t];
    label.append(box, swatch, document.createTextNode(t));
    filtersBox.append(label);
  }
}

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
searchBox.addEventListener('input', renderResults);
filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  if (!file) return;
  const read = file.text();
  filePicker.value = '';
  read.then(load, (e) => showError(`Could not read file: ${String(e)}`));
});
window.addEventListener('resize', () => graph.width(window.innerWidth).height(window.innerHeight));

void loadFromServer();
