import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_PALETTE,
  DEFAULT_VIEW_TYPES,
  UNASSIGNED_COLOR,
  clusterLabels,
  communityColor,
  monthRange,
  viewGraph,
} from '../src/view';
import { linkEnd, parseGraph } from '../src/graph';
import type { GraphData, GraphLink, GraphNode, NodeType } from '../src/graph';
import { analyzeGraph } from '../src/analysis';
import type { Analysis, Community } from '../src/analysis';

function node(
  id: string,
  type: NodeType,
  label: string = id,
  meta: Record<string, unknown> = {},
): GraphNode {
  return { id, type, label, size: 1, meta };
}

function session(id: string, startedAt?: unknown): GraphNode {
  return node(id, 'session', id, startedAt === undefined ? {} : { started_at: startedAt });
}

function link(source: string | { id: string }, target: string | { id: string }): GraphLink {
  return { source, target, type: 'rel' };
}

function ids(nodes: GraphNode[]): string[] {
  return nodes.map((n) => n.id);
}

function edgeKeys(links: GraphLink[]): string[] {
  return links.map((l) => `${linkEnd(l.source)}->${linkEnd(l.target)}`).sort();
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

function community(id: number, label: string, sessions: string[]): Community {
  return {
    id,
    label,
    topics: [],
    sessions,
    size: sessions.length,
    projects: [],
    firstAt: null,
    lastAt: null,
  };
}

function analysis(over: Partial<Analysis>): Analysis {
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

describe('communityColor and palette', () => {
  it('AC-12-01 palette has 12 distinct #rrggbb colours', () => {
    expect(COMMUNITY_PALETTE).toHaveLength(12);
    for (const c of COMMUNITY_PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(new Set(COMMUNITY_PALETTE.map((c) => c.toLowerCase())).size).toBe(12);
  });

  it('AC-12-01 UNASSIGNED_COLOR is the grey constant', () => {
    expect(UNASSIGNED_COLOR).toBe('#8a8f98');
  });

  it('AC-12-01 communityColor maps ids 0..11 to the palette in order', () => {
    for (let i = 0; i < 12; i++) {
      expect(communityColor(i)).toBe(COMMUNITY_PALETTE[i]);
    }
  });

  it('AC-12-01 communityColor wraps around after 12', () => {
    expect(communityColor(12)).toBe(COMMUNITY_PALETTE[0]);
    expect(communityColor(13)).toBe(COMMUNITY_PALETTE[1]);
    expect(communityColor(25)).toBe(COMMUNITY_PALETTE[1]);
    expect(communityColor(35)).toBe(COMMUNITY_PALETTE[11]);
  });

  it('AC-12-01 communityColor returns UNASSIGNED_COLOR for undefined', () => {
    expect(communityColor(undefined)).toBe(UNASSIGNED_COLOR);
  });

  it('AC-12-01 communityColor returns UNASSIGNED_COLOR for negative ids', () => {
    expect(communityColor(-1)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(-12)).toBe(UNASSIGNED_COLOR);
  });

  it('AC-12-01 communityColor returns UNASSIGNED_COLOR for fractional and non-finite ids', () => {
    expect(communityColor(1.5)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(0.1)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(Number.NaN)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(Number.POSITIVE_INFINITY)).toBe(UNASSIGNED_COLOR);
  });
});

describe('DEFAULT_VIEW_TYPES', () => {
  it('AC-12-02 is session, project, topic', () => {
    expect([...DEFAULT_VIEW_TYPES]).toEqual(['session', 'project', 'topic']);
  });
});

describe('viewGraph type filtering', () => {
  const g: GraphData = {
    nodes: [
      session('s1'),
      node('p1', 'project'),
      node('t1', 'topic'),
      node('f1', 'file'),
      node('tool1', 'tool'),
    ],
    links: [
      link('s1', 'p1'),
      link('s1', 't1'),
      link('s1', 'f1'),
      link({ id: 'tool1' }, { id: 's1' }),
      link('t1', 'f1'),
      link('p1', 't1'),
    ],
  };

  it('AC-12-02 default types remove file and tool nodes', () => {
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES });
    expect(ids(out.nodes)).toEqual(['s1', 'p1', 't1']);
  });

  it('AC-12-02 default types remove every link touching file or tool nodes', () => {
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES });
    expect(edgeKeys(out.links)).toEqual(['p1->t1', 's1->p1', 's1->t1']);
  });

  it('AC-12-02 switching files and tools on brings them back with their links', () => {
    const out = viewGraph(g, { types: ['session', 'project', 'topic', 'file', 'tool'] });
    expect(ids(out.nodes)).toEqual(['s1', 'p1', 't1', 'f1', 'tool1']);
    expect(out.links).toHaveLength(6);
  });

  it('AC-12-02 accepts any iterable of types', () => {
    const out = viewGraph(g, { types: new Set<NodeType>(['session', 'tool']) });
    expect(ids(out.nodes)).toEqual(['s1', 'tool1']);
    expect(edgeKeys(out.links)).toEqual(['tool1->s1']);
  });
});

describe('viewGraph month range', () => {
  const g: GraphData = {
    nodes: [
      session('jan', '2025-01-10T09:00:00Z'),
      session('feb', '2025-02-15T09:00:00Z'),
      session('mar', '2025-03-01T00:00:00Z'),
      session('none'),
      session('num', 20250210),
      node('projA', 'project'),
      node('projB', 'project'),
      node('topJan', 'topic'),
      node('topFeb', 'topic'),
      node('topShared', 'topic'),
      node('topNone', 'topic'),
    ],
    links: [
      link('jan', 'projA'),
      link('feb', 'projA'),
      link('mar', 'projB'),
      link('jan', 'topJan'),
      link('feb', 'topFeb'),
      link('jan', 'topShared'),
      link('mar', 'topShared'),
      link('none', 'topNone'),
      link('topJan', 'projA'),
      link('topFeb', 'projB'),
    ],
  };
  const types = DEFAULT_VIEW_TYPES;

  it('AC-12-03 keeps only sessions inside the range, inclusive on both ends', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-01', toMonth: '2025-02' });
    const sessions = out.nodes.filter((n) => n.type === 'session');
    expect(ids(sessions)).toEqual(['jan', 'feb']);
  });

  it('AC-12-03 a single-month range keeps exactly that month', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-02', toMonth: '2025-02' });
    expect(ids(out.nodes.filter((n) => n.type === 'session'))).toEqual(['feb']);
  });

  it('AC-12-03 open lower end keeps everything up to toMonth', () => {
    const out = viewGraph(g, { types, toMonth: '2025-01' });
    expect(ids(out.nodes.filter((n) => n.type === 'session'))).toEqual(['jan']);
  });

  it('AC-12-03 open upper end keeps everything from fromMonth', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-02', toMonth: null });
    expect(ids(out.nodes.filter((n) => n.type === 'session'))).toEqual(['feb', 'mar']);
  });

  it('AC-12-03 drops sessions with missing or non-string started_at', () => {
    const out = viewGraph(g, { types, fromMonth: '2000-01', toMonth: '2099-12' });
    expect(ids(out.nodes.filter((n) => n.type === 'session'))).toEqual(['jan', 'feb', 'mar']);
  });

  it('AC-12-03 removes topics and projects no longer linked to a kept session', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-02', toMonth: '2025-02' });
    expect(ids(out.nodes)).toEqual(['feb', 'projA', 'topFeb']);
  });

  it('AC-12-03 keeps a topic shared with another session when one of them survives', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-03', toMonth: '2025-03' });
    expect(ids(out.nodes)).toEqual(['mar', 'projB', 'topShared']);
  });

  it('AC-12-03 removes links whose endpoints are not both kept', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-02', toMonth: '2025-02' });
    expect(edgeKeys(out.links)).toEqual(['feb->projA', 'feb->topFeb']);
  });

  it('AC-12-03 keeps links between non-session nodes when both ends survive', () => {
    const out = viewGraph(g, { types, fromMonth: '2025-01', toMonth: '2025-01' });
    expect(ids(out.nodes)).toEqual(['jan', 'projA', 'topJan', 'topShared']);
    expect(edgeKeys(out.links)).toEqual(['jan->projA', 'jan->topJan', 'jan->topShared', 'topJan->projA']);
  });

  it('AC-12-03 a range that matches no session leaves an empty graph', () => {
    const out = viewGraph(g, { types, fromMonth: '2030-01', toMonth: '2030-12' });
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('AC-12-03 the range also applies when file nodes are switched on', () => {
    const withFiles: GraphData = {
      nodes: [
        session('a', '2025-05-01'),
        session('b', '2025-06-01'),
        node('fa', 'file'),
        node('fb', 'file'),
      ],
      links: [link('a', 'fa'), link('b', 'fb')],
    };
    const out = viewGraph(withFiles, {
      types: ['session', 'file'],
      fromMonth: '2025-06',
      toMonth: '2025-06',
    });
    expect(ids(out.nodes)).toEqual(['b', 'fb']);
    expect(edgeKeys(out.links)).toEqual(['b->fb']);
  });
});

describe('viewGraph without range, pruning and purity', () => {
  it('AC-12-04 without a range undated sessions are kept', () => {
    const g: GraphData = {
      nodes: [session('dated', '2025-04-01'), session('undated'), node('t', 'topic')],
      links: [link('undated', 't')],
    };
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES });
    expect(ids(out.nodes)).toEqual(['dated', 'undated', 't']);
    expect(edgeKeys(out.links)).toEqual(['undated->t']);
  });

  it('AC-12-04 empty-string and null months mean no range', () => {
    const g: GraphData = {
      nodes: [session('undated'), session('dated', '2025-04-01')],
      links: [],
    };
    expect(ids(viewGraph(g, { types: ['session'], fromMonth: '', toMonth: '' }).nodes)).toEqual([
      'undated',
      'dated',
    ]);
    expect(ids(viewGraph(g, { types: ['session'], fromMonth: null, toMonth: null }).nodes)).toEqual([
      'undated',
      'dated',
    ]);
  });

  it('AC-12-04 without session in the types nothing is pruned for lack of a session', () => {
    const g: GraphData = {
      nodes: [
        session('s1', '2025-01-01'),
        node('t1', 'topic'),
        node('t2', 'topic'),
        node('f1', 'file'),
      ],
      links: [link('s1', 't1'), link('t1', 'f1')],
    };
    const out = viewGraph(g, { types: ['topic', 'file'], fromMonth: '2030-01' });
    expect(ids(out.nodes)).toEqual(['t1', 't2', 'f1']);
    expect(edgeKeys(out.links)).toEqual(['t1->f1']);
  });

  it('AC-12-04 with session in the types, nodes with no session link are pruned', () => {
    const g: GraphData = {
      nodes: [session('s1', '2025-01-01'), node('t1', 'topic'), node('orphan', 'topic')],
      links: [link('s1', 't1')],
    };
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES });
    expect(ids(out.nodes)).toEqual(['s1', 't1']);
  });

  it('AC-12-04 session links count in either direction and as {id} endpoints', () => {
    const g: GraphData = {
      nodes: [session('s1', '2025-01-01'), node('a', 'topic'), node('b', 'project')],
      links: [link({ id: 'a' }, { id: 's1' }), link({ id: 's1' }, { id: 'b' })],
    };
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES });
    expect(ids(out.nodes)).toEqual(['s1', 'a', 'b']);
    expect(out.links).toHaveLength(2);
  });

  it('AC-12-04 returns link endpoints as strings', () => {
    const g: GraphData = {
      nodes: [session('s1', '2025-01-01'), node('a', 'topic')],
      links: [link({ id: 's1' }, { id: 'a' })],
    };
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES });
    expect(out.links).toEqual([{ source: 's1', target: 'a', type: 'rel' }]);
    expect(typeof out.links[0].source).toBe('string');
    expect(typeof out.links[0].target).toBe('string');
  });

  it('AC-12-04 keeps the original node order', () => {
    const g: GraphData = {
      nodes: [
        node('z', 'topic'),
        session('m', '2025-01-01'),
        node('a', 'project'),
        session('b', '2025-01-02'),
      ],
      links: [link('m', 'z'), link('b', 'a')],
    };
    expect(ids(viewGraph(g, { types: DEFAULT_VIEW_TYPES }).nodes)).toEqual(['z', 'm', 'a', 'b']);
  });

  it('AC-12-04 does not mutate the input graph', () => {
    const g: GraphData = {
      nodes: [session('s1', '2025-01-01'), session('s2', '2025-09-01'), node('t', 'topic')],
      links: [link({ id: 's1' }, 't'), link('s2', 't')],
    };
    const copy = structuredClone(g);
    deepFreeze(g);
    const out = viewGraph(g, { types: DEFAULT_VIEW_TYPES, fromMonth: '2025-01', toMonth: '2025-02' });
    expect(g).toEqual(copy);
    expect(out.nodes).not.toBe(g.nodes);
    expect(out.links).not.toBe(g.links);
  });

  it('AC-12-04 an empty graph gives an empty graph', () => {
    const out = viewGraph({ nodes: [], links: [] }, { types: DEFAULT_VIEW_TYPES });
    expect(out).toEqual({ nodes: [], links: [] });
  });
});

describe('clusterLabels', () => {
  const a = analysis({
    communities: [
      community(0, 'Alpha theme', ['s-a', 's-b', 's-c']),
      community(1, 'Beta theme', ['s-d', 's-e']),
      community(2, 'Gamma theme', ['s-f']),
    ],
    rank: new Map<string, number>([
      ['s-a', 0.05],
      ['s-b', 0.2],
      ['s-c', 0.1],
      ['s-d', 0.3],
      ['s-e', 0.01],
      ['s-f', 0.07],
      ['topic-x', 0.9],
    ]),
  });

  it('AC-12-05 returns one label per community in community order', () => {
    const out = clusterLabels(a);
    expect(out.map((l) => l.community)).toEqual([0, 1, 2]);
    expect(out.map((l) => l.label)).toEqual(['Alpha theme', 'Beta theme', 'Gamma theme']);
  });

  it('AC-12-05 anchors each label at the highest-ranked session of the community', () => {
    const out = clusterLabels(a);
    expect(out.map((l) => l.nodeId)).toEqual(['s-b', 's-d', 's-f']);
  });

  it('AC-12-05 label objects have exactly community, label and nodeId', () => {
    expect(clusterLabels(a)[0]).toEqual({ community: 0, label: 'Alpha theme', nodeId: 's-b' });
  });

  it('AC-12-05 honours an explicit limit', () => {
    const out = clusterLabels(a, 2);
    expect(out.map((l) => l.community)).toEqual([0, 1]);
    expect(clusterLabels(a, 1)).toHaveLength(1);
    expect(clusterLabels(a, 0)).toEqual([]);
  });

  it('AC-12-05 defaults the limit to 12', () => {
    const many = analysis({
      communities: Array.from({ length: 15 }, (_, i) => community(i, `C${i}`, [`s${i}`])),
      rank: new Map(Array.from({ length: 15 }, (_, i) => [`s${i}`, 0.1] as [string, number])),
    });
    const out = clusterLabels(many);
    expect(out).toHaveLength(12);
    expect(out[11].community).toBe(11);
    expect(clusterLabels(many, 15)).toHaveLength(15);
  });

  it('AC-12-05 ties on rank go to the smallest session id', () => {
    const tie = analysis({
      communities: [community(0, 'Tie', ['s-c', 's-a', 's-b'])],
      rank: new Map<string, number>([
        ['s-a', 0.2],
        ['s-b', 0.2],
        ['s-c', 0.2],
      ]),
    });
    expect(clusterLabels(tie)[0].nodeId).toBe('s-a');
  });

  it('AC-12-05 skips communities that have no sessions', () => {
    const withEmpty = analysis({
      communities: [community(0, 'Real', ['s1']), community(1, 'Empty', []), community(2, 'Also', ['s2'])],
      rank: new Map<string, number>([
        ['s1', 0.5],
        ['s2', 0.5],
      ]),
    });
    const out = clusterLabels(withEmpty);
    expect(out.map((l) => l.community)).toEqual([0, 2]);
  });

  it('AC-12-05 returns an empty array for an analysis without communities', () => {
    expect(clusterLabels(analysis({}))).toEqual([]);
  });

  it('AC-12-05 works on a real analysis of a parsed graph', () => {
    const g = parseGraph({
      nodes: [
        { id: 's1', type: 'session', label: 'S1', meta: { started_at: '2025-01-01T00:00:00Z' } },
        { id: 's2', type: 'session', label: 'S2', meta: { started_at: '2025-01-02T00:00:00Z' } },
        { id: 's3', type: 'session', label: 'S3', meta: { started_at: '2025-01-03T00:00:00Z' } },
        { id: 't1', type: 'topic', label: 'Rust' },
      ],
      links: [
        { source: 's1', target: 't1' },
        { source: 's2', target: 't1' },
        { source: 's3', target: 't1' },
      ],
    });
    const an = analyzeGraph(g);
    const out = clusterLabels(an);
    expect(out).toHaveLength(1);
    expect(out[0].community).toBe(an.communities[0].id);
    expect(out[0].label).toBe(an.communities[0].label);
    expect(['s1', 's2', 's3']).toContain(out[0].nodeId);
    const best = Math.max(...['s1', 's2', 's3'].map((s) => an.rank.get(s) ?? 0));
    expect(an.rank.get(out[0].nodeId)).toBe(best);
  });
});

describe('monthRange', () => {
  it('AC-12-06 returns the timeline months in order', () => {
    const a = analysis({
      timeline: [
        { month: '2024-11', sessions: 2, topTopics: [] },
        { month: '2025-01', sessions: 1, topTopics: ['x'] },
        { month: '2025-04', sessions: 5, topTopics: [] },
      ],
    });
    expect(monthRange(a)).toEqual(['2024-11', '2025-01', '2025-04']);
  });

  it('AC-12-06 returns an empty array when the timeline is empty', () => {
    expect(monthRange(analysis({}))).toEqual([]);
  });

  it('AC-12-06 returns [] for the analysis of an empty graph', () => {
    expect(monthRange(analyzeGraph(parseGraph({ nodes: [], links: [] })))).toEqual([]);
  });

  it('AC-12-06 matches the months of a real analysis, skipping undated sessions', () => {
    const g = parseGraph({
      nodes: [
        { id: 'a', type: 'session', label: 'A', meta: { started_at: '2025-03-05T10:00:00Z' } },
        { id: 'b', type: 'session', label: 'B', meta: { started_at: '2025-01-20T10:00:00Z' } },
        { id: 'c', type: 'session', label: 'C', meta: { started_at: '2025-01-21T10:00:00Z' } },
        { id: 'd', type: 'session', label: 'D' },
      ],
      links: [],
    });
    expect(monthRange(analyzeGraph(g))).toEqual(['2025-01', '2025-03']);
  });
});

describe('dependencies', () => {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  it('AC-12-07 package.json lists force-graph in dependencies', () => {
    expect(pkg.dependencies).toBeDefined();
    expect(Object.keys(pkg.dependencies ?? {})).toContain('force-graph');
    expect(typeof pkg.dependencies?.['force-graph']).toBe('string');
    expect((pkg.dependencies?.['force-graph'] ?? '').length).toBeGreaterThan(0);
  });

  it('AC-12-07 package.json keeps 3d-force-graph for the 3D toggle', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toContain('3d-force-graph');
  });
});
