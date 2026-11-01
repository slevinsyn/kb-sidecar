import { filterByTypes, linkEnd } from './graph';
import type { GraphData, GraphLink, NodeType } from './graph';
import type { Analysis } from './analysis';

export const COMMUNITY_PALETTE: readonly string[] = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#17becf',
  '#8cd17d',
  '#d37295',
];

export const UNASSIGNED_COLOR = '#8a8f98';

export function communityColor(id: number | undefined): string {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return UNASSIGNED_COLOR;
  return COMMUNITY_PALETTE[id % COMMUNITY_PALETTE.length];
}

export const DEFAULT_VIEW_TYPES: readonly NodeType[] = ['session', 'project', 'topic'];

export interface ViewOptions {
  types: Iterable<NodeType>;
  fromMonth?: string | null;
  toMonth?: string | null;
}

const MONTH_CHARS = 7;
const MONTH_KEY = /^\d{4}-\d{2}$/;

/** First 7 characters (YYYY-MM) of a usable started_at, or null when missing or invalid. */
function monthOf(v: unknown): string | null {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return null;
  const m = v.slice(0, MONTH_CHARS);
  return MONTH_KEY.test(m) ? m : null;
}

export function viewGraph(g: GraphData, opts: ViewOptions): GraphData {
  const types = new Set<NodeType>(opts.types);
  const from = typeof opts.fromMonth === 'string' && opts.fromMonth !== '' ? opts.fromMonth : null;
  const to = typeof opts.toMonth === 'string' && opts.toMonth !== '' ? opts.toMonth : null;
  const ranged = from !== null || to !== null;

  const typed = filterByTypes(g, types);
  let nodes = typed.nodes;
  if (ranged) {
    nodes = nodes.filter((n) => {
      if (n.type !== 'session') return true;
      const m = monthOf(n.meta.started_at);
      if (m === null) return false;
      if (from !== null && m < from) return false;
      if (to !== null && m > to) return false;
      return true;
    });
  }

  let kept = new Set(nodes.map((n) => n.id));
  let links: GraphLink[] = typed.links.filter(
    (l) => kept.has(linkEnd(l.source)) && kept.has(linkEnd(l.target)),
  );

  if (types.has('session')) {
    const sessions = new Set(nodes.filter((n) => n.type === 'session').map((n) => n.id));
    const linked = new Set<string>();
    for (const l of links) {
      const s = linkEnd(l.source);
      const t = linkEnd(l.target);
      if (sessions.has(s)) linked.add(t);
      if (sessions.has(t)) linked.add(s);
    }
    nodes = nodes.filter((n) => n.type === 'session' || linked.has(n.id));
    kept = new Set(nodes.map((n) => n.id));
    links = links.filter((l) => kept.has(linkEnd(l.source)) && kept.has(linkEnd(l.target)));
  }

  return {
    nodes,
    links: links.map((l) => ({ source: linkEnd(l.source), target: linkEnd(l.target), type: l.type })),
  };
}

export interface ClusterLabel {
  community: number;
  label: string;
  nodeId: string;
}

const DEFAULT_LABEL_LIMIT = 12;

export function clusterLabels(a: Analysis, limit: number = DEFAULT_LABEL_LIMIT): ClusterLabel[] {
  const out: ClusterLabel[] = [];
  if (!(limit > 0)) return out;
  for (const c of a.communities.slice(0, limit)) {
    let best: string | null = null;
    let bestRank = -Infinity;
    for (const s of c.sessions) {
      const r = a.rank.get(s) ?? 0;
      if (best === null || r > bestRank || (r === bestRank && s < best)) {
        best = s;
        bestRank = r;
      }
    }
    if (best !== null) out.push({ community: c.id, label: c.label, nodeId: best });
  }
  return out;
}

export function monthRange(a: Analysis): string[] {
  return a.timeline.map((b) => b.month);
}
