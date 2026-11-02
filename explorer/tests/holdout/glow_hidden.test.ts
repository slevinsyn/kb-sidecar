import { describe, it, expect } from 'vitest';
import { MAX_EMISSIVE, glowLevels } from '../../src/scene3d';

describe('glowLevels hidden', () => {
  it('AC-17-01 normal at brightness 0.6 follows the linear formulas', () => {
    const g = glowLevels(0.6, 'normal');
    expect(g.emissive).toBeCloseTo(0.05 + 0.2 * 0.6, 10);
    expect(g.opacity).toBeCloseTo(0.4 + 0.6 * 0.6, 10);
    expect(g.ring).toBeCloseTo(0.45 + 0.4 * 0.6, 10);
  });

  it('AC-17-02 emissive grows with brightness and differs by 0.2*delta', () => {
    const hi = glowLevels(0.9, 'normal').emissive;
    const lo = glowLevels(0.1, 'normal').emissive;
    expect(hi - lo).toBeCloseTo(0.16, 10);
  });

  it('AC-17-03 selected is never brighter than normal at brightness 0.8', () => {
    const s = glowLevels(0.8, 'selected');
    expect(s.emissive).toBeCloseTo(glowLevels(0.8, 'normal').emissive, 10);
    expect(s.emissive).toBeLessThanOrEqual(MAX_EMISSIVE);
    expect(s.opacity).toBe(1);
    expect(s.ring).toBe(1);
  });

  it('AC-17-04 dim at brightness 0.77 is fixed', () => {
    expect(glowLevels(0.77, 'dim')).toEqual({ emissive: 0, opacity: 0.3, ring: 0.2 });
  });

  it('AC-17-05 out-of-range and NaN inputs are clamped', () => {
    expect(glowLevels(-42, 'normal').emissive).toBeCloseTo(0.05, 10);
    expect(glowLevels(42, 'normal').emissive).toBeCloseTo(MAX_EMISSIVE, 10);
    expect(glowLevels(NaN, 'normal').opacity).toBeCloseTo(0.7, 10);
    expect(glowLevels(NaN, 'normal').ring).toBeCloseTo(0.65, 10);
    expect(glowLevels(NaN, 'selected').emissive).toBeCloseTo(0.15, 10);
  });
});
