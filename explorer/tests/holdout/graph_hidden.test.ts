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
} from '../../src/graph';
import type { GraphData, GraphNode, NodeType } from '../../src/graph';

function n(id: string, type: NodeType, label: string): GraphNode {
  return { id, type, label, size: 1, meta: {} };
}

function keys(links: { source: string | { id: string }; target: string | { id: string } }[]): string[] {
  return links.map((l) => `${linkEnd(l.source)}>${linkEnd(l.target)}`).sort();
}

describe('hidden graph tests', () => {
  it('AC-07-01 AC-07-03 parses a string graph, cleans it and normalises links', () => {
    const text = JSON.stringify({
      nodes: [
        { id: 'proj/alpha', type: 'project', label: 'Alpha', size: 12, meta: { path: '/x' } },
        { id: 'tool:Bash', type: 'tool', label: 'Bash', size: -1 },
        { id: 'proj/alpha', type: 'file', label: 'Impostor' },
        { id: 'sess-9', type: 'session', label: 'Nine', meta: { n: 9 } },
      ],
      links: [
        { source: { id: 'sess-9' }, target: 'proj/alpha', type: 'part_of' },
        { source: 'sess-9', target: { id: 'tool:Bash' } },
        { source: 'tool:Bash', target: 'tool:Zsh', type: 'bad' },
        { source: 'unknown', target: 'sess-9' },
      ],
    });
    const g = parseGraph(text);
    expect(g.nodes.map((x) => x.id).sort()).toEqual(['proj/alpha', 'sess-9', 'tool:Bash']);
    const alpha = g.nodes.find((x) => x.id === 'proj/alpha');
    expect(alpha).toEqual({
      id: 'proj/alpha',
      type: 'project',
      label: 'Alpha',
      size: 12,
      meta: { path: '/x' },
    });
    const bash = g.nodes.find((x) => x.id === 'tool:Bash');
    expect(bash?.size).toBe(1);
    expect(bash?.meta).toEqual({});
    expect(g.links).toHaveLength(2);
    expect(g.links.find((l) => l.target === 'proj/alpha')).toEqual({
      source: 'sess-9',
      target: 'proj/alpha',
      type: 'part_of',
    });
    expect(g.links.find((l) => l.target === 'tool:Bash')?.type).toBe('');
  });

  it('AC-07-02 rejects several kinds of bad graphs with the Invalid graph prefix', () => {
    const bad: unknown[] = [
      '[1, 2',
      '[]',
      '{"nodes": [], "links": 3}',
      { nodes: [{ id: '', type: 'file' }], links: [] },
      { nodes: [{ id: 'q', type: 'Session', label: 'case matters' }], links: [] },
      { nodes: [{ id: 'q', type: 'folder', label: 'x' }], links: [] },
      { nodes: [null], links: [] },
    ];
    for (const input of bad) {
      let caught: unknown;
      try {
        parseGraph(input);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GraphError);
      expect((caught as Error).message).toMatch(/^Invalid graph/);
    }
  });

  it('AC-07-03 leaves a frozen input untouched', () => {
    const input = Object.freeze({
      nodes: Object.freeze([
        Object.freeze({ id: 'k', type: 'topic', label: 'K' }),
        Object.freeze({ id: 'm', type: 'file', label: 'M' }),
      ]),
      links: Object.freeze([Object.freeze({ source: 'k', target: 'm', type: 'z' })]),
    });
    const g = parseGraph(input);
    expect(g.links).toEqual([{ source: 'k', target: 'm', type: 'z' }]);
    expect(Object.keys(input.nodes[0]).sort()).toEqual(['id', 'label', 'type']);
  });

  it('AC-07-04 filters a graph with mixed endpoint forms', () => {
    const g: GraphData = {
      nodes: [n('a', 'tool', 'A'), n('b', 'tool', 'B'), n('c', 'file', 'C'), n('d', 'topic', 'D')],
      links: [
        { source: { id: 'a' }, target: { id: 'b' }, type: '' },
        { source: 'b', target: { id: 'c' }, type: '' },
        { source: { id: 'd' }, target: 'a', type: '' },
      ],
    };
    const out = filterByTypes(g, ['tool']);
    expect(out.nodes.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(keys(out.links)).toEqual(['a>b']);
    const gen = (function* () {
      yield 'file' as NodeType;
      yield 'topic' as NodeType;
    })();
    const out2 = filterByTypes(g, gen);
    expect(out2.nodes.map((x) => x.id).sort()).toEqual(['c', 'd']);
    expect(out2.links).toEqual([]);
  });

  it('AC-07-05 ranks and limits search results on a different data set', () => {
    const g: GraphData = {
      nodes: [
        n('id-1', 'file', 'readme.md'),
        n('docs/readme', 'topic', 'Documentation'),
        n('id-3', 'tool', 'Read'),
        n('id-4', 'session', 'Spread sheet'),
        n('id-5', 'project', 'READ-ONLY'),
      ],
      links: [],
    };
    expect(searchNodes(g, 'READ').map((x) => x.id)).toEqual([
      'id-3',
      'id-5',
      'id-1',
      'id-4',
      'docs/readme',
    ]);
    expect(searchNodes(g, 'read', 3).map((x) => x.id)).toEqual(['id-3', 'id-5', 'id-1']);
    expect(searchNodes(g, ' \n ')).toEqual([]);
  });

  it('AC-07-05 breaks ties by label then id', () => {
    const g: GraphData = {
      nodes: [n('z', 'file', 'Foo'), n('y', 'file', 'foo'), n('x', 'file', 'FOO'), n('w', 'file', 'Foa')],
      links: [],
    };
    expect(searchNodes(g, 'fo').map((x) => x.id)).toEqual(['w', 'x', 'y', 'z']);
  });

  it('AC-07-06 finds neighbours across link directions and forms', () => {
    const g: GraphData = {
      nodes: [n('hub', 'topic', 'Hub'), n('z', 'file', 'Z'), n('m', 'file', 'M'), n('far', 'tool', 'Far')],
      links: [
        { source: 'z', target: { id: 'hub' }, type: '' },
        { source: { id: 'hub' }, target: 'm', type: '' },
        { source: 'm', target: 'hub', type: '' },
        { source: 'm', target: 'far', type: '' },
      ],
    };
    const out = neighbors(g, 'hub');
    expect(out.nodes.map((x) => x.id)).toEqual(['m', 'z']);
    expect(keys(out.links)).toEqual(['hub>m', 'm>hub', 'z>hub']);
    expect(neighbors(g, 'far').nodes.map((x) => x.id)).toEqual(['m']);
    expect(neighbors(g, 'absent')).toEqual({ nodes: [], links: [] });
  });

  it('AC-07-07 groups details by type', () => {
    const g: GraphData = {
      nodes: [
        n('p', 'project', 'Proj'),
        n('s2', 'session', 'bravo'),
        n('s1', 'session', 'alpha'),
        n('s3', 'session', 'charlie'),
        n('tl', 'tool', 'Grep'),
      ],
      links: [
        { source: 's3', target: 'p', type: '' },
        { source: { id: 's1' }, target: { id: 'p' }, type: '' },
        { source: 'p', target: 's2', type: '' },
        { source: 'p', target: 'tl', type: '' },
      ],
    };
    const d = nodeDetails(g, 'p');
    expect(d).not.toBeNull();
    expect(d?.node.label).toBe('Proj');
    expect(Object.keys(d?.neighborsByType ?? {}).sort()).toEqual(['file', 'project', 'session', 'tool', 'topic']);
    expect(d?.neighborsByType.session.map((x) => x.label)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(d?.neighborsByType.tool.map((x) => x.id)).toEqual(['tl']);
    expect(d?.neighborsByType.topic).toEqual([]);
    expect(nodeDetails(g, 'S1')).toBeNull();
  });

  it('AC-07-08 colours are distinct hex strings for each type', () => {
    expect(NODE_TYPES).toHaveLength(5);
    const values = Object.values(TYPE_COLORS).map((c) => c.toLowerCase());
    expect(values).toHaveLength(5);
    expect(new Set(values).size).toBe(5);
    for (const c of values) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
