import { describe, it, expect } from 'vitest';
import {
  LINK_OPACITY,
  NOISE_LINK_TYPES,
  clusterBounds,
  defaultLinkFilter,
  linkRgba,
  nextMonth,
  orbitPosition,
  shortestPath,
} from '../src/scene3d';
import type { Point3 } from '../src/scene3d';
import type { GraphData, GraphNode, NodeType } from '../src/graph';

// ---------- helpers ----------

function gn(id: string, type: NodeType): GraphNode {
  return { id, type, label: id, size: 1, meta: {} };
}

const S = (id: string): GraphNode => gn(id, 'session');
const T = (id: string): GraphNode => gn(id, 'topic');
const P = (id: string): GraphNode => gn(id, 'project');
const F = (id: string): GraphNode => gn(id, 'file');
const X = (id: string): GraphNode => gn(id, 'tool');

function graph(nodes: GraphNode[], links: Array<[string, string, string?]>): GraphData {
  return {
    nodes,
    links: links.map(([source, target, type]) => ({ source, target, type: type ?? 'has_topic' })),
  };
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

// ---------- defaultLinkFilter ----------

describe('defaultLinkFilter', () => {
  function mixed(): GraphData {
    return graph(
      [S('s1'), S('s2'), T('t1'), P('p1'), F('f1'), X('x1')],
      [
        ['s1', 'p1', 'in_project'],
        ['s1', 't1', 'has_topic'],
        ['s1', 'f1', 'touched_file'],
        ['s1', 'x1', 'used_tool'],
        ['s2', 'x1', 'used_tool'],
        ['s2', 't1', 'has_topic'],
        ['s2', 'p1', 'in_project'],
        ['s2', 'f1', 'touched_file'],
      ],
    );
  }

  it('AC-14-01 NOISE_LINK_TYPES lists used_tool and touched_file', () => {
    expect([...NOISE_LINK_TYPES].sort()).toEqual(['touched_file', 'used_tool']);
  });

  it('AC-14-01 drops used_tool and touched_file links by default', () => {
    const out = defaultLinkFilter(mixed());
    expect(out.links.map((l) => l.type)).toEqual(['in_project', 'has_topic', 'has_topic', 'in_project']);
    expect(out.links.some((l) => l.type === 'used_tool' || l.type === 'touched_file')).toBe(false);
  });

  it('AC-14-01 keeps every node, including file and tool nodes whose links were dropped', () => {
    const g = mixed();
    const out = defaultLinkFilter(g);
    expect(out.nodes).toEqual(g.nodes);
    expect(out.nodes.map((n) => n.id)).toEqual(['s1', 's2', 't1', 'p1', 'f1', 'x1']);
  });

  it('AC-14-01 showNoise = true keeps all links', () => {
    const g = mixed();
    const out = defaultLinkFilter(g, true);
    expect(out.links).toHaveLength(8);
    expect(out.links.map((l) => l.type)).toEqual(g.links.map((l) => l.type));
    expect(out.nodes).toEqual(g.nodes);
  });

  it('AC-14-01 showNoise = false behaves like the default', () => {
    const g = mixed();
    expect(defaultLinkFilter(g, false)).toEqual(defaultLinkFilter(g));
  });

  it('AC-14-01 a graph with no noise links is returned with all of its links', () => {
    const g = graph([S('s'), T('t')], [['s', 't', 'has_topic']]);
    expect(defaultLinkFilter(g).links).toEqual([{ source: 's', target: 't', type: 'has_topic' }]);
  });

  it('AC-14-01 an empty graph gives an empty graph', () => {
    const out = defaultLinkFilter({ nodes: [], links: [] });
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('AC-14-02 returns string endpoints when the input uses {id} ends', () => {
    const g: GraphData = {
      nodes: [S('s1'), T('t1'), X('x1')],
      links: [
        { source: { id: 's1' }, target: { id: 't1' }, type: 'has_topic' },
        { source: { id: 's1' }, target: { id: 'x1' }, type: 'used_tool' },
        { source: 't1', target: { id: 's1' }, type: 'has_topic' },
      ],
    };
    const out = defaultLinkFilter(g);
    expect(out.links).toEqual([
      { source: 's1', target: 't1', type: 'has_topic' },
      { source: 't1', target: 's1', type: 'has_topic' },
    ]);
    for (const l of out.links) {
      expect(typeof l.source).toBe('string');
      expect(typeof l.target).toBe('string');
    }
  });

  it('AC-14-02 string endpoints are also returned when showNoise = true', () => {
    const g: GraphData = {
      nodes: [S('s1'), X('x1')],
      links: [{ source: { id: 's1' }, target: { id: 'x1' }, type: 'used_tool' }],
    };
    const out = defaultLinkFilter(g, true);
    expect(out.links).toEqual([{ source: 's1', target: 'x1', type: 'used_tool' }]);
  });

  it('AC-14-02 keeps the original link order', () => {
    const g = graph(
      [S('a'), S('b'), S('c'), T('t'), T('u'), P('p')],
      [
        ['c', 'u', 'has_topic'],
        ['a', 't', 'has_topic'],
        ['b', 'p', 'in_project'],
        ['a', 'u', 'has_topic'],
        ['c', 'p', 'in_project'],
      ],
    );
    const out = defaultLinkFilter(g);
    expect(out.links.map((l) => `${l.source}>${l.target}`)).toEqual(['c>u', 'a>t', 'b>p', 'a>u', 'c>p']);
  });

  it('AC-14-02 returns a new graph and does not mutate or alias the input', () => {
    const g = mixed();
    const before = JSON.stringify(g);
    deepFreeze(g);
    const out = defaultLinkFilter(g);
    expect(out).not.toBe(g);
    expect(out.links).not.toBe(g.links);
    expect(out.links.length).toBeLessThan(g.links.length);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('AC-14-02 does not mutate the input with {id} ends or showNoise = true', () => {
    const g: GraphData = {
      nodes: [S('s1'), T('t1')],
      links: [{ source: { id: 's1' }, target: { id: 't1' }, type: 'has_topic' }],
    };
    const before = JSON.stringify(g);
    deepFreeze(g);
    defaultLinkFilter(g, true);
    defaultLinkFilter(g);
    expect(JSON.stringify(g)).toBe(before);
    expect(typeof g.links[0].source).toBe('object');
  });
});

// ---------- linkRgba ----------

describe('linkRgba', () => {
  it('AC-14-03 LINK_OPACITY is 0.15', () => {
    expect(LINK_OPACITY).toBe(0.15);
  });

  it('AC-14-03 in_project is 247, 201, 107 with default alpha 0.15', () => {
    expect(linkRgba('in_project')).toBe('rgba(247, 201, 107, 0.15)');
  });

  it('AC-14-03 has_topic is 122, 162, 247 with default alpha 0.15', () => {
    expect(linkRgba('has_topic')).toBe('rgba(122, 162, 247, 0.15)');
  });

  it('AC-14-03 touched_file is 158, 206, 106 with default alpha 0.15', () => {
    expect(linkRgba('touched_file')).toBe('rgba(158, 206, 106, 0.15)');
  });

  it('AC-14-03 used_tool is 187, 154, 247 with default alpha 0.15', () => {
    expect(linkRgba('used_tool')).toBe('rgba(187, 154, 247, 0.15)');
  });

  it('AC-14-03 unknown types fall back to grey 138, 143, 152', () => {
    expect(linkRgba('related')).toBe('rgba(138, 143, 152, 0.15)');
    expect(linkRgba('')).toBe('rgba(138, 143, 152, 0.15)');
    expect(linkRgba('IN_PROJECT')).toBe('rgba(138, 143, 152, 0.15)');
  });

  it('AC-14-03 honours an explicit alpha for known and unknown types', () => {
    expect(linkRgba('in_project', 0.5)).toBe('rgba(247, 201, 107, 0.5)');
    expect(linkRgba('has_topic', 0.9)).toBe('rgba(122, 162, 247, 0.9)');
    expect(linkRgba('used_tool', 1)).toBe('rgba(187, 154, 247, 1)');
    expect(linkRgba('touched_file', 0)).toBe('rgba(158, 206, 106, 0)');
    expect(linkRgba('mystery', 0.25)).toBe('rgba(138, 143, 152, 0.25)');
  });

  it('AC-14-03 an explicit alpha equal to the default matches the default', () => {
    expect(linkRgba('has_topic', LINK_OPACITY)).toBe(linkRgba('has_topic'));
  });
});

// ---------- shortestPath ----------

describe('shortestPath', () => {
  // topic-session-topic chain: ta - s1 - tm - s2 - tb, with shortcuts through
  // project, file and tool nodes that must never be used.
  function chain(): GraphData {
    return graph(
      [T('ta'), T('tb'), T('tm'), S('s1'), S('s2'), P('pj'), F('fl'), X('tl')],
      [
        ['s1', 'ta'],
        ['s1', 'tm'],
        ['s2', 'tm'],
        ['s2', 'tb'],
        ['ta', 'pj', 'in_project'],
        ['pj', 'tb', 'in_project'],
        ['ta', 'fl', 'touched_file'],
        ['fl', 'tb', 'touched_file'],
        ['ta', 'tl', 'used_tool'],
        ['tl', 'tb', 'used_tool'],
      ],
    );
  }

  it('AC-14-04 returns the topic-session-topic chain inclusive of both ends', () => {
    expect(shortestPath(chain(), 'ta', 'tb')).toEqual(['ta', 's1', 'tm', 's2', 'tb']);
  });

  it('AC-14-04 a single session between two topics gives three ids', () => {
    const g = graph([T('left'), T('right'), S('mid')], [['mid', 'left'], ['mid', 'right']]);
    expect(shortestPath(g, 'left', 'right')).toEqual(['left', 'mid', 'right']);
  });

  it('AC-14-04 links are undirected so the reverse route is the reversed path', () => {
    const forward = shortestPath(chain(), 'ta', 'tb');
    const backward = shortestPath(chain(), 'tb', 'ta');
    expect(forward).toEqual(['ta', 's1', 'tm', 's2', 'tb']);
    expect(backward).toEqual(['tb', 's2', 'tm', 's1', 'ta']);
  });

  it('AC-14-04 link direction in the data does not matter', () => {
    const g = graph(
      [T('a'), T('b'), S('s')],
      [
        ['a', 's'],
        ['b', 's'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toEqual(['a', 's', 'b']);
    expect(shortestPath(g, 'b', 'a')).toEqual(['b', 's', 'a']);
  });

  it('AC-14-04 prefers the shorter of two routes of different length', () => {
    const g = graph(
      [T('a'), T('b'), T('c'), S('s1'), S('s2'), S('s3')],
      [
        ['s1', 'a'],
        ['s1', 'c'],
        ['s2', 'c'],
        ['s2', 'b'],
        ['s3', 'a'],
        ['s3', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toEqual(['a', 's3', 'b']);
  });

  it('AC-14-04 can start or end at a session', () => {
    expect(shortestPath(chain(), 's1', 'tb')).toEqual(['s1', 'tm', 's2', 'tb']);
    expect(shortestPath(chain(), 'ta', 's2')).toEqual(['ta', 's1', 'tm', 's2']);
  });

  it('AC-14-04 does not mutate the input graph', () => {
    const g = chain();
    const before = JSON.stringify(g);
    deepFreeze(g);
    expect(shortestPath(g, 'ta', 'tb')).toEqual(['ta', 's1', 'tm', 's2', 'tb']);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('AC-14-05 identical existing nodes give a one-element path', () => {
    expect(shortestPath(chain(), 'ta', 'ta')).toEqual(['ta']);
    expect(shortestPath(chain(), 's2', 's2')).toEqual(['s2']);
  });

  it('AC-14-05 an isolated node to itself is still a one-element path', () => {
    const g = graph([T('lonely'), T('other')], []);
    expect(shortestPath(g, 'lonely', 'lonely')).toEqual(['lonely']);
  });

  it('AC-14-05 identical ids that do not exist give null', () => {
    expect(shortestPath(chain(), 'ghost', 'ghost')).toBeNull();
  });

  it('AC-14-05 a missing from or to id gives null', () => {
    expect(shortestPath(chain(), 'nope', 'tb')).toBeNull();
    expect(shortestPath(chain(), 'ta', 'nope')).toBeNull();
    expect(shortestPath(chain(), 'nope', 'nada')).toBeNull();
  });

  it('AC-14-05 an empty graph gives null', () => {
    expect(shortestPath({ nodes: [], links: [] }, 'a', 'b')).toBeNull();
  });

  it('AC-14-05 an unreachable pair gives null', () => {
    const g = graph(
      [T('a'), S('s1'), T('b'), S('s2')],
      [
        ['s1', 'a'],
        ['s2', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toBeNull();
  });

  it('AC-14-05 never routes through a project node', () => {
    const g = graph(
      [T('a'), T('b'), S('s1'), S('s2'), P('pj')],
      [
        ['s1', 'a'],
        ['s1', 'pj', 'in_project'],
        ['s2', 'pj', 'in_project'],
        ['s2', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toBeNull();
  });

  it('AC-14-05 never routes through a file node', () => {
    const g = graph(
      [T('a'), T('b'), S('s1'), S('s2'), F('fl')],
      [
        ['s1', 'a'],
        ['s1', 'fl', 'touched_file'],
        ['s2', 'fl', 'touched_file'],
        ['s2', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toBeNull();
  });

  it('AC-14-05 never routes through a tool node', () => {
    const g = graph(
      [T('a'), T('b'), S('s1'), S('s2'), X('tl')],
      [
        ['s1', 'a'],
        ['s1', 'tl', 'used_tool'],
        ['s2', 'tl', 'used_tool'],
        ['s2', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toBeNull();
  });

  it('AC-14-05 ignores a shortcut through project, file and tool nodes in favour of the longer valid route', () => {
    const path = shortestPath(chain(), 'ta', 'tb');
    expect(path).not.toBeNull();
    expect(path).not.toContain('pj');
    expect(path).not.toContain('fl');
    expect(path).not.toContain('tl');
    expect(path).toHaveLength(5);
  });

  it('AC-14-05 a path to a project, file or tool node is not found', () => {
    expect(shortestPath(chain(), 'ta', 'pj')).toBeNull();
    expect(shortestPath(chain(), 'ta', 'fl')).toBeNull();
    expect(shortestPath(chain(), 'ta', 'tl')).toBeNull();
  });

  it('AC-14-06 picks the lowest-id route when two shortest paths exist', () => {
    const g = graph(
      [T('a'), T('b'), S('s1'), S('s2')],
      [
        ['s2', 'a'],
        ['s2', 'b'],
        ['s1', 'a'],
        ['s1', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toEqual(['a', 's1', 'b']);
  });

  it('AC-14-06 the result does not depend on node or link order', () => {
    const nodes = [T('a'), T('b'), S('s1'), S('s2'), S('s3')];
    const links: Array<[string, string]> = [
      ['s1', 'a'],
      ['s1', 'b'],
      ['s2', 'a'],
      ['s2', 'b'],
      ['s3', 'a'],
      ['s3', 'b'],
    ];
    const forward = shortestPath(graph(nodes, links), 'a', 'b');
    const reversed = shortestPath(graph([...nodes].reverse(), [...links].reverse()), 'a', 'b');
    expect(forward).toEqual(['a', 's1', 'b']);
    expect(reversed).toEqual(['a', 's1', 'b']);
  });

  it('AC-14-06 repeated calls on the same graph give the same path', () => {
    const g = graph(
      [T('a'), T('b'), S('s1'), S('s2'), S('s3')],
      [
        ['s3', 'b'],
        ['s3', 'a'],
        ['s2', 'b'],
        ['s2', 'a'],
        ['s1', 'b'],
        ['s1', 'a'],
      ],
    );
    const first = shortestPath(g, 'a', 'b');
    for (let i = 0; i < 5; i++) expect(shortestPath(g, 'a', 'b')).toEqual(first);
    expect(first).toEqual(['a', 's1', 'b']);
  });

  it('AC-14-06 ties between topics in a longer chain also resolve to lowest ids', () => {
    // a - s1 - {m1, m2} - s2 - b
    const g = graph(
      [T('a'), T('b'), T('m2'), T('m1'), S('s1'), S('s2')],
      [
        ['s1', 'a'],
        ['s1', 'm2'],
        ['s1', 'm1'],
        ['s2', 'm2'],
        ['s2', 'm1'],
        ['s2', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toEqual(['a', 's1', 'm1', 's2', 'b']);
  });

  it('AC-14-06 a lower-id route that is longer does not beat a shorter one', () => {
    const g = graph(
      [T('a'), T('b'), T('m'), S('s1'), S('s2'), S('s9')],
      [
        ['s1', 'a'],
        ['s1', 'm'],
        ['s2', 'm'],
        ['s2', 'b'],
        ['s9', 'a'],
        ['s9', 'b'],
      ],
    );
    expect(shortestPath(g, 'a', 'b')).toEqual(['a', 's9', 'b']);
  });
});

// ---------- nextMonth ----------

describe('nextMonth', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-05'];

  it('AC-14-07 null steps to the first month', () => {
    expect(nextMonth(months, null)).toBe('2026-01');
  });

  it('AC-14-07 steps from month to month', () => {
    expect(nextMonth(months, '2026-01')).toBe('2026-02');
    expect(nextMonth(months, '2026-02')).toBe('2026-03');
    expect(nextMonth(months, '2026-03')).toBe('2026-05');
  });

  it('AC-14-07 returns null after the last month', () => {
    expect(nextMonth(months, '2026-05')).toBeNull();
  });

  it('AC-14-07 returns null for an unknown month', () => {
    expect(nextMonth(months, '2025-12')).toBeNull();
    expect(nextMonth(months, '2026-04')).toBeNull();
    expect(nextMonth(months, '')).toBeNull();
  });

  it('AC-14-07 an empty list gives null for null and for any month', () => {
    expect(nextMonth([], null)).toBeNull();
    expect(nextMonth([], '2026-01')).toBeNull();
  });

  it('AC-14-07 a single-month list steps in and then out', () => {
    expect(nextMonth(['2026-07'], null)).toBe('2026-07');
    expect(nextMonth(['2026-07'], '2026-07')).toBeNull();
  });

  it('AC-14-07 does not mutate the list', () => {
    const list = deepFreeze(['2026-01', '2026-02']);
    expect(nextMonth(list, '2026-01')).toBe('2026-02');
    expect(list).toEqual(['2026-01', '2026-02']);
  });
});

// ---------- clusterBounds ----------

describe('clusterBounds', () => {
  it('AC-14-08 no points gives centre 0,0,0 and radius 120', () => {
    expect(clusterBounds([])).toEqual({ center: { x: 0, y: 0, z: 0 }, radius: 120 });
  });

  it('AC-14-08 centre is the mean point and radius is the farthest distance plus 40', () => {
    const pts: Point3[] = [
      { x: -300, y: 0, z: 0 },
      { x: 300, y: 0, z: 0 },
    ];
    const b = clusterBounds(pts);
    expect(b.center.x).toBeCloseTo(0, 9);
    expect(b.center.y).toBeCloseTo(0, 9);
    expect(b.center.z).toBeCloseTo(0, 9);
    expect(b.radius).toBeCloseTo(340, 9);
  });

  it('AC-14-08 uses the farthest point, not the average distance', () => {
    const pts: Point3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 300, y: 0, z: 0 },
    ];
    const b = clusterBounds(pts);
    expect(b.center.x).toBeCloseTo(75, 9);
    expect(b.center.y).toBeCloseTo(0, 9);
    expect(b.center.z).toBeCloseTo(0, 9);
    expect(b.radius).toBeCloseTo(265, 9);
  });

  it('AC-14-08 averages all three axes and measures distance in 3D', () => {
    const pts: Point3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 60, y: 80, z: 120 },
    ];
    const b = clusterBounds(pts);
    expect(b.center.x).toBeCloseTo(30, 9);
    expect(b.center.y).toBeCloseTo(40, 9);
    expect(b.center.z).toBeCloseTo(60, 9);
    expect(b.radius).toBeCloseTo(Math.hypot(30, 40, 60) + 40, 9);
  });

  it('AC-14-08 the radius is at least 80 for a single point', () => {
    const b = clusterBounds([{ x: 10, y: 20, z: 30 }]);
    expect(b.center).toEqual({ x: 10, y: 20, z: 30 });
    expect(b.radius).toBe(80);
  });

  it('AC-14-08 the radius is at least 80 for a tight cluster', () => {
    const b = clusterBounds([
      { x: 0, y: 0, z: 0 },
      { x: 6, y: 8, z: 0 },
    ]);
    expect(b.center.x).toBeCloseTo(3, 9);
    expect(b.center.y).toBeCloseTo(4, 9);
    expect(b.radius).toBe(80);
  });

  it('AC-14-08 farthest distance 40 gives exactly 80 and 41 gives 81', () => {
    const at40 = clusterBounds([
      { x: -40, y: 0, z: 0 },
      { x: 40, y: 0, z: 0 },
    ]);
    expect(at40.radius).toBeCloseTo(80, 9);
    const at41 = clusterBounds([
      { x: 0, y: -41, z: 0 },
      { x: 0, y: 41, z: 0 },
    ]);
    expect(at41.radius).toBeCloseTo(81, 9);
  });

  it('AC-14-08 does not mutate the points', () => {
    const pts = deepFreeze([
      { x: 1, y: 2, z: 3 },
      { x: 5, y: 6, z: 7 },
    ]);
    const b = clusterBounds(pts);
    expect(b.center).toEqual({ x: 3, y: 4, z: 5 });
    expect(pts[0]).toEqual({ x: 1, y: 2, z: 3 });
  });
});

// ---------- orbitPosition ----------

describe('orbitPosition', () => {
  const center: Point3 = { x: 10, y: 5, z: -20 };

  it('AC-14-09 angle 0 is straight along +z from the centre', () => {
    const p = orbitPosition(center, 100, 0);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBe(5);
    expect(p.z).toBeCloseTo(80, 9);
  });

  it('AC-14-09 quarter, half and three-quarter turns', () => {
    const q = orbitPosition(center, 100, Math.PI / 2);
    expect(q.x).toBeCloseTo(110, 9);
    expect(q.z).toBeCloseTo(-20, 9);
    const h = orbitPosition(center, 100, Math.PI);
    expect(h.x).toBeCloseTo(10, 9);
    expect(h.z).toBeCloseTo(-120, 9);
    const t = orbitPosition(center, 100, (3 * Math.PI) / 2);
    expect(t.x).toBeCloseTo(-90, 9);
    expect(t.z).toBeCloseTo(-20, 9);
  });

  it('AC-14-09 keeps y equal to the centre y for any angle', () => {
    for (const a of [0, 0.5, 1.234, Math.PI, 4.5, -2, 10]) {
      expect(orbitPosition(center, 77, a).y).toBe(5);
    }
  });

  it('AC-14-09 sits exactly radius away from the centre on the x-z plane', () => {
    for (const a of [0, 0.3, 1.234, 2.5, 3.9, 5.7, -1.1]) {
      const p = orbitPosition(center, 250, a);
      expect(Math.hypot(p.x - center.x, p.z - center.z)).toBeCloseTo(250, 9);
    }
  });

  it('AC-14-09 follows x = cx + r sin(angle), z = cz + r cos(angle)', () => {
    const angle = 1.0;
    const p = orbitPosition({ x: 1, y: 2, z: 3 }, 50, angle);
    expect(p.x).toBeCloseTo(1 + 50 * Math.sin(angle), 9);
    expect(p.y).toBe(2);
    expect(p.z).toBeCloseTo(3 + 50 * Math.cos(angle), 9);
  });

  it('AC-14-09 a radius of 0 stays at the centre', () => {
    const p = orbitPosition(center, 0, 2.2);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBe(5);
    expect(p.z).toBeCloseTo(-20, 9);
  });

  it('AC-14-09 does not mutate the centre', () => {
    const c = deepFreeze({ x: 1, y: 2, z: 3 });
    orbitPosition(c, 10, 1);
    expect(c).toEqual({ x: 1, y: 2, z: 3 });
  });
});
