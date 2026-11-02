import { describe, it, expect } from 'vitest';
import {
  ISLAND_RADIUS,
  LAYER_Z,
  Z_SPAN,
  bridgeIds,
  brightnessMap,
  islandCenters,
  layerZ,
  nodeSize,
  recency,
  timeAxis,
} from '../src/scene3d';
import { analyzeGraph } from '../src/analysis';
import type { Analysis, Bridge, Community } from '../src/analysis';
import { linkEnd, parseGraph } from '../src/graph';
import type { GraphData, GraphNode, NodeType } from '../src/graph';

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

function build(nodes: RawNode[], links: RawLink[]): GraphData {
  return parseGraph({ nodes, links });
}

// ISO date `n` days after 2026-01-01T00:00:00Z.
function day(n: number): string {
  return new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function gn(id: string, type: NodeType, meta: Record<string, unknown> = {}): GraphNode {
  return { id, type, label: id, size: 1, meta };
}

function comm(id: number): Community {
  return {
    id,
    label: `Community ${id + 1}`,
    topics: [],
    sessions: [],
    size: 0,
    projects: [],
    firstAt: null,
    lastAt: null,
  };
}

function mkAnalysis(over: Partial<Analysis> = {}): Analysis {
  return {
    communityOf: new Map(),
    communities: [],
    rank: new Map(),
    bridges: [],
    oneOffTopics: [],
    looseEnds: [],
    timeline: [],
    latestAt: null,
    ...over,
  };
}

// ---------- constants ----------

describe('scene3d constants', () => {
  it('AC-13-05 Z_SPAN is 600 and ISLAND_RADIUS is 200', () => {
    expect(Z_SPAN).toBe(600);
    expect(ISLAND_RADIUS).toBe(200);
  });
});

// ---------- timeAxis ----------

describe('timeAxis', () => {
  it('AC-13-01 puts the earliest session at -300, the latest at +300 and others proportionally', () => {
    const g = build(
      [
        S('late', { started_at: day(20) }),
        S('early', { started_at: day(0) }),
        S('mid', { started_at: day(10) }),
        S('quarter', { started_at: day(5) }),
      ],
      [],
    );
    const z = timeAxis(g);
    expect(z).toBeInstanceOf(Map);
    expect(z.get('early')).toBeCloseTo(-300, 9);
    expect(z.get('late')).toBeCloseTo(300, 9);
    expect(z.get('mid')).toBeCloseTo(0, 9);
    expect(z.get('quarter')).toBeCloseTo(-150, 9);
    expect(z.size).toBe(4);
  });

  it('AC-13-01 spacing follows real time, not rank order', () => {
    const g = build(
      [
        S('a', { started_at: day(0) }),
        S('b', { started_at: day(1) }),
        S('c', { started_at: day(100) }),
      ],
      [],
    );
    const z = timeAxis(g);
    expect(z.get('a')).toBeCloseTo(-300, 9);
    expect(z.get('b')).toBeCloseTo((1 / 100 - 0.5) * 600, 9);
    expect(z.get('c')).toBeCloseTo(300, 9);
  });

  it('AC-13-02 gives 0 to every session when all dates are equal', () => {
    const g = build(
      [
        S('a', { started_at: day(3) }),
        S('b', { started_at: day(3) }),
        S('c', { started_at: day(3) }),
        T('t', 'Topic'),
      ],
      [L('a', 't'), L('b', 't')],
    );
    const z = timeAxis(g);
    expect(z.get('a')).toBeCloseTo(0, 9);
    expect(z.get('b')).toBeCloseTo(0, 9);
    expect(z.get('c')).toBeCloseTo(0, 9);
    expect(z.get('t')).toBeCloseTo(0, 9);
  });

  it('AC-13-02 gives 0 when only one session is dated and leaves the rest absent', () => {
    const g = build(
      [S('dated', { started_at: day(7) }), S('none'), S('bad', { started_at: 'not a date' })],
      [],
    );
    const z = timeAxis(g);
    expect(z.get('dated')).toBeCloseTo(0, 9);
    expect(z.has('none')).toBe(false);
    expect(z.has('bad')).toBe(false);
    expect(z.size).toBe(1);
  });

  it('AC-13-02 undated sessions, files and tools are absent from the map', () => {
    const g = build(
      [
        S('s1', { started_at: day(0) }),
        S('s2', { started_at: day(4) }),
        S('missing'),
        S('garbage', { started_at: 'garbage' }),
        S('numeric', { started_at: 12345 }),
        F('f:main'),
        X('tool:Read'),
      ],
      [L('s1', 'f:main'), L('s2', 'tool:Read'), L('missing', 'f:main')],
    );
    const z = timeAxis(g);
    expect([...z.keys()].sort()).toEqual(['s1', 's2']);
  });

  it('AC-13-02 an undated session does not stretch the range', () => {
    const g = build(
      [S('a', { started_at: day(0) }), S('b', { started_at: day(2) }), S('u', {})],
      [],
    );
    const z = timeAxis(g);
    expect(z.get('a')).toBeCloseTo(-300, 9);
    expect(z.get('b')).toBeCloseTo(300, 9);
  });

  it('AC-13-02 an empty graph gives an empty map', () => {
    const z = timeAxis(parseGraph({ nodes: [], links: [] }));
    expect(z).toBeInstanceOf(Map);
    expect(z.size).toBe(0);
  });

  function topicGraph(): GraphData {
    return build(
      [
        S('s1', { started_at: day(0) }),
        S('s2', { started_at: day(5) }),
        S('s3', { started_at: day(20) }),
        S('su'),
        T('t:both', 'Both'),
        T('t:once', 'Once'),
        T('t:mixed', 'Mixed'),
        T('t:undated', 'Undated only'),
        T('t:none', 'No links'),
        P('p:a', 'Project A'),
        P('p:b', 'Project B'),
      ],
      [
        // t:both: s1 (-300) three times in different shapes, s3 (+300) once -> mean 0
        L('s1', 't:both', 'about'),
        L('s1', 't:both', 'again'),
        L('t:both', 's1', 'reverse'),
        L('t:both', 's3', 'about'),
        // t:once: s2 only
        L('t:once', 's2'),
        // t:mixed: s2 (-150) and s3 (300), plus an undated session
        L('s2', 't:mixed'),
        L('s3', 't:mixed'),
        L('su', 't:mixed'),
        // t:undated: only an undated session
        L('su', 't:undated'),
        // projects
        L('s1', 'p:a', 'in_project'),
        L('p:a', 's2', 'in_project'),
        L('s3', 'p:b', 'in_project'),
        L('t:both', 'p:b'),
      ],
    );
  }

  it('AC-13-03 places a topic at the mean z of its dated sessions, each counted once', () => {
    const z = timeAxis(topicGraph());
    expect(z.get('t:both')).toBeCloseTo(0, 9);
    expect(z.get('t:once')).toBeCloseTo(-150, 9);
    expect(z.get('t:mixed')).toBeCloseTo(75, 9);
  });

  it('AC-13-03 places a project at the mean z of its dated sessions in either link direction', () => {
    const z = timeAxis(topicGraph());
    expect(z.get('p:a')).toBeCloseTo(-225, 9);
    expect(z.get('p:b')).toBeCloseTo(300, 9);
  });

  it('AC-13-03 a topic with no dated session, or no links at all, is absent', () => {
    const z = timeAxis(topicGraph());
    expect(z.has('t:undated')).toBe(false);
    expect(z.has('t:none')).toBe(false);
    expect(z.has('su')).toBe(false);
  });

  it('AC-13-03 {id} link ends give the same result as string ends', () => {
    const g = topicGraph();
    const a = timeAxis(g);
    const b = timeAxis(withObjectEndpoints(g));
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [id, v] of a) expect(b.get(id)).toBeCloseTo(v, 9);
  });

  it('AC-13-03 does not mutate the input graph', () => {
    const g = topicGraph();
    const before = JSON.stringify(g);
    deepFreeze(g);
    const z = timeAxis(g);
    expect(z.size).toBeGreaterThan(0);
    expect(JSON.stringify(g)).toBe(before);
  });
});

// ---------- islandCenters ----------

describe('islandCenters', () => {
  it('AC-13-04 places 4 communities on a circle of radius 200 in order', () => {
    const c = islandCenters(mkAnalysis({ communities: [comm(0), comm(1), comm(2), comm(3)] }));
    expect(c.size).toBe(4);
    const expected: Array<[number, number]> = [
      [200, 0],
      [0, 200],
      [-200, 0],
      [0, -200],
    ];
    expected.forEach(([x, y], i) => {
      const p = c.get(i);
      expect(p).toBeDefined();
      expect(p?.x).toBeCloseTo(x, 6);
      expect(p?.y).toBeCloseTo(y, 6);
    });
  });

  it('AC-13-04 places 3 communities 120 degrees apart', () => {
    const c = islandCenters(mkAnalysis({ communities: [comm(0), comm(1), comm(2)] }));
    expect(c.get(0)?.x).toBeCloseTo(200, 6);
    expect(c.get(0)?.y).toBeCloseTo(0, 6);
    expect(c.get(1)?.x).toBeCloseTo(-100, 6);
    expect(c.get(1)?.y).toBeCloseTo(200 * Math.sin((2 * Math.PI) / 3), 6);
    expect(c.get(2)?.x).toBeCloseTo(-100, 6);
    expect(c.get(2)?.y).toBeCloseTo(-200 * Math.sin((2 * Math.PI) / 3), 6);
  });

  it('AC-13-04 every centre lies exactly on the circle', () => {
    const comms = Array.from({ length: 7 }, (_, i) => comm(i));
    const c = islandCenters(mkAnalysis({ communities: comms }));
    expect(c.size).toBe(7);
    for (const p of c.values()) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(200, 6);
    }
  });

  it('AC-13-04 a single community sits at the origin', () => {
    const c = islandCenters(mkAnalysis({ communities: [comm(0)] }));
    expect(c.size).toBe(1);
    expect(c.get(0)?.x).toBeCloseTo(0, 9);
    expect(c.get(0)?.y).toBeCloseTo(0, 9);
  });

  it('AC-13-04 no communities gives an empty map', () => {
    const c = islandCenters(mkAnalysis());
    expect(c).toBeInstanceOf(Map);
    expect(c.size).toBe(0);
  });

  it('AC-13-04 works on a real analysis: one centre per community, keyed by id', () => {
    const g = build(
      [
        S('a1'), S('a2'), S('b1'), S('b2'), S('c1'),
        T('ta', 'A'), T('tb', 'B'), T('tc', 'C'),
      ],
      [L('a1', 'ta'), L('a2', 'ta'), L('b1', 'tb'), L('b2', 'tb'), L('c1', 'tc')],
    );
    const a = analyzeGraph(g);
    expect(a.communities).toHaveLength(3);
    const c = islandCenters(a);
    expect([...c.keys()].sort()).toEqual(a.communities.map((x) => x.id).sort());
    expect(c.get(a.communities[0].id)?.x).toBeCloseTo(200, 6);
  });
});

// ---------- layerZ ----------

describe('layerZ', () => {
  it('AC-13-05 returns -200 for project, 0 for session, 200 for topic', () => {
    expect(layerZ('project')).toBe(-200);
    expect(layerZ('session')).toBe(0);
    expect(layerZ('topic')).toBe(200);
  });

  it('AC-13-05 files and tools sit on the session layer', () => {
    expect(layerZ('file')).toBe(0);
    expect(layerZ('tool')).toBe(0);
  });

  it('AC-13-05 LAYER_Z holds the same values for all five types', () => {
    expect(LAYER_Z.project).toBe(-200);
    expect(LAYER_Z.session).toBe(0);
    expect(LAYER_Z.topic).toBe(200);
    expect(LAYER_Z.file).toBe(0);
    expect(LAYER_Z.tool).toBe(0);
    const types: NodeType[] = ['project', 'session', 'topic', 'file', 'tool'];
    for (const t of types) expect(layerZ(t)).toBe(LAYER_Z[t]);
  });
});

// ---------- nodeSize ----------

describe('nodeSize', () => {
  const ranks = new Map<string, number>([
    ['top', 0.4],
    ['half', 0.2],
    ['low', 0.1],
    ['zero', 0],
  ]);
  const a = mkAnalysis({ rank: ranks });

  it('AC-13-06 a session with turns uses a log scale: 3 + 2*log2(1+turns)', () => {
    expect(nodeSize(gn('s', 'session', { turns: 1 }), a)).toBeCloseTo(5, 9);
    expect(nodeSize(gn('s', 'session', { turns: 3 }), a)).toBeCloseTo(7, 9);
    expect(nodeSize(gn('s', 'session', { turns: 7 }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('s', 'session', { turns: 15 }), a)).toBeCloseTo(11, 9);
  });

  it('AC-13-06 session size from turns ignores its rank', () => {
    const withRank = mkAnalysis({ rank: new Map([['s', 0.9], ['other', 0.1]]) });
    expect(nodeSize(gn('s', 'session', { turns: 3 }), withRank)).toBeCloseTo(7, 9);
  });

  it('AC-13-06 turns are capped at 15', () => {
    expect(nodeSize(gn('s', 'session', { turns: 1023 }), a)).toBe(15);
    expect(nodeSize(gn('s', 'session', { turns: 1e9 }), a)).toBe(15);
    expect(nodeSize(gn('s', 'session', { turns: 4095 }), a)).toBe(15);
  });

  it('AC-13-06 a topic uses rank relative to the largest rank', () => {
    expect(nodeSize(gn('top', 'topic'), a)).toBeCloseTo(15, 9);
    expect(nodeSize(gn('half', 'topic'), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('low', 'topic'), a)).toBeCloseTo(6, 9);
    expect(nodeSize(gn('zero', 'topic'), a)).toBeCloseTo(3, 9);
  });

  it('AC-13-06 a node missing from rank counts as rank 0', () => {
    expect(nodeSize(gn('unknown', 'topic'), a)).toBeCloseTo(3, 9);
    expect(nodeSize(gn('f', 'file'), a)).toBeCloseTo(3, 9);
  });

  it('AC-13-06 a session without usable turns falls back to rank', () => {
    expect(nodeSize(gn('half', 'session'), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: 0 }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: -4 }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: 'many' }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: '7' }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: null }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: NaN }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(gn('half', 'session', { turns: Infinity }), a)).toBeCloseTo(9, 9);
  });

  it('AC-13-06 turns on a non-session node are ignored', () => {
    expect(nodeSize(gn('half', 'topic', { turns: 3 }), a)).toBeCloseTo(9, 9);
  });

  it('AC-13-06 is 3 when every rank is 0 or the rank map is empty', () => {
    const allZero = mkAnalysis({ rank: new Map([['x', 0], ['y', 0]]) });
    expect(nodeSize(gn('x', 'topic'), allZero)).toBe(3);
    expect(nodeSize(gn('x', 'session'), allZero)).toBe(3);
    expect(nodeSize(gn('x', 'topic'), mkAnalysis())).toBe(3);
  });

  it('AC-13-06 always stays within 3..15', () => {
    const nodes: GraphNode[] = [
      gn('top', 'topic'),
      gn('zero', 'topic'),
      gn('nope', 'tool'),
      gn('s1', 'session', { turns: 0.0001 }),
      gn('s2', 'session', { turns: 1 }),
      gn('s3', 'session', { turns: 100000 }),
      gn('s4', 'session', { turns: -1 }),
    ];
    for (const n of nodes) {
      const v = nodeSize(n, a);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it('AC-13-06 works with a real analysis and parsed nodes', () => {
    const g = build(
      [S('s1', { turns: 3 }), S('s2'), T('t1', 'One'), T('t2', 'Two')],
      [L('s1', 't1'), L('s2', 't1'), L('s2', 't2')],
    );
    const an = analyzeGraph(g);
    const s1 = g.nodes.find((n) => n.id === 's1') as GraphNode;
    expect(nodeSize(s1, an)).toBeCloseTo(7, 9);
    const m = Math.max(...an.rank.values());
    const t1 = g.nodes.find((n) => n.id === 't1') as GraphNode;
    expect(nodeSize(t1, an)).toBeCloseTo(3 + (12 * (an.rank.get('t1') as number)) / m, 9);
  });
});

// ---------- recency ----------

describe('recency', () => {
  const latest = '2026-06-30T00:00:00Z';

  it('AC-13-07 is 1 for the latest date itself', () => {
    expect(recency(latest, latest)).toBeCloseTo(1, 9);
  });

  it('AC-13-07 is 0.25 at exactly 180 days and beyond', () => {
    expect(recency('2026-01-01T00:00:00Z', latest)).toBeCloseTo(0.25, 9);
    expect(recency('2025-06-30T00:00:00Z', latest)).toBeCloseTo(0.25, 9);
    expect(recency('2000-01-01T00:00:00Z', latest)).toBeCloseTo(0.25, 9);
  });

  it('AC-13-07 is linear between: 90 days gives 0.625, 18 days gives 0.925', () => {
    expect(recency('2026-04-01T00:00:00Z', latest)).toBeCloseTo(0.625, 9);
    expect(recency('2026-06-12T00:00:00Z', latest)).toBeCloseTo(0.925, 9);
    expect(recency('2026-01-02T00:00:00Z', latest)).toBeCloseTo(1 - 0.75 * (179 / 180), 9);
  });

  it('AC-13-07 a date after latestAt counts as age 0', () => {
    expect(recency('2026-07-15T00:00:00Z', latest)).toBeCloseTo(1, 9);
  });

  it('AC-13-07 returns 0.5 when the date is missing or invalid', () => {
    expect(recency(undefined, latest)).toBe(0.5);
    expect(recency('not a date', latest)).toBe(0.5);
    expect(recency('', latest)).toBe(0.5);
  });

  it('AC-13-07 returns 0.5 when latestAt is missing or invalid', () => {
    expect(recency('2026-06-01T00:00:00Z', null)).toBe(0.5);
    expect(recency('2026-06-01T00:00:00Z', 'garbage')).toBe(0.5);
    expect(recency(undefined, null)).toBe(0.5);
  });
});

// ---------- brightnessMap ----------

describe('brightnessMap', () => {
  function brightGraph(): GraphData {
    return build(
      [
        S('new', { started_at: '2026-06-30T00:00:00Z' }),
        S('mid', { started_at: '2026-04-01T00:00:00Z' }),
        S('old', { started_at: '2025-01-01T00:00:00Z' }),
        S('undated'),
        S('bad', { started_at: 'garbage' }),
        T('t:newest', 'Newest'),
        T('t:mid', 'Mid only'),
        T('t:undated', 'Undated only'),
        T('t:unlinked', 'Unlinked'),
        T('t:oldmid', 'Old and mid'),
        P('p:main', 'Main'),
        P('p:none', 'No sessions'),
        F('f:a'),
        X('tool:Bash'),
      ],
      [
        L('new', 't:newest'),
        L('t:newest', 'mid'),
        L('mid', 't:mid'),
        L('undated', 't:undated'),
        L('bad', 't:undated'),
        L('old', 't:oldmid'),
        L('t:oldmid', 'mid'),
        L('mid', 'p:main', 'in_project'),
        L('p:main', 'undated', 'in_project'),
        L('new', 'f:a', 'touched'),
        L('new', 'tool:Bash', 'used'),
        L('t:mid', 'f:a'),
      ],
    );
  }

  it('AC-13-08 has an entry for every node', () => {
    const g = brightGraph();
    const b = brightnessMap(g, analyzeGraph(g));
    expect(b.size).toBe(g.nodes.length);
    for (const n of g.nodes) expect(b.has(n.id)).toBe(true);
  });

  it('AC-13-08 sessions use recency of their own date against latestAt', () => {
    const g = brightGraph();
    const an = analyzeGraph(g);
    expect(an.latestAt).toBe('2026-06-30T00:00:00Z');
    const b = brightnessMap(g, an);
    expect(b.get('new')).toBeCloseTo(1, 9);
    expect(b.get('mid')).toBeCloseTo(0.625, 9);
    expect(b.get('old')).toBeCloseTo(0.25, 9);
    expect(b.get('undated')).toBe(0.5);
    expect(b.get('bad')).toBe(0.5);
  });

  it('AC-13-08 topics take the brightness of their newest linked session', () => {
    const g = brightGraph();
    const b = brightnessMap(g, analyzeGraph(g));
    expect(b.get('t:newest')).toBeCloseTo(1, 9);
    expect(b.get('t:mid')).toBeCloseTo(0.625, 9);
    expect(b.get('t:oldmid')).toBeCloseTo(0.625, 9);
  });

  it('AC-13-08 projects take the newest dated session, ignoring undated ones', () => {
    const g = brightGraph();
    const b = brightnessMap(g, analyzeGraph(g));
    expect(b.get('p:main')).toBeCloseTo(0.625, 9);
  });

  it('AC-13-08 undated-only, unlinked, file and tool nodes get 0.5', () => {
    const g = brightGraph();
    const b = brightnessMap(g, analyzeGraph(g));
    expect(b.get('t:undated')).toBe(0.5);
    expect(b.get('t:unlinked')).toBe(0.5);
    expect(b.get('p:none')).toBe(0.5);
    expect(b.get('f:a')).toBe(0.5);
    expect(b.get('tool:Bash')).toBe(0.5);
  });

  it('AC-13-08 {id} link ends give the same result as string ends', () => {
    const g = brightGraph();
    const an = analyzeGraph(g);
    const a = brightnessMap(g, an);
    const b = brightnessMap(withObjectEndpoints(g), an);
    expect(b.size).toBe(a.size);
    for (const [id, v] of a) expect(b.get(id)).toBeCloseTo(v, 9);
  });

  it('AC-13-08 an empty graph gives an empty map and nothing is mutated', () => {
    const empty = parseGraph({ nodes: [], links: [] });
    expect(brightnessMap(empty, analyzeGraph(empty)).size).toBe(0);

    const g = brightGraph();
    const an = analyzeGraph(g);
    const before = JSON.stringify(g);
    deepFreeze(g);
    const b = brightnessMap(g, an);
    expect(b.size).toBe(g.nodes.length);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('AC-13-08 with no dated session at all, every node is 0.5', () => {
    const g = build([S('a'), S('b', { started_at: 'x' }), T('t', 'T')], [L('a', 't')]);
    const b = brightnessMap(g, analyzeGraph(g));
    expect(b.get('a')).toBe(0.5);
    expect(b.get('b')).toBe(0.5);
    expect(b.get('t')).toBe(0.5);
  });
});

// ---------- bridgeIds ----------

describe('bridgeIds', () => {
  function bridge(id: string, type: NodeType, communities: number[]): Bridge {
    return { id, label: id.toUpperCase(), type, communities };
  }

  it('AC-13-09 returns exactly the ids of a.bridges', () => {
    const a = mkAnalysis({
      bridges: [bridge('t:one', 'topic', [0, 1]), bridge('p:two', 'project', [1, 2]), bridge('t:three', 'topic', [0, 2])],
    });
    const ids = bridgeIds(a);
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(['p:two', 't:one', 't:three']);
    expect(ids.has('t:one')).toBe(true);
    expect(ids.has('t:other')).toBe(false);
  });

  it('AC-13-09 an empty analysis gives an empty set', () => {
    const ids = bridgeIds(mkAnalysis());
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
  });

  it('AC-13-09 matches the bridges of a real analysis and excludes non-bridges', () => {
    const links: RawLink[] = [];
    for (const s of ['a1', 'a2', 'a3']) for (const t of ['ta1', 'ta2']) links.push(L(s, t));
    for (const s of ['b1', 'b2', 'b3']) for (const t of ['tb1', 'tb2']) links.push(L(s, t));
    links.push(L('a1', 'tx'), L('b1', 'tx'));
    links.push(L('a2', 'p:shared', 'in_project'), L('b2', 'p:shared', 'in_project'));
    links.push(L('a1', 'p:solo', 'in_project'), L('a3', 'p:solo', 'in_project'));
    const g = build(
      [
        S('a1'), S('a2'), S('a3'), S('b1'), S('b2'), S('b3'),
        T('ta1', 'A one'), T('ta2', 'A two'), T('tb1', 'B one'), T('tb2', 'B two'),
        T('tx', 'Cross'),
        P('p:shared', 'Shared'), P('p:solo', 'Solo'),
      ],
      links,
    );
    const an = analyzeGraph(g);
    const ids = bridgeIds(an);
    expect([...ids].sort()).toEqual(an.bridges.map((b) => b.id).sort());
    expect([...ids].sort()).toEqual(['p:shared', 'tx']);
    expect(ids.has('ta1')).toBe(false);
    expect(ids.has('p:solo')).toBe(false);
  });

  it('AC-13-09 an empty parsed graph has no bridge ids', () => {
    const an = analyzeGraph(parseGraph({ nodes: [], links: [] }));
    expect(bridgeIds(an).size).toBe(0);
  });
});
