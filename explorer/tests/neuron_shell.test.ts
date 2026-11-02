import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 20 is an app-shell phase (explorer/src/main.ts and explorer/index.html): the look is
// checked in the browser. These tests pin what can be read from the text of those files:
// the "Neuron look" tick box, the scene3d imports and their use, the curved-link settings,
// the change listener that reheats, the gating of the cell scale, and that the 2D path is
// untouched. Comments are stripped before matching. The checks are written loosely so that
// any reasonable wiring passes (they look for ideas, not for exact variable names).

// ---------- source scanning helpers ----------

interface Src {
  /** Source with comments blanked out (same length as the original). */
  code: string;
  /** Like `code`, but string, template and regex contents are blanked too (for brackets). */
  masked: string;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

function skipTemplate(src: string, start: number): number {
  let j = start + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
    } else if (ch === '`') {
      return j + 1;
    } else if (ch === '$' && src[j + 1] === '{') {
      j = skipExpression(src, j + 2);
    } else {
      j += 1;
    }
  }
  return src.length;
}

function skipExpression(src: string, start: number): number {
  let depth = 1;
  let j = start;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '`') {
      j = skipTemplate(src, j);
      continue;
    }
    if (ch === "'" || ch === '"') {
      j += 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return src.length;
}

function scan(src: string): Src {
  let code = '';
  let masked = '';
  const n = src.length;
  let i = 0;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      code += blank(src.slice(i, j));
      masked += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      code += blank(src.slice(i, j));
      masked += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '`') {
      const end = skipTemplate(src, i);
      code += src.slice(i, end);
      masked += '`' + blank(src.slice(i + 1, Math.max(i + 1, end - 1))) + '`';
      i = end;
      prev = 'a';
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j, n);
      const closed = src[j] === c;
      const end = closed ? j + 1 : j;
      code += src.slice(i, end);
      masked += c + blank(src.slice(i + 1, j)) + (closed ? c : '');
      i = end;
      prev = 'a';
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          ok = true;
          break;
        }
        j += 1;
      }
      if (ok) {
        let end = j + 1;
        while (end < n && /[a-z]/i.test(src[end])) end += 1;
        code += src.slice(i, end);
        masked += '/' + blank(src.slice(i + 1, j)) + '/' + blank(src.slice(j + 1, end));
        i = end;
        prev = 'a';
        continue;
      }
    }
    code += c;
    masked += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { code, masked };
}

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const CLOSERS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

function matchClose(masked: string, open: number): number {
  const o = masked[open];
  const c = CLOSERS[o];
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === o) depth += 1;
    else if (masked[i] === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Site {
  /** Index where the callee match starts. */
  start: number;
  /** Index of the closing parenthesis. */
  close: number;
  /** Top-level arguments, trimmed. */
  args: string[];
  /** Raw argument text. */
  text: string;
}

/** Every call matching `<callee>(`, callee being a regex source. */
function sites(src: Src, callee: string): Site[] {
  const re = new RegExp(`${callee}\\s*\\(`, 'g');
  const out: Site[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src.masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src.masked, open);
    if (close <= open) continue;
    const parts: string[] = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open + 1; i < close; i++) {
      const ch = src.masked[i];
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(src.code.slice(from, i).trim());
        from = i + 1;
      }
    }
    parts.push(src.code.slice(from, close).trim());
    out.push({
      start: m.index,
      close,
      args: parts.filter((p) => p.length > 0),
      text: src.code.slice(open + 1, close),
    });
  }
  return out;
}

/**
 * Text from the declaration of `name` (function, const, let or var) up to the next
 * declaration that starts in column 0. Loose on purpose: it may include a little more.
 */
function declWindow(src: Src, name: string): string | null {
  const id = escapeRe(name);
  const decl = new RegExp(`\\b(?:function\\s+${id}\\b|(?:const|let|var)\\s+${id}\\b)`).exec(src.masked);
  if (!decl) return null;
  const rest = src.masked.slice(decl.index + decl[0].length);
  const next = /\n(?=(?:export\s+|async\s+)*(?:function|const|let|var|class|interface|type|import)\b)/.exec(rest);
  const end = next ? decl.index + decl[0].length + next.index : src.code.length;
  return src.code.slice(decl.index, end);
}

/** `text` plus the declaration windows of the names in it, followed a few levels deep. */
function reach(src: Src, text: string, depth = 3): string {
  let out = text;
  let frontier = text;
  const seen = new Set<string>();
  for (let d = 0; d < depth; d++) {
    let next = '';
    for (const id of new Set(frontier.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (seen.has(id)) continue;
      seen.add(id);
      const w = declWindow(src, id);
      if (w) next += '\n' + w;
    }
    out += next;
    frontier = next;
  }
  return out;
}

/** Body text of the function or arrow function whose declaration starts at `from`. */
function bodyAfter(src: Src, from: number): string {
  const m = src.masked;
  let depth = 0;
  for (let i = from; i < m.length; i++) {
    const ch = m[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ';' && depth <= 0) return src.code.slice(from, i);
    else if (ch === '{' && depth <= 0) {
      const prev = m.slice(0, i).trimEnd().slice(-1);
      const end = matchClose(m, i);
      if (end < 0) return src.code.slice(from);
      if (prev === ':') {
        i = end;
        continue;
      }
      return src.code.slice(from, end + 1);
    }
  }
  return src.code.slice(from);
}

function enclosingBlocks(masked: string, idx: number): Array<[number, number]> {
  const stack: number[] = [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}') {
      const o = stack.pop();
      if (o !== undefined && o < idx && i > idx) out.push([o, i]);
    }
  }
  return out.sort((a, b) => b[0] - a[0]);
}

function header(src: Src, blockStart: number): string {
  return src.code.slice(Math.max(0, blockStart - 150), blockStart);
}

/** Text near `idx`: 400 characters before, and the two innermost enclosing blocks with headers. */
function windowAround(src: Src, idx: number): string {
  let text = src.code.slice(Math.max(0, idx - 400), idx + 200);
  for (const [o, c] of enclosingBlocks(src.masked, idx).slice(0, 2)) {
    text += '\n' + header(src, o) + src.code.slice(o, c + 1);
  }
  return text;
}

function withoutImports(src: Src): string {
  return src.masked.replace(
    /\bimport\s+(?:type\s+)?(?:[\w*$]+(?:\s+as\s+\w+)?\s*,?\s*)?(?:\{[^}]*\})?\s*from\s*(['"`])[^\n]*?\1\s*;?/g,
    (m) => blank(m),
  );
}

function importedFromScene3d(src: Src): string[] {
  const out: string[] = [];
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]\.\/scene3d(?:\.js|\.ts)?['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src.code)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/** True when the value of the call is kept in a name that is used again, or passed on. */
function resultUsed(src: Src, s: Site): boolean {
  const before = src.masked.slice(0, s.start).trimEnd();
  const named = /([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=$/.exec(before);
  if (named) {
    const count = (src.masked.match(new RegExp(`\\b${escapeRe(named[1])}\\b`, 'g')) ?? []).length;
    return count >= 2;
  }
  if (/[(,?:>|&[]$/.test(before) || /\breturn$/.test(before)) return true;
  const next = src.masked.slice(s.close + 1).trimStart()[0];
  return next === '.' || next === '[' || next === '?';
}

/** Start of the statement (or chain) that contains the `.method(` at `idx`, walking back over brackets. */
function chainPrefix(src: Src, idx: number): string {
  let depth = 0;
  let i = idx - 1;
  for (; i >= 0; i--) {
    const ch = src.masked[i];
    if (ch === ')' || ch === '}' || ch === ']') depth += 1;
    else if (ch === '(' || ch === '{' || ch === '[') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ';' && depth === 0) break;
  }
  return src.code.slice(i + 1, idx);
}

function receiverIs3d(src: Src, idx: number): boolean {
  const prefix = chainPrefix(src, idx);
  if (/3d|three/i.test(prefix)) return true;
  const first = /[A-Za-z_$][\w$]*/.exec(prefix.replace(/^\s*(?:const|let|var|await|return)\s+(?:[A-Za-z_$][\w$]*\s*=\s*)?/, ''));
  if (first) {
    const id = escapeRe(first[0]);
    if (new RegExp(`\\b${id}\\b[^;=]{0,120}3D|\\b${id}\\b\\s*=[^;]{0,120}3D`, 'i').test(src.code)) return true;
  }
  return enclosingBlocks(src.masked, idx)
    .slice(0, 3)
    .some(([o]) => /3d|three/i.test(header(src, o)));
}

const main = scan(read('../src/main.ts'));
const html = read('../index.html').replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
const NAMES = ['cellBodies', 'branchOffsets', 'axonCurve', 'CELL_SCALE'];

// ---------- index.html ----------

function inputTags(id: string): Array<{ tag: string; index: number }> {
  const out: Array<{ tag: string; index: number }> = [];
  const re = /<input\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (new RegExp(`\\bid\\s*=\\s*["']?${escapeRe(id)}["']?(?=[\\s/>])`).test(m[0])) {
      out.push({ tag: m[0], index: m.index });
    }
  }
  return out;
}

describe('AC-20-02 index.html has the "Neuron look" tick box', () => {
  it('AC-20-02 there is exactly one element with id neuron-look and it is an input', () => {
    expect(inputTags('neuron-look')).toHaveLength(1);
    expect((html.match(/\bid\s*=\s*["']?neuron-look["']?(?=[\s/>])/g) ?? []).length).toBe(1);
  });

  it('AC-20-02 #neuron-look is a checkbox', () => {
    const [box] = inputTags('neuron-look');
    expect(box.tag).toMatch(/\btype\s*=\s*["']?checkbox["']?(?=[\s/>])/i);
  });

  it('AC-20-02 #neuron-look is ticked by default (checked attribute)', () => {
    const [box] = inputTags('neuron-look');
    expect(box.tag).toMatch(/\schecked(?=[\s/>=])/i);
  });

  it('AC-20-02 the text "Neuron look" is the label of the tick box', () => {
    const [box] = inputTags('neuron-look');
    const labels: string[] = [];
    const re = /<label\b[^>]*>[\s\S]*?<\/label>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const wraps = m.index < box.index && box.index < m.index + m[0].length;
      const forIt = /\bfor\s*=\s*["']?neuron-look["']?(?=[\s/>])/i.test(m[0]);
      if (wraps || forIt) labels.push(m[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    const trailing = html
      .slice(box.index + box.tag.length, box.index + box.tag.length + 80)
      .split('<')[0]
      .trim();
    expect([...labels, trailing].some((t) => t.includes('Neuron look'))).toBe(true);
  });

  it('AC-20-02 the Neuron look tick box sits next to the Layers tick box (#layers-mode)', () => {
    const layers = inputTags('layers-mode');
    const neuron = inputTags('neuron-look');
    expect(layers).toHaveLength(1);
    expect(neuron).toHaveLength(1);
    expect(Math.abs(layers[0].index - neuron[0].index)).toBeLessThan(500);
  });
});

// ---------- AC-20-01: build wiring ----------

describe('AC-20-01 build wiring', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it('AC-20-01 npm run build still type-checks with tsc --noEmit and builds with vite', () => {
    const build = pkg.scripts?.build ?? '';
    expect(build).toContain('tsc --noEmit');
    expect(build).toContain('vite build');
  });

  it('AC-20-01 no new packages: dependencies stay 3d-force-graph, force-graph and three', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['3d-force-graph', 'force-graph', 'three']);
  });

  for (const name of NAMES) {
    it(`AC-20-01 main.ts imports ${name} from ./scene3d`, () => {
      expect(importedFromScene3d(main)).toContain(name);
    });

    it(`AC-20-01 ${name} is used in main.ts beyond the import (nothing unused for tsc)`, () => {
      const uses = (withoutImports(main).match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
      expect(uses).toBeGreaterThanOrEqual(1);
    });
  }

  it('AC-20-01 cellBodies is called with the analysis and its result is used', () => {
    const calls = sites(main, '\\bcellBodies');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c.args.length).toBeGreaterThanOrEqual(1);
      expect(resultUsed(main, c)).toBe(true);
    }
  });

  it('AC-20-02 branchOffsets is called with the analysis and a list of ids, and its result is used', () => {
    const calls = sites(main, '\\bbranchOffsets');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c.args).toHaveLength(2);
      expect(resultUsed(main, c)).toBe(true);
    }
  });

  it('AC-20-01 axonCurve is called with a link and the analysis', () => {
    const calls = sites(main, '\\baxonCurve');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) expect(c.args).toHaveLength(2);
  });
});

// ---------- AC-20-02: cells, branches, curved links ----------

describe('AC-20-02 curved links between themes', () => {
  it('AC-20-02 linkCurvature is set with a value (an accessor, a property name or a number)', () => {
    const calls = sites(main, '\\.\\s*linkCurvature');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) expect(c.args).toHaveLength(1);
  });

  it('AC-20-02 linkCurveRotation is set with a value (an accessor, a property name or a number)', () => {
    const calls = sites(main, '\\.\\s*linkCurveRotation');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) expect(c.args).toHaveLength(1);
  });

  it('AC-20-02 axonCurve is where the curve numbers come from (its result is read as curvature and rotation)', () => {
    const hay = [
      ...sites(main, '\\.\\s*linkCurvature'),
      ...sites(main, '\\.\\s*linkCurveRotation'),
      ...sites(main, '\\baxonCurve'),
    ]
      .map((c) => windowAround(main, c.start))
      .join('\n');
    expect(hay).toMatch(/\bcurvature\b/);
    expect(hay).toMatch(/\brotation\b/);
  });

  it('AC-20-02 CELL_SCALE is used outside its import', () => {
    expect((withoutImports(main).match(/\bCELL_SCALE\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- AC-20-03 / AC-20-02: the tick box state, listener and gating ----------

/** Names of variables that hold the element looked up by id neuron-look. */
function neuronElementNames(): Set<string> {
  const names = new Set<string>();
  const lookup = /['"`]#?neuron-look['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = lookup.exec(main.code)) !== null) {
    const stmt = main.code.slice(main.code.lastIndexOf(';', m.index) + 1, m.index);
    const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=[^;]*$/.exec(stmt);
    if (decl) names.add(decl[1]);
  }
  return names;
}

/** The ;-delimited statement around `idx`. */
function statementOf(idx: number): string {
  const from = main.code.lastIndexOf(';', idx) + 1;
  const to = main.code.indexOf(';', idx);
  return main.code.slice(from, to < 0 ? main.code.length : to);
}

describe('AC-20-03 the neuron state is read from #neuron-look', () => {
  it('AC-20-03 main.ts looks up the element with id neuron-look', () => {
    expect(main.code).toMatch(/\(\s*['"`]#?neuron-look['"`]\s*\)/);
  });

  it('AC-20-03 the element found by id neuron-look has its .checked read', () => {
    const names = neuronElementNames();
    const named = [...names].some((n) =>
      new RegExp(`\\b${escapeRe(n)}\\s*[!?]?\\s*\\.\\s*checked\\b`).test(main.masked),
    );
    const inline = [...main.code.matchAll(/['"`]#?neuron-look['"`]/g)].some((m) =>
      /\.\s*checked\b/.test(statementOf(m.index as number)),
    );
    expect(named || inline).toBe(true);
  });
});

describe('AC-20-03 the change listener rebuilds and reheats', () => {
  function handlerTexts(): string[] {
    const out: string[] = [];
    const names = neuronElementNames();
    for (const call of sites(main, '\\.\\s*addEventListener')) {
      const recv = main.code.slice(Math.max(0, call.start - 120), call.start);
      const isNeuron = [...names].some((n) => new RegExp(`\\b${escapeRe(n)}\\s*[!?]?\\s*$`).test(recv));
      const inline = /['"`]#?neuron-look['"`]\s*\)[^;]{0,60}$/.test(recv);
      if ((isNeuron || inline) && /^['"`](?:change|input|click)['"`]/.test(call.args[0] ?? '')) {
        out.push(call.args.slice(1).join(','));
      }
    }
    for (const n of names) {
      const re = new RegExp(`\\b${escapeRe(n)}\\s*[!?]?\\s*\\.\\s*onchange\\s*=(?!=)`, 'g');
      let h: RegExpExecArray | null;
      while ((h = re.exec(main.masked)) !== null) out.push(bodyAfter(main, h.index + h[0].length));
    }
    return out;
  }

  it('AC-20-03 the #neuron-look element has a change listener', () => {
    expect(handlerTexts().length).toBeGreaterThanOrEqual(1);
  });

  it('AC-20-03 the listener (followed through helpers, up to 3 levels) reheats the layout with d3ReheatSimulation', () => {
    const texts = handlerTexts().map((t) => reach(main, t, 3));
    expect(texts.some((t) => /\bd3ReheatSimulation\s*\(/.test(t))).toBe(true);
  });

  it('AC-20-03 the listener rebuilds the node objects or re-installs a d3 force', () => {
    const texts = handlerTexts().map((t) => reach(main, t, 3));
    expect(texts.some((t) => /\bnodeThreeObject\b|rebuild|\bd3Force\s*\(/i.test(t))).toBe(true);
  });
});

describe('AC-20-03 CELL_SCALE comes from scene3d', () => {
  it('AC-20-03 CELL_SCALE is not redeclared in main.ts', () => {
    expect(main.masked).not.toMatch(/\b(?:const|let|var)\s+CELL_SCALE\b/);
  });
});

// ---------- AC-20-04: nothing else broken, 2D untouched ----------

describe('AC-20-04 glow, selection and the 2D map', () => {
  it('AC-20-04 styleNode still takes its light from glowLevels (not brighter than before)', () => {
    const body = declWindow(main, 'styleNode');
    expect(body, 'styleNode not found in main.ts').not.toBeNull();
    expect(body as string).toMatch(/\bglowLevels\s*\(/);
    expect(body as string).toMatch(/['"`]selected['"`]/);
  });

  it('AC-20-04 the curve settings are made on the 3D graph, not on the 2D one', () => {
    const calls = [...sites(main, '\\.\\s*linkCurvature'), ...sites(main, '\\.\\s*linkCurveRotation')];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(receiverIs3d(main, c.start), chainPrefix(main, c.start)).toBe(true);
  });

  it('AC-20-04 functions and canvas callbacks of the 2D map do not use the neuron maths', () => {
    const forbidden = /\b(?:cellBodies|branchOffsets|axonCurve|CELL_SCALE|linkCurvature|linkCurveRotation)\b/;
    const re =
      /\bfunction\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=;{]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(main.masked)) !== null) {
      const name = m[1] ?? m[2] ?? '';
      if (!/2d|canvas/i.test(name)) continue;
      const body = bodyAfter(main, m.index + m[0].length);
      expect(body, `2D function ${name}`).not.toMatch(forbidden);
    }
    for (const c of sites(main, '\\.\\s*(?:nodeCanvasObject|linkCanvasObject|nodePointerAreaPaint|nodeCanvasObjectMode)')) {
      expect(c.text).not.toMatch(forbidden);
    }
  });

  it('AC-20-04 no other source file (2D drawing, graph, view, analysis) uses the neuron maths', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const forbidden = /\b(?:cellBodies|branchOffsets|axonCurve|CELL_SCALE|linkCurvature|linkCurveRotation)\b/;
    const files = readdirSync(dir).filter((f) => /\.(?:ts|tsx|js|mjs)$/.test(f) && f !== 'main.ts' && !/^scene3d\./.test(f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) {
      expect(scan(readFileSync(dir + f, 'utf8')).code, f).not.toMatch(forbidden);
    }
  });
});
