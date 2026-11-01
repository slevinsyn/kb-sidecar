import { describe, it, expect } from 'vitest';
import { analyzeGraph, louvain, pageRank, sessionTopicGraph } from '../../src/analysis';
import type { WeightedEdge } from '../../src/analysis';
import { parseGraph } from '../../src/graph';
import type { GraphData, GraphNode, NodeType } from '../../src/graph';

type Raw = { id: string; type: NodeType; label: string; meta?: Record<string, unknown> };
type RawLink = { source: string; target: string; type: string };

const sess = (id: string, meta: Record<string, unknown> = {}): Raw => ({
  id,
  type: 'session',
  label: id.toUpperCase(),
  meta,
});
const top = (id: string, label: string): Raw => ({ id, type: 'topic', label });
const proj = (id: string, label: string): Raw => ({ id, type: 'project', label });
const ln = (source: string, target: string): RawLink => ({ source, target, type: 'x' });

function every(sessions: string[], topics: string[]): RawLink[] {
  return sessions.flatMap((s) => topics.map((t) => ln(s, t)));
}

function g(nodes: Raw[], links: RawLink[]): GraphData {
  return parseGraph({ nodes, links });
}

function obj(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) as number;
  return out;
}

function gn(id: string, type: NodeType, label: string): GraphNode {
  return { id, type, label, size: 1, meta: {} };
}

describe('hidden analysis tests', () => {
  it('AC-10-01 AC-10-10 sessionTopicGraph handles {id} endpoints, both directions and other node types', () => {
    const graph: GraphData = {
      nodes: [
        gn('sess-b', 'session', 'B'),
        gn('topic-y', 'topic', 'Y'),
        gn('sess-a', 'session', 'A'),
        gn('topic-x', 'topic', 'X'),
        gn('tool:Read', 'tool', 'Read'),
        gn('proj:k', 'project', 'K'),
        gn('file:/a', 'file', '/a'),
      ],
      links: [
        { source: { id: 'topic-y' }, target: 'sess-a', type: 'about' },
        { source: 'sess-b', target: { id: 'topic-y' }, type: 'about' },
        { source: { id: 'sess-a' }, target: { id: 'topic-y' }, type: 'dup' },
        { source: 'sess-a', target: 'tool:Read', type: 'used' },
        { source: 'topic-x', target: { id: 'proj:k' }, type: 'in' },
        { source: { id: 'file:/a' }, target: 'sess-b', type: 'touched' },
        { source: 'sess-a', target: 'sess-b', type: 'next' },
      ],
    };
    const before = JSON.stringify(graph);
    const st = sessionTopicGraph(graph);
    expect(st.nodes).toEqual(['sess-a', 'sess-b', 'topic-x', 'topic-y']);
    expect(st.edges).toEqual([
      { a: 'sess-a', b: 'topic-y', w: 1 },
      { a: 'sess-b', b: 'topic-y', w: 1 },
    ]);
    const a = analyzeGraph(graph);
    expect(JSON.stringify(graph)).toBe(before);
    expect(a.oneOffTopics).toEqual([]);
    expect(a.communities.map((c) => c.sessions)).toEqual([['sess-a', 'sess-b']]);
    expect(a.communities[0].label).toBe('Y');
  });

  it('AC-10-02 AC-10-03 weights decide the split of a 4-cycle, parallel edges add up', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const ab: WeightedEdge[] = [
      { a: 'a', b: 'b', w: 5 },
      { a: 'b', b: 'c', w: 1 },
      { a: 'c', b: 'd', w: 5 },
      { a: 'd', b: 'a', w: 1 },
    ];
    expect(obj(louvain(nodes, ab))).toEqual({ a: 0, b: 0, c: 1, d: 1, e: 2 });

    const bc: WeightedEdge[] = [
      { a: 'a', b: 'b', w: 1 },
      { a: 'c', b: 'b', w: 2.5 },
      { a: 'b', b: 'c', w: 2.5 },
      { a: 'c', b: 'd', w: 1 },
      { a: 'd', b: 'a', w: 5 },
      { a: 'e', b: 'e', w: 9 },
    ];
    const first = louvain(nodes, bc);
    expect(obj(first)).toEqual({ a: 0, d: 0, b: 1, c: 1, e: 2 });
    expect(obj(louvain(nodes, bc))).toEqual(obj(first));
  });

  it('AC-10-04 exact one-step values, dangling spread and weighted ranks', () => {
    const star: WeightedEdge[] = ['p', 'q', 'r', 's'].map((x) => ({ a: 'c', b: x, w: 1 }));
    const one = pageRank(['c', 'p', 'q', 'r', 's'], star, { iterations: 1 });
    expect(one.get('c') as number).toBeCloseTo(0.71, 9);
    expect(one.get('p') as number).toBeCloseTo(0.0725, 9);

    const dangling = pageRank(['c', 'p', 'q', 'r', 's', 'z'], star, { iterations: 1 });
    expect(dangling.get('c') as number).toBeCloseTo(0.025 + 0.85 * (4 / 6) + 0.85 / 36, 9);
    expect(dangling.get('p') as number).toBeCloseTo(0.025 + 0.85 / 24 + 0.85 / 36, 9);
    expect(dangling.get('z') as number).toBeCloseTo(0.025 + 0.85 / 36, 9);
    let total = 0;
    for (const v of dangling.values()) total += v;
    expect(Math.abs(total - 1)).toBeLessThan(1e-6);

    const path = pageRank(['x', 'y', 'w'], [
      { a: 'x', b: 'y', w: 3 },
      { a: 'y', b: 'w', w: 1 },
    ]);
    // stationary: y = 0.9 / 1.85, x = 0.05 + 0.85 * 0.75 * y, w = 0.05 + 0.85 * 0.25 * y
    const y = 0.9 / 1.85;
    expect(path.get('y') as number).toBeCloseTo(y, 3);
    expect(path.get('x') as number).toBeCloseTo(0.05 + 0.6375 * y, 3);
    expect(path.get('w') as number).toBeCloseTo(0.05 + 0.2125 * y, 3);
    expect(path.get('x') as number).toBeGreaterThan(path.get('w') as number);
  });

  it('AC-10-05 AC-10-06 member-count tie-break, two-topic label, Community N labels and the 20-bridge cap', () => {
    const projects: Raw[] = [];
    const projectLinks: RawLink[] = [];
    for (let i = 0; i < 22; i++) {
      const id = `p:${String(i).padStart(2, '0')}`;
      projects.push(proj(id, `Proj ${i}`));
      projectLinks.push(ln('x1', id), ln(id, 'x2'));
    }
    const graph = g(
      [
        sess('q1', { project: 'mango', started_at: '2026-04-02T00:00:00Z' }),
        sess('q2', { project: 'kiwi', started_at: '2026-04-01T00:00:00Z' }),
        sess('q3', { started_at: '' }),
        sess('r1'), sess('r2'), sess('r3'),
        sess('x1'), sess('x2'),
        top('t:pear', 'Pear'), top('t:fig', 'Fig'),
        top('u1', 'U1'), top('u2', 'U2'), top('u3', 'U3'),
        ...projects,
      ],
      [
        ...every(['q1', 'q2', 'q3'], ['t:pear']),
        ...every(['q1', 'q2'], ['t:fig']),
        ...every(['r1', 'r2', 'r3'], ['u1', 'u2', 'u3']),
        ...projectLinks,
      ],
    );
    const a = analyzeGraph(graph);
    expect(a.communities).toEqual([
      {
        id: 0,
        label: 'U1 · U2 · U3',
        topics: ['U1', 'U2', 'U3'],
        sessions: ['r1', 'r2', 'r3'],
        size: 3,
        projects: [],
        firstAt: null,
        lastAt: null,
      },
      {
        id: 1,
        label: 'Pear · Fig',
        topics: ['Pear', 'Fig'],
        sessions: ['q1', 'q2', 'q3'],
        size: 3,
        projects: ['kiwi', 'mango'],
        firstAt: '2026-04-01T00:00:00Z',
        lastAt: '2026-04-02T00:00:00Z',
      },
      {
        id: 2,
        label: 'Community 3',
        topics: [],
        sessions: ['x1'],
        size: 1,
        projects: [],
        firstAt: null,
        lastAt: null,
      },
      {
        id: 3,
        label: 'Community 4',
        topics: [],
        sessions: ['x2'],
        size: 1,
        projects: [],
        firstAt: null,
        lastAt: null,
      },
    ]);
    expect(a.bridges).toHaveLength(20);
    expect(a.bridges.map((b) => b.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `p:${String(i).padStart(2, '0')}`),
    );
    for (const b of a.bridges) {
      expect(b.type).toBe('project');
      expect(b.communities).toEqual([2, 3]);
    }
    expect(a.latestAt).toBe('2026-04-02T00:00:00Z');
  });

  it('AC-10-07 AC-10-08 one-offs and loose-end boundaries with other dates', () => {
    const graph = g(
      [
        sess('k0', { started_at: '2026-09-15T12:00:00Z' }),
        sess('e1', { started_at: '2026-08-01T12:00:00Z' }),
        sess('e2', { started_at: '2026-08-16T12:00:00Z' }),
        sess('e3', { started_at: '2026-08-16T11:59:59Z' }),
        sess('f1', { started_at: '2026-01-01T00:00:00Z' }),
        sess('f2', { started_at: '2026-02-01T00:00:00Z' }),
        ...['g1', 'g2', 'g3', 'g4', 'g5'].map((id, i) =>
          sess(id, { started_at: `2025-0${i + 1}-10T00:00:00Z` }),
        ),
        top('tf', 'Shared F'),
        top('tg', 'Shared G'),
        top('t:omega', 'Omega'),
        top('t:kappa', 'Kappa'),
        top('t:fileonly', 'FileOnly'),
        { id: 'file:x', type: 'file', label: 'x' },
      ],
      [
        ...every(['f1', 'f2'], ['tf']),
        ...every(['g1', 'g2', 'g3', 'g4', 'g5'], ['tg']),
        ln('t:omega', 'e1'),
        ln('e2', 't:kappa'),
        ln('t:fileonly', 'file:x'),
      ],
    );
    const a = analyzeGraph(graph);
    expect(a.oneOffTopics.map((n) => n.id)).toEqual(['t:kappa', 't:omega']);
    expect(a.latestAt).toBe('2026-09-15T12:00:00Z');
    expect(a.looseEnds.map((c) => c.sessions)).toEqual([['e3'], ['e1'], ['f1', 'f2']]);
    expect(a.looseEnds.map((c) => c.lastAt)).toEqual([
      '2026-08-16T11:59:59Z',
      '2026-08-01T12:00:00Z',
      '2026-02-01T00:00:00Z',
    ]);
  });

  it('AC-10-09 timeline ties broken by label and date-only strings accepted', () => {
    const graph = g(
      [
        sess('m0', { started_at: '2024-12-31' }),
        sess('m1', { started_at: '2026-07-04T10:00:00Z' }),
        sess('m2', { started_at: '2026-07-19T10:00:00Z' }),
        sess('m3', { started_at: '' }),
        top('t:d', 'Delta'), top('t:c', 'Charlie'), top('t:b', 'Bravo'),
        top('t:e', 'Echo'), top('t:z', 'Zulu'),
      ],
      [
        ln('m1', 't:d'), ln('m2', 't:c'), ln('m1', 't:b'),
        ln('m1', 't:e'), ln('t:e', 'm2'),
        ln('m0', 't:z'), ln('m3', 't:z'), ln('m3', 't:e'),
      ],
    );
    const a = analyzeGraph(graph);
    expect(a.timeline).toEqual([
      { month: '2024-12', sessions: 1, topTopics: ['Zulu'] },
      { month: '2026-07', sessions: 2, topTopics: ['Echo', 'Bravo', 'Charlie'] },
    ]);
  });
});
