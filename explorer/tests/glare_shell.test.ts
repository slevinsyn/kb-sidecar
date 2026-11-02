import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 18 is an app-shell phase (explorer/src/main.ts and explorer/index.html): the look is
// checked in the browser. These tests pin what can be read from the text of those files:
// the named constants, the use of glowLevels in styleNode, the soft selection white in
// linkColor3d, the particle settings, the 3D nodeLabel and the .scene-tooltip CSS rule.
// Comments are stripped before matching and function bodies are found by brace matching.

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
  // `start` is the index of the opening backtick; returns the index after the closing one.
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
  // `start` is just after "${"; returns the index after the matching "}".
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

function load(relative: string): Src {
  return scan(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
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

/** Argument text of every call matching `<callee>(`, callee being a regex source. */
function calls(src: Src, callee: string): string[] {
  const re = new RegExp(`${callee}\\s*\\(`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src.masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src.masked, open);
    if (close > open) out.push(src.code.slice(open + 1, close));
  }
  return out;
}

/** Top-level, comma separated argument list of one call, trimmed. */
function splitArgs(src: Src, callee: string): string[][] {
  const re = new RegExp(`${callee}\\s*\\(`, 'g');
  const out: string[][] = [];
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
    out.push(parts.filter((p) => p.length > 0));
  }
  return out;
}

/** Whole text (parameters and body) of `function name` or `const name = (...) =>`. */
function functionText(src: Src, name: string): string | null {
  const id = escapeRe(name);
  const decl = new RegExp(`\\b(?:function\\s+${id}\\b|(?:const|let|var)\\s+${id}\\b)`).exec(src.masked);
  if (!decl) return null;
  const after = decl.index + decl[0].length;
  const blockFrom = (from: number): string | null => {
    const open = src.masked.indexOf('(', from);
    if (open < 0) return null;
    const close = matchClose(src.masked, open);
    const brace = src.masked.indexOf('{', close);
    if (close < 0 || brace < 0) return null;
    const end = matchClose(src.masked, brace);
    return end < 0 ? null : src.code.slice(decl.index, end + 1);
  };
  if (decl[0].startsWith('function')) return blockFrom(after);

  const rel = src.masked.slice(after).search(/=(?!>)/);
  if (rel < 0) return null;
  const eq = after + rel;
  const rest = src.masked.slice(eq + 1);
  const head =
    /^\s*(?:async\s+)?(?:function\b[^(]*\(|\([^;]*?\)\s*(?::[^=;]*?)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(rest);
  if (!head) return null;
  if (/^\s*(?:async\s+)?function\b/.test(head[0])) return blockFrom(eq + 1);
  let bodyAt = eq + 1 + head[0].length;
  while (bodyAt < src.masked.length && /\s/.test(src.masked[bodyAt])) bodyAt += 1;
  if (src.masked[bodyAt] === '{') {
    const end = matchClose(src.masked, bodyAt);
    return end < 0 ? null : src.code.slice(decl.index, end + 1);
  }
  let depth = 0;
  let end = bodyAt;
  for (; end < src.masked.length; end++) {
    const ch = src.masked[end];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ';' && depth <= 0) break;
    if (depth < 0) break;
  }
  return src.code.slice(decl.index, end);
}

function mustFunction(src: Src, name: string): string {
  const text = functionText(src, name);
  expect(text, `function ${name} not found in main.ts`).not.toBeNull();
  return text as string;
}

/** `text` plus the text of every function declared in `src` whose name occurs in `text`. */
function reach(src: Src, text: string, skip?: RegExp): string {
  let out = text;
  const seen = new Set<string>();
  for (const id of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (seen.has(id)) continue;
    if (skip && skip.test(id)) continue;
    seen.add(id);
    const fn = functionText(src, id);
    if (fn) out += '\n' + fn;
  }
  return out;
}

function stringConsts(src: Src): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"`])((?:(?!\2)[^\\\n]|\\.)*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src.code)) !== null) out.set(m[1], m[3]);
  return out;
}

/** `text` plus the value of every string constant it names. */
function withConstValues(src: Src, text: string): string {
  const consts = stringConsts(src);
  let out = text;
  for (const id of new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const v = consts.get(id);
    if (v !== undefined) out += '\n' + v;
  }
  return out;
}

function numberConst(src: Src, name: string): number | null {
  const re = new RegExp(
    `\\bconst\\s+${escapeRe(name)}\\s*(?::\\s*number\\s*)?=\\s*([^;\\n]+)`,
  );
  const m = re.exec(src.code);
  if (!m) return null;
  const raw = m[1].trim().replace(/\s+as\s+const$/, '').replace(/,$/, '').trim();
  return raw === '' ? null : Number(raw);
}

function declarationCount(src: Src, name: string): number {
  return (src.masked.match(new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(name)}\\b`, 'g')) ?? []).length;
}

function usesOutsideDeclaration(src: Src, name: string): number {
  const all = (src.masked.match(new RegExp(`\\b${escapeRe(name)}\\b`, 'g')) ?? []).length;
  return all - declarationCount(src, name);
}

const main = load('../src/main.ts');

// ---------- AC-18-01 ----------

describe('AC-18-01 build wiring', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };

  it('AC-18-01 npm run build still type-checks with tsc --noEmit and builds with vite', () => {
    const build = pkg.scripts?.build ?? '';
    expect(build).toContain('tsc --noEmit');
    expect(build).toContain('vite build');
  });

  it('AC-18-01 no new packages: dependencies stay 3d-force-graph, force-graph and three', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['3d-force-graph', 'force-graph', 'three']);
  });

  it('AC-18-01 main.ts imports glowLevels from ./scene3d', () => {
    expect(main.code).toMatch(
      /import\s*(?:type\s*)?\{[^}]*\bglowLevels\b[^}]*\}\s*from\s*['"]\.\/scene3d(?:\.js|\.ts)?['"]/,
    );
  });

  it('AC-18-01 glowLevels is called (the import is not left unused)', () => {
    expect(splitArgs(main, '\\bglowLevels').length).toBeGreaterThanOrEqual(1);
  });

  for (const name of ['BLOOM_STRENGTH', 'BLOOM_RADIUS', 'BLOOM_THRESHOLD', 'SELECTED_PARTICLES', 'PARTICLE_WIDTH']) {
    it(`AC-18-01 ${name} is declared once and used (nothing unused for tsc)`, () => {
      expect(declarationCount(main, name)).toBe(1);
      expect(usesOutsideDeclaration(main, name)).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------- AC-18-02: gentler bloom ----------

describe('AC-18-02 bloom constants', () => {
  it('AC-18-02 BLOOM_STRENGTH is 0.35', () => {
    expect(numberConst(main, 'BLOOM_STRENGTH')).toBe(0.35);
  });

  it('AC-18-02 BLOOM_RADIUS is 0.4', () => {
    expect(numberConst(main, 'BLOOM_RADIUS')).toBe(0.4);
  });

  it('AC-18-02 BLOOM_THRESHOLD is 0.6', () => {
    expect(numberConst(main, 'BLOOM_THRESHOLD')).toBe(0.6);
  });

  it('AC-18-02 the UnrealBloomPass is built from strength, radius and threshold constants in that order', () => {
    const passes = splitArgs(main, 'new\\s+UnrealBloomPass');
    expect(passes.length).toBeGreaterThanOrEqual(1);
    for (const args of passes) {
      expect(args).toHaveLength(4);
      expect(args[1]).toBe('BLOOM_STRENGTH');
      expect(args[2]).toBe('BLOOM_RADIUS');
      expect(args[3]).toBe('BLOOM_THRESHOLD');
    }
  });

  it('AC-18-02 the old harsh bloom numbers (threshold 0.15, strength 0.9) are gone from the bloom pass', () => {
    for (const text of calls(main, 'new\\s+UnrealBloomPass')) {
      expect(text).not.toMatch(/(?<![\w.])0?\.15\b/);
      expect(text).not.toMatch(/(?<![\w.])0?\.9\b/);
    }
  });
});

// ---------- AC-18-02 / AC-18-03: node styling ----------

describe('AC-18-03 styleNode takes its light from glowLevels', () => {
  const styleNodeBody = (): string => mustFunction(main, 'styleNode');

  it('AC-18-03 styleNode calls glowLevels(brightness value, state) with a computed brightness, not a number literal', () => {
    const body = styleNodeBody();
    const argLists = splitArgs({ code: body, masked: scan(body).masked }, '\\bglowLevels');
    expect(argLists).toHaveLength(1);
    expect(argLists[0]).toHaveLength(2);
    expect(argLists[0][0]).not.toMatch(/^[-+]?\.?\d/);
    expect(argLists[0][0]).toMatch(/^[A-Za-z_$]/);
  });

  it('AC-18-03 styleNode reads the node brightness with brightness.get(', () => {
    expect(styleNodeBody()).toMatch(/\bbrightness\.get\s*\(/);
  });

  it('AC-18-03 the body and ring opacity assignments come from the glowLevels result only', () => {
    const body = styleNodeBody();
    // The glowLevels result: either `const X = glowLevels(` or `const { opacity, ring } = glowLevels(`.
    const whole = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*glowLevels\s*\(/.exec(body);
    const destructured = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*glowLevels\s*\(/.exec(body);
    expect(whole !== null || destructured !== null, 'glowLevels result must be captured').toBe(true);

    let opacityRef: RegExp;
    let ringRef: RegExp;
    if (whole) {
      const v = escapeRe(whole[1]);
      opacityRef = new RegExp(`\\b${v}\\s*\\.\\s*opacity\\b`);
      ringRef = new RegExp(`\\b${v}\\s*\\.\\s*ring\\b`);
    } else {
      const local = (key: string): string => {
        const part = (destructured as RegExpExecArray)[1]
          .split(',')
          .map((p) => p.trim())
          .find((p) => p === key || p.startsWith(`${key}:`) || p.startsWith(`${key} :`));
        expect(part, `destructured ${key}`).toBeDefined();
        return escapeRe(((part as string).split(':')[1] ?? key).trim());
      };
      opacityRef = new RegExp(`\\b${local('opacity')}\\b`);
      ringRef = new RegExp(`\\b${local('ring')}\\b`);
    }

    const rhsOf = (target: RegExp): string => {
      const m = target.exec(body);
      expect(m, `assignment ${target}`).not.toBeNull();
      return (m as RegExpExecArray)[1];
    };
    const bodyRhs = rhsOf(/\bbody\s*\.\s*opacity\s*=(?!=)\s*([^;\n]+)/);
    const ringRhs = rhsOf(/\bring\s*\.\s*opacity\s*=(?!=)\s*([^;\n]+)/);

    expect(bodyRhs).toMatch(opacityRef);
    expect(ringRhs).toMatch(ringRef);
    for (const rhs of [bodyRhs, ringRhs]) {
      expect(rhs, rhs).not.toMatch(/(?<![\w.$])\d/);
      expect(rhs, rhs).not.toMatch(/brightness/i);
      expect(rhs, rhs).not.toMatch(/(?<![\w.$])b(?![\w$])/);
    }
  });

  it("AC-18-03 styleNode knows the three states 'selected', 'dim' and 'normal'", () => {
    const body = styleNodeBody();
    for (const state of ['selected', 'dim', 'normal']) {
      expect(body, `state '${state}'`).toMatch(new RegExp(`(['"\`])${state}\\1`));
    }
  });

  it('AC-18-03 the dim state is chosen with isDimmed', () => {
    expect(styleNodeBody()).toMatch(/\bisDimmed\b/);
  });

  it('AC-18-03 the selected state depends on the selected node, not a constant', () => {
    const body = styleNodeBody();
    const withoutLiterals = body.replace(/(['"`])(?:selected|dim|normal)\1/g, '');
    expect(withoutLiterals).toMatch(/select/i);
  });

  it('AC-18-03 emissive, opacity and ring are read from the glowLevels result', () => {
    const body = styleNodeBody();
    const afterCall = body.slice(body.indexOf('glowLevels'));
    expect(afterCall).toMatch(/\bemissive\b/);
    expect(afterCall).toMatch(/\bopacity\b/);
    expect(afterCall).toMatch(/\bring\b/);
  });

  it('AC-18-03 no emissive line recomputes light from brightness or picks a number for the selected node', () => {
    const body = styleNodeBody();
    const lines = body.split('\n').filter((l) => /emissive/i.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line, line).not.toMatch(/brightness/i);
      expect(line, line).not.toMatch(/\?[^:]*\d/);
      expect(line, line).not.toMatch(/\bselect\w*\s*\?/i);
    }
  });
});

// ---------- AC-18-03: selected links and particles ----------

describe('AC-18-03 soft white for links touching the selected node', () => {
  const SOFT = 'rgba(255,255,255,0.55)';
  const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
  const linkBody = (): string => mustFunction(main, 'linkColor3d');
  const effectiveText = (): string => withConstValues(main, linkBody());

  it("AC-18-03 linkColor3d uses 'rgba(255, 255, 255, 0.55)', as a literal or a named const", () => {
    expect(squash(effectiveText())).toContain(SOFT);
  });

  it('AC-18-03 if a named const is used for the soft white, it is defined as that exact literal', () => {
    const body = linkBody();
    const consts = stringConsts(main);
    const named = [...new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter((id) => consts.has(id));
    const softNames = named.filter((id) => squash(consts.get(id) as string).includes('rgba(255,255,255')) ;
    for (const id of softNames) expect(squash(consts.get(id) as string)).toBe(SOFT);
  });

  it('AC-18-03 linkColor3d has no pure white (#ffffff, #fff, white, rgb(255,255,255), alpha 1, 0xffffff)', () => {
    const flat = squash(effectiveText());
    expect(flat).not.toMatch(/#fff(?:fff)?(?![0-9a-f])/);
    expect(flat).not.toMatch(/['"`]white['"`]/);
    expect(flat).not.toContain('rgb(255,255,255)');
    expect(flat).not.toMatch(/rgba\(255,255,255,1(?:\.0+)?\)/);
    expect(flat).not.toContain('0xffffff');
  });

  it('AC-18-03 linkColor3d still handles the shortest-path highlight', () => {
    expect(linkBody()).toMatch(/path/i);
  });
});

describe('AC-18-03 particles on selected links', () => {
  it('AC-18-03 SELECTED_PARTICLES is 2', () => {
    expect(numberConst(main, 'SELECTED_PARTICLES')).toBe(2);
  });

  it('AC-18-03 PARTICLE_WIDTH is 1.2', () => {
    expect(numberConst(main, 'PARTICLE_WIDTH')).toBe(1.2);
  });

  it('AC-18-03 a linkDirectionalParticles setting yields SELECTED_PARTICLES and no longer four', () => {
    const texts = calls(main, '\\.linkDirectionalParticles').map((t) => reach(main, t));
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const hit = texts.filter((t) => /\bSELECTED_PARTICLES\b/.test(t));
    expect(hit.length).toBeGreaterThanOrEqual(1);
    for (const t of hit) expect(t).not.toMatch(/(?<![\w.])4(?![\w.])/);
  });

  it('AC-18-03 a linkDirectionalParticleWidth setting uses PARTICLE_WIDTH', () => {
    const texts = calls(main, '\\.linkDirectionalParticleWidth').map((t) => reach(main, t));
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.some((t) => /\bPARTICLE_WIDTH\b/.test(t))).toBe(true);
  });

  it('AC-18-03 link widths are still set for the 3D graph (path widths stay)', () => {
    expect(calls(main, '\\.linkWidth').length).toBeGreaterThanOrEqual(1);
  });

  it("AC-18-03 PATH_COLOR is still '#ffd166' and linkColor3d returns it on the on-path branch", () => {
    expect(stringConsts(main).get('PATH_COLOR')?.toLowerCase()).toBe('#ffd166');
    expect(mustFunction(main, 'linkColor3d')).toMatch(/(?:return|\?|:|=>)\s*PATH_COLOR\b/);
  });

  it('AC-18-03 linkWidth3d still uses the path widths 2.5 and 0.5', () => {
    const fn = mustFunction(main, 'linkWidth3d');
    expect(fn).toMatch(/(?<![\w.])2\.5(?![\d.])/);
    expect(fn).toMatch(/(?<![\w.])0\.5(?![\d.])/);
  });
});

// ---------- AC-18-04: hover name ----------

describe('AC-18-04 the 3D nodeLabel shows escaped name, a line break, escaped type', () => {
  const labelCalls = calls(main, '\\.nodeLabel');
  const last = labelCalls[labelCalls.length - 1] ?? '';
  // The label text: the call itself plus any helper it names (one level), e.g.
  // `.nodeLabel((n) => hoverHtml(n))`. The escape helper itself is not appended.
  const text = reach(main, last, /esc/i);
  const ARGS = '(?:[^()]|\\([^()]*\\))*';
  const ESC_CALL = `\\w*[Ee]sc\\w*\\s*\\(${ARGS}\\)`;

  it('AC-18-04 there is a nodeLabel call to check', () => {
    expect(labelCalls.length).toBeGreaterThanOrEqual(1);
    expect(last.trim().length).toBeGreaterThan(0);
  });

  it('AC-18-04 the last nodeLabel has escaped name, then <br>, then escaped type', () => {
    const re = new RegExp(
      `\\w*[Ee]sc\\w*\\s*\\(${ARGS}\\b(?:name|label|title)\\b${ARGS}\\)[\\s\\S]*?<br\\s*/?>[\\s\\S]*?\\w*[Ee]sc\\w*\\s*\\(${ARGS}\\btype\\b${ARGS}\\)`,
    );
    expect(text).toMatch(re);
  });

  it('AC-18-04 name and type are never interpolated or concatenated unescaped', () => {
    const stripped = text.replace(new RegExp(ESC_CALL, 'g'), '');
    expect(stripped).not.toMatch(/\$\{[^}]*\.(?:name|label|title|type)\b[^}]*\}/);
    expect(stripped).not.toMatch(/\+\s*[\w$.()]*\.(?:name|label|title|type)\b/);
  });

  it('AC-18-04 name and type go through the same escape helper, which turns < into &lt;', () => {
    const names = [...text.matchAll(/(\w*[Ee]sc\w*)\s*\(/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(2);
    const helper = names[0];
    expect(new Set(names).size).toBe(1);
    const def = functionText(main, helper);
    if (def !== null) {
      expect(def).toContain('&lt;');
    } else {
      expect(main.code).toMatch(new RegExp(`import[^;]*\\b${escapeRe(helper)}\\b[^;]*from`));
    }
  });
});

// ---------- AC-18-04: tooltip panel CSS ----------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  ghostwhite: [248, 248, 255],
  whitesmoke: [245, 245, 245],
  lavender: [230, 230, 250],
  gainsboro: [220, 220, 220],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  lightsteelblue: [176, 196, 222],
  silver: [192, 192, 192],
  black: [0, 0, 0],
};

function parseColor(raw: string): Rgba | null {
  const v = raw.replace(/!important/i, '').trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[5] === '%' ? Number(fn[4]) / 100 : Number(fn[4]);
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: alpha };
  }
  const named = NAMED[v];
  return named ? { r: named[0], g: named[1], b: named[2], a: 1 } : null;
}

function luminance(c: Rgba): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function tooltipDeclarations(): Map<string, string> {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const merged = new Map<string, string>();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let rule: RegExpExecArray | null;
  while ((rule = ruleRe.exec(css)) !== null) {
    const targets = rule[1].split(',').some((sel) => /\.scene-tooltip\s*$/.test(sel.trim()));
    if (!targets) continue;
    for (const decl of rule[2].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      merged.set(decl.slice(0, at).trim().toLowerCase(), decl.slice(at + 1).trim());
    }
  }
  return merged;
}

describe('AC-18-04 .scene-tooltip panel in index.html', () => {
  const css = tooltipDeclarations();

  it('AC-18-04 index.html has a .scene-tooltip rule', () => {
    expect(css.size).toBeGreaterThan(0);
  });

  it('AC-18-04 background is dark and semi-opaque (alpha between 0.6 and 1)', () => {
    const raw = css.get('background-color') ?? css.get('background') ?? '';
    const colour = parseColor(raw);
    expect(colour, `background "${raw}"`).not.toBeNull();
    const c = colour as Rgba;
    expect(luminance(c)).toBeLessThan(70);
    expect(c.a).toBeGreaterThanOrEqual(0.6);
    expect(c.a).toBeLessThan(1);
  });

  it('AC-18-04 text colour is light', () => {
    const raw = css.get('color') ?? '';
    const colour = parseColor(raw);
    expect(colour, `color "${raw}"`).not.toBeNull();
    expect(luminance(colour as Rgba)).toBeGreaterThan(170);
  });

  it('AC-18-04 font size is 12px or 13px', () => {
    const raw = css.get('font-size') ?? css.get('font') ?? '';
    const m = /(\d+(?:\.\d+)?)px/.exec(raw);
    expect(m, `font-size "${raw}"`).not.toBeNull();
    const size = Number((m as RegExpExecArray)[1]);
    expect(size).toBeGreaterThanOrEqual(12);
    expect(size).toBeLessThanOrEqual(13);
  });

  it('AC-18-04 the panel has padding', () => {
    const values = [...css.entries()].filter(([k]) => k.startsWith('padding')).map(([, v]) => v);
    const numbers = values.flatMap((v) => v.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers.some((x) => x > 0)).toBe(true);
  });

  it('AC-18-04 the panel has a border radius', () => {
    const raw = css.get('border-radius') ?? '';
    const numbers = (raw.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers.some((x) => x > 0)).toBe(true);
  });

  it('AC-18-04 short names do not wrap: white-space is nowrap', () => {
    expect(css.get('white-space')?.replace(/!important/i, '').trim()).toBe('nowrap');
  });

  it('AC-18-04 the panel does not catch the mouse: pointer-events is none', () => {
    expect(css.get('pointer-events')?.replace(/!important/i, '').trim()).toBe('none');
  });
});
