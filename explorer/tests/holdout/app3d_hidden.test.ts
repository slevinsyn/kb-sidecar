import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function path(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path(rel), 'utf8')) as T;
}

describe('three dependency (hidden)', () => {
  it('AC-15-01 three is a runtime dependency, not a devDependency, in package.json and the lock root', () => {
    const pkg = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>('../../package.json');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('three');
    expect(Object.keys(pkg.dependencies ?? {})).toContain('three');

    const lock = readJson<{
      packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    }>('../../package-lock.json');
    const root = lock.packages?.[''];
    expect(Object.keys(root?.devDependencies ?? {})).not.toContain('three');
    expect(root?.dependencies?.['three']).toBe(pkg.dependencies?.['three']);
  });

  it('AC-15-01 the installed three is 0.179.x and ships the UnrealBloomPass module main.ts imports', () => {
    const installed = readJson<{ name?: string; version?: string }>('../../node_modules/three/package.json');
    expect(installed.name).toBe('three');
    expect(installed.version ?? '').toMatch(/^0\.179\.\d+$/);
    expect(
      existsSync(path('../../node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js')),
    ).toBe(true);
  });
});

describe('legend element (hidden)', () => {
  it('AC-15-03 the legend div sits inside the document body', () => {
    const html = readFileSync(path('../../index.html'), 'utf8');
    const bodyOpen = html.search(/<body\b/i);
    const bodyClose = html.search(/<\/body>/i);
    const legend = html.search(/<div\b[^>]*\bid\s*=\s*["']legend["']/i);
    expect(bodyOpen).toBeGreaterThanOrEqual(0);
    expect(bodyClose).toBeGreaterThan(bodyOpen);
    expect(legend).toBeGreaterThan(bodyOpen);
    expect(legend).toBeLessThan(bodyClose);
  });
});
