import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 15 is an app shell (rendering in main.ts) checked by build, tsc and the browser.
// Only the static, file-level parts of the contract are unit-testable: the `three`
// dependency (package.json + package-lock.json) and the legend element in index.html.

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockPackage {
  version?: string;
  dependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, LockPackage>;
}

function readText(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('three dependency', () => {
  const pkg = JSON.parse(readText('../package.json')) as PackageJson;

  it('AC-15-01 package.json lists three at ^0.179.0 under dependencies', () => {
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies?.['three']).toBe('^0.179.0');
  });

  it('AC-15-01 package.json keeps 3d-force-graph and force-graph alongside three', () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toContain('three');
    expect(deps).toContain('3d-force-graph');
    expect(deps).toContain('force-graph');
  });

  it('AC-15-01 package-lock.json root entry lists three at ^0.179.0', () => {
    const lock = JSON.parse(readText('../package-lock.json')) as PackageLock;
    expect(lock.packages?.['']?.dependencies?.['three']).toBe('^0.179.0');
  });

  it('AC-15-01 package-lock.json resolves three to a 0.179.x version', () => {
    const lock = JSON.parse(readText('../package-lock.json')) as PackageLock;
    const version = lock.packages?.['node_modules/three']?.version ?? '';
    expect(version).toMatch(/^0\.179\.\d+$/);
  });
});

describe('legend element', () => {
  const html = readText('../index.html');

  it('AC-15-03 index.html contains a <div id="legend"> element', () => {
    expect(html).toMatch(/<div\b[^>]*\bid\s*=\s*["']legend["'][^>]*>/i);
  });

  it('AC-15-03 index.html has exactly one element with id legend', () => {
    const matches = html.match(/\bid\s*=\s*["']legend["']/gi) ?? [];
    expect(matches).toHaveLength(1);
  });
});
