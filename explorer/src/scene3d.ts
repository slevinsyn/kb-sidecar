import type { Analysis } from './analysis';
import { linkEnd } from './graph';
import type { GraphData, GraphLink, GraphNode, NodeType } from './graph';

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

export const NOISE_LINK_TYPES: readonly string[] = ['used_tool', 'touched_file'];

export function defaultLinkFilter(g: GraphData, showNoise = false): GraphData {
  const links: GraphLink[] = [];
  for (const l of g.links) {
    if (!showNoise && NOISE_LINK_TYPES.includes(l.type)) continue;
    links.push({ source: linkEnd(l.source), target: linkEnd(l.target), type: l.type });
  }
  return { nodes: [...g.nodes], links };
}

export const LINK_OPACITY = 0.15;

const LINK_RGB: Readonly<Record<string, readonly [number, number, number]>> = {
  in_project: [247, 201, 107],
  has_topic: [122, 162, 247],
  touched_file: [158, 206, 106],
  used_tool: [187, 154, 247],
};
const FALLBACK_RGB: readonly [number, number, number] = [138, 143, 152];

export function linkRgba(type: string, alpha: number = LINK_OPACITY): string {
  const known = Object.prototype.hasOwnProperty.call(LINK_RGB, type);
  const [r, g, b] = known ? LINK_RGB[type] : FALLBACK_RGB;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function shortestPath(g: GraphData, from: string, to: string): string[] | null {
  const eligible = new Set<string>();
  const ids = new Set<string>();
  for (const n of g.nodes) {
    ids.add(n.id);
    if (n.type === 'session' || n.type === 'topic') eligible.add(n.id);
  }
  if (!ids.has(from) || !ids.has(to)) return null;
  if (from === to) return [from];
  if (!eligible.has(from) || !eligible.has(to)) return null;
  const adj = new Map<string, Set<string>>();
  const connect = (a: string, b: string): void => {
    let set = adj.get(a);
    if (!set) {
      set = new Set();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const l of g.links) {
    const a = linkEnd(l.source);
    const b = linkEnd(l.target);
    if (a === b || !eligible.has(a) || !eligible.has(b)) continue;
    connect(a, b);
    connect(b, a);
  }
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  let queue = [from];
  while (queue.length > 0) {
    const next: string[] = [];
    for (const cur of queue) {
      const nbrs = [...(adj.get(cur) ?? [])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      for (const nb of nbrs) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, cur);
        if (nb === to) {
          const path = [to];
          let at = to;
          while (at !== from) {
            at = prev.get(at) as string;
            path.push(at);
          }
          return path.reverse();
        }
        next.push(nb);
      }
    }
    queue = next;
  }
  return null;
}

export function nextMonth(months: readonly string[], current: string | null): string | null {
  if (current === null) return months.length > 0 ? months[0] : null;
  const i = months.indexOf(current);
  if (i < 0 || i + 1 >= months.length) return null;
  return months[i + 1];
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export function clusterBounds(points: readonly Point3[]): { center: Point3; radius: number } {
  if (points.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: 120 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }
  const n = points.length;
  const center = { x: sx / n, y: sy / n, z: sz / n };
  let far = 0;
  for (const p of points) {
    const d = Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
    if (d > far) far = d;
  }
  return { center, radius: Math.max(80, far + 40) };
}

export function orbitPosition(center: Point3, radius: number, angle: number): Point3 {
  return {
    x: center.x + radius * Math.sin(angle),
    y: center.y,
    z: center.z + radius * Math.cos(angle),
  };
}
