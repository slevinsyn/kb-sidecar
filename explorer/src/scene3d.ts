import type { Analysis } from './analysis';
import { linkEnd } from './graph';
import type { GraphData, GraphNode, NodeType } from './graph';

export const Z_SPAN = 600;
export const ISLAND_RADIUS = 200;
export const LAYER_Z: Readonly<Record<NodeType, number>> = {
  project: -200,
  session: 0,
  topic: 200,
  file: 0,
  tool: 0,
};

const DAY_MS = 86_400_000;
const RECENCY_DAYS = 180;
const MIN_SIZE = 3;
const MAX_SIZE = 15;

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function sessionTimes(g: GraphData): Map<string, number> {
  const times = new Map<string, number>();
  for (const n of g.nodes) {
    if (n.type !== 'session') continue;
    const t = parseTime(n.meta?.started_at);
    if (t !== null) times.set(n.id, t);
  }
  return times;
}

// For every topic/project, the set of session ids it is linked to (any direction).
function linkedSessions(g: GraphData): Map<string, Set<string>> {
  const type = new Map<string, NodeType>();
  for (const n of g.nodes) type.set(n.id, n.type);
  const out = new Map<string, Set<string>>();
  const add = (owner: string, session: string): void => {
    let set = out.get(owner);
    if (!set) {
      set = new Set();
      out.set(owner, set);
    }
    set.add(session);
  };
  const isGroup = (t: NodeType | undefined): boolean => t === 'topic' || t === 'project';
  for (const l of g.links) {
    const a = linkEnd(l.source);
    const b = linkEnd(l.target);
    const ta = type.get(a);
    const tb = type.get(b);
    if (ta === 'session' && isGroup(tb)) add(b, a);
    else if (tb === 'session' && isGroup(ta)) add(a, b);
  }
  return out;
}

export function timeAxis(g: GraphData): Map<string, number> {
  const times = sessionTimes(g);
  const z = new Map<string, number>();
  if (times.size === 0) return z;
  let tmin = Infinity;
  let tmax = -Infinity;
  for (const t of times.values()) {
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  const range = tmax - tmin;
  for (const [id, t] of times) {
    z.set(id, range > 0 ? ((t - tmin) / range - 0.5) * Z_SPAN : 0);
  }
  for (const [owner, sessions] of linkedSessions(g)) {
    let sum = 0;
    let count = 0;
    for (const s of sessions) {
      const v = z.get(s);
      if (v === undefined) continue;
      sum += v;
      count += 1;
    }
    if (count > 0) z.set(owner, sum / count);
  }
  return z;
}

export function islandCenters(a: Analysis): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  const n = a.communities.length;
  if (n === 1) {
    out.set(a.communities[0].id, { x: 0, y: 0 });
    return out;
  }
  a.communities.forEach((c, i) => {
    const angle = (2 * Math.PI * i) / n;
    out.set(c.id, { x: ISLAND_RADIUS * Math.cos(angle), y: ISLAND_RADIUS * Math.sin(angle) });
  });
  return out;
}

export function layerZ(type: NodeType): number {
  return LAYER_Z[type];
}

export function nodeSize(n: GraphNode, a: Analysis): number {
  if (n.type === 'session') {
    const turns = n.meta?.turns;
    if (typeof turns === 'number' && Number.isFinite(turns) && turns > 0) {
      return Math.min(MAX_SIZE, MIN_SIZE + 2 * Math.log2(1 + turns));
    }
  }
  let m = 0;
  for (const v of a.rank.values()) if (v > m) m = v;
  if (!(m > 0)) return MIN_SIZE;
  const r = a.rank.get(n.id) ?? 0;
  const size = MIN_SIZE + (12 * r) / m;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
}

export function recency(date: string | undefined, latestAt: string | null): number {
  const d = parseTime(date);
  const latest = parseTime(latestAt);
  if (d === null || latest === null) return 0.5;
  const age = Math.max(0, (latest - d) / DAY_MS);
  return 1 - 0.75 * Math.min(1, age / RECENCY_DAYS);
}

export function brightnessMap(g: GraphData, a: Analysis): Map<string, number> {
  const out = new Map<string, number>();
  const dates = new Map<string, string>();
  const times = new Map<string, number>();
  for (const n of g.nodes) {
    if (n.type !== 'session') continue;
    const started = n.meta?.started_at;
    const t = parseTime(started);
    if (t !== null && typeof started === 'string') {
      dates.set(n.id, started);
      times.set(n.id, t);
    }
  }
  const linked = linkedSessions(g);
  for (const n of g.nodes) {
    if (n.type === 'session') {
      out.set(n.id, recency(dates.get(n.id), a.latestAt));
    } else if (n.type === 'topic' || n.type === 'project') {
      let best: string | undefined;
      let bestT = -Infinity;
      for (const s of linked.get(n.id) ?? []) {
        const t = times.get(s);
        if (t !== undefined && t > bestT) {
          bestT = t;
          best = dates.get(s);
        }
      }
      out.set(n.id, recency(best, a.latestAt));
    } else {
      out.set(n.id, 0.5);
    }
  }
  return out;
}

export function bridgeIds(a: Analysis): Set<string> {
  return new Set(a.bridges.map((b) => b.id));
}
