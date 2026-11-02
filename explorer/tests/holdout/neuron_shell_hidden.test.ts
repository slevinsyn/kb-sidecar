import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Hidden checks for phase 20 (3D neuron look wiring). Self-contained: own small scanner.
// They ask different questions from the visible tests: no copied numbers, the default state,
// the shape of the HTML, how the node ids are chosen, and how CELL_SCALE is applied.

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

interface Call {
  at: number;
  args: string[];
  text: string;
}

/** Every `<head>(` call (head is a regex source) with its top-level arguments. */
function callsOf(t: Text, head: string): Call[] {
  const out: Call[] = [];
  const re = new RegExp(`${head}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(t.flat)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(t, open);
    if (close <= open) continue;
    const args: string[] = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open + 1; i < close; i++) {
      const ch = t.flat[i];
      if ('({['.includes(ch)) depth++;
      else if (')}]'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) {
        args.push(t.code.slice(from, i).trim());
        from = i + 1;
      }
    }
    args.push(t.code.slice(from, close).trim());
    out.push({ at: m.index, args: args.filter((a) => a.length > 0), text: t.code.slice(open + 1, close) });
  }
  return out;
}

/** The statement that contains index `at`, cut at semicolons. */
function statementAt(t: Text, at: number): string {
  const from = t.flat.lastIndexOf(';', at) + 1;
  const to = t.flat.indexOf(';', at);
  return t.code.slice(from, to < 0 ? t.code.length : to);
}

const rawMain = readFileSync(fileURLToPath(new URL('../../src/main.ts', import.meta.url)), 'utf8');
const rawHtml = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const main = scanText(rawMain);

// ---------- AC-20-02 / AC-20-03: the tick box in the HTML ----------

describe('hidden: neuron-look markup', () => {
  it('AC-20-02 AC-20-03 the neuron-look input is a ticked checkbox and "Neuron look" is written beside it', () => {
    const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');
    const tag = /<input\b[^>]*\bid\s*=\s*["']neuron-look["'][^>]*>/i.exec(html);
    expect(tag, 'input#neuron-look').not.toBeNull();
    const t = (tag as RegExpExecArray)[0];
    expect(t).toMatch(/type\s*=\s*["']checkbox["']/i);
    expect(t).toMatch(/\schecked\b/i);
    const around = html.slice(Math.max(0, (tag as RegExpExecArray).index - 200), (tag as RegExpExecArray).index + t.length + 200);
    expect(around).toContain('Neuron look');
    const layers = /<input\b[^>]*\bid\s*=\s*["']layers-mode["'][^>]*>/i.exec(html);
    expect(layers, 'input#layers-mode').not.toBeNull();
    expect(Math.abs((layers as RegExpExecArray).index - (tag as RegExpExecArray).index)).toBeLessThan(500);
  });
});

// ---------- AC-20-01 / AC-20-02: numbers come from scene3d, not copied ----------

describe('hidden: no copied numbers in main.ts', () => {
  it('AC-20-02 CELL_SCALE and AXON_CURVATURE are imported, not redeclared with copied values in main.ts', () => {
    expect(main.flat).not.toMatch(/\b(?:const|let|var)\s+CELL_SCALE\b/);
    expect(main.flat).not.toMatch(/\b(?:const|let|var)\s+AXON_CURVATURE\b/);
    expect(main.flat).not.toMatch(/\bCELL_SCALE\s*=(?!=)\s*2\.2\b/);
  });

  it('AC-20-02 linkCurvature and linkCurveRotation are not given a fixed non-zero number', () => {
    const calls = [...callsOf(main, '\\.\\s*linkCurvature'), ...callsOf(main, '\\.\\s*linkCurveRotation')];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      const literals = (c.text.replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, '').match(/(?<![\w.$])\d*\.?\d+(?![\w$])/g) ?? [])
        .map(Number)
        .filter((n) => n !== 0);
      expect(literals, c.text).toEqual([]);
    }
  });
});

// ---------- AC-20-03: the default and how the cell size is applied ----------

describe('hidden: default state and CELL_SCALE use', () => {
  it('AC-20-03 the neuron state is initialised from the checkbox .checked, not from a literal', () => {
    const names = new Set<string>();
    const lookup = /['"`]#?neuron-look['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = lookup.exec(main.code)) !== null) {
      const stmt = main.code.slice(main.code.lastIndexOf(';', m.index) + 1, m.index);
      const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=[^;]*$/.exec(stmt);
      if (decl) names.add(decl[1]);
    }
    const readsOf = (): string[] => {
      const out: string[] = [];
      for (const n of names) {
        const re = new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*[!?]?\\s*\\.\\s*checked\\b`, 'g');
        let r: RegExpExecArray | null;
        while ((r = re.exec(main.flat)) !== null) out.push(statementAt(main, r.index));
      }
      for (const lit of main.code.matchAll(/['"`]#?neuron-look['"`]/g)) {
        const s = statementAt(main, lit.index as number);
        if (/\.\s*checked\b/.test(s)) out.push(s);
      }
      return out;
    };
    const reads = readsOf();
    expect(reads.length).toBeGreaterThanOrEqual(1);
    // At least one read of .checked feeds a value (an assignment, a return or an arrow body).
    expect(reads.some((s) => /(?:=(?!=)|=>|\breturn\b)[^;]*\.\s*checked\b/.test(s))).toBe(true);
    // No neuron or look flag is declared with a bare true/false that is never replaced by .checked.
    const literalFlags = [...main.flat.matchAll(/\b(?:let|var)\s+(\w*(?:[Nn]euron|Look)\w*)\s*(?::\s*boolean)?\s*=\s*(?:true|false)\s*;/g)];
    for (const f of literalFlags) {
      const reassigned = new RegExp(`\\b${f[1]}\\s*=(?!=)[^;]*\\.\\s*checked\\b`).test(main.flat);
      expect(reassigned, `${f[1]} starts as a literal and is never set from .checked`).toBe(true);
    }
  });

  it('AC-20-02 CELL_SCALE is used outside its import and is not redeclared', () => {
    const noImports = main.flat.replace(/\bimport\s+(?:type\s+)?[\w*${][^;]*?\bfrom\b[^;\n]*;?/g, (s) => s.replace(/[^\n]/g, ' '));
    expect((noImports.match(/\bCELL_SCALE\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(main.flat).not.toMatch(/\b(?:const|let|var)\s+CELL_SCALE\b/);
  });
});

// ---------- AC-20-04: 2D drawing files stay untouched ----------

describe('hidden: other modules', () => {
  it('AC-20-04 only main.ts and scene3d.ts mention the neuron maths', () => {
    const dir = fileURLToPath(new URL('../../src/', import.meta.url));
    for (const f of readdirSync(dir)) {
      if (f === 'main.ts' || /^scene3d\./.test(f) || !/\.(?:ts|js|mjs|tsx)$/.test(f)) continue;
      const t = scanText(readFileSync(dir + f, 'utf8'));
      expect(t.flat, f).not.toMatch(/\b(?:CELL_SCALE|AXON_CURVATURE|BRANCH_BASE_RADIUS|cellBodies|branchOffsets?|axonCurve)\b/);
    }
  });
});
