import { describe, it, expect } from 'vitest';
import { axonCurve, branchOffset, branchOffsets, cellBodies } from '../../src/scene3d';
import type { Analysis, Community } from '../../src/analysis';
import type { GraphLink } from '../../src/graph';

function comm(id: number, topics: string[] = []): Community {
  return {
    id,
    label: `Community ${id + 1}`,
    topics,
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

function lk(source: GraphLink['source'], target: GraphLink['target']): GraphLink {
  return { source, target, type: 'x' } as GraphLink;
}

describe('neuron maths hidden', () => {
  it('AC-19-01 picks the top-ranked topic per community with a different layout', () => {
    const a = mkAnalysis({
      communities: [comm(4, ['zeta', 'alpha', 'mid']), comm(9, ['p', 'q']), comm(2, [])],
      rank: new Map([
        ['zeta', 0.31],
        ['alpha', 0.12],
        ['mid', 0.3],
        ['p', 4],
        ['q', 4],
      ]),
    });
    const out = cellBodies(a);
    expect(out.get(4)).toBe('zeta');
    expect(out.get(9)).toBe('p');
    expect(out.has(2)).toBe(false);
    expect(out.size).toBe(2);
  });

  it('AC-19-01 tie between all-unranked topics goes to the smaller id; empty analysis is empty', () => {
    const a = mkAnalysis({ communities: [comm(1, ['n-3', 'n-12', 'n-2'])] });
    expect(cellBodies(a).get(1)).toBe('n-12');
    expect(cellBodies(mkAnalysis()).size).toBe(0);
  });

  it('AC-19-02 branch positions on several rings follow the formula', () => {
    const o1 = branchOffset(1, 3);
    expect(o1.x).toBeCloseTo(60 * Math.cos(Math.PI / 6), 9);
    expect(o1.y).toBeCloseTo(30, 9);
    const o6 = branchOffset(6, 7);
    expect(o6.x).toBeCloseTo(-60, 9);
    expect(o6.y).toBeCloseTo(0, 9);
    const o25 = branchOffset(25, 26);
    const angle = Math.PI / 6 + (2 * Math.PI) / 12;
    expect(o25.x).toBeCloseTo(68 * Math.cos(angle), 9);
    expect(o25.y).toBeCloseTo(68 * Math.sin(angle), 9);
  });

  it('AC-19-03 invalid index or count falls back to (60, 0)', () => {
    expect(branchOffset(-0.5, 4)).toEqual({ x: 60, y: 0 });
    expect(branchOffset(7, 7)).toEqual({ x: 60, y: 0 });
    expect(branchOffset(3, 2)).toEqual({ x: 60, y: 0 });
    expect(branchOffset(1, Infinity)).toEqual({ x: 60, y: 0 });
    expect(branchOffset(NaN, 3)).toEqual({ x: 60, y: 0 });
    expect(branchOffset(2.25, 9)).toEqual({ x: 60, y: 0 });
  });

  it('AC-19-04 branchOffsets numbers each community by sorted ids and skips the cell body', () => {
    const a = mkAnalysis({
      communities: [comm(8, ['hub', 'minor']), comm(3, [])],
      rank: new Map([
        ['hub', 9],
        ['minor', 1],
      ]),
      communityOf: new Map<string, number>([
        ['hub', 8],
        ['minor', 8],
        ['k', 8],
        ['B', 8],
        ['x', 3],
        ['w', 3],
      ]),
    });
    const out = branchOffsets(a, ['x', 'k', 'hub', 'w', 'B', 'minor', 'nowhere', 'k']);
    // Community 8 minus hub, sorted by plain order: B < k < minor
    const c8 = ['B', 'k', 'minor'];
    c8.forEach((id, i) => {
      const want = branchOffset(i, 3);
      expect(out.get(id)?.x).toBeCloseTo(want.x, 9);
      expect(out.get(id)?.y).toBeCloseTo(want.y, 9);
    });
    // Community 3 has no cell body: w < x
    expect(out.get('w')?.x).toBeCloseTo(branchOffset(0, 2).x, 9);
    expect(out.get('w')?.y).toBeCloseTo(branchOffset(0, 2).y, 9);
    expect(out.get('x')?.x).toBeCloseTo(branchOffset(1, 2).x, 9);
    expect(out.get('x')?.y).toBeCloseTo(branchOffset(1, 2).y, 9);
    expect(out.has('hub')).toBe(false);
    expect(out.has('nowhere')).toBe(false);
    expect(out.size).toBe(5);
  });

  it('AC-19-04 spots in one community are distinct and repeatable for 26 members', () => {
    const communityOf = new Map<string, number>();
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      const id = `m${String.fromCharCode(97 + i)}`;
      ids.push(id);
      communityOf.set(id, 1);
    }
    const a = mkAnalysis({ communities: [comm(1, [])], communityOf });
    const first = branchOffsets(a, ids);
    const second = branchOffsets(a, [...ids].reverse());
    expect(second).toEqual(first);
    const keys = new Set([...first.values()].map((p) => `${p.x.toFixed(6)}|${p.y.toFixed(6)}`));
    expect(keys.size).toBe(26);
  });

  it('AC-19-05 axonCurve curves between themes and is flat otherwise', () => {
    const a = mkAnalysis({
      communityOf: new Map<string, number>([
        ['u', 5],
        ['v', 6],
        ['w', 5],
      ]),
    });
    const c = axonCurve(lk('u', 'v'), a);
    expect(c.curvature).toBe(0.3);
    expect(c.rotation).toBeGreaterThanOrEqual(0);
    expect(c.rotation).toBeLessThan(2 * Math.PI);
    expect(axonCurve(lk('u', 'v'), a)).toEqual(c);
    expect(axonCurve(lk('u', 'w'), a)).toEqual({ curvature: 0, rotation: 0 });
    expect(axonCurve(lk('u', 'nobody'), a)).toEqual({ curvature: 0, rotation: 0 });
    expect(axonCurve(lk('nobody', 'v'), a)).toEqual({ curvature: 0, rotation: 0 });
  });

  it('AC-19-05 object link ends match string link ends', () => {
    const a = mkAnalysis({
      communityOf: new Map<string, number>([
        ['p1', 0],
        ['q1', 2],
      ]),
    });
    expect(axonCurve(lk({ id: 'p1' }, { id: 'q1' }), a)).toEqual(axonCurve(lk('p1', 'q1'), a));
    expect(axonCurve(lk({ id: 'p1' }, { id: 'zz' }), a)).toEqual({ curvature: 0, rotation: 0 });
  });
});
