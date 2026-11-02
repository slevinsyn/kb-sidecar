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
} from '../../src/scene3d';
import type { GraphData, GraphNode, NodeType } from '../../src/graph';

function node(id: string, type: NodeType): GraphNode {
  return { id, type, label: id.toUpperCase(), size: 2, meta: {} };
}

function build(
  nodes: Array<[string, NodeType]>,
  links: Array<[string, string, string]>,
): GraphData {
  return {
    nodes: nodes.map(([id, type]) => node(id, type)),
    links: links.map(([source, target, type]) => ({ source, target, type })),
  };
}

describe('hidden scene3d logic tests', () => {
  it('AC-14-01 AC-14-02 filter drops noise, keeps nodes and order, normalises {id} ends', () => {
    const g: GraphData = {
      nodes: [
        node('sx', 'session'),
        node('sy', 'session'),
        node('tz', 'topic'),
        node('pw', 'project'),
        node('fq', 'file'),
        node('tr', 'tool'),
      ],
      links: [
        { source: { id: 'sy' }, target: { id: 'fq' }, type: 'touched_file' },
        { source: { id: 'sy' }, target: 'pw', type: 'in_project' },
        { source: 'tr', target: { id: 'sx' }, type: 'used_tool' },
        { source: 'tz', target: { id: 'sx' }, type: 'has_topic' },
        { source: 'sx', target: 'pw', type: 'in_project' },
        { source: 'sx', target: 'fq', type: 'touched_file' },
      ],
    };
    const snapshot = JSON.stringify(g);
    Object.freeze(g.links);
    expect([...NOISE_LINK_TYPES]).toContain('used_tool');
    expect([...NOISE_LINK_TYPES]).toContain('touched_file');

    const quiet = defaultLinkFilter(g);
    expect(quiet.nodes.map((n) => n.id)).toEqual(['sx', 'sy', 'tz', 'pw', 'fq', 'tr']);
    expect(quiet.links).toEqual([
      { source: 'sy', target: 'pw', type: 'in_project' },
      { source: 'tz', target: 'sx', type: 'has_topic' },
      { source: 'sx', target: 'pw', type: 'in_project' },
    ]);

    const loud = defaultLinkFilter(g, true);
    expect(loud.links.map((l) => l.type)).toEqual([
      'touched_file',
      'in_project',
      'used_tool',
      'has_topic',
      'in_project',
      'touched_file',
    ]);
    for (const l of loud.links) {
      expect(typeof l.source).toBe('string');
      expect(typeof l.target).toBe('string');
    }
    expect(loud.links[0]).toEqual({ source: 'sy', target: 'fq', type: 'touched_file' });
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it('AC-14-03 link colours for every type, default and custom alpha', () => {
    expect(LINK_OPACITY).toBe(0.15);
    const table: Array<[string, string]> = [
      ['in_project', '247, 201, 107'],
      ['has_topic', '122, 162, 247'],
      ['touched_file', '158, 206, 106'],
      ['used_tool', '187, 154, 247'],
      ['something_else', '138, 143, 152'],
    ];
    for (const [type, rgb] of table) {
      expect(linkRgba(type)).toBe(`rgba(${rgb}, 0.15)`);
      expect(linkRgba(type, 0.7)).toBe(`rgba(${rgb}, 0.7)`);
      expect(linkRgba(type, 0.05)).toBe(`rgba(${rgb}, 0.05)`);
      expect(linkRgba(type, 1)).toBe(`rgba(${rgb}, 1)`);
    }
  });

  it('AC-14-04 AC-14-05 path across a longer topic-session chain avoids non-conversation nodes', () => {
    const g = build(
      [
        ['t1', 'topic'],
        ['t2', 'topic'],
        ['t3', 'topic'],
        ['t4', 'topic'],
        ['s1', 'session'],
        ['s2', 'session'],
        ['s3', 'session'],
        ['proj', 'project'],
        ['file', 'file'],
        ['tool', 'tool'],
      ],
      [
        ['t1', 's1', 'has_topic'],
        ['s1', 't2', 'has_topic'],
        ['t2', 's2', 'has_topic'],
        ['s2', 't3', 'has_topic'],
        ['t3', 's3', 'has_topic'],
        ['s3', 't4', 'has_topic'],
        ['t1', 'proj', 'in_project'],
        ['proj', 't4', 'in_project'],
        ['s1', 'file', 'touched_file'],
        ['file', 's3', 'touched_file'],
        ['s2', 'tool', 'used_tool'],
        ['tool', 't4', 'used_tool'],
      ],
    );
    expect(shortestPath(g, 't1', 't4')).toEqual(['t1', 's1', 't2', 's2', 't3', 's3', 't4']);
    expect(shortestPath(g, 't4', 't1')).toEqual(['t4', 's3', 't3', 's2', 't2', 's1', 't1']);
    expect(shortestPath(g, 't2', 't2')).toEqual(['t2']);
    expect(shortestPath(g, 't2', 'missing')).toBeNull();
    expect(shortestPath(g, 'missing', 't2')).toBeNull();
    expect(shortestPath(g, 't1', 'proj')).toBeNull();
  });

  it('AC-14-05 two components joined only by a project are unreachable', () => {
    const g = build(
      [
        ['left', 'topic'],
        ['right', 'topic'],
        ['sl', 'session'],
        ['sr', 'session'],
        ['hub', 'project'],
      ],
      [
        ['sl', 'left', 'has_topic'],
        ['sr', 'right', 'has_topic'],
        ['sl', 'hub', 'in_project'],
        ['sr', 'hub', 'in_project'],
      ],
    );
    expect(shortestPath(g, 'left', 'right')).toBeNull();
    expect(shortestPath(g, 'sl', 'sr')).toBeNull();
    expect(shortestPath(g, 'left', 'sl')).toEqual(['left', 'sl']);
  });

  it('AC-14-06 three-way tie is broken by lowest id and is stable across calls and orderings', () => {
    const nodes: Array<[string, NodeType]> = [
      ['origin', 'topic'],
      ['goal', 'topic'],
      ['sc', 'session'],
      ['sa', 'session'],
      ['sb', 'session'],
    ];
    const links: Array<[string, string, string]> = [
      ['sc', 'origin', 'has_topic'],
      ['goal', 'sc', 'has_topic'],
      ['sb', 'origin', 'has_topic'],
      ['goal', 'sb', 'has_topic'],
      ['sa', 'origin', 'has_topic'],
      ['goal', 'sa', 'has_topic'],
    ];
    const g1 = build(nodes, links);
    const g2 = build([...nodes].reverse(), [...links].reverse());
    const expected = ['origin', 'sa', 'goal'];
    expect(shortestPath(g1, 'origin', 'goal')).toEqual(expected);
    expect(shortestPath(g1, 'origin', 'goal')).toEqual(expected);
    expect(shortestPath(g2, 'origin', 'goal')).toEqual(expected);
    expect(shortestPath(g1, 'goal', 'origin')).toEqual(['goal', 'sa', 'origin']);
  });

  it('AC-14-07 month stepping with a different list', () => {
    const months = ['2024-11', '2024-12', '2025-01'];
    expect(nextMonth(months, null)).toBe('2024-11');
    expect(nextMonth(months, '2024-11')).toBe('2024-12');
    expect(nextMonth(months, '2024-12')).toBe('2025-01');
    expect(nextMonth(months, '2025-01')).toBeNull();
    expect(nextMonth(months, '2025-02')).toBeNull();
    expect(nextMonth(months, '2024-10')).toBeNull();
    expect(nextMonth([], null)).toBeNull();
    expect(nextMonth([], '2024-11')).toBeNull();
  });

  it('AC-14-08 cluster bounds for other point sets', () => {
    expect(clusterBounds([])).toEqual({ center: { x: 0, y: 0, z: 0 }, radius: 120 });

    const spread = clusterBounds([
      { x: 100, y: 100, z: 100 },
      { x: 100, y: -100, z: 100 },
      { x: 100, y: 100, z: -100 },
      { x: 100, y: -100, z: -100 },
    ]);
    expect(spread.center.x).toBeCloseTo(100, 9);
    expect(spread.center.y).toBeCloseTo(0, 9);
    expect(spread.center.z).toBeCloseTo(0, 9);
    expect(spread.radius).toBeCloseTo(Math.hypot(100, 100) + 40, 9);

    const lopsided = clusterBounds([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 500 },
    ]);
    expect(lopsided.center.z).toBeCloseTo(100, 9);
    expect(lopsided.radius).toBeCloseTo(440, 9);

    const tiny = clusterBounds([
      { x: -5, y: 5, z: 0 },
      { x: 5, y: -5, z: 0 },
    ]);
    expect(tiny.center.x).toBeCloseTo(0, 9);
    expect(tiny.center.y).toBeCloseTo(0, 9);
    expect(tiny.radius).toBe(80);

    const single = clusterBounds([{ x: -7, y: 0.5, z: 900 }]);
    expect(single.center).toEqual({ x: -7, y: 0.5, z: 900 });
    expect(single.radius).toBe(80);
  });

  it('AC-14-09 orbit positions around a different centre', () => {
    const c = { x: -50, y: 120, z: 75 };
    const start = orbitPosition(c, 200, 0);
    expect(start.x).toBeCloseTo(-50, 9);
    expect(start.y).toBe(120);
    expect(start.z).toBeCloseTo(275, 9);

    const quarter = orbitPosition(c, 200, Math.PI / 2);
    expect(quarter.x).toBeCloseTo(150, 9);
    expect(quarter.z).toBeCloseTo(75, 9);

    const back = orbitPosition(c, 200, Math.PI);
    expect(back.x).toBeCloseTo(-50, 9);
    expect(back.z).toBeCloseTo(-125, 9);

    const angle = 2.2;
    const p = orbitPosition(c, 90, angle);
    expect(p.x).toBeCloseTo(-50 + 90 * Math.sin(angle), 9);
    expect(p.y).toBe(120);
    expect(p.z).toBeCloseTo(75 + 90 * Math.cos(angle), 9);
    expect(Math.hypot(p.x - c.x, p.z - c.z)).toBeCloseTo(90, 9);

    const full = orbitPosition(c, 200, 2 * Math.PI);
    expect(full.x).toBeCloseTo(-50, 6);
    expect(full.z).toBeCloseTo(275, 6);
  });
});
