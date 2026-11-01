import { describe, it, expect } from 'vitest';
import {
  GraphError,
  NODE_TYPES,
  TYPE_COLORS,
  filterByTypes,
  linkEnd,
  neighbors,
  nodeDetails,
  parseGraph,
  searchNodes,
} from '../src/graph';
import type { GraphData, GraphLink, GraphNode, NodeType } from '../src/graph';

function node(id: string, type: NodeType, label: string, size = 1): GraphNode {
  return { id, type, label, size, meta: {} };
}

function link(
  source: string | { id: string },
  target: string | { id: string },
  type = 'rel',
): GraphLink {
  return { source, target, type };
}

function edgeKeys(links: GraphLink[]): string[] {
  return links.map((l) => `${linkEnd(l.source)}->${linkEnd(l.target)}`).sort();
}

function ids(nodes: GraphNode[]): string[] {
  return nodes.map((n) => n.id);
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

function expectInvalid(input: unknown): void {
  let caught: unknown;
  try {
    parseGraph(input);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(GraphError);
  expect((caught as GraphError).name).toBe('GraphError');
  expect((caught as GraphError).message.startsWith('Invalid graph')).toBe(true);
}

describe('linkEnd', () => {
  it('AC-07-04 returns a string endpoint unchanged', () => {
    expect(linkEnd('abc')).toBe('abc');
  });

  it('AC-07-04 returns the id of an object endpoint', () => {
    expect(linkEnd({ id: 'xyz' })).toBe('xyz');
  });
});

describe('parseGraph valid input', () => {
  const raw = {
    nodes: [
      { id: 's1', type: 'session', label: 'Session One', size: 4, meta: { when: '2025-01-01' } },
      { id: 'p1', type: 'project', label: 'Project One' },
      { id: 't1', type: 'topic', label: 'Topic One', size: 0 },
    ],
    links: [
      { source: 's1', target: 'p1', type: 'in_project' },
      { source: { id: 's1' }, target: { id: 't1' } },
    ],
  };

  it('AC-07-01 accepts a valid graph given as an object and defaults size and meta', () => {
    const g = parseGraph(raw);
    expect(g.nodes).toHaveLength(3);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('s1')).toEqual({
      id: 's1',
      type: 'session',
      label: 'Session One',
      size: 4,
      meta: { when: '2025-01-01' },
    });
    expect(byId.get('p1')).toEqual({
      id: 'p1',
      type: 'project',
      label: 'Project One',
      size: 1,
      meta: {},
    });
    expect(byId.get('t1')?.size).toBe(1);
    expect(byId.get('t1')?.meta).toEqual({});
  });

  it('AC-07-01 accepts a valid graph given as a JSON string', () => {
    const g = parseGraph(JSON.stringify(raw));
    expect(ids(g.nodes).sort()).toEqual(['p1', 's1', 't1']);
    expect(g.links).toHaveLength(2);
  });

  it('AC-07-01 string and object inputs give equal results', () => {
    expect(parseGraph(JSON.stringify(raw))).toEqual(parseGraph(raw));
  });

  it('AC-07-01 returns link endpoints as strings and defaults link type to empty string', () => {
    const g = parseGraph(raw);
    for (const l of g.links) {
      expect(typeof l.source).toBe('string');
      expect(typeof l.target).toBe('string');
    }
    const withType = g.links.find((l) => l.target === 'p1');
    const withoutType = g.links.find((l) => l.target === 't1');
    expect(withType).toEqual({ source: 's1', target: 'p1', type: 'in_project' });
    expect(withoutType).toEqual({ source: 's1', target: 't1', type: '' });
  });

  it('AC-07-01 defaults size to 1 when it is not a positive number', () => {
    const bad: unknown[] = [undefined, 0, -2, '7', null, Number.NaN];
    const g = parseGraph({
      nodes: bad.map((size, i) => ({ id: `n${i}`, type: 'file', label: `L${i}`, size })),
      links: [],
    });
    expect(g.nodes.map((n) => n.size)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('AC-07-01 keeps a positive fractional size', () => {
    const g = parseGraph({
      nodes: [{ id: 'a', type: 'tool', label: 'A', size: 2.5 }],
      links: [],
    });
    expect(g.nodes[0].size).toBe(2.5);
  });

  it('AC-07-01 accepts all five node types and an empty graph', () => {
    const g = parseGraph({
      nodes: NODE_TYPES.map((t) => ({ id: `id-${t}`, type: t, label: `label-${t}` })),
      links: [],
    });
    expect(g.nodes.map((n) => n.type)).toEqual([...NODE_TYPES]);
    expect(parseGraph({ nodes: [], links: [] })).toEqual({ nodes: [], links: [] });
  });
});

describe('parseGraph invalid input', () => {
  it('AC-07-02 rejects malformed JSON text', () => {
    expectInvalid('{not json');
    expectInvalid('');
  });

  it('AC-07-02 rejects a missing nodes array', () => {
    expectInvalid({ links: [] });
    expectInvalid({ nodes: 'nope', links: [] });
    expectInvalid(JSON.stringify({ links: [] }));
  });

  it('AC-07-02 rejects a missing links array', () => {
    expectInvalid({ nodes: [] });
    expectInvalid({ nodes: [], links: {} });
    expectInvalid(JSON.stringify({ nodes: [] }));
  });

  it('AC-07-02 rejects input that is not an object', () => {
    expectInvalid(null);
    expectInvalid(42);
    expectInvalid('null');
  });

  it('AC-07-02 rejects a node without an id', () => {
    expectInvalid({ nodes: [{ type: 'session', label: 'x' }], links: [] });
    expectInvalid({ nodes: [{ id: 5, type: 'session', label: 'x' }], links: [] });
  });

  it('AC-07-02 rejects an unknown or missing node type', () => {
    expectInvalid({ nodes: [{ id: 'a', type: 'banana', label: 'x' }], links: [] });
    expectInvalid({ nodes: [{ id: 'a', label: 'x' }], links: [] });
  });

  it('AC-07-02 rejects a node without a string label', () => {
    expectInvalid({ nodes: [{ id: 'a', type: 'file' }], links: [] });
    expectInvalid({ nodes: [{ id: 'a', type: 'file', label: 3 }], links: [] });
  });

  it('AC-07-02 GraphError is an Error with name GraphError', () => {
    const e = new GraphError('Invalid graph: x');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('GraphError');
    expect(e.message).toBe('Invalid graph: x');
  });
});

describe('parseGraph cleaning', () => {
  it('AC-07-03 drops links whose endpoints are not node ids', () => {
    const g = parseGraph({
      nodes: [
        { id: 'a', type: 'session', label: 'A' },
        { id: 'b', type: 'topic', label: 'B' },
      ],
      links: [
        { source: 'a', target: 'b', type: 'k' },
        { source: 'a', target: 'ghost', type: 'k' },
        { source: 'ghost', target: 'b', type: 'k' },
        { source: { id: 'a' }, target: { id: 'nowhere' }, type: 'k' },
      ],
    });
    expect(g.links).toEqual([{ source: 'a', target: 'b', type: 'k' }]);
  });

  it('AC-07-03 keeps the first node when ids are duplicated', () => {
    const g = parseGraph({
      nodes: [
        { id: 'dup', type: 'file', label: 'First', size: 3 },
        { id: 'other', type: 'tool', label: 'Other' },
        { id: 'dup', type: 'topic', label: 'Second', size: 9 },
      ],
      links: [{ source: 'dup', target: 'other', type: 'k' }],
    });
    expect(g.nodes).toHaveLength(2);
    const dup = g.nodes.find((n) => n.id === 'dup');
    expect(dup?.label).toBe('First');
    expect(dup?.type).toBe('file');
    expect(dup?.size).toBe(3);
    expect(g.links).toHaveLength(1);
  });

  it('AC-07-03 does not mutate its input and returns new objects', () => {
    const input = {
      nodes: [
        { id: 'a', type: 'session', label: 'A', meta: { k: [1, 2] } },
        { id: 'b', type: 'project', label: 'B', size: 2 },
        { id: 'a', type: 'tool', label: 'Dup' },
      ],
      links: [
        { source: { id: 'a' }, target: { id: 'b' } },
        { source: 'a', target: 'missing', type: 'x' },
      ],
    };
    const before = structuredClone(input);
    deepFreeze(input);
    const g = parseGraph(input);
    expect(input).toEqual(before);
    expect(g.nodes[0]).not.toBe(input.nodes[0]);
    expect(g.nodes).not.toBe(input.nodes);
    expect(g.links).not.toBe(input.links);
    expect(g.links).toEqual([{ source: 'a', target: 'b', type: '' }]);
  });
});

describe('filterByTypes', () => {
  const g: GraphData = {
    nodes: [
      node('s1', 'session', 'S1'),
      node('p1', 'project', 'P1'),
      node('t1', 'topic', 'T1'),
      node('f1', 'file', 'F1'),
    ],
    links: [
      link('s1', 'p1'),
      link({ id: 's1' }, { id: 't1' }),
      link('t1', { id: 'f1' }),
      link({ id: 'p1' }, 't1'),
    ],
  };

  it('AC-07-04 removes nodes of other types and every link touching them', () => {
    const out = filterByTypes(g, ['session', 'project']);
    expect(ids(out.nodes).sort()).toEqual(['p1', 's1']);
    expect(edgeKeys(out.links)).toEqual(['s1->p1']);
  });

  it('AC-07-04 handles object endpoints when removing links', () => {
    const out = filterByTypes(g, ['session', 'topic']);
    expect(ids(out.nodes).sort()).toEqual(['s1', 't1']);
    expect(edgeKeys(out.links)).toEqual(['s1->t1']);
  });

  it('AC-07-04 accepts any iterable of types', () => {
    const out = filterByTypes(g, new Set<NodeType>(['topic', 'file']));
    expect(ids(out.nodes).sort()).toEqual(['f1', 't1']);
    expect(edgeKeys(out.links)).toEqual(['t1->f1']);
  });

  it('AC-07-04 keeps everything when all types are selected', () => {
    const out = filterByTypes(g, NODE_TYPES);
    expect(ids(out.nodes).sort()).toEqual(['f1', 'p1', 's1', 't1']);
    expect(out.links).toHaveLength(4);
  });

  it('AC-07-04 returns an empty graph for no types', () => {
    const out = filterByTypes(g, []);
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('AC-07-04 does not mutate the input', () => {
    const copy = structuredClone(g);
    deepFreeze(g);
    filterByTypes(g, ['file']);
    expect(g).toEqual(copy);
  });
});

describe('searchNodes', () => {
  const g: GraphData = {
    nodes: [
      node('x1', 'topic', 'Zebra auth notes'),
      node('x2', 'file', 'Auth service'),
      node('auth-id', 'tool', 'Unrelated'),
      node('x3', 'session', 'Nothing here'),
    ],
    links: [],
  };

  it('AC-07-05 ranks prefix label matches, then substring matches, then id-only matches', () => {
    expect(ids(searchNodes(g, 'auth'))).toEqual(['x2', 'x1', 'auth-id']);
  });

  it('AC-07-05 is case-insensitive and trims the query', () => {
    expect(ids(searchNodes(g, '  AuTh  '))).toEqual(['x2', 'x1', 'auth-id']);
  });

  it('AC-07-05 returns an empty array for blank queries', () => {
    expect(searchNodes(g, '')).toEqual([]);
    expect(searchNodes(g, '   ')).toEqual([]);
    expect(searchNodes(g, '\t\n')).toEqual([]);
  });

  it('AC-07-05 returns an empty array when nothing matches', () => {
    expect(searchNodes(g, 'qqqq')).toEqual([]);
  });

  it('AC-07-05 honours an explicit limit', () => {
    expect(ids(searchNodes(g, 'auth', 2))).toEqual(['x2', 'x1']);
    expect(ids(searchNodes(g, 'auth', 1))).toEqual(['x2']);
  });

  it('AC-07-05 defaults the limit to 20', () => {
    const many: GraphData = {
      nodes: Array.from({ length: 25 }, (_, i) =>
        node(`id${String(i).padStart(2, '0')}`, 'file', `match ${String(i).padStart(2, '0')}`),
      ),
      links: [],
    };
    const out = searchNodes(many, 'match');
    expect(out).toHaveLength(20);
    expect(out[0].label).toBe('match 00');
    expect(out[19].label).toBe('match 19');
  });

  it('AC-07-05 breaks ties by lower-cased label, then by id', () => {
    const t: GraphData = {
      nodes: [
        node('n3', 'file', 'Beta'),
        node('n2', 'file', 'alpha'),
        node('n9', 'file', 'Same'),
        node('n1', 'file', 'same'),
      ],
      links: [],
    };
    expect(ids(searchNodes(t, 'a'))).toEqual(['n2', 'n3', 'n1', 'n9']);
  });

  it('AC-07-05 orders equal labels by id', () => {
    const t: GraphData = {
      nodes: [node('b', 'file', 'Same'), node('a', 'file', 'Same'), node('c', 'file', 'same')],
      links: [],
    };
    expect(ids(searchNodes(t, 'sam'))).toEqual(['a', 'b', 'c']);
  });

  it('AC-07-05 compares labels without locale rules', () => {
    const t: GraphData = {
      nodes: [node('1', 'file', 'xé'), node('2', 'file', 'xf')],
      links: [],
    };
    expect(ids(searchNodes(t, 'x'))).toEqual(['2', '1']);
  });

  it('AC-07-05 does not mutate the graph', () => {
    const copy = structuredClone(g);
    deepFreeze(g);
    searchNodes(g, 'auth');
    expect(g).toEqual(copy);
  });
});

describe('neighbors', () => {
  const g: GraphData = {
    nodes: [
      node('c', 'topic', 'C'),
      node('a', 'session', 'A'),
      node('b', 'project', 'B'),
      node('d', 'file', 'D'),
      node('e', 'tool', 'E'),
    ],
    links: [
      link('a', 'c'),
      link({ id: 'd' }, { id: 'a' }),
      link('a', 'b'),
      link('b', 'a'),
      link('c', 'd'),
    ],
  };

  it('AC-07-06 returns direct neighbours in both directions, sorted by id, without duplicates', () => {
    const out = neighbors(g, 'a');
    expect(ids(out.nodes)).toEqual(['b', 'c', 'd']);
  });

  it('AC-07-06 returns the links touching the node', () => {
    const out = neighbors(g, 'a');
    expect(edgeKeys(out.links)).toEqual(['a->b', 'a->c', 'b->a', 'd->a']);
  });

  it('AC-07-06 excludes the node itself even with a self link', () => {
    const withLoop: GraphData = {
      nodes: [node('a', 'session', 'A'), node('b', 'topic', 'B')],
      links: [link('a', 'a'), link('a', 'b')],
    };
    expect(ids(neighbors(withLoop, 'a').nodes)).toEqual(['b']);
  });

  it('AC-07-06 returns empty arrays for an isolated node', () => {
    const out = neighbors(g, 'e');
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('AC-07-06 returns empty arrays for an unknown id', () => {
    const out = neighbors(g, 'nope');
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('AC-07-06 does not mutate the graph', () => {
    const copy = structuredClone(g);
    deepFreeze(g);
    neighbors(g, 'a');
    expect(g).toEqual(copy);
  });
});

describe('nodeDetails', () => {
  const g: GraphData = {
    nodes: [
      node('s1', 'session', 'Main session'),
      node('t2', 'topic', 'zeta'),
      node('t1', 'topic', 'alpha'),
      node('f1', 'file', 'file.ts'),
      node('p1', 'project', 'proj'),
      node('lonely', 'tool', 'Lonely'),
    ],
    links: [
      link('s1', 't2'),
      link({ id: 't1' }, { id: 's1' }),
      link('s1', 'f1'),
      link('s1', 'f1'),
    ],
  };

  it('AC-07-07 returns null for an unknown id', () => {
    expect(nodeDetails(g, 'missing')).toBeNull();
  });

  it('AC-07-07 returns the node and neighbours grouped by type with all five keys', () => {
    const d = nodeDetails(g, 's1');
    expect(d).not.toBeNull();
    expect(d?.node.id).toBe('s1');
    expect(d?.node.label).toBe('Main session');
    expect(Object.keys(d!.neighborsByType).sort()).toEqual([...NODE_TYPES].sort());
    expect(ids(d!.neighborsByType.file)).toEqual(['f1']);
    expect(ids(d!.neighborsByType.session)).toEqual([]);
    expect(ids(d!.neighborsByType.project)).toEqual([]);
    expect(ids(d!.neighborsByType.tool)).toEqual([]);
  });

  it('AC-07-07 sorts each group by label', () => {
    const d = nodeDetails(g, 's1');
    expect(d!.neighborsByType.topic.map((n) => n.label)).toEqual(['alpha', 'zeta']);
  });

  it('AC-07-07 gives every key with an empty array for a node without neighbours', () => {
    const d = nodeDetails(g, 'lonely');
    expect(d?.node.id).toBe('lonely');
    for (const t of NODE_TYPES) {
      expect(d!.neighborsByType[t]).toEqual([]);
    }
  });
});

describe('TYPE_COLORS', () => {
  it('AC-07-08 has exactly one entry per node type', () => {
    expect(Object.keys(TYPE_COLORS).sort()).toEqual([...NODE_TYPES].sort());
    expect([...NODE_TYPES]).toEqual(['session', 'project', 'topic', 'file', 'tool']);
  });

  it('AC-07-08 uses #rrggbb hex colours', () => {
    for (const t of NODE_TYPES) {
      expect(TYPE_COLORS[t]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('AC-07-08 uses five distinct colours', () => {
    const colours = NODE_TYPES.map((t) => TYPE_COLORS[t].toLowerCase());
    expect(new Set(colours).size).toBe(5);
  });
});
