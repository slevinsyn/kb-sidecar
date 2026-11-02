import { describe, it, expect } from 'vitest';
import {
  AXON_CURVATURE,
  BRANCH_BASE_RADIUS,
  BRANCH_RADIUS_STEP,
  CELL_SCALE,
  axonCurve,
  branchOffset,
  branchOffsets,
  cellBodies,
} from '../src/scene3d';
import type { Analysis, Community } from '../src/analysis';
import type { GraphLink } from '../src/graph';

// ---------- helpers ----------

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

function lk(source: GraphLink['source'], target: GraphLink['target'], type = 'rel'): GraphLink {
  return { source, target, type } as GraphLink;
}

function deepFreeze<V>(value: V): V {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const FALLBACK = { x: 60, y: 0 };

// ---------- constants ----------

describe('neuron constants', () => {
  it('AC-19-02 branch radius constants are 60 and 4', () => {
    expect(BRANCH_BASE_RADIUS).toBe(60);
    expect(BRANCH_RADIUS_STEP).toBe(4);
  });

  it('AC-19-05 AXON_CURVATURE is 0.3', () => {
    expect(AXON_CURVATURE).toBe(0.3);
  });

  it('CELL_SCALE is 2.2', () => {
    expect(CELL_SCALE).toBe(2.2);
  });
});

// ---------- cellBodies ----------

describe('cellBodies', () => {
  it('AC-19-01 picks the highest-ranked topic of each community', () => {
    const a = mkAnalysis({
      communities: [comm(0, ['t:a', 't:b', 't:c']), comm(1, ['t:x', 't:y'])],
      rank: new Map([
        ['t:a', 0.1],
        ['t:b', 0.9],
        ['t:c', 0.5],
        ['t:x', 0.7],
        ['t:y', 0.2],
      ]),
    });
    const out = cellBodies(a);
    expect(out).toBeInstanceOf(Map);
    expect(out.get(0)).toBe('t:b');
    expect(out.get(1)).toBe('t:x');
    expect(out.size).toBe(2);
  });

  it('AC-19-01 on equal rank the smaller id wins, whatever the listing order', () => {
    const rank = new Map([
      ['t:m', 0.5],
      ['t:k', 0.5],
      ['t:z', 0.5],
    ]);
    const a1 = mkAnalysis({ communities: [comm(0, ['t:m', 't:k', 't:z'])], rank });
    const a2 = mkAnalysis({ communities: [comm(0, ['t:z', 't:m', 't:k'])], rank });
    expect(cellBodies(a1).get(0)).toBe('t:k');
    expect(cellBodies(a2).get(0)).toBe('t:k');
  });

  it('AC-19-01 ties use plain string order, not numeric or locale order', () => {
    const rank = new Map([
      ['T2', 1],
      ['T10', 1],
    ]);
    expect(cellBodies(mkAnalysis({ communities: [comm(0, ['T2', 'T10'])], rank })).get(0)).toBe('T10');
    const upper = new Map([
      ['a', 1],
      ['B', 1],
    ]);
    expect(cellBodies(mkAnalysis({ communities: [comm(0, ['a', 'B'])], rank: upper })).get(0)).toBe('B');
  });

  it('AC-19-01 a topic with no rank counts as 0', () => {
    // 'a' has no rank (0) and beats a negative rank.
    const neg = mkAnalysis({
      communities: [comm(0, ['b', 'a'])],
      rank: new Map([['b', -1]]),
    });
    expect(cellBodies(neg).get(0)).toBe('a');
    // A positive rank beats a missing one even if the missing id is smaller.
    const pos = mkAnalysis({
      communities: [comm(0, ['a', 'b'])],
      rank: new Map([['b', 0.01]]),
    });
    expect(cellBodies(pos).get(0)).toBe('b');
  });

  it('AC-19-01 with no ranks at all the smallest id wins', () => {
    const a = mkAnalysis({ communities: [comm(3, ['t:q', 't:d', 't:m'])] });
    expect(cellBodies(a).get(3)).toBe('t:d');
  });

  it('AC-19-01 a missing rank ties with an explicit rank of 0', () => {
    const a = mkAnalysis({
      communities: [comm(0, ['t:b', 't:a'])],
      rank: new Map([['t:b', 0]]),
    });
    expect(cellBodies(a).get(0)).toBe('t:a');
  });

  it('AC-19-01 a single-topic community gets that topic', () => {
    const a = mkAnalysis({ communities: [comm(7, ['only'])] });
    expect(cellBodies(a).get(7)).toBe('only');
  });

  it('AC-19-01 a community with no topics has no entry', () => {
    const a = mkAnalysis({
      communities: [comm(0, ['t:a']), comm(1, []), comm(2, ['t:c'])],
      rank: new Map([
        ['t:a', 1],
        ['t:c', 1],
      ]),
    });
    const out = cellBodies(a);
    expect(out.has(1)).toBe(false);
    expect(out.get(0)).toBe('t:a');
    expect(out.get(2)).toBe('t:c');
    expect(out.size).toBe(2);
  });

  it('AC-19-01 an empty analysis gives an empty map', () => {
    const out = cellBodies(mkAnalysis());
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });

  it('AC-19-01 only topics listed in the community are considered, not higher-ranked outsiders', () => {
    const a = mkAnalysis({
      communities: [comm(0, ['t:a'])],
      rank: new Map([
        ['t:a', 0.1],
        ['t:other', 99],
      ]),
    });
    expect(cellBodies(a).get(0)).toBe('t:a');
  });

  it('AC-19-01 does not modify the analysis and gives the same answer twice', () => {
    const a = deepFreeze(
      mkAnalysis({
        communities: [comm(0, ['t:a', 't:b']), comm(1, [])],
        rank: new Map([
          ['t:a', 2],
          ['t:b', 3],
        ]),
      }),
    );
    const first = cellBodies(a);
    const second = cellBodies(a);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get(0)).toBe('t:b');
  });
});

// ---------- branchOffset ----------

describe('branchOffset', () => {
  it('AC-19-02 branch 0 of 5 is at (60, 0)', () => {
    const o = branchOffset(0, 5);
    expect(o.x).toBeCloseTo(60, 9);
    expect(o.y).toBeCloseTo(0, 9);
  });

  it('AC-19-02 branch 3 of 20 is at radius 60 and angle PI/2', () => {
    const o = branchOffset(3, 20);
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.y).toBeCloseTo(60, 9);
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(60, 9);
    expect(Math.atan2(o.y, o.x)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('AC-19-02 branch 12 of 20 is at radius 64 and angle PI/12', () => {
    const o = branchOffset(12, 20);
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(64, 9);
    expect(Math.atan2(o.y, o.x)).toBeCloseTo(Math.PI / 12, 9);
    expect(o.x).toBeCloseTo(64 * Math.cos(Math.PI / 12), 9);
    expect(o.y).toBeCloseTo(64 * Math.sin(Math.PI / 12), 9);
  });

  it('AC-19-02 slots within ring 0 are 30 degrees apart', () => {
    for (let s = 0; s < 12; s++) {
      const o = branchOffset(s, 12);
      expect(o.x).toBeCloseTo(60 * Math.cos((2 * Math.PI * s) / 12), 9);
      expect(o.y).toBeCloseTo(60 * Math.sin((2 * Math.PI * s) / 12), 9);
    }
  });

  it('AC-19-02 outer rings grow by 4 and turn half a slot per ring', () => {
    for (const [i, n] of [
      [24, 30],
      [30, 40],
      [37, 40],
    ] as const) {
      const r = Math.floor(i / 12);
      const s = i % 12;
      const radius = 60 + 4 * r;
      const angle = (2 * Math.PI * s) / 12 + (r * Math.PI) / 12;
      const o = branchOffset(i, n);
      expect(o.x).toBeCloseTo(radius * Math.cos(angle), 9);
      expect(o.y).toBeCloseTo(radius * Math.sin(angle), 9);
    }
    expect(Math.hypot(branchOffset(24, 30).x, branchOffset(24, 30).y)).toBeCloseTo(68, 9);
  });

  it('AC-19-02 the result does not depend on count while the index is valid', () => {
    const a = branchOffset(5, 6);
    const b = branchOffset(5, 500);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.y).toBeCloseTo(b.y, 12);
  });

  it('AC-19-03 a negative index gives (60, 0)', () => {
    expect(branchOffset(-1, 5)).toEqual(FALLBACK);
    expect(branchOffset(-100, 5)).toEqual(FALLBACK);
  });

  it('AC-19-03 an index at or past count gives (60, 0)', () => {
    expect(branchOffset(5, 5)).toEqual(FALLBACK);
    expect(branchOffset(9, 5)).toEqual(FALLBACK);
    expect(branchOffset(0, 0)).toEqual(FALLBACK);
  });

  it('AC-19-03 the last valid index still gives its own spot', () => {
    const o = branchOffset(4, 5);
    expect(o.x).toBeCloseTo(60 * Math.cos((2 * Math.PI * 4) / 12), 9);
    expect(o.y).toBeCloseTo(60 * Math.sin((2 * Math.PI * 4) / 12), 9);
  });

  it('AC-19-03 a fractional index or count gives (60, 0)', () => {
    expect(branchOffset(1.5, 5)).toEqual(FALLBACK);
    expect(branchOffset(2, 5.5)).toEqual(FALLBACK);
    expect(branchOffset(0.5, 10)).toEqual(FALLBACK);
  });

  it('AC-19-03 NaN and Infinity give (60, 0)', () => {
    expect(branchOffset(NaN, 5)).toEqual(FALLBACK);
    expect(branchOffset(2, NaN)).toEqual(FALLBACK);
    expect(branchOffset(Infinity, 5)).toEqual(FALLBACK);
    expect(branchOffset(-Infinity, 5)).toEqual(FALLBACK);
    expect(branchOffset(2, Infinity)).toEqual(FALLBACK);
    expect(branchOffset(NaN, NaN)).toEqual(FALLBACK);
  });
});

// ---------- branchOffsets ----------

describe('branchOffsets', () => {
  // Community 0: topics t:a (rank 1), t:b (rank 5) -> cell body t:b.
  // Community 1: topics t:x -> cell body t:x.
  // Community 2: no topics -> no cell body.
  function sample(): Analysis {
    return mkAnalysis({
      communities: [comm(0, ['t:a', 't:b']), comm(1, ['t:x']), comm(2, [])],
      rank: new Map([
        ['t:a', 1],
        ['t:b', 5],
        ['t:x', 2],
      ]),
      communityOf: new Map<string, number>([
        ['t:a', 0],
        ['t:b', 0],
        ['s1', 0],
        ['s10', 0],
        ['s2', 0],
        ['t:x', 1],
        ['s3', 1],
        ['s4', 1],
        ['n1', 2],
        ['n2', 2],
      ]),
    });
  }

  it('AC-19-04 skips the cell body of each community', () => {
    const out = branchOffsets(sample(), ['t:b', 't:x', 't:a', 's3']);
    expect(out.has('t:b')).toBe(false);
    expect(out.has('t:x')).toBe(false);
    expect(out.has('t:a')).toBe(true);
    expect(out.has('s3')).toBe(true);
  });

  it('AC-19-04 skips ids with no community and ids unknown to the analysis', () => {
    const out = branchOffsets(sample(), ['s1', 'orphan', 'ghost', 's2']);
    expect(out.has('orphan')).toBe(false);
    expect(out.has('ghost')).toBe(false);
    expect([...out.keys()].sort()).toEqual(['s1', 's2']);
  });

  it('AC-19-04 only returns ids that were asked for', () => {
    const out = branchOffsets(sample(), ['s1']);
    expect([...out.keys()]).toEqual(['s1']);
    expect(out.has('s2')).toBe(false);
  });

  it('AC-19-04 spots follow sorted id order within a community (plain string order)', () => {
    // Qualifying ids of community 0 (cell body t:b removed): s1, s10, s2, t:a
    // sorted by plain < order: s1 < s10 < s2 < t:a.
    const out = branchOffsets(sample(), ['t:a', 's2', 's10', 's1', 't:b']);
    const expected = ['s1', 's10', 's2', 't:a'];
    expect(out.size).toBe(4);
    expected.forEach((id, k) => {
      const want = branchOffset(k, expected.length);
      expect(out.get(id)?.x).toBeCloseTo(want.x, 9);
      expect(out.get(id)?.y).toBeCloseTo(want.y, 9);
    });
  });

  it('AC-19-04 the count is the number of qualifying ids, so a subset gets spots from its own list', () => {
    const out = branchOffsets(sample(), ['s2', 's1']);
    expect(out.get('s1')?.x).toBeCloseTo(branchOffset(0, 2).x, 9);
    expect(out.get('s1')?.y).toBeCloseTo(branchOffset(0, 2).y, 9);
    expect(out.get('s2')?.x).toBeCloseTo(branchOffset(1, 2).x, 9);
    expect(out.get('s2')?.y).toBeCloseTo(branchOffset(1, 2).y, 9);
  });

  it('AC-19-04 each community is numbered on its own', () => {
    const out = branchOffsets(sample(), ['s3', 's4', 's1', 's2', 's10', 't:a']);
    // Community 1 has s3, s4 -> indexes 0, 1
    expect(out.get('s3')?.x).toBeCloseTo(branchOffset(0, 2).x, 9);
    expect(out.get('s3')?.y).toBeCloseTo(branchOffset(0, 2).y, 9);
    expect(out.get('s4')?.x).toBeCloseTo(branchOffset(1, 2).x, 9);
    expect(out.get('s4')?.y).toBeCloseTo(branchOffset(1, 2).y, 9);
    // Community 0 has s1, s10, s2, t:a -> indexes 0..3
    expect(out.get('s1')?.x).toBeCloseTo(branchOffset(0, 4).x, 9);
    expect(out.get('t:a')?.y).toBeCloseTo(branchOffset(3, 4).y, 9);
  });

  it('AC-19-04 a community with no cell body gives every member a spot', () => {
    const out = branchOffsets(sample(), ['n2', 'n1']);
    expect(out.size).toBe(2);
    expect(out.get('n1')?.x).toBeCloseTo(branchOffset(0, 2).x, 9);
    expect(out.get('n1')?.y).toBeCloseTo(branchOffset(0, 2).y, 9);
    expect(out.get('n2')?.x).toBeCloseTo(branchOffset(1, 2).x, 9);
    expect(out.get('n2')?.y).toBeCloseTo(branchOffset(1, 2).y, 9);
  });

  it('AC-19-04 the order of the input ids does not change the result', () => {
    const a = branchOffsets(sample(), ['s1', 's10', 's2', 't:a', 's3', 's4']);
    const b = branchOffsets(sample(), ['s4', 't:a', 's3', 's2', 's10', 's1']);
    expect(b.size).toBe(a.size);
    for (const [id, pos] of a) {
      expect(b.get(id)).toEqual(pos);
    }
  });

  it('AC-19-04 an id repeated in the input is counted once', () => {
    const once = branchOffsets(sample(), ['s1', 's2']);
    const dup = branchOffsets(sample(), ['s2', 's1', 's2', 's1', 's2']);
    expect(dup.size).toBe(2);
    expect(dup.get('s1')).toEqual(once.get('s1'));
    expect(dup.get('s2')).toEqual(once.get('s2'));
    expect(dup.get('s2')?.x).toBeCloseTo(branchOffset(1, 2).x, 9);
  });

  it('AC-19-04 an empty id list or empty analysis gives an empty map', () => {
    const empty = branchOffsets(sample(), []);
    expect(empty).toBeInstanceOf(Map);
    expect(empty.size).toBe(0);
    const none = branchOffsets(mkAnalysis(), ['s1', 's2']);
    expect(none).toBeInstanceOf(Map);
    expect(none.size).toBe(0);
  });

  it('AC-19-04 a list with only the cell body gives an empty map', () => {
    expect(branchOffsets(sample(), ['t:b']).size).toBe(0);
  });

  it('AC-19-04 the spots of one community are all different, even across several rings', () => {
    const ids: string[] = [];
    const communityOf = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const id = `n${String(i).padStart(3, '0')}`;
      ids.push(id);
      communityOf.set(id, 5);
    }
    const a = mkAnalysis({ communities: [comm(5, [])], communityOf });
    const out = branchOffsets(a, ids);
    expect(out.size).toBe(40);
    const seen = new Set<string>();
    for (const pos of out.values()) {
      seen.add(`${pos.x.toFixed(6)},${pos.y.toFixed(6)}`);
    }
    expect(seen.size).toBe(40);
    // First ring is at radius 60, the 4th ring (ids 36..39) at radius 72.
    expect(Math.hypot(out.get('n000')!.x, out.get('n000')!.y)).toBeCloseTo(60, 9);
    expect(Math.hypot(out.get('n039')!.x, out.get('n039')!.y)).toBeCloseTo(72, 9);
  });

  it('AC-19-04 two calls give equal results', () => {
    const ids = ['s1', 's10', 's2', 't:a', 's3', 's4', 'n1', 'n2', 'orphan'];
    const first = branchOffsets(sample(), ids);
    const second = branchOffsets(sample(), ids);
    expect(second).toEqual(first);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('AC-19-04 does not modify its inputs', () => {
    const a = deepFreeze(sample());
    const ids = Object.freeze(['s2', 's1', 't:b']) as readonly string[];
    const out = branchOffsets(a, ids);
    expect(out.get('s1')).toBeDefined();
    expect([...ids]).toEqual(['s2', 's1', 't:b']);
  });
});

// ---------- axonCurve ----------

describe('axonCurve', () => {
  function themes(): Analysis {
    return mkAnalysis({
      communities: [comm(0, ['a1']), comm(1, ['b1'])],
      communityOf: new Map<string, number>([
        ['a1', 0],
        ['a2', 0],
        ['b1', 1],
        ['b2', 1],
      ]),
    });
  }

  it('AC-19-05 a link between two themes has curvature 0.3 and a rotation in [0, 2*PI)', () => {
    const c = axonCurve(lk('a1', 'b1'), themes());
    expect(c.curvature).toBe(0.3);
    expect(c.curvature).toBe(AXON_CURVATURE);
    expect(c.rotation).toBeGreaterThanOrEqual(0);
    expect(c.rotation).toBeLessThan(2 * Math.PI);
    expect(Number.isFinite(c.rotation)).toBe(true);
  });

  it('AC-19-05 the same link twice gives the same rotation', () => {
    const a = themes();
    const first = axonCurve(lk('a1', 'b1'), a);
    const second = axonCurve(lk('a1', 'b1'), a);
    expect(second).toEqual(first);
    expect(axonCurve(lk('a2', 'b2'), a)).toEqual(axonCurve(lk('a2', 'b2'), a));
  });

  it('AC-19-05 the rotation depends only on source and target, not on link type', () => {
    const a = themes();
    expect(axonCurve(lk('a1', 'b2', 'has_topic'), a).rotation).toBe(axonCurve(lk('a1', 'b2', 'other'), a).rotation);
  });

  it('AC-19-05 rotations stay in range and are not all equal across many links', () => {
    const communityOf = new Map<string, number>();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `node-${i}`;
      ids.push(id);
      communityOf.set(id, i % 2);
    }
    const a = mkAnalysis({ communityOf });
    const rotations = new Set<number>();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (i % 2 === j % 2) continue;
        const c = axonCurve(lk(ids[i], ids[j]), a);
        expect(c.curvature).toBe(0.3);
        expect(c.rotation).toBeGreaterThanOrEqual(0);
        expect(c.rotation).toBeLessThan(2 * Math.PI);
        rotations.add(c.rotation);
      }
    }
    expect(rotations.size).toBeGreaterThan(5);
  });

  it('AC-19-05 a link inside one theme is flat', () => {
    expect(axonCurve(lk('a1', 'a2'), themes())).toEqual({ curvature: 0, rotation: 0 });
  });

  it('AC-19-05 a link from a node to itself is flat', () => {
    expect(axonCurve(lk('a1', 'a1'), themes())).toEqual({ curvature: 0, rotation: 0 });
  });

  it('AC-19-05 an end with no theme makes the link flat', () => {
    const a = themes();
    expect(axonCurve(lk('a1', 'loose'), a)).toEqual({ curvature: 0, rotation: 0 });
    expect(axonCurve(lk('loose', 'b1'), a)).toEqual({ curvature: 0, rotation: 0 });
    expect(axonCurve(lk('loose', 'also-loose'), a)).toEqual({ curvature: 0, rotation: 0 });
  });

  it('AC-19-05 an empty analysis makes every link flat', () => {
    expect(axonCurve(lk('a1', 'b1'), mkAnalysis())).toEqual({ curvature: 0, rotation: 0 });
  });

  it('AC-19-05 theme id 0 counts as a theme', () => {
    // a1 is in community 0 (falsy id), b1 in community 1: still a curved link.
    const c = axonCurve(lk('a1', 'b1'), themes());
    expect(c.curvature).toBe(0.3);
  });

  it('AC-19-05 link ends given as { id } objects work like strings', () => {
    const a = themes();
    const asStrings = axonCurve(lk('a1', 'b1'), a);
    const asObjects = axonCurve(lk({ id: 'a1' }, { id: 'b1' }), a);
    expect(asObjects).toEqual(asStrings);
    expect(asObjects.curvature).toBe(0.3);

    const mixed = axonCurve(lk({ id: 'a1' }, 'b1'), a);
    expect(mixed).toEqual(asStrings);

    expect(axonCurve(lk({ id: 'a1' }, { id: 'a2' }), a)).toEqual({ curvature: 0, rotation: 0 });
    expect(axonCurve(lk({ id: 'a1' }, { id: 'loose' }), a)).toEqual({ curvature: 0, rotation: 0 });
  });

  it('AC-19-05 does not modify the link or analysis', () => {
    const a = deepFreeze(themes());
    const link = deepFreeze(lk({ id: 'a1' }, { id: 'b2' }));
    const c = axonCurve(link, a);
    expect(c.curvature).toBe(0.3);
  });
});
