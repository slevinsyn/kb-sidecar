import { linkEnd } from './graph';
import type { GraphData, GraphNode, NodeType } from './graph';

export interface WeightedEdge {
  a: string;
  b: string;
  w: number;
}

export interface Community {
  id: number;
  label: string;
  topics: string[];
  sessions: string[];
  size: number;
  projects: string[];
  firstAt: string | null;
  lastAt: string | null;
}

export interface Bridge {
  id: string;
  label: string;
  type: NodeType;
  communities: number[];
}

export interface TimelineBucket {
  month: string;
  sessions: number;
  topTopics: string[];
}

export interface Analysis {
  communityOf: Map<string, number>;
  communities: Community[];
  rank: Map<string, number>;
  bridges: Bridge[];
  oneOffTopics: GraphNode[];
  looseEnds: Community[];
  timeline: TimelineBucket[];
  latestAt: string | null;
}

export const LOOSE_END_DAYS = 30;

const DAY_MS = 86400000;
const MAX_BRIDGES = 20;
const LOOSE_END_MAX_SIZE = 3;
const EPS = 1e-10;
const MAX_PASSES = 1000;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- shared helpers ----------

interface Indexed {
  ids: string[];
  adj: Map<number, number>[];
}

/** Distinct node ids (first occurrence wins) and an undirected weighted adjacency.
 *  Unknown endpoints, self-loops and non-positive or non-finite weights are ignored;
 *  parallel edges add up. */
function indexGraph(nodes: readonly string[], edges: readonly WeightedEdge[]): Indexed {
  const index = new Map<string, number>();
  const ids: string[] = [];
  for (const id of nodes) {
    if (!index.has(id)) {
      index.set(id, ids.length);
      ids.push(id);
    }
  }
  const adj: Map<number, number>[] = ids.map(() => new Map<number, number>());
  for (const e of edges) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || i === j) continue;
    if (typeof e.w !== 'number' || !Number.isFinite(e.w) || e.w <= 0) continue;
    adj[i].set(j, (adj[i].get(j) ?? 0) + e.w);
    adj[j].set(i, (adj[j].get(i) ?? 0) + e.w);
  }
  return { ids, adj };
}

function validDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Orders date strings by time, then by the string itself. */
function cmpDate(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || cmp(a, b);
}

// ---------- sessionTopicGraph ----------

export function sessionTopicGraph(g: GraphData): { nodes: string[]; edges: WeightedEdge[] } {
  const types = new Map<string, NodeType>();
  for (const n of g.nodes) {
    if (n.type === 'session' || n.type === 'topic') types.set(n.id, n.type);
  }
  const nodes = [...types.keys()].sort(cmp);
  const pairs = new Map<string, WeightedEdge>();
  for (const l of g.links) {
    const s = linkEnd(l.source);
    const t = linkEnd(l.target);
    let session: string;
    let topic: string;
    if (types.get(s) === 'session' && types.get(t) === 'topic') {
      session = s;
      topic = t;
    } else if (types.get(s) === 'topic' && types.get(t) === 'session') {
      session = t;
      topic = s;
    } else {
      continue;
    }
    const key = JSON.stringify([session, topic]);
    if (!pairs.has(key)) pairs.set(key, { a: session, b: topic, w: 1 });
  }
  const edges = [...pairs.values()].sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b));
  return { nodes, edges };
}

// ---------- louvain ----------

/** One local-moving phase on a level graph. Returns the community of each level node
 *  and whether any node moved. */
function localMoving(
  adj: Map<number, number>[],
  self: number[],
): { comm: number[]; moved: boolean } {
  const n = adj.length;
  const comm = Array.from({ length: n }, (_, i) => i);
  const deg = new Array<number>(n).fill(0);
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    let d = 2 * self[i];
    for (const w of adj[i].values()) d += w;
    deg[i] = d;
    m2 += d;
  }
  if (m2 <= 0) return { comm, moved: false };
  const tot = deg.slice();
  let moved = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      const own = comm[i];
      const toComm = new Map<number, number>();
      for (const [j, w] of adj[i]) {
        const c = comm[j];
        toComm.set(c, (toComm.get(c) ?? 0) + w);
      }
      tot[own] -= deg[i];
      const ownGain = (toComm.get(own) ?? 0) - (tot[own] * deg[i]) / m2;
      let best = -1;
      let bestGain = -Infinity;
      for (const [c, w] of toComm) {
        if (c === own) continue;
        const gain = w - (tot[c] * deg[i]) / m2;
        if (gain > bestGain + EPS || (Math.abs(gain - bestGain) <= EPS && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      if (best !== -1 && bestGain > EPS && bestGain > ownGain + EPS) {
        comm[i] = best;
        improved = true;
        moved = true;
      }
      tot[comm[i]] += deg[i];
    }
    if (!improved) break;
  }
  return { comm, moved };
}

export function louvain(nodes: string[], edges: WeightedEdge[]): Map<string, number> {
  const { ids, adj: baseAdj } = indexGraph(nodes, edges);
  const n = ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  let adj = baseAdj;
  let self = new Array<number>(n).fill(0);
  // member[x] = level node that original node x currently belongs to
  let member = Array.from({ length: n }, (_, i) => i);

  for (;;) {
    const { comm, moved } = localMoving(adj, self);
    if (!moved) break;
    // renumber communities 0..k-1 by first appearance
    const renum = new Map<number, number>();
    for (const c of comm) if (!renum.has(c)) renum.set(c, renum.size);
    const k = renum.size;
    const level = comm.map((c) => renum.get(c) as number);
    const nextAdj: Map<number, number>[] = Array.from({ length: k }, () => new Map());
    const nextSelf = new Array<number>(k).fill(0);
    for (let i = 0; i < adj.length; i++) {
      const ci = level[i];
      nextSelf[ci] += self[i];
      for (const [j, w] of adj[i]) {
        const cj = level[j];
        if (ci === cj) nextSelf[ci] += w / 2;
        else nextAdj[ci].set(cj, (nextAdj[ci].get(cj) ?? 0) + w);
      }
    }
    member = member.map((x) => level[x]);
    const shrunk = k < adj.length;
    adj = nextAdj;
    self = nextSelf;
    if (!shrunk) break;
  }

  const groups = new Map<number, string[]>();
  for (let x = 0; x < n; x++) {
    const list = groups.get(member[x]);
    if (list) list.push(ids[x]);
    else groups.set(member[x], [ids[x]]);
  }
  const ordered = [...groups.values()].map((list) => list.slice().sort(cmp));
  ordered.sort((x, y) => y.length - x.length || cmp(x[0], y[0]));
  ordered.forEach((list, id) => {
    for (const nodeId of list) result.set(nodeId, id);
  });
  return result;
}

// ---------- pageRank ----------

export function pageRank(
  nodes: string[],
  edges: WeightedEdge[],
  opts?: { damping?: number; iterations?: number },
): Map<string, number> {
  const { ids, adj } = indexGraph(nodes, edges);
  const n = ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  let damping = opts?.damping ?? 0.85;
  if (typeof damping !== 'number' || !Number.isFinite(damping)) damping = 0.85;
  damping = Math.min(1, Math.max(0, damping));
  let iterations = opts?.iterations ?? 50;
  if (typeof iterations !== 'number' || !Number.isFinite(iterations)) iterations = 50;
  iterations = Math.max(0, Math.floor(iterations));

  const deg = adj.map((m) => {
    let d = 0;
    for (const w of m.values()) d += w;
    return d;
  });
  let rank = new Array<number>(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (deg[i] === 0) dangling += rank[i];
    const base = (1 - damping) / n + (damping * dangling) / n;
    const next = new Array<number>(n).fill(base);
    for (let i = 0; i < n; i++) {
      if (deg[i] === 0) continue;
      const share = (damping * rank[i]) / deg[i];
      for (const [j, w] of adj[i]) next[j] += share * w;
    }
    rank = next;
  }
  let sum = 0;
  for (const r of rank) sum += r;
  for (let i = 0; i < n; i++) result.set(ids[i], sum > 0 ? rank[i] / sum : 1 / n);
  return result;
}

// ---------- analyzeGraph ----------

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

export function analyzeGraph(g: GraphData): Analysis {
  const byId = new Map<string, GraphNode>();
  for (const n of g.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const typeOf = (id: string): NodeType | undefined => byId.get(id)?.type;

  const st = sessionTopicGraph(g);
  const groups = louvain(st.nodes, st.edges);
  const rank = pageRank(st.nodes, st.edges);

  // links: topic -> sessions, session -> topics, project -> sessions
  const topicSessions = new Map<string, Set<string>>();
  const sessionTopics = new Map<string, Set<string>>();
  for (const e of st.edges) {
    addTo(topicSessions, e.b, e.a);
    addTo(sessionTopics, e.a, e.b);
  }
  const projectSessions = new Map<string, Set<string>>();
  for (const l of g.links) {
    const s = linkEnd(l.source);
    const t = linkEnd(l.target);
    if (typeOf(s) === 'session' && typeOf(t) === 'project') addTo(projectSessions, t, s);
    else if (typeOf(s) === 'project' && typeOf(t) === 'session') addTo(projectSessions, s, t);
  }

  // session dates
  const startedAt = new Map<string, string>();
  let latestAt: string | null = null;
  for (const n of byId.values()) {
    if (n.type !== 'session') continue;
    const v = n.meta?.started_at;
    if (!validDate(v)) continue;
    startedAt.set(n.id, v);
    if (latestAt === null || cmpDate(v, latestAt) > 0) latestAt = v;
  }

  // communities
  const members = new Map<number, string[]>();
  for (const [id, c] of groups) {
    const list = members.get(c);
    if (list) list.push(id);
    else members.set(c, [id]);
  }
  const raw = [...members.values()]
    .map((list) => {
      const sorted = list.slice().sort(cmp);
      const sessions = sorted.filter((id) => typeOf(id) === 'session');
      const topics = sorted.filter((id) => typeOf(id) === 'topic');
      return { sorted, sessions, topics };
    })
    .filter((c) => c.sessions.length > 0);
  raw.sort(
    (x, y) =>
      y.sessions.length - x.sessions.length ||
      y.sorted.length - x.sorted.length ||
      cmp(x.sorted[0], y.sorted[0]),
  );

  const communityOf = new Map<string, number>();
  const communities: Community[] = raw.map((c, id) => {
    for (const m of c.sorted) communityOf.set(m, id);
    const sessionSet = new Set(c.sessions);

    const topicEntries = c.topics.map((t) => {
      let count = 0;
      for (const s of topicSessions.get(t) ?? []) if (sessionSet.has(s)) count++;
      return { id: t, label: (byId.get(t) as GraphNode).label, count };
    });
    topicEntries.sort((x, y) => y.count - x.count || cmp(x.label, y.label) || cmp(x.id, y.id));
    const topics = topicEntries.map((t) => t.label);

    const projectCounts = new Map<string, number>();
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    for (const s of c.sessions) {
      const p = byId.get(s)?.meta?.project;
      if (typeof p === 'string') projectCounts.set(p, (projectCounts.get(p) ?? 0) + 1);
      const d = startedAt.get(s);
      if (d !== undefined) {
        if (firstAt === null || cmpDate(d, firstAt) < 0) firstAt = d;
        if (lastAt === null || cmpDate(d, lastAt) > 0) lastAt = d;
      }
    }
    const projects = [...projectCounts.entries()]
      .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
      .map(([name]) => name);

    let label: string;
    if (topics.length > 0) label = topics.slice(0, 3).join(' · ');
    else if (projects.length > 0) label = projects[0];
    else label = `Community ${id + 1}`;

    return {
      id,
      label,
      topics,
      sessions: c.sessions,
      size: c.sessions.length,
      projects,
      firstAt,
      lastAt,
    };
  });

  // bridges
  const bridgeEntries: { bridge: Bridge; score: number }[] = [];
  const consider = (node: GraphNode, sessions: Set<string> | undefined, score: number): void => {
    const ids = new Set<number>();
    for (const s of sessions ?? []) {
      const c = communityOf.get(s);
      if (c !== undefined) ids.add(c);
    }
    if (ids.size < 2) return;
    bridgeEntries.push({
      bridge: {
        id: node.id,
        label: node.label,
        type: node.type,
        communities: [...ids].sort((x, y) => x - y),
      },
      score,
    });
  };
  for (const n of byId.values()) {
    if (n.type === 'topic') consider(n, topicSessions.get(n.id), rank.get(n.id) ?? 0);
    else if (n.type === 'project') consider(n, projectSessions.get(n.id), 0);
  }
  bridgeEntries.sort(
    (x, y) =>
      y.bridge.communities.length - x.bridge.communities.length ||
      y.score - x.score ||
      cmp(x.bridge.id, y.bridge.id),
  );
  const bridges = bridgeEntries.slice(0, MAX_BRIDGES).map((e) => e.bridge);

  // one-off topics
  const oneOffTopics = [...byId.values()]
    .filter((n) => n.type === 'topic' && (topicSessions.get(n.id)?.size ?? 0) === 1)
    .sort((x, y) => cmp(x.label, y.label) || cmp(x.id, y.id));

  // loose ends
  const looseEnds: Community[] = [];
  if (latestAt !== null) {
    const latest = Date.parse(latestAt);
    for (const c of communities) {
      if (c.size > LOOSE_END_MAX_SIZE || c.lastAt === null) continue;
      if (latest - Date.parse(c.lastAt) > LOOSE_END_DAYS * DAY_MS) looseEnds.push(c);
    }
    looseEnds.sort((x, y) => cmpDate(y.lastAt as string, x.lastAt as string) || x.id - y.id);
  }

  // timeline
  const months = new Map<string, string[]>();
  for (const [s, d] of startedAt) {
    const month = d.slice(0, 7);
    const list = months.get(month);
    if (list) list.push(s);
    else months.set(month, [s]);
  }
  const timeline: TimelineBucket[] = [...months.keys()].sort(cmp).map((month) => {
    const sessions = months.get(month) as string[];
    const counts = new Map<string, number>();
    for (const s of sessions) {
      for (const t of sessionTopics.get(s) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const topTopics = [...counts.entries()]
      .map(([t, count]) => ({ id: t, label: (byId.get(t) as GraphNode).label, count }))
      .sort((x, y) => y.count - x.count || cmp(x.label, y.label) || cmp(x.id, y.id))
      .slice(0, 3)
      .map((t) => t.label);
    return { month, sessions: sessions.length, topTopics };
  });

  return {
    communityOf,
    communities,
    rank,
    bridges,
    oneOffTopics,
    looseEnds,
    timeline,
    latestAt,
  };
}
