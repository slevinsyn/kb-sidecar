import { describe, it, expect } from 'vitest';
import {
  COMMUNITY_PALETTE,
  UNASSIGNED_COLOR,
  clusterLabels,
  communityColor,
  monthRange,
  viewGraph,
} from '../../src/view';
import { linkEnd, parseGraph } from '../../src/graph';
import type { GraphData } from '../../src/graph';
import { analyzeGraph } from '../../src/analysis';
import type { Analysis, Community } from '../../src/analysis';

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

function emptyAnalysis(over: Partial<Analysis>): Analysis {
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

describe('hidden: communityColor', () => {
  it('AC-12-01 wraps large ids modulo 12', () => {
    expect(communityColor(120)).toBe(COMMUNITY_PALETTE[0]);
    expect(communityColor(121)).toBe(COMMUNITY_PALETTE[1]);
    expect(communityColor(1000)).toBe(COMMUNITY_PALETTE[1000 % 12]);
  });

  it('AC-12-01 rejects -0.5, -Infinity and NaN as unassigned', () => {
    expect(communityColor(-0.5)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(Number.NEGATIVE_INFINITY)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(Number.NaN)).toBe(UNASSIGNED_COLOR);
    expect(communityColor(7.0001)).toBe(UNASSIGNED_COLOR);
  });

  it('AC-12-01 palette colours are all valid and none equals the unassigned grey', () => {
    for (const c of COMMUNITY_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(COMMUNITY_PALETTE.map((c) => c.toLowerCase())).not.toContain(UNASSIGNED_COLOR);
  });
});

describe('hidden: viewGraph', () => {
  const g: GraphData = {
    nodes: [
      { id: 'x1', type: 'session', label: 'x1', size: 1, meta: { started_at: '2024-12-31T23:59:59Z' } },
      { id: 'x2', type: 'session', label: 'x2', size: 1, meta: { started_at: '2025-01-01T00:00:00Z' } },
      { id: 'x3', type: 'session', label: 'x3', size: 1, meta: { started_at: '2025-06-15' } },
      { id: 'x4', type: 'session', label: 'x4', size: 1, meta: { started_at: 'not-a-date' } },
      { id: 'x5', type: 'session', label: 'x5', size: 1, meta: {} },
      { id: 'pr', type: 'project', label: 'pr', size: 1, meta: {} },
      { id: 'tp1', type: 'topic', label: 'tp1', size: 1, meta: {} },
      { id: 'tp2', type: 'topic', label: 'tp2', size: 1, meta: {} },
      { id: 'fl', type: 'file', label: 'fl', size: 1, meta: {} },
      { id: 'tl', type: 'tool', label: 'tl', size: 1, meta: {} },
    ],
    links: [
      { source: 'x1', target: 'pr', type: 'a' },
      { source: { id: 'x2' }, target: { id: 'tp1' }, type: 'b' },
      { source: 'tp2', target: 'x3', type: 'c' },
      { source: 'x4', target: 'tp2', type: 'd' },
      { source: 'x5', target: 'fl', type: 'e' },
      { source: 'x2', target: 'tl', type: 'f' },
      { source: 'pr', target: 'tp1', type: 'g' },
    ],
  };

  it('AC-12-02 default-like types drop file and tool and their links only', () => {
    const out = viewGraph(g, { types: ['session', 'project', 'topic'] });
    expect(out.nodes.map((n) => n.id)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'pr', 'tp1', 'tp2']);
    const keys = out.links.map((l) => `${linkEnd(l.source)}>${linkEnd(l.target)}`).sort();
    expect(keys).toEqual(['pr>tp1', 'tp2>x3', 'x1>pr', 'x2>tp1', 'x4>tp2']);
  });

  it('AC-12-03 fromMonth alone drops sessions before it and unparsable dates', () => {
    const out = viewGraph(g, { types: ['session', 'project', 'topic'], fromMonth: '2025-01' });
    expect(out.nodes.map((n) => n.id)).toEqual(['x2', 'x3', 'tp1', 'tp2']);
  });

  it('AC-12-03 pruned links disappear together with their nodes', () => {
    const out = viewGraph(g, { types: ['session', 'project', 'topic'], fromMonth: '2025-01' });
    const keys = out.links.map((l) => `${linkEnd(l.source)}>${linkEnd(l.target)}`).sort();
    expect(keys).toEqual(['tp2>x3', 'x2>tp1']);
  });

  it('AC-12-03 a range covering a boundary month excludes the previous month', () => {
    const out = viewGraph(g, { types: ['session'], fromMonth: '2025-01', toMonth: '2025-01' });
    expect(out.nodes.map((n) => n.id)).toEqual(['x2']);
    expect(out.links).toEqual([]);
  });

  it('AC-12-03 toMonth alone keeps sessions up to and including that month', () => {
    const out = viewGraph(g, { types: ['session'], toMonth: '2025-01' });
    expect(out.nodes.map((n) => n.id)).toEqual(['x1', 'x2']);
  });

  it('AC-12-04 no range keeps undated and unparsable sessions', () => {
    const out = viewGraph(g, { types: ['session'] });
    expect(out.nodes.map((n) => n.id)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
  });

  it('AC-12-04 session-less types keep isolated topics and a range does not touch them', () => {
    const out = viewGraph(g, { types: ['topic', 'project'], fromMonth: '2030-01', toMonth: '2030-12' });
    expect(out.nodes.map((n) => n.id)).toEqual(['pr', 'tp1', 'tp2']);
    expect(out.links).toEqual([{ source: 'pr', target: 'tp1', type: 'g' }]);
  });

  it('AC-12-04 does not mutate the input (link endpoints stay objects)', () => {
    const copy = structuredClone(g);
    viewGraph(g, { types: ['session', 'topic'], fromMonth: '2025-01' });
    expect(g).toEqual(copy);
    expect(g.links[1].source).toEqual({ id: 'x2' });
  });
});

describe('hidden: clusterLabels', () => {
  it('AC-12-05 anchors at the top-ranked session even when a topic outranks everything', () => {
    const a = emptyAnalysis({
      communities: [community(0, 'Zero', ['b1', 'b2']), community(1, 'One', ['c1'])],
      rank: new Map<string, number>([
        ['b1', 0.11],
        ['b2', 0.12],
        ['c1', 0.01],
        ['some-topic', 0.99],
      ]),
    });
    expect(clusterLabels(a)).toEqual([
      { community: 0, label: 'Zero', nodeId: 'b2' },
      { community: 1, label: 'One', nodeId: 'c1' },
    ]);
  });

  it('AC-12-05 limit larger than the community count returns all', () => {
    const a = emptyAnalysis({
      communities: [community(0, 'Only', ['k'])],
      rank: new Map<string, number>([['k', 1]]),
    });
    expect(clusterLabels(a, 50)).toHaveLength(1);
  });

  it('AC-12-05 ties break on the smallest id, comparing as plain strings', () => {
    const a = emptyAnalysis({
      communities: [community(0, 'T', ['sess-2', 'sess-10'])],
      rank: new Map<string, number>([
        ['sess-10', 0.5],
        ['sess-2', 0.5],
      ]),
    });
    expect(clusterLabels(a)[0].nodeId).toBe('sess-10');
  });

  it('AC-12-05 end to end: two themes get two labels matching analyzeGraph communities', () => {
    const sessions = ['a1', 'a2', 'a3', 'b1', 'b2'].map((id) => ({
      id,
      type: 'session',
      label: id,
      meta: { started_at: '2025-02-01T00:00:00Z' },
    }));
    const g = parseGraph({
      nodes: [
        ...sessions,
        { id: 'ta', type: 'topic', label: 'Alpha' },
        { id: 'tb', type: 'topic', label: 'Beta' },
      ],
      links: [
        { source: 'a1', target: 'ta' },
        { source: 'a2', target: 'ta' },
        { source: 'a3', target: 'ta' },
        { source: 'b1', target: 'tb' },
        { source: 'b2', target: 'tb' },
      ],
    });
    const an = analyzeGraph(g);
    const out = clusterLabels(an);
    expect(out).toHaveLength(an.communities.length);
    expect(out.map((l) => l.label).sort()).toEqual(['Alpha', 'Beta']);
    for (const l of out) {
      const c = an.communities.find((x) => x.id === l.community);
      expect(c?.sessions).toContain(l.nodeId);
    }
  });
});

describe('hidden: monthRange', () => {
  it('AC-12-06 preserves the timeline order as given', () => {
    const a = emptyAnalysis({
      timeline: [
        { month: '2026-02', sessions: 1, topTopics: [] },
        { month: '2026-09', sessions: 1, topTopics: [] },
      ],
    });
    expect(monthRange(a)).toEqual(['2026-02', '2026-09']);
  });

  it('AC-12-06 end to end across a year boundary', () => {
    const g = parseGraph({
      nodes: [
        { id: 'n1', type: 'session', label: 'n1', meta: { started_at: '2026-01-02T00:00:00Z' } },
        { id: 'n2', type: 'session', label: 'n2', meta: { started_at: '2025-12-30T00:00:00Z' } },
        { id: 'n3', type: 'session', label: 'n3', meta: { started_at: '2025-10-01T00:00:00Z' } },
      ],
      links: [],
    });
    expect(monthRange(analyzeGraph(g))).toEqual(['2025-10', '2025-12', '2026-01']);
  });
});
