import { describe, it, expect } from 'vitest';
import { MAX_EMISSIVE, glowLevels } from '../src/scene3d';
import type { NodeState } from '../src/scene3d';

const STATES: NodeState[] = ['normal', 'selected', 'dim'];

describe('glowLevels', () => {
  it('AC-17-01 normal at brightness 1 hits the cap, opacity 1, ring 0.85', () => {
    const g = glowLevels(1, 'normal');
    expect(MAX_EMISSIVE).toBe(0.25);
    expect(g.emissive).toBeCloseTo(0.25, 10);
    expect(g.opacity).toBeCloseTo(1, 10);
    expect(g.ring).toBeCloseTo(0.85, 10);
  });

  it('AC-17-01 normal at brightness 0 gives 0.05, 0.4, 0.45', () => {
    const g = glowLevels(0, 'normal');
    expect(g.emissive).toBeCloseTo(0.05, 10);
    expect(g.opacity).toBeCloseTo(0.4, 10);
    expect(g.ring).toBeCloseTo(0.45, 10);
  });

  it('AC-17-02 recent node glows at least 0.03 more than an old one', () => {
    const recent = glowLevels(1, 'normal').emissive;
    const old = glowLevels(0.25, 'normal').emissive;
    expect(recent - old).toBeGreaterThanOrEqual(0.03);
    expect(old).toBeCloseTo(0.1, 10);
  });

  it('AC-17-03 selected emissive equals normal emissive for the same brightness', () => {
    for (const b of [0, 0.25, 0.5, 1]) {
      expect(glowLevels(b, 'selected').emissive).toBe(glowLevels(b, 'normal').emissive);
    }
  });

  it('AC-17-03 selected opacity and ring are 1', () => {
    for (const b of [0, 0.25, 0.5, 1]) {
      const g = glowLevels(b, 'selected');
      expect(g.opacity).toBe(1);
      expect(g.ring).toBe(1);
    }
  });

  it('AC-17-04 dim gives 0, 0.3, 0.2 for any brightness', () => {
    for (const b of [0, 0.25, 0.5, 1, -3, 7, NaN]) {
      const g = glowLevels(b, 'dim');
      expect(g.emissive).toBe(0);
      expect(g.opacity).toBe(0.3);
      expect(g.ring).toBe(0.2);
    }
  });

  it('AC-17-05 brightness below 0 behaves like 0', () => {
    expect(glowLevels(-5, 'normal')).toEqual(glowLevels(0, 'normal'));
    expect(glowLevels(-0.001, 'selected')).toEqual(glowLevels(0, 'selected'));
  });

  it('AC-17-05 brightness above 1 behaves like 1', () => {
    expect(glowLevels(5, 'normal')).toEqual(glowLevels(1, 'normal'));
    expect(glowLevels(1.001, 'selected')).toEqual(glowLevels(1, 'selected'));
  });

  it('AC-17-05 NaN behaves like 0.5', () => {
    for (const s of STATES) {
      expect(glowLevels(NaN, s)).toEqual(glowLevels(0.5, s));
    }
    expect(glowLevels(NaN, 'normal').emissive).toBeCloseTo(0.15, 10);
  });

  it('AC-17-05 emissive never exceeds MAX_EMISSIVE and opacity/ring never exceed 1', () => {
    for (const s of STATES) {
      for (const b of [-100, -1, 0, 0.3, 0.5, 0.99, 1, 2, 1e9, Infinity, NaN]) {
        const g = glowLevels(b, s);
        expect(g.emissive).toBeLessThanOrEqual(MAX_EMISSIVE);
        expect(g.emissive).toBeGreaterThanOrEqual(0);
        expect(g.opacity).toBeLessThanOrEqual(1);
        expect(g.ring).toBeLessThanOrEqual(1);
      }
    }
  });
});
