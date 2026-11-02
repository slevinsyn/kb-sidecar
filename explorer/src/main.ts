import ForceGraph from 'force-graph';
import ForceGraph3D from '3d-force-graph';
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

const DIM_COLOR = '#2b3040';
const TOP_LABEL_COUNT = 30;
const LABEL_ZOOM = 1.6;
/** The 2D canvas starts to the right of the left-hand panels (matches #graph2d in index.html). */
const LEFT_PANEL_PX = 324;
const width2d = (): number => Math.max(200, window.innerWidth - LEFT_PANEL_PX);
const MONTH_KEY = /^\d{4}-\d{2}$/;
const BACKGROUND = '#0b0e14';

type Mode = '2d' | '3d';
type Tab = 'summary' | 'themes' | 'bridges' | 'loose' | 'roadmap' | 'timeline';
type RenderNode = GraphNode & { x?: number; y?: number; z?: number };

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

function colorOf(n: GraphNode): string {
  return communityColor(analysis?.communityOf.get(n.id));
}

function isDimmed(n: GraphNode): boolean {
  return selectedId !== null && !highlighted.has(n.id);
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
    .width(width2d())
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

function makeGraph3d() {
  return new ForceGraph3D(container3d)
    .backgroundColor(BACKGROUND)
    .nodeId('id')
    .width(window.innerWidth)
    .height(window.innerHeight)
    .nodeLabel((n) => escapeHtml((n as GraphNode).label))
    .linkLabel(() => '')
    .nodeVal((n) => (n as GraphNode).size)
    .nodeColor((n) => {
      const node = n as GraphNode;
      return isDimmed(node) ? DIM_COLOR : colorOf(node);
    })
    .linkColor((l) => linkColorOf(l as GraphLink))
    .linkWidth((l) => linkWidthOf(l as GraphLink))
    .onNodeClick((n) => select((n as GraphNode).id, false));
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
    graph3d
      ?.nodeColor(graph3d.nodeColor())
      .linkColor(graph3d.linkColor())
      .linkWidth(graph3d.linkWidth());
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
  full = data;
  errorBox.hidden = true;
  selectedId = null;
  highlighted = new Set();
  detailsBox.hidden = true;
  // Analysis and insights are computed once per loaded graph, in the browser only.
  analysis = analyzeGraph(full);
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
  if (!analysis) return;
  const inView = new Set(visible.nodes.map((n) => n.id));
  for (const label of clusterLabels(analysis)) {
    const anchor = inView.has(label.nodeId) ? label.nodeId : bestVisibleSession(label.community);
    if (anchor !== null) anchors.set(label.community, anchor);
  }
}

function applyFilters(): void {
  visible = viewGraph(full, { types: activeTypes, fromMonth, toMonth });
  if (selectedId !== null && !visible.nodes.some((n) => n.id === selectedId)) {
    selectedId = null;
    highlighted = new Set();
    detailsBox.hidden = true;
  }
  computeViewState();
  const sessions = visible.nodes.filter((n) => n.type === 'session').length;
  statsBox.textContent =
    visible.nodes.length === 0
      ? 'Nothing to show for this selection.'
      : `${visible.nodes.length} nodes, ${visible.links.length} links, ${sessions} sessions`;
  fitPending = true;
  // Both libraries mutate the data they are given, so hand them copies.
  activeGraph().graphData({
    nodes: visible.nodes.map((n) => ({ ...n })),
    links: visible.links.map((l) => ({ ...l })),
  });
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
  selectedId = id;
  highlighted = new Set([id, ...neighbors(visible, id).nodes.map((n) => n.id)]);
  renderDetails(details.node, details.neighborsByType);
  refreshColors();
  if (fly) flyTo(id);
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
  if (anchor !== null) select(anchor, true);
}

function focusNode(id: string): void {
  select(id, true);
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

// ---------- 2D / 3D toggle ----------

function setMode(next: Mode): void {
  mode = next;
  container2d.hidden = mode !== '2d';
  container3d.hidden = mode !== '3d';
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
  fromMonth = fromSelect.value;
  applyFilters();
  renderResults();
});
toSelect.addEventListener('change', () => {
  toMonth = toSelect.value;
  applyFilters();
  renderResults();
});
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
  graph2d?.width(width2d()).height(window.innerHeight);
  graph3d?.width(window.innerWidth).height(window.innerHeight);
});

container3d.hidden = true;
graph2d = makeGraph2d();
void loadFromServer();
