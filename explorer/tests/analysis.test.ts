import { describe, it, expect } from 'vitest';
import {
  LOOSE_END_DAYS,
  analyzeGraph,
  louvain,
  pageRank,
  sessionTopicGraph,
} from '../src/analysis';
import type { Community, WeightedEdge } from '../src/analysis';
import { linkEnd, parseGraph } from '../src/graph';
import type { GraphData, NodeType } from '../src/graph';

// ---------- helpers ----------

interface RawNode {
  id: string;
  type: NodeType;
  label: string;
  meta?: Record<string, unknown>;
}

interface RawLink {
  source: string;
  target: string;
  type: string;
}

function S(id: string, meta: Record<string, unknown> = {}): RawNode {
  return { id, type: 'session', label: `Session ${id}`, meta };
}

function T(id: string, label: string): RawNode {
  return { id, type: 'topic', label };
}

function P(id: string, label: string): RawNode {
  return { id, type: 'project', label };
}

function F(id: string): RawNode {
  return { id, type: 'file', label: id };
}

function X(id: string): RawNode {
  return { id, type: 'tool', label: id };
}

function L(source: string, target: string, type = 'rel'): RawLink {
  return { source, target, type };
}

function linkAll(sessions: string[], topics: string[]): RawLink[] {
  const out: RawLink[] = [];
  for (const s of sessions) {
    for (const t of topics) out.push(L(s, t, 'about'));
  }
  return out;
}

function build(nodes: RawNode[], links: RawLink[]): GraphData {
  return parseGraph({ nodes, links });
}

function clique(ids: string[], w = 1): WeightedEdge[] {
  const out: WeightedEdge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push({ a: ids[i], b: ids[j], w });
  }
  return out;
}

function asObject(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) as number;
  return out;
}

function sumValues(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function withObjectEndpoints(g: GraphData): GraphData {
  return {
    nodes: g.nodes,
    links: g.links.map((l) => ({
      source: { id: linkEnd(l.source) },
      target: { id: linkEnd(l.target) },
      type: l.type,
    })),
  };
}

// Three themes: A (a1..a3), B (b1..b3), C (c1, c2), plus a topic shared by A and B,
// a topic shared by A, B and C and projects that do / do not cross themes.
function bridgeGraph(): GraphData {
  const nodes: RawNode[] = [
    S('a1'), S('a2'), S('a3'), S('b1'), S('b2'), S('b3'), S('c1'), S('c2'),
    T('ta1', 'A one'), T('ta2', 'A two'),
    T('tb1', 'B one'), T('tb2', 'B two'),
    T('tc1', 'C one'), T('tc2', 'C two'),
    T('tx', 'Cross'), T('tri', 'Triad'),
    P('p:shared', 'Shared'), P('p:solo', 'Solo'), P('p:none', 'None'),
  ];
  const links: RawLink[] = [
    ...linkAll(['a1', 'a2', 'a3'], ['ta1', 'ta2']),
    ...linkAll(['b1', 'b2', 'b3'], ['tb1', 'tb2']),
    ...linkAll(['c1', 'c2'], ['tc1', 'tc2']),
    L('a1', 'tx'), L('b1', 'tx'),
    L('a3', 'tri'), L('b3', 'tri'), L('c1', 'tri'),
    L('a2', 'p:shared', 'in_project'), L('b2', 'p:shared', 'in_project'),
    L('a1', 'p:solo', 'in_project'), L('a3', 'p:solo', 'in_project'),
  ];
  return build(nodes, links);
}

// ---------- sessionTopicGraph ----------

describe('sessionTopicGraph', () => {
  it('AC-10-01 keeps only session-topic pairs, deduplicated and sorted', () => {
    const g = build(
      [
        S('s2'), S('s1'),
        T('t:b', 'B'), T('t:a', 'A'), T('t:lonely', 'Lonely'),
        P('p1', 'Proj'), F('f1'), X('x1'),
      ],
      [
        L('s2', 't:b'),
        L('s1', 't:a'),
        L('t:a', 's1'), // reverse direction duplicate
        L('s1', 't:a', 'other'), // duplicate with another link type
        L('t:a', 's2'), // topic -> session direction
        L('s1', 'p1', 'in_project'),
        L('s1', 'f1', 'touched'),
        L('s1', 'x1', 'used'),
        L('t:a', 'p1'),
        L('s1', 's2'),
        L('t:a', 't:b'),
        L('f1', 't:b'),
      ],
    );
    const st = sessionTopicGraph(g);
    expect(st.nodes).toEqual(['s1', 's2', 't:a', 't:b', 't:lonely']);
    expect(st.edges).toEqual([
      { a: 's1', b: 't:a', w: 1 },
      { a: 's2', b: 't:a', w: 1 },
      { a: 's2', b: 't:b', w: 1 },
    ]);
  });

  it('AC-10-01 ignores files, tools and projects entirely', () => {
    const g = build(
      [S('s1'), P('p1', 'Proj'), F('f1'), X('x1')],
      [L('s1', 'p1'), L('s1', 'f1'), L('x1', 's1')],
    );
    const st = sessionTopicGraph(g);
    expect(st.nodes).toEqual(['s1']);
    expect(st.edges).toEqual([]);
  });
});

// ---------- louvain ----------

describe('louvain', () => {
  const aIds = ['a1', 'a2', 'a3', 'a4'];
  const bIds = ['b1', 'b2', 'b3', 'b4'];
  const twoCliqueEdges = (): WeightedEdge[] => [
    ...clique(aIds),
    ...clique(bIds),
    { a: 'a4', b: 'b1', w: 1 },
  ];

  it('AC-10-02 splits two 4-node cliques joined by one edge and isolates edgeless nodes', () => {
    const nodes = [...aIds, ...bIds, 'iso'];
    const result = louvain(nodes, twoCliqueEdges());
    expect(asObject(result)).toEqual({
      a1: 0, a2: 0, a3: 0, a4: 0,
      b1: 1, b2: 1, b3: 1, b4: 1,
      iso: 2,
    });
  });

  it('AC-10-02 puts every input node in exactly one community with ids 0..k-1', () => {
    const nodes = [...aIds, ...bIds, 'iso', 'iso2'];
    const result = louvain(nodes, twoCliqueEdges());
    expect(result.size).toBe(nodes.length);
    expect([...result.keys()].sort()).toEqual([...nodes].sort());
    const ids = new Set(result.values());
    expect([...ids].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
    expect(result.get('iso')).not.toBe(result.get('iso2'));
  });

  it('AC-10-02 returns an empty map for empty input', () => {
    const result = louvain([], []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('AC-10-02 ignores unknown endpoints, self-loops and zero or negative weights', () => {
    const nodes = [...aIds, ...bIds, 'iso'];
    const noisy: WeightedEdge[] = [
      ...twoCliqueEdges(),
      { a: 'iso', b: 'iso', w: 5 },
      { a: 'iso', b: 'a1', w: 0 },
      { a: 'iso', b: 'b1', w: -3 },
      { a: 'a1', b: 'ghost', w: 4 },
      { a: 'ghost', b: 'iso', w: 4 },
    ];
    const result = louvain(nodes, noisy);
    expect(asObject(result)).toEqual({
      a1: 0, a2: 0, a3: 0, a4: 0,
      b1: 1, b2: 1, b3: 1, b4: 1,
      iso: 2,
    });
    expect(result.has('ghost')).toBe(false);
  });

  it('AC-10-02 adds up parallel edges and treats edges as undirected', () => {
    const nodes = [...aIds, ...bIds];
    const merged = louvain(nodes, [...clique(aIds), ...clique(bIds), { a: 'a4', b: 'b1', w: 2 }]);
    const parallel = louvain(nodes, [
      ...clique(aIds),
      ...clique(bIds),
      { a: 'a4', b: 'b1', w: 1 },
      { a: 'b1', b: 'a4', w: 1 },
    ]);
    expect(asObject(parallel)).toEqual(asObject(merged));
    expect(asObject(merged)).toEqual({
      a1: 0, a2: 0, a3: 0, a4: 0,
      b1: 1, b2: 1, b3: 1, b4: 1,
    });
  });

  const numberingNodes = ['c2', 'm3', 'b1', 'a0', 'c1', 'm1', 'b3', 'm4', 'c3', 'b2', 'm2'];
  const numberingEdges = (): WeightedEdge[] => [
    ...clique(['m1', 'm2', 'm3', 'm4']),
    ...clique(['c1', 'c2', 'c3']),
    ...clique(['b1', 'b2', 'b3']),
  ];
  const expectedNumbering = {
    m1: 0, m2: 0, m3: 0, m4: 0,
    b1: 1, b2: 1, b3: 1,
    c1: 2, c2: 2, c3: 2,
    a0: 3,
  };

  it('AC-10-03 numbers communities by member count descending, then smallest member id', () => {
    const result = louvain(numberingNodes, numberingEdges());
    expect(asObject(result)).toEqual(expectedNumbering);
  });

  it('AC-10-03 is deterministic for the same input', () => {
    const first = louvain(numberingNodes, numberingEdges());
    const second = louvain(numberingNodes, numberingEdges());
    expect(asObject(second)).toEqual(asObject(first));
    const firstTwo = louvain([...aIds, ...bIds, 'iso'], twoCliqueEdges());
    const secondTwo = louvain([...aIds, ...bIds, 'iso'], twoCliqueEdges());
    expect(asObject(secondTwo)).toEqual(asObject(firstTwo));
  });

  it('AC-10-03 numbering does not depend on input node order for the same partition', () => {
    const sorted = [...numberingNodes].sort();
    const reversed = [...sorted].reverse();
    expect(asObject(louvain(sorted, numberingEdges()))).toEqual(expectedNumbering);
    expect(asObject(louvain(reversed, numberingEdges()))).toEqual(expectedNumbering);
  });
});

// ---------- pageRank ----------

describe('pageRank', () => {
  const starNodes = ['hub', 'l1', 'l2', 'l3', 'l4'];
  const starEdges = (): WeightedEdge[] => [
    { a: 'hub', b: 'l1', w: 1 },
    { a: 'l2', b: 'hub', w: 1 },
    { a: 'hub', b: 'l3', w: 1 },
    { a: 'l4', b: 'hub', w: 1 },
  ];

  it('AC-10-04 values sum to 1 and the centre of a star ranks highest', () => {
    const r = pageRank(starNodes, starEdges());
    expect(r.size).toBe(5);
    expect(Math.abs(sumValues(r) - 1)).toBeLessThan(1e-6);
    const hub = r.get('hub') as number;
    for (const leaf of ['l1', 'l2', 'l3', 'l4']) {
      expect(hub).toBeGreaterThan(r.get(leaf) as number);
    }
  });

  it('AC-10-04 star ranks match the damped stationary values (damping 0.85)', () => {
    const r = pageRank(starNodes, starEdges());
    // fixed point: hub = 0.15/5 + 0.85 * (1 - hub)  ->  hub = 0.88 / 1.85
    expect(r.get('hub') as number).toBeCloseTo(0.88 / 1.85, 3);
    for (const leaf of ['l1', 'l2', 'l3', 'l4']) {
      expect(r.get(leaf) as number).toBeCloseTo((1 - 0.88 / 1.85) / 4, 3);
    }
    const l1 = r.get('l1') as number;
    expect(Math.abs((r.get('l4') as number) - l1)).toBeLessThan(1e-9);
  });

  it('AC-10-04 an empty graph gives an empty map', () => {
    const r = pageRank([], []);
    expect(r).toBeInstanceOf(Map);
    expect(r.size).toBe(0);
  });

  it('AC-10-04 nodes without edges still get rank and the total stays 1', () => {
    const r = pageRank([...starNodes, 'lonely'], starEdges());
    expect(r.size).toBe(6);
    expect(Math.abs(sumValues(r) - 1)).toBeLessThan(1e-6);
    expect(r.get('lonely') as number).toBeGreaterThan(0);
    expect(r.get('hub') as number).toBeGreaterThan(r.get('lonely') as number);
  });

  it('AC-10-04 damping 0 gives a uniform distribution', () => {
    const r = pageRank(starNodes, starEdges(), { damping: 0 });
    for (const id of starNodes) {
      expect(r.get(id) as number).toBeCloseTo(0.2, 9);
    }
  });
});

// ---------- analyzeGraph: communities ----------

function communityGraph(): GraphData {
  const yTopics = ['t:css', 't:dom', 't:html', 't:http', 't:json', 't:web'];
  return build(
    [
      S('s1', { project: 'zed', started_at: '2026-03-05T10:00:00Z' }),
      S('s2', { project: 'zed', started_at: '2026-01-20T08:00:00Z' }),
      S('s3', { project: 'beta', started_at: 'not a date' }),
      S('s4', { project: 'gamma', started_at: '2026-02-01T00:00:00Z' }),
      S('s5', { project: 42 }),
      S('s6', { project: 'delta', started_at: '2025-12-31T23:00:00Z' }),
      S('s7'),
      S('s8'),
      T('t:rust', 'Rust'), T('t:cli', 'CLI'), T('t:tests', 'Tests'), T('t:async', 'Async'),
      T('t:css', 'Css'), T('t:dom', 'Dom'), T('t:html', 'Html'),
      T('t:http', 'Http'), T('t:json', 'Json'), T('t:web', 'Web'),
      T('t:solo', 'Solo'),
      T('t:orphan', 'Orphan'),
      F('f:main'),
    ],
    [
      L('s1', 't:rust'), L('s2', 't:rust'), L('t:rust', 's3'), L('s1', 't:rust', 'again'),
      L('s1', 't:cli'), L('s2', 't:cli'),
      L('s2', 't:tests'), L('s3', 't:tests'),
      L('s3', 't:async'),
      ...linkAll(['s4', 's5'], yTopics),
      L('s8', 't:solo'),
      L('s1', 'f:main', 'touched'),
    ],
  );
}

describe('analyzeGraph communities', () => {
  it('AC-10-05 builds communities with labels, sorted topics, projects, dates and ids by session count', () => {
    const a = analyzeGraph(communityGraph());
    const expected: Community[] = [
      {
        id: 0,
        label: 'Rust · CLI · Tests',
        topics: ['Rust', 'CLI', 'Tests', 'Async'],
        sessions: ['s1', 's2', 's3'],
        size: 3,
        projects: ['zed', 'beta'],
        firstAt: '2026-01-20T08:00:00Z',
        lastAt: '2026-03-05T10:00:00Z',
      },
      {
        id: 1,
        label: 'Css · Dom · Html',
        topics: ['Css', 'Dom', 'Html', 'Http', 'Json', 'Web'],
        sessions: ['s4', 's5'],
        size: 2,
        projects: ['gamma'],
        firstAt: '2026-02-01T00:00:00Z',
        lastAt: '2026-02-01T00:00:00Z',
      },
      {
        id: 2,
        label: 'Solo',
        topics: ['Solo'],
        sessions: ['s8'],
        size: 1,
        projects: [],
        firstAt: null,
        lastAt: null,
      },
      {
        id: 3,
        label: 'delta',
        topics: [],
        sessions: ['s6'],
        size: 1,
        projects: ['delta'],
        firstAt: '2025-12-31T23:00:00Z',
        lastAt: '2025-12-31T23:00:00Z',
      },
      {
        id: 4,
        label: 'Community 5',
        topics: [],
        sessions: ['s7'],
        size: 1,
        projects: [],
        firstAt: null,
        lastAt: null,
      },
    ];
    expect(a.communities).toEqual(expected);
  });

  it('AC-10-05 communityOf maps every session and topic of a community to its id, nothing else', () => {
    const a = analyzeGraph(communityGraph());
    expect(a.communityOf.get('s1')).toBe(0);
    expect(a.communityOf.get('s3')).toBe(0);
    expect(a.communityOf.get('t:rust')).toBe(0);
    expect(a.communityOf.get('t:async')).toBe(0);
    expect(a.communityOf.get('s4')).toBe(1);
    expect(a.communityOf.get('t:web')).toBe(1);
    expect(a.communityOf.get('s8')).toBe(2);
    expect(a.communityOf.get('t:solo')).toBe(2);
    expect(a.communityOf.get('s6')).toBe(3);
    expect(a.communityOf.get('s7')).toBe(4);
    expect(a.communityOf.has('t:orphan')).toBe(false);
    expect(a.communityOf.has('f:main')).toBe(false);
    expect(a.communityOf.size).toBe(19);
  });

  it('AC-10-05 rank covers session and topic ids only and sums to 1', () => {
    const a = analyzeGraph(communityGraph());
    expect(a.rank.size).toBe(20);
    expect(a.rank.has('f:main')).toBe(false);
    expect(a.rank.has('t:orphan')).toBe(true);
    expect(a.rank.has('s7')).toBe(true);
    expect(Math.abs(sumValues(a.rank) - 1)).toBeLessThan(1e-6);
  });

  it('AC-10-05 latestAt is the largest valid started_at of all sessions', () => {
    const a = analyzeGraph(communityGraph());
    expect(a.latestAt).toBe('2026-03-05T10:00:00Z');
  });
});

// ---------- bridges ----------

describe('analyzeGraph bridges', () => {
  it('AC-10-06 lists shared topics and projects with their community ids, ordered', () => {
    const a = analyzeGraph(bridgeGraph());
    expect(a.communities.map((c) => c.size)).toEqual([3, 3, 2]);
    expect(a.bridges).toEqual([
      { id: 'tri', label: 'Triad', type: 'topic', communities: [0, 1, 2] },
      { id: 'tx', label: 'Cross', type: 'topic', communities: [0, 1] },
      { id: 'p:shared', label: 'Shared', type: 'project', communities: [0, 1] },
    ]);
  });

  it('AC-10-06 a topic or project used inside one community is not a bridge', () => {
    const a = analyzeGraph(bridgeGraph());
    const ids = a.bridges.map((b) => b.id);
    expect(ids).not.toContain('ta1');
    expect(ids).not.toContain('tc2');
    expect(ids).not.toContain('p:solo');
    expect(ids).not.toContain('p:none');
  });

  it('AC-10-06 bridge community ids match the communities of the linked sessions', () => {
    const a = analyzeGraph(bridgeGraph());
    const tx = a.bridges.find((b) => b.id === 'tx');
    const expected = [a.communityOf.get('a1') as number, a.communityOf.get('b1') as number].sort(
      (x, y) => x - y,
    );
    expect(tx?.communities).toEqual(expected);
    expect(a.communityOf.get('a1')).not.toBe(a.communityOf.get('b1'));
  });
});

// ---------- one-off topics ----------

describe('analyzeGraph oneOffTopics', () => {
  it('AC-10-07 topics linked to exactly one session are one-offs, sorted by label then id', () => {
    const g = build(
      [
        S('s1'), S('s2'), S('s3'),
        T('t:m', 'Alpha'),
        T('t:z', 'Dup'),
        T('t:y', 'Dup'),
        T('t:two', 'Both'),
        T('t:none', 'None'),
        T('t:proj', 'Mixed'),
        P('p1', 'Proj'),
      ],
      [
        L('s1', 't:m'),
        L('s2', 't:z'),
        L('s3', 't:y'),
        L('t:y', 's3'),
        L('s1', 't:two'),
        L('s2', 't:two'),
        L('s1', 't:proj'),
        L('t:proj', 'p1'),
      ],
    );
    const a = analyzeGraph(g);
    expect(a.oneOffTopics.map((n) => n.id)).toEqual(['t:m', 't:y', 't:z', 't:proj']);
    expect(a.oneOffTopics.map((n) => n.label)).toEqual(['Alpha', 'Dup', 'Dup', 'Mixed']);
    for (const n of a.oneOffTopics) expect(n.type).toBe('topic');
  });

  it('AC-10-07 a topic used by two sessions is not a one-off', () => {
    const g = build(
      [S('s1'), S('s2'), T('t:shared', 'Shared'), T('t:single', 'Single')],
      [L('s1', 't:shared'), L('s2', 't:shared'), L('s2', 't:single')],
    );
    const a = analyzeGraph(g);
    expect(a.oneOffTopics.map((n) => n.id)).toEqual(['t:single']);
  });
});

// ---------- loose ends ----------

function looseGraph(): GraphData {
  return build(
    [
      S('n1', { started_at: '2026-06-30T00:00:00Z' }),
      S('o1', { started_at: '2026-05-01T00:00:00Z' }),
      S('o2', { started_at: '2026-05-31T00:00:00Z' }),
      S('o3', { started_at: '2026-05-30T23:59:59Z' }),
      S('o4', { started_at: '2026-05-01T00:00:00Z' }),
      S('w1', { started_at: '2026-06-15T00:00:00Z' }),
      S('u1'),
      S('g1', { started_at: '2026-01-01T00:00:00Z' }),
      S('g2', { started_at: '2026-01-02T00:00:00Z' }),
      S('g3', { started_at: '2026-01-03T00:00:00Z' }),
      S('g4', { started_at: '2026-01-04T00:00:00Z' }),
      S('h1', { started_at: '2026-03-01T00:00:00Z' }),
      S('h2', { started_at: '2026-03-10T00:00:00Z' }),
      S('h3', { started_at: '2026-02-01T00:00:00Z' }),
      T('tg1', 'G one'), T('tg2', 'G two'), T('th', 'H'),
    ],
    [
      ...linkAll(['g1', 'g2', 'g3', 'g4'], ['tg1', 'tg2']),
      ...linkAll(['h1', 'h2', 'h3'], ['th']),
    ],
  );
}

describe('analyzeGraph looseEnds', () => {
  it('AC-10-08 LOOSE_END_DAYS is 30', () => {
    expect(LOOSE_END_DAYS).toBe(30);
  });

  it('AC-10-08 small communities idle for more than 30 days are loose ends, newest first', () => {
    const a = analyzeGraph(looseGraph());
    expect(a.latestAt).toBe('2026-06-30T00:00:00Z');
    expect(a.looseEnds.map((c) => c.sessions)).toEqual([['o3'], ['o1'], ['o4'], ['h1', 'h2', 'h3']]);
    expect(a.looseEnds.map((c) => c.lastAt)).toEqual([
      '2026-05-30T23:59:59Z',
      '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
      '2026-03-10T00:00:00Z',
    ]);
  });

  it('AC-10-08 loose ends are the same Community objects as in communities', () => {
    const a = analyzeGraph(looseGraph());
    for (const le of a.looseEnds) {
      expect(le).toEqual(a.communities.find((c) => c.id === le.id));
    }
  });

  it('AC-10-08 excludes recent, exactly-30-day, undated and larger-than-3 communities', () => {
    const a = analyzeGraph(looseGraph());
    const sessions = a.looseEnds.flatMap((c) => c.sessions);
    expect(sessions).not.toContain('n1');
    expect(sessions).not.toContain('w1');
    expect(sessions).not.toContain('o2');
    expect(sessions).not.toContain('u1');
    expect(sessions).not.toContain('g1');
    const big = a.communities.find((c) => c.sessions.includes('g1'));
    expect(big?.size).toBe(4);
    expect(big?.lastAt).toBe('2026-01-04T00:00:00Z');
  });
});

// ---------- timeline ----------

describe('analyzeGraph timeline', () => {
  it('AC-10-09 groups dated sessions by month ascending with counts and top 3 topics', () => {
    const g = build(
      [
        S('a1', { started_at: '2026-01-05T09:00:00Z' }),
        S('a2', { started_at: '2026-01-20T09:00:00Z' }),
        S('a3', { started_at: '2026-01-28T09:00:00Z' }),
        S('b1', { started_at: '2026-03-02T09:00:00Z' }),
        S('b2', { started_at: '2026-03-15T09:00:00Z' }),
        S('c1', { started_at: '2025-11-30T22:00:00Z' }),
        S('u1'),
        S('u2', { started_at: 'garbage' }),
        T('t:rust', 'Rust'), T('t:bash', 'Bash'), T('t:docs', 'Docs'),
        T('t:alpha', 'Alpha'), T('t:css', 'Css'), T('t:web', 'Web'),
      ],
      [
        ...linkAll(['a1', 'a2', 'a3', 'b1', 'u1', 'u2'], ['t:rust']),
        ...linkAll(['a1', 'a2'], ['t:bash']),
        L('a3', 't:docs'),
        L('a2', 't:alpha'),
        ...linkAll(['b1', 'b2'], ['t:css']),
        L('b1', 't:web'),
      ],
    );
    const a = analyzeGraph(g);
    expect(a.timeline).toEqual([
      { month: '2025-11', sessions: 1, topTopics: [] },
      { month: '2026-01', sessions: 3, topTopics: ['Rust', 'Bash', 'Alpha'] },
      { month: '2026-03', sessions: 2, topTopics: ['Css', 'Rust', 'Web'] },
    ]);
  });

  it('AC-10-09 a graph with only undated sessions has an empty timeline', () => {
    const g = build([S('u1'), S('u2', { started_at: 'nope' }), T('t', 'T')], [L('u1', 't')]);
    const a = analyzeGraph(g);
    expect(a.timeline).toEqual([]);
    expect(a.latestAt).toBeNull();
  });
});

// ---------- empty, immutability, {id} endpoints ----------

describe('analyzeGraph robustness', () => {
  it('AC-10-10 an empty graph gives empty results and latestAt null', () => {
    const a = analyzeGraph(parseGraph({ nodes: [], links: [] }));
    expect(a.communities).toEqual([]);
    expect(a.bridges).toEqual([]);
    expect(a.timeline).toEqual([]);
    expect(a.oneOffTopics).toEqual([]);
    expect(a.looseEnds).toEqual([]);
    expect(a.latestAt).toBeNull();
    expect(a.communityOf.size).toBe(0);
    expect(a.rank.size).toBe(0);
    expect(sessionTopicGraph(parseGraph({ nodes: [], links: [] }))).toEqual({ nodes: [], edges: [] });
  });

  it('AC-10-10 does not mutate the input graph', () => {
    const g = communityGraph();
    const before = JSON.stringify(g);
    deepFreeze(g);
    const a = analyzeGraph(g);
    expect(JSON.stringify(g)).toBe(before);
    expect(a.communities).toHaveLength(5);
    sessionTopicGraph(g);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('AC-10-10 louvain and pageRank do not mutate their inputs', () => {
    const nodes = ['d', 'c', 'b', 'a'];
    const edges: WeightedEdge[] = [
      { a: 'd', b: 'c', w: 1 },
      { a: 'b', b: 'a', w: 2 },
    ];
    const before = JSON.stringify({ nodes, edges });
    deepFreeze(nodes);
    deepFreeze(edges);
    const c = louvain(nodes, edges);
    const r = pageRank(nodes, edges);
    expect(JSON.stringify({ nodes, edges })).toBe(before);
    expect(c.size).toBe(4);
    expect(r.size).toBe(4);
  });

  it('AC-10-10 {id} link endpoints give the same analysis as string endpoints', () => {
    const g = bridgeGraph();
    const gObj = withObjectEndpoints(g);
    expect(sessionTopicGraph(gObj)).toEqual(sessionTopicGraph(g));
    const a = analyzeGraph(g);
    const b = analyzeGraph(gObj);
    expect(b.bridges).toEqual([
      { id: 'tri', label: 'Triad', type: 'topic', communities: [0, 1, 2] },
      { id: 'tx', label: 'Cross', type: 'topic', communities: [0, 1] },
      { id: 'p:shared', label: 'Shared', type: 'project', communities: [0, 1] },
    ]);
    expect(b.communities).toEqual(a.communities);
    expect(asObject(b.communityOf)).toEqual(asObject(a.communityOf));
    expect(b.oneOffTopics.map((n) => n.id)).toEqual(a.oneOffTopics.map((n) => n.id));
    expect(b.timeline).toEqual(a.timeline);
  });

  it('AC-10-10 never throws for odd meta values and ignores non-string dates and projects', () => {
    const g = build(
      [
        S('s1', { started_at: 12345, project: { name: 'x' } }),
        S('s2', { started_at: null, project: null }),
        T('t1', 'Topic'),
      ],
      [L('s1', 't1'), L('s2', 't1')],
    );
    const a = analyzeGraph(g);
    expect(a.latestAt).toBeNull();
    expect(a.timeline).toEqual([]);
    expect(a.communities).toHaveLength(1);
    expect(a.communities[0].projects).toEqual([]);
    expect(a.communities[0].firstAt).toBeNull();
    expect(a.communities[0].lastAt).toBeNull();
    expect(a.communities[0].label).toBe('Topic');
  });
});
