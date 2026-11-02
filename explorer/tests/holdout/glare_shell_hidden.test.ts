import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Hidden checks for phase 18 (3D glare fix). Self-contained: own small source scanner.
// They look at the same files as the visible tests but ask different questions
// (numeric relations, contrast maths, order inside the label, every colour in linkColor3d).

// ---------- tiny scanner ----------

interface Text {
  code: string; // comments blanked
  flat: string; // comments, strings and templates blanked (brackets only)
}

function scanText(raw: string): Text {
  let code = '';
  let flat = '';
  let i = 0;
  const pad = (s: string): string => s.replace(/[^\n]/g, ' ');
  while (i < raw.length) {
    const two = raw.slice(i, i + 2);
    if (two === '//') {
      const e = raw.indexOf('\n', i);
      const end = e < 0 ? raw.length : e;
      code += pad(raw.slice(i, end));
      flat += pad(raw.slice(i, end));
      i = end;
    } else if (two === '/*') {
      const e = raw.indexOf('*/', i + 2);
      const end = e < 0 ? raw.length : e + 2;
      code += pad(raw.slice(i, end));
      flat += pad(raw.slice(i, end));
      i = end;
    } else if (raw[i] === '"' || raw[i] === "'" || raw[i] === '`') {
      const q = raw[i];
      let j = i + 1;
      while (j < raw.length && raw[j] !== q && (q === '`' || raw[j] !== '\n')) {
        j += raw[j] === '\\' ? 2 : 1;
      }
      const end = Math.min(raw[j] === q ? j + 1 : j, raw.length);
      code += raw.slice(i, end);
      flat += pad(raw.slice(i, end));
      i = end;
    } else {
      code += raw[i];
      flat += raw[i];
      i += 1;
    }
  }
  return { code, flat };
}

function closeOf(t: Text, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const o = t.flat[open];
  const c = pairs[o];
  let depth = 0;
  for (let i = open; i < t.flat.length; i++) {
    if (t.flat[i] === o) depth++;
    if (t.flat[i] === c && --depth === 0) return i;
  }
  return -1;
}

/** Text between the parentheses of every `<head>(` match (head is a regex source). */
function argTexts(t: Text, head: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${head}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(t.flat)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(t, open);
    if (close > open) out.push(t.code.slice(open + 1, close));
  }
  return out;
}

/** Top-level comma split of the argument text of the first call matching head. */
function topLevelArgs(t: Text, head: string): string[][] {
  const re = new RegExp(`${head}\\s*\\(`, 'g');
  const lists: string[][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t.flat)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(t, open);
    if (close <= open) continue;
    const parts: string[] = [];
    let level = 0;
    let from = open + 1;
    for (let i = open + 1; i < close; i++) {
      const ch = t.flat[i];
      if ('([{'.includes(ch)) level++;
      else if (')]}'.includes(ch)) level--;
      else if (ch === ',' && level === 0) {
        parts.push(t.code.slice(from, i).trim());
        from = i + 1;
      }
    }
    parts.push(t.code.slice(from, close).trim());
    lists.push(parts.filter((p) => p !== ''));
  }
  return lists;
}

/** Text of `function name(...) {...}` or `const name = (...) => {...}` / expression form. */
function definition(t: Text, name: string): string | null {
  const m = new RegExp(`(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`).exec(t.flat);
  if (!m) return null;
  const start = m.index;
  const afterName = start + m[0].length;
  if (m[0].startsWith('function')) {
    const p = t.flat.indexOf('(', afterName);
    const pc = closeOf(t, p);
    const b = t.flat.indexOf('{', pc);
    const e = closeOf(t, b);
    return p < 0 || b < 0 || e < 0 ? null : t.code.slice(start, e + 1);
  }
  // A const only counts when its value starts an arrow function: `= (...) =>`, `= x =>`,
  // optionally async, with an optional return type. Plain values (`const n = obj as X;`) do not.
  const eqRel = t.flat.slice(afterName).search(/=(?!>)/);
  if (eqRel < 0) return null;
  const eq = afterName + eqRel;
  const head = /^\s*(?:async\s+)?(?:\([^;]*?\)\s*(?::[^=;]*?)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(t.flat.slice(eq + 1));
  if (!head) return null;
  const arrow = eq + 1 + head[0].length - 2;
  let at = arrow + 2;
  while (/\s/.test(t.flat[at] ?? '')) at++;
  if (t.flat[at] === '{') {
    const e = closeOf(t, at);
    return e < 0 ? null : t.code.slice(start, e + 1);
  }
  let level = 0;
  let k = at;
  for (; k < t.flat.length; k++) {
    const ch = t.flat[k];
    if ('([{'.includes(ch)) level++;
    else if (')]}'.includes(ch)) {
      level--;
      if (level < 0) break;
    } else if (ch === ';' && level === 0) break;
  }
  return t.code.slice(start, k);
}

function readText(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const main = scanText(readText('../../src/main.ts'));

function numberValue(name: string): number {
  const m = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*([-+0-9.eE]+)\\s*(?:as\\s+const\\s*)?[;,\\n]`).exec(main.code);
  expect(m, `const ${name} = <number>`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

function countWord(t: Text, word: string): number {
  return (t.flat.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length;
}

// ---------- constants ----------

describe('phase 18 constants (hidden)', () => {
  const names = ['BLOOM_STRENGTH', 'BLOOM_RADIUS', 'BLOOM_THRESHOLD', 'SELECTED_PARTICLES', 'PARTICLE_WIDTH'];

  it('AC-18-02 each constant is declared exactly once and referenced at least once more', () => {
    for (const n of names) {
      const declarations = (main.flat.match(new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`, 'g')) ?? []).length;
      expect(declarations, `${n} declarations`).toBe(1);
      expect(countWord(main, n), `${n} mentions`).toBeGreaterThanOrEqual(2);
    }
  });

  it('AC-18-02 bloom is gentler than the old glare on every axis', () => {
    expect(numberValue('BLOOM_THRESHOLD')).toBeGreaterThan(0.15);
    expect(numberValue('BLOOM_STRENGTH')).toBeLessThan(0.9);
    expect(numberValue('BLOOM_THRESHOLD')).toBeCloseTo(0.6, 10);
    expect(numberValue('BLOOM_STRENGTH')).toBeCloseTo(0.35, 10);
    expect(numberValue('BLOOM_RADIUS')).toBeCloseTo(0.4, 10);
  });

  it('AC-18-02 the bloom pass receives the three constants in strength, radius, threshold order', () => {
    const calls = argTexts(main, 'new\\s+UnrealBloomPass');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const text of calls) {
      const s = text.indexOf('BLOOM_STRENGTH');
      const r = text.indexOf('BLOOM_RADIUS');
      const th = text.indexOf('BLOOM_THRESHOLD');
      expect(s).toBeGreaterThan(-1);
      expect(r).toBeGreaterThan(s);
      expect(th).toBeGreaterThan(r);
    }
  });

  it('AC-18-03 selected links get fewer, thinner particles than before', () => {
    expect(Number.isInteger(numberValue('SELECTED_PARTICLES'))).toBe(true);
    expect(numberValue('SELECTED_PARTICLES')).toBeLessThan(4);
    expect(numberValue('SELECTED_PARTICLES')).toBeGreaterThan(0);
    expect(numberValue('PARTICLE_WIDTH')).toBeCloseTo(1.2, 10);
  });

  it('AC-18-03 the particle constants are returned by the accessors, not just declared', () => {
    expect(main.flat).toMatch(/(?:\?|return|=>)\s*SELECTED_PARTICLES\b/);
    expect(main.flat).toMatch(/(?:\?|return|=>|\()\s*PARTICLE_WIDTH\b/);
  });
});

// ---------- styleNode ----------

describe('styleNode (hidden)', () => {
  const style = (): string => {
    const d = definition(main, 'styleNode');
    expect(d, 'styleNode definition').not.toBeNull();
    return d as string;
  };

  it('AC-18-03 glowLevels is called exactly once in main.ts and that call is inside styleNode', () => {
    const calls = (main.flat.match(/\bglowLevels\s*\(/g) ?? []).length;
    expect(calls).toBe(1);
    expect(style()).toMatch(/\bglowLevels\s*\(/);
  });

  it('AC-18-03 the state passed to glowLevels is computed, not a single fixed literal', () => {
    const lists = topLevelArgs(scanText(style()), '\\bglowLevels');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveLength(2);
    expect(lists[0][1]).not.toMatch(/^(['"`])\w+\1$/);
  });

  it('AC-18-03 the first argument is a looked-up value, not a number, and brightness.get( is read', () => {
    const text = style();
    const lists = topLevelArgs(scanText(text), '\\bglowLevels');
    expect(lists[0][0]).not.toMatch(/^[-+]?\.?\d/);
    expect(lists[0][0]).toMatch(/^[A-Za-z_$]/);
    expect(text).toMatch(/\bbrightness\s*\.\s*get\s*\(/);
  });

  it('AC-18-03 body and ring opacity are assigned straight from the glowLevels result', () => {
    const text = style();
    const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*glowLevels\s*\(/.exec(text);
    const picked = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*glowLevels\s*\(/.exec(text);
    expect(assigned !== null || picked !== null).toBe(true);
    const body = /\bbody\s*\.\s*opacity\s*=(?!=)\s*([^;\n]+)/.exec(text);
    const ring = /\bring\s*\.\s*opacity\s*=(?!=)\s*([^;\n]+)/.exec(text);
    expect(body, 'body.opacity assignment').not.toBeNull();
    expect(ring, 'ring.opacity assignment').not.toBeNull();
    const rhsBody = (body as RegExpExecArray)[1].trim();
    const rhsRing = (ring as RegExpExecArray)[1].trim();
    if (assigned) {
      expect(rhsBody).toBe(`${assigned[1]}.opacity`);
      expect(rhsRing).toBe(`${assigned[1]}.ring`);
    } else {
      const names = (picked as RegExpExecArray)[1].split(',').map((p) => p.trim());
      const localOf = (key: string): string => {
        const hit = names.find((p) => p === key || p.startsWith(`${key}:`));
        return hit === undefined ? '' : (hit.split(':')[1] ?? key).trim();
      };
      expect(rhsBody).toBe(localOf('opacity'));
      expect(rhsRing).toBe(localOf('ring'));
    }
  });

  it('AC-18-03 all three node states are named, and each only as a string', () => {
    const text = style();
    for (const state of ['selected', 'dim', 'normal']) {
      expect(text.split(new RegExp(`['"\`]${state}['"\`]`)).length - 1, state).toBeGreaterThanOrEqual(1);
    }
  });

  it('AC-18-03 nothing in styleNode multiplies or caps emissive by hand', () => {
    for (const line of style().split('\n')) {
      if (!/emissive/i.test(line)) continue;
      expect(line).not.toMatch(/Math\.(?:min|max)/);
      expect(line).not.toMatch(/[*+\-/]\s*\d/);
    }
  });

  it('AC-18-02 the opacity and ring of a node come from the glow result as well', () => {
    const text = style();
    const afterCall = text.slice(text.search(/\bglowLevels\b/));
    expect(afterCall).toMatch(/\bopacity\b/);
    expect(afterCall).toMatch(/\bring\b/);
    expect(afterCall).toMatch(/\bemissive\b/);
  });
});

// ---------- linkColor3d ----------

describe('linkColor3d (hidden)', () => {
  function everyColourText(): string {
    const body = definition(main, 'linkColor3d');
    expect(body, 'linkColor3d definition').not.toBeNull();
    let out = body as string;
    // add the value of any string constant the body names
    const known = new Map<string, string>();
    const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*(['"`])([^'"`\n]*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(main.code)) !== null) known.set(m[1], m[3]);
    for (const id of new Set(out.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (known.has(id)) out += `\n"${known.get(id)}"`;
    }
    return out;
  }

  it('AC-18-03 every white rgba used for selected links has alpha 0.55, none is opaque', () => {
    const text = everyColourText();
    const found = [...text.matchAll(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1]));
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found).toContain(0.55);
    for (const alpha of found) expect(alpha).toBeLessThan(1);
  });

  it('AC-18-03 no hex colour in linkColor3d is white or near white', () => {
    const text = everyColourText();
    for (const m of text.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
      const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
      const channels = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
      expect(Math.min(...channels), `#${m[1]}`).toBeLessThan(240);
    }
  });

  it('AC-18-03 linkColor3d does not use the keyword white or an opaque rgb()', () => {
    const text = everyColourText();
    expect(text).not.toMatch(/\bwhite\b/i);
    expect(text).not.toMatch(/\brgb\(\s*255\s*,\s*255\s*,\s*255\s*\)/);
  });
});

// ---------- nodeLabel ----------

describe('3D nodeLabel (hidden)', () => {
  const all = argTexts(main, '\\.nodeLabel');
  const lastCall = all[all.length - 1] ?? '';
  // The call plus the helpers it names (one level); the escape helper itself is left out.
  let label = lastCall;
  for (const id of new Set(lastCall.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (/esc/i.test(id)) continue;
    const def = definition(main, id);
    if (def) label += '\n' + def;
  }

  it('AC-18-04 the label has exactly one line break', () => {
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect((label.match(/<br\s*\/?>/gi) ?? []).length).toBe(1);
  });

  it('AC-18-04 the first escaped value comes before the break, the second one after it', () => {
    const br = label.search(/<br\s*\/?>/i);
    const before = label.slice(0, br);
    const after = label.slice(br);
    expect(before).toMatch(/[Ee]sc\w*\s*\(/);
    expect(after).toMatch(/[Ee]sc\w*\s*\(/);
    expect(before).toMatch(/\b(?:name|label|title)\b/);
    expect(after).toMatch(/\btype\b/);
  });

  it('AC-18-04 every ${...} piece of a template label is a call (an escape), never a bare property', () => {
    const pieces = [...label.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
    for (const piece of pieces) {
      expect(piece, piece).toMatch(/^[A-Za-z_$][\w$]*\s*\(/);
    }
  });

  it('AC-18-04 the label never injects markup through innerHTML or a raw <b> of its own', () => {
    expect(label).not.toMatch(/innerHTML/);
    expect(label).not.toMatch(/<b>/i);
  });
});

// ---------- tooltip CSS ----------

function tooltipRule(): Map<string, string> {
  const html = readText('../../index.html');
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const props = new Map<string, string>();
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1].split(',').map((s) => s.trim());
    if (!selectors.some((s) => s.endsWith('.scene-tooltip'))) continue;
    for (const piece of block[2].split(';')) {
      const colon = piece.indexOf(':');
      if (colon > 0) props.set(piece.slice(0, colon).trim().toLowerCase(), piece.slice(colon + 1).trim());
    }
  }
  return props;
}

function toRgba(v: string): [number, number, number, number] {
  const s = v.replace(/!important/i, '').trim().toLowerCase();
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(s);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
  }
  if (s === 'white') return [255, 255, 255, 1];
  if (s === 'lavender') return [230, 230, 250, 1];
  if (s === 'lightsteelblue') return [176, 196, 222, 1];
  throw new Error(`unrecognised colour "${v}"`);
}

function relative([r, g, b]: [number, number, number, number]): number {
  const lin = (x: number): number => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

describe('.scene-tooltip panel (hidden)', () => {
  const rule = tooltipRule();

  it('AC-18-04 light text on the dark panel reaches contrast 7:1 over the page background #0b0e14', () => {
    const bg = toRgba(rule.get('background-color') ?? rule.get('background') ?? '');
    const fg = toRgba(rule.get('color') ?? '');
    const page: [number, number, number] = [11, 14, 20];
    const mixed: [number, number, number, number] = [
      bg[0] * bg[3] + page[0] * (1 - bg[3]),
      bg[1] * bg[3] + page[1] * (1 - bg[3]),
      bg[2] * bg[3] + page[2] * (1 - bg[3]),
      1,
    ];
    const l1 = relative(fg);
    const l2 = relative(mixed);
    const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(7);
  });

  it('AC-18-04 the panel background is see-through a little but not faint', () => {
    const bg = toRgba(rule.get('background-color') ?? rule.get('background') ?? '');
    expect(bg[3]).toBeGreaterThan(0.5);
    expect(bg[3]).toBeLessThan(1);
  });

  it('AC-18-04 text size is a readable 12 to 13 px, in font-size or the font shorthand', () => {
    const raw = `${rule.get('font-size') ?? ''} ${rule.get('font') ?? ''}`;
    const px = [...raw.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(px.length).toBeGreaterThanOrEqual(1);
    expect(px[0]).toBeGreaterThanOrEqual(12);
    expect(px[0]).toBeLessThanOrEqual(13);
  });

  it('AC-18-04 padding is at least 2px and radius at least 2px', () => {
    const pad = [...rule.entries()]
      .filter(([k]) => k.startsWith('padding'))
      .flatMap(([, v]) => [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])));
    const radius = [...(rule.get('border-radius') ?? '').matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(Math.max(0, ...pad)).toBeGreaterThanOrEqual(2);
    expect(Math.max(0, ...radius)).toBeGreaterThanOrEqual(2);
  });

  it('AC-18-04 the panel stays visible, on one line and out of the way of the mouse', () => {
    const clean = (k: string): string => (rule.get(k) ?? '').replace(/!important/i, '').trim().toLowerCase();
    expect(clean('white-space')).toBe('nowrap');
    expect(clean('pointer-events')).toBe('none');
    expect(clean('display')).not.toBe('none');
    expect(clean('visibility')).not.toBe('hidden');
    if (rule.has('opacity')) expect(Number(clean('opacity'))).toBeGreaterThanOrEqual(0.8);
  });
});

// ---------- build ----------

describe('build and packages (hidden)', () => {
  const pkg = JSON.parse(readText('../../package.json')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('AC-18-01 the build script runs the type check before vite and the test script is vitest', () => {
    const build = pkg.scripts?.build ?? '';
    expect(build.indexOf('tsc --noEmit')).toBeGreaterThan(-1);
    expect(build.indexOf('vite build')).toBeGreaterThan(build.indexOf('tsc --noEmit'));
    expect(pkg.scripts?.test).toContain('vitest');
  });

  it('AC-18-01 no package was added to dependencies or devDependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['3d-force-graph', 'force-graph', 'three']);
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([
      '@types/node',
      '@types/three',
      'typescript',
      'vite',
      'vitest',
    ]);
  });

  it('AC-18-01 main.ts imports glowLevels from the scene3d module', () => {
    expect(main.code).toMatch(/import[^;]*\bglowLevels\b[^;]*from\s*['"][^'"]*scene3d/);
  });
});
