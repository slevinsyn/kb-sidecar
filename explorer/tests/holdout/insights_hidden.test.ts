import { describe, it, expect } from 'vitest';
import { buildInsights, insightsMarkdown } from '../../src/insights';
import type { Insights } from '../../src/insights';
import type { Analysis, Community } from '../../src/analysis';
import type { GraphData, GraphNode } from '../../src/graph';

const LATEST = '2024-11-15T12:00:00Z';

function sess(id: string, startedAt: string | null): GraphNode {
  return {
    id,
    type: 'session',
    label: id,
    size: 1,
    meta: startedAt === null ? {} : { started_at: startedAt },
  };
}

function comm(id: number, label: string, dates: (string | null)[], lastAt: string | null): {
  community: Community;
  nodes: GraphNode[];
} {
  const nodes = dates.map((d, i) => sess(`h${id}-${i}`, d));
  const valid = dates.filter((d): d is string => d !== null).sort();
  return {
    nodes,
    community: {
      id,
      label,
      topics: [],
      sessions: nodes.map((n) => n.id).sort(),
      size: dates.length,
      projects: [],
      firstAt: valid.length > 0 ? valid[0] : null,
      lastAt,
    },
  };
}

function analysis(extra: Partial<Analysis>): Analysis {
  return {
    communityOf: new Map(),
    communities: [],
    rank: new Map(),
    bridges: [],
    oneOffTopics: [],
    looseEnds: [],
    timeline: [],
    latestAt: LATEST,
    ...extra,
  };
}

function ins(extra: Partial<Insights>): Insights {
  return {
    headline: 'Head',
    summary: [],
    themes: [],
    bridges: [],
    looseEnds: [],
    oneOffCount: 0,
    roadmap: [],
    ...extra,
  };
}

function scenario() {
  const rust = comm(
    0,
    'Rust · Parser · Lexer',
    ['2024-11-14T09:00:00Z', '2024-11-10T09:00:00Z', '2024-09-01T09:00:00Z', '2024-08-01T09:00:00Z'],
    '2024-11-14T09:00:00Z',
  );
  const garden = comm(
    1,
    'Garden',
    ['2024-11-15T12:00:00Z', '2024-10-16T12:00:00Z', '2024-10-15T12:00:00Z'],
    '2024-11-15T12:00:00Z',
  );
  const g: GraphData = { nodes: [...rust.nodes, ...garden.nodes], links: [] };
  const a = analysis({
    communities: [rust.community, garden.community],
    oneOffTopics: [{ id: 'o', type: 'topic', label: 'solo', size: 1, meta: {} }],
    timeline: [
      { month: '2024-08', sessions: 1, topTopics: [] },
      { month: '2024-09', sessions: 1, topTopics: [] },
      { month: '2024-10', sessions: 3, topTopics: [] },
      { month: '2024-11', sessions: 3, topTopics: [] },
    ],
  });
  return { g, a };
}

describe('hidden insights', () => {
  it('AC-11-01 AC-11-02 headline and themes for a different graph', () => {
    const { g, a } = scenario();
    const out = buildInsights(g, a);
    expect(out.headline).toBe('7 sessions across 2 themes, 2024-08 to 2024-11');
    expect(out.themes).toEqual([
      { label: 'Rust · Parser · Lexer', sessions: 4, share: 57, lastAt: '2024-11-14T09:00:00Z' },
      { label: 'Garden', sessions: 3, share: 43, lastAt: '2024-11-15T12:00:00Z' },
    ]);
  });

  it('AC-11-01 a single timeline month and a single session', () => {
    const one = comm(0, 'Only', ['2024-06-02T00:00:00Z'], '2024-06-02T00:00:00Z');
    const a = analysis({
      communities: [one.community],
      timeline: [{ month: '2024-06', sessions: 1, topTopics: [] }],
    });
    expect(buildInsights({ nodes: one.nodes, links: [] }, a).headline).toBe(
      '1 session across 1 theme, 2024-06 to 2024-06',
    );
  });

  it('AC-11-01 no sessions wins over a non-empty analysis', () => {
    const one = comm(0, 'Ghost', ['2024-06-02T00:00:00Z'], '2024-06-02T00:00:00Z');
    const a = analysis({
      communities: [one.community],
      timeline: [{ month: '2024-06', sessions: 1, topTopics: [] }],
    });
    expect(buildInsights({ nodes: [], links: [] }, a).headline).toBe('No sessions yet');
  });

  it('AC-11-02 AC-11-04 rounding up of 2.5 percent and half percentages', () => {
    const lone = comm(0, 'Lone', [null], null);
    const extra = Array.from({ length: 39 }, (_, i) => sess(`z${i}`, null));
    const a = analysis({ communities: [lone.community], latestAt: null });
    const out = buildInsights({ nodes: [...lone.nodes, ...extra], links: [] }, a);
    expect(out.themes).toEqual([{ label: 'Lone', sessions: 1, share: 3, lastAt: null }]);
  });

  it('AC-11-03 AC-11-04 summary with tie on month, recent focus tie and omissions', () => {
    const { g, a } = scenario();
    expect(buildInsights(g, a).summary).toEqual([
      'Main themes: Rust · Parser · Lexer (4), Garden (3).',
      'Most active month: 2024-10 (3 sessions).',
      'Recent focus: Rust · Parser · Lexer.',
      'One-off topics: 1.',
    ]);
  });

  it('AC-11-04 recent focus includes the 30 day boundary and excludes 31 days', () => {
    const { g, a } = scenario();
    // Garden has 2 recent sessions (0 days and exactly 30 days); drop one Rust recent session
    const rustNodes = g.nodes.filter((n) => n.id.startsWith('h0-'));
    const gardenNodes = g.nodes.filter((n) => n.id.startsWith('h1-'));
    const trimmed: GraphData = {
      nodes: [...rustNodes.filter((n) => n.id !== 'h0-1'), ...gardenNodes],
      links: [],
    };
    expect(buildInsights(trimmed, a).summary).toContain('Recent focus: Garden.');
  });

  it('AC-11-05 AC-11-06 loose ends and roadmap for a different analysis', () => {
    const { g, a } = scenario();
    const stale = (id: number, label: string, size: number, lastAt: string): Community => ({
      id,
      label,
      topics: [],
      sessions: Array.from({ length: size }, (_, i) => `x${id}-${i}`),
      size,
      projects: [],
      firstAt: lastAt,
      lastAt,
    });
    a.looseEnds = [stale(7, 'Stale · One', 2, '2024-09-30T00:00:00Z'), stale(4, 'Stale Two', 1, '2024-08-02')];
    const out = buildInsights(g, a);
    expect(out.looseEnds).toEqual([
      'Stale · One - last touched 2024-09-30, 2 sessions',
      'Stale Two - last touched 2024-08-02, 1 session',
    ]);
    expect(out.roadmap).toEqual([
      { title: 'Continue: Rust · Parser · Lexer', detail: '4 sessions, last 2024-11-14', community: 0 },
      { title: 'Continue: Garden', detail: '3 sessions, last 2024-11-15', community: 1 },
      { title: 'Decide: Stale · One', detail: 'Finish or drop - idle since 2024-09-30', community: 7 },
      { title: 'Decide: Stale Two', detail: 'Finish or drop - idle since 2024-08-02', community: 4 },
    ]);
    expect(out.summary).toContain('Loose ends: 2 small themes not touched for over 30 days.');
  });

  it('AC-11-06 a community last active exactly 31 days before latestAt is not continued', () => {
    const edge = comm(0, 'Edge', ['2024-10-15T12:00:00Z'], '2024-10-15T12:00:00Z');
    const ok = comm(1, 'Ok', ['2024-10-16T12:00:00Z'], '2024-10-16T12:00:00Z');
    const a = analysis({ communities: [edge.community, ok.community] });
    const out = buildInsights({ nodes: [...edge.nodes, ...ok.nodes], links: [] }, a);
    expect(out.roadmap).toEqual([
      { title: 'Continue: Ok', detail: '1 session, last 2024-10-16', community: 1 },
    ]);
  });

  it('AC-11-03 caps bridges at ten but names three in the summary', () => {
    const { g, a } = scenario();
    a.bridges = Array.from({ length: 11 }, (_, i) => ({
      id: `br${i}`,
      label: `Link ${i}`,
      type: 'project' as const,
      communities: [0, 1],
    }));
    const out = buildInsights(g, a);
    expect(out.bridges).toHaveLength(10);
    expect(out.bridges[9]).toBe('Link 9');
    expect(out.summary).toContain('Bridges: Link 0, Link 1, Link 2 link separate themes.');
  });

  it('AC-11-07 markdown with pipes, null dates and many roadmap items', () => {
    const md = insightsMarkdown(
      ins({
        headline: '3 sessions across 1 theme',
        themes: [
          { label: 'x|y|z', sessions: 3, share: 100, lastAt: null },
          { label: 'plain', sessions: 0, share: 0, lastAt: '2024-02-29T23:00:00Z' },
        ],
        roadmap: [
          { title: 'Continue: a', detail: 'da', community: 0 },
          { title: 'Continue: b', detail: 'db', community: 1 },
          { title: 'Continue: c', detail: 'dc', community: 2 },
          { title: 'Decide: d', detail: 'dd', community: 3 },
        ],
      }),
    );
    expect(md).toBe(
      [
        '# Knowledge graph insights',
        '',
        '3 sessions across 1 theme',
        '',
        '## Main themes',
        '| Theme | Sessions | Share | Last active |',
        '|---|---|---|---|',
        '| x\\|y\\|z | 3 | 100% | - |',
        '| plain | 0 | 0% | 2024-02-29 |',
        '',
        '## Roadmap',
        '1. **Continue: a** - da',
        '2. **Continue: b** - db',
        '3. **Continue: c** - dc',
        '4. **Decide: d** - dd',
        '',
      ].join('\n'),
    );
  });

  it('AC-11-07 only bridges and loose ends sections', () => {
    const md = insightsMarkdown(ins({ bridges: ['One'], looseEnds: ['Two - last touched 2024-01-01, 3 sessions'] }));
    expect(md).toBe(
      '# Knowledge graph insights\n\nHead\n\n## Bridges\n- One\n\n## Loose ends\n- Two - last touched 2024-01-01, 3 sessions\n',
    );
  });

  it('AC-11-08 empty graph with a stale analysis still reports no sessions', () => {
    const out = buildInsights({ nodes: [], links: [] }, analysis({ latestAt: null }));
    expect(out.headline).toBe('No sessions yet');
    expect(out.themes).toEqual([]);
    expect(out.summary).toEqual([]);
    expect(out.roadmap).toEqual([]);
    expect(insightsMarkdown(out)).toBe('# Knowledge graph insights\n\nNo sessions yet\n');
  });

  it('AC-11-08 inputs are not mutated and results repeat', () => {
    const { g, a } = scenario();
    const gCopy = structuredClone(g);
    const aCopy = structuredClone(a);
    const first = buildInsights(g, a);
    const second = buildInsights(g, a);
    expect(g).toEqual(gCopy);
    expect(a).toEqual(aCopy);
    expect(second).toEqual(first);
  });
});
