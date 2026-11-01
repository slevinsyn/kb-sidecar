export type NodeType = 'session' | 'project' | 'topic' | 'file' | 'tool';

export const NODE_TYPES: readonly NodeType[] = ['session', 'project', 'topic', 'file', 'tool'];

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  size: number;
  meta: Record<string, unknown>;
}

export interface GraphLink {
  source: string | { id: string };
  target: string | { id: string };
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

export const TYPE_COLORS: Record<NodeType, string> = {
  session: '#4e9af1',
  project: '#f5a623',
  topic: '#7ed321',
  file: '#bd10e0',
  tool: '#e94b6a',
};

export function linkEnd(end: string | { id: string }): string {
  return typeof end === 'string' ? end : end.id;
}

function invalid(reason: string): GraphError {
  return new GraphError(`Invalid graph: ${reason}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function copyMeta(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) return {};
  try {
    return structuredClone(v);
  } catch {
    return { ...v };
  }
}

function parseEnd(v: unknown, what: string, index: number): string {
  if (typeof v === 'string') return v;
  if (isRecord(v) && typeof v.id === 'string') return v.id;
  throw invalid(`link ${index} has an invalid ${what}`);
}

export function parseGraph(input: unknown): GraphData {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw invalid(`not valid JSON (${msg})`);
    }
  }
  if (!isRecord(raw)) throw invalid('expected an object with nodes and links');
  if (!Array.isArray(raw.nodes)) throw invalid('"nodes" must be an array');
  if (!Array.isArray(raw.links)) throw invalid('"links" must be an array');

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  raw.nodes.forEach((n: unknown, i: number) => {
    if (!isRecord(n)) throw invalid(`node ${i} is not an object`);
    if (typeof n.id !== 'string') throw invalid(`node ${i} has no string id`);
    if (typeof n.type !== 'string' || !(NODE_TYPES as readonly string[]).includes(n.type)) {
      throw invalid(`node ${i} has an unknown type`);
    }
    if (typeof n.label !== 'string') throw invalid(`node ${i} has no string label`);
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const size =
      typeof n.size === 'number' && Number.isFinite(n.size) && n.size > 0 ? n.size : 1;
    nodes.push({ id: n.id, type: n.type as NodeType, label: n.label, size, meta: copyMeta(n.meta) });
  });

  const links: GraphLink[] = [];
  raw.links.forEach((l: unknown, i: number) => {
    if (!isRecord(l)) throw invalid(`link ${i} is not an object`);
    const source = parseEnd(l.source, 'source', i);
    const target = parseEnd(l.target, 'target', i);
    if (!seen.has(source) || !seen.has(target)) return;
    links.push({ source, target, type: typeof l.type === 'string' ? l.type : '' });
  });

  return { nodes, links };
}

export function filterByTypes(g: GraphData, types: Iterable<NodeType>): GraphData {
  const allowed = new Set<NodeType>(types);
  const nodes = g.nodes.filter((n) => allowed.has(n.type));
  const kept = new Set(nodes.map((n) => n.id));
  const links = g.links.filter((l) => kept.has(linkEnd(l.source)) && kept.has(linkEnd(l.target)));
  return { nodes, links };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function searchNodes(g: GraphData, query: string, limit = 20): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (q === '' || !(limit > 0)) return [];
  const ranked: { n: GraphNode; rank: number; label: string }[] = [];
  for (const n of g.nodes) {
    const label = n.label.toLowerCase();
    let rank: number;
    if (label.startsWith(q)) rank = 0;
    else if (label.includes(q)) rank = 1;
    else if (n.id.toLowerCase().includes(q)) rank = 2;
    else continue;
    ranked.push({ n, rank, label });
  }
  ranked.sort((a, b) => a.rank - b.rank || cmp(a.label, b.label) || cmp(a.n.id, b.n.id));
  return ranked.slice(0, limit).map((r) => r.n);
}

export function neighbors(
  g: GraphData,
  id: string,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
  if (!byId.has(id)) return { nodes: [], links: [] };
  const links: GraphLink[] = [];
  const ids = new Set<string>();
  for (const l of g.links) {
    const s = linkEnd(l.source);
    const t = linkEnd(l.target);
    if (s !== id && t !== id) continue;
    links.push(l);
    const other = s === id ? t : s;
    if (other !== id && byId.has(other)) ids.add(other);
  }
  const nodes = [...ids].sort(cmp).map((i) => byId.get(i) as GraphNode);
  return { nodes, links };
}

export function nodeDetails(
  g: GraphData,
  id: string,
): { node: GraphNode; neighborsByType: Record<NodeType, GraphNode[]> } | null {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return null;
  const neighborsByType: Record<NodeType, GraphNode[]> = {
    session: [],
    project: [],
    topic: [],
    file: [],
    tool: [],
  };
  for (const n of neighbors(g, id).nodes) neighborsByType[n.type].push(n);
  for (const t of NODE_TYPES) {
    neighborsByType[t].sort(
      (a, b) => cmp(a.label.toLowerCase(), b.label.toLowerCase()) || cmp(a.id, b.id),
    );
  }
  return { node, neighborsByType };
}
