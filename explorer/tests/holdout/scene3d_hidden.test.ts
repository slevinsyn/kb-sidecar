import { describe, it, expect } from 'vitest';
import {
  LAYER_Z,
  bridgeIds,
  brightnessMap,
  islandCenters,
  layerZ,
  nodeSize,
  recency,
  timeAxis,
} from '../../src/scene3d';
import { analyzeGraph } from '../../src/analysis';
import type { Analysis, Community } from '../../src/analysis';
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
const other = (id: string, type: NodeType): Raw => ({ id, type, label: id });
const ln = (source: string, target: string): RawLink => ({ source, target, type: 'x' });

function g(nodes: Raw[], links: RawLink[]): GraphData {
  return parseGraph({ nodes, links });
}

function node(id: string, type: NodeType, meta: Record<string, unknown> = {}): GraphNode {
  return { id, type, label: id, size: 1, meta };
}

function comm(id: number): Community {
  return {
    id,
    label: `C${id}`,
    topics: [],
    sessions: [],
    size: 0,
    projects: [],
    firstAt: null,
    lastAt: null,
  };
}

function an(over: Partial<Analysis> = {}): Analysis {
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

describe('hidden scene3d tests', () => {
  it('AC-13-01 AC-13-03 time axis with other dates, offsets and project/topic means', () => {
    const graph: GraphData = {
      nodes: [
        node('x3', 'session', { started_at: '2025-03-11T00:00:00Z' }),
        node('x1', 'session', { started_at: '2025-03-01T00:00:00Z' }),
        node('x2', 'session', { started_at: '2025-03-04T00:00:00Z' }),
        node('x4', 'session', { started_at: '2025-03-06T02:00:00+02:00' }),
        node('tp', 'topic'),
        node('pr', 'project'),
        node('ta', 'topic'),
        node('fl', 'file'),
      ],
      links: [
        { source: { id: 'x2' }, target: 'tp', type: 'a' },
        { source: 'tp', target: { id: 'x3' }, type: 'a' },
        { source: 'x2', target: { id: 'tp' }, type: 'b' },
        { source: 'pr', target: 'x1', type: 'in' },
        { source: { id: 'x4' }, target: { id: 'pr' }, type: 'in' },
        { source: 'x3', target: 'pr', type: 'in' },
        { source: 'ta', target: 'fl', type: 'in' },
        { source: 'tp', target: 'ta', type: 'rel' },
      ],
    };
    const z = timeAxis(graph);
    expect(z.get('x1')).toBeCloseTo(-300, 9);
    expect(z.get('x3')).toBeCloseTo(300, 9);
    expect(z.get('x2')).toBeCloseTo((0.3 - 0.5) * 600, 9);
    expect(z.get('x4')).toBeCloseTo((0.5 - 0.5) * 600, 9);
    expect(z.get('tp')).toBeCloseTo((-120 + 300) / 2, 9);
    expect(z.get('pr')).toBeCloseTo((-300 + 0 + 300) / 3, 9);
    expect(z.has('ta')).toBe(false);
    expect(z.has('fl')).toBe(false);
    expect(z.size).toBe(6);
  });

  it('AC-13-02 equal dates and a single dated session both collapse to z = 0', () => {
    const same = g(
      [
        sess('q1', { started_at: '2024-02-29T12:00:00Z' }),
        sess('q2', { started_at: '2024-02-29T12:00:00Z' }),
        sess('q3'),
        top('tq', 'Q'),
        proj('pq', 'PQ'),
        other('fq', 'file'),
        other('xq', 'tool'),
      ],
      [ln('q1', 'tq'), ln('pq', 'q2'), ln('q3', 'tq'), ln('q1', 'fq'), ln('q2', 'xq')],
    );
    const z = timeAxis(same);
    expect([...z.keys()].sort()).toEqual(['pq', 'q1', 'q2', 'tq']);
    for (const v of z.values()) expect(v).toBeCloseTo(0, 9);

    const one = g([sess('only', { started_at: '2023-05-05T05:05:05Z' }), sess('nodate')], []);
    const z1 = timeAxis(one);
    expect([...z1.keys()]).toEqual(['only']);
    expect(z1.get('only')).toBeCloseTo(0, 9);
  });

  it('AC-13-04 islands are keyed by community id in order of a.communities', () => {
    const c = islandCenters(an({ communities: [comm(7), comm(3)] }));
    expect([...c.keys()].sort()).toEqual([3, 7]);
    expect(c.get(7)?.x).toBeCloseTo(200, 6);
    expect(c.get(7)?.y).toBeCloseTo(0, 6);
    expect(c.get(3)?.x).toBeCloseTo(-200, 6);
    expect(c.get(3)?.y).toBeCloseTo(0, 6);

    const six = islandCenters(an({ communities: [0, 1, 2, 3, 4, 5].map(comm) }));
    expect(six.get(1)?.x).toBeCloseTo(100, 6);
    expect(six.get(1)?.y).toBeCloseTo(200 * Math.sin(Math.PI / 3), 6);
    expect(six.get(4)?.x).toBeCloseTo(-100, 6);
    expect(six.get(4)?.y).toBeCloseTo(-200 * Math.sin(Math.PI / 3), 6);

    const solo = islandCenters(an({ communities: [comm(4)] }));
    expect(solo.get(4)?.x).toBeCloseTo(0, 9);
    expect(solo.get(4)?.y).toBeCloseTo(0, 9);
    expect(islandCenters(an()).size).toBe(0);
  });

  it('AC-13-05 layerZ agrees with LAYER_Z for every node type', () => {
    const expected: Record<NodeType, number> = {
      project: -200,
      session: 0,
      topic: 200,
      file: 0,
      tool: 0,
    };
    for (const t of Object.keys(expected) as NodeType[]) {
      expect(layerZ(t)).toBe(expected[t]);
      expect(LAYER_Z[t]).toBe(expected[t]);
    }
  });

  it('AC-13-06 nodeSize log scale, cap boundary and rank fallback with other numbers', () => {
    const a = an({ rank: new Map([['hi', 0.5], ['mid', 0.125], ['sess', 0.25]]) });
    expect(nodeSize(node('s', 'session', { turns: 2 }), a)).toBeCloseTo(3 + 2 * Math.log2(3), 9);
    expect(nodeSize(node('s', 'session', { turns: 63 }), a)).toBeCloseTo(15, 9);
    expect(nodeSize(node('s', 'session', { turns: 64 }), a)).toBe(15);
    expect(nodeSize(node('s', 'session', { turns: 31 }), a)).toBeCloseTo(13, 9);
    expect(nodeSize(node('hi', 'topic'), a)).toBeCloseTo(15, 9);
    expect(nodeSize(node('mid', 'project'), a)).toBeCloseTo(6, 9);
    expect(nodeSize(node('sess', 'session', { turns: 0 }), a)).toBeCloseTo(9, 9);
    expect(nodeSize(node('sess', 'session'), a)).toBeCloseTo(9, 9);
    expect(nodeSize(node('nowhere', 'topic'), a)).toBe(3);
    expect(nodeSize(node('hi', 'topic'), an({ rank: new Map([['hi', 0]]) }))).toBe(3);
  });

  it('AC-13-07 recency with a different anchor date', () => {
    const latest = '2025-12-31T12:00:00Z';
    expect(recency('2025-12-31T12:00:00Z', latest)).toBeCloseTo(1, 9);
    expect(recency('2025-10-02T12:00:00Z', latest)).toBeCloseTo(1 - 0.75 * (90 / 180), 9);
    expect(recency('2025-12-01T12:00:00Z', latest)).toBeCloseTo(1 - 0.75 * (30 / 180), 9);
    expect(recency('2025-07-04T12:00:00Z', latest)).toBeCloseTo(0.25, 9);
    expect(recency('1999-12-31T12:00:00Z', latest)).toBeCloseTo(0.25, 9);
    expect(recency('2026-02-01T12:00:00Z', latest)).toBeCloseTo(1, 9);
    expect(recency('nonsense', latest)).toBe(0.5);
    expect(recency(undefined, latest)).toBe(0.5);
    expect(recency(latest, null)).toBe(0.5);
    expect(recency(latest, 'nonsense')).toBe(0.5);
  });

  it('AC-13-08 brightness of topics, projects and unlinked nodes with other dates', () => {
    const graph = g(
      [
        sess('n', { started_at: '2025-12-31T12:00:00Z' }),
        sess('m', { started_at: '2025-10-02T12:00:00Z' }),
        sess('o', { started_at: '2024-01-01T00:00:00Z' }),
        sess('u'),
        top('tn', 'TN'),
        top('tm', 'TM'),
        top('to', 'TO'),
        top('tu', 'TU'),
        top('tz', 'TZ'),
        proj('pm', 'PM'),
        proj('pu', 'PU'),
        other('fi', 'file'),
        other('to1', 'tool'),
      ],
      [
        ln('tn', 'o'),
        ln('n', 'tn'),
        ln('m', 'tm'),
        ln('o', 'to'),
        ln('u', 'tu'),
        ln('pm', 'u'),
        ln('o', 'pm'),
        ln('m', 'pm'),
        ln('u', 'pu'),
        ln('n', 'fi'),
        ln('n', 'to1'),
        ln('tz', 'tu'),
      ],
    );
    const analysis = analyzeGraph(graph);
    expect(analysis.latestAt).toBe('2025-12-31T12:00:00Z');
    const b = brightnessMap(graph, analysis);
    expect(b.size).toBe(graph.nodes.length);
    const mid = 1 - 0.75 * 0.5;
    expect(b.get('n')).toBeCloseTo(1, 9);
    expect(b.get('m')).toBeCloseTo(mid, 9);
    expect(b.get('o')).toBeCloseTo(0.25, 9);
    expect(b.get('u')).toBe(0.5);
    expect(b.get('tn')).toBeCloseTo(1, 9);
    expect(b.get('tm')).toBeCloseTo(mid, 9);
    expect(b.get('to')).toBeCloseTo(0.25, 9);
    expect(b.get('pm')).toBeCloseTo(mid, 9);
    for (const id of ['tu', 'tz', 'pu', 'fi', 'to1']) expect(b.get(id)).toBe(0.5);
  });

  it('AC-13-09 bridgeIds picks exactly the bridge ids from a three-theme analysis', () => {
    const links: RawLink[] = [];
    for (const s of ['a1', 'a2', 'a3']) for (const t of ['ta1', 'ta2']) links.push(ln(s, t));
    for (const s of ['b1', 'b2', 'b3']) for (const t of ['tb1', 'tb2']) links.push(ln(s, t));
    links.push(ln('a1', 'hx'), ln('b1', 'hx'));
    links.push(ln('pj', 'a2'), ln('b2', 'pj'));
    links.push(ln('b1', 'pin'), ln('pin', 'b3'));
    const graph = g(
      [
        sess('a1'), sess('a2'), sess('a3'), sess('b1'), sess('b2'), sess('b3'),
        top('ta1', 'TA1'), top('ta2', 'TA2'), top('tb1', 'TB1'), top('tb2', 'TB2'),
        top('hx', 'HX'),
        proj('pj', 'PJ'),
        proj('pin', 'PIN'),
      ],
      links,
    );
    const analysis = analyzeGraph(graph);
    const ids = bridgeIds(analysis);
    expect([...ids].sort()).toEqual(['hx', 'pj']);
    expect(ids.size).toBe(analysis.bridges.length);
    expect(bridgeIds(an()).size).toBe(0);
  });
});
