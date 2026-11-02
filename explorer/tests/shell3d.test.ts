import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 16 is an app-shell phase: behaviour is checked in the browser. These tests pin the
// static parts of the Interface contract in explorer/index.html (ids, element kinds, labels
// and default state) plus the build script AC-16-01 depends on.

// ---------- helpers ----------

function loadHtml(): string {
  const raw = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  // Ignore comments, styles and scripts so commented-out markup or CSS selectors never count.
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

interface StartTag {
  tag: string;
  attrs: Map<string, string>;
  start: number;
  end: number; // index just after the closing '>' of the start tag
}

function parseAttrs(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (!attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

function startTags(html: string): StartTag[] {
  const out: StartTag[] = [];
  const re = /<([a-zA-Z][\w-]*)(\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      tag: m[1].toLowerCase(),
      attrs: parseAttrs(m[2] ?? ''),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

function byId(html: string, id: string): StartTag[] {
  return startTags(html).filter((t) => t.attrs.get('id') === id);
}

function only(html: string, id: string): StartTag {
  const found = byId(html, id);
  expect(found, `expected exactly one element with id="${id}"`).toHaveLength(1);
  return found[0];
}

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function innerText(html: string, el: StartTag): string {
  const close = html.toLowerCase().indexOf(`</${el.tag}>`, el.end);
  expect(close, `missing </${el.tag}> for #${el.attrs.get('id')}`).toBeGreaterThan(-1);
  return textOf(html.slice(el.end, close));
}

/** Text of the <label> tied to the element: either <label for=id> or a wrapping <label>. */
function labelTextFor(html: string, id: string): string[] {
  const texts: string[] = [];
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2];
    const wraps = startTags(body).some((t) => t.attrs.get('id') === id);
    if (attrs.get('for') === id || wraps) texts.push(textOf(body));
  }
  return texts;
}

const NEW_IDS = ['layers-mode', 'timelapse', 'path-from', 'path-to', 'path-go', 'path-result'];

// ---------- tests ----------

describe('phase 16 controls exist once each', () => {
  const html = loadHtml();

  for (const id of NEW_IDS) {
    it(`AC-16-01 index.html has exactly one element with id="${id}"`, () => {
      expect(byId(html, id)).toHaveLength(1);
    });
  }

  it('AC-16-01 the new ids are all different elements', () => {
    const positions = NEW_IDS.map((id) => only(html, id).start);
    expect(new Set(positions).size).toBe(NEW_IDS.length);
  });

  it('AC-16-04 the month filter selects the time-lapse drives are still there once each', () => {
    expect(only(html, 'from-month').tag).toBe('select');
    expect(only(html, 'to-month').tag).toBe('select');
  });

  it('AC-16-02 the 2D/3D mode toggle is still present once', () => {
    expect(only(html, 'mode-toggle').tag).toBe('button');
  });
});

describe('Layers switch', () => {
  const html = loadHtml();

  it('AC-16-03 #layers-mode is a checkbox input', () => {
    const el = only(html, 'layers-mode');
    expect(el.tag).toBe('input');
    expect((el.attrs.get('type') ?? '').toLowerCase()).toBe('checkbox');
  });

  it('AC-16-03 #layers-mode is unticked by default so the time axis is used first', () => {
    const el = only(html, 'layers-mode');
    expect(el.attrs.has('checked')).toBe(false);
  });

  it('AC-16-03 #layers-mode has a label reading "Layers"', () => {
    const texts = labelTextFor(html, 'layers-mode');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('Layers');
  });
});

describe('Time-lapse button', () => {
  const html = loadHtml();

  it('AC-16-04 #timelapse is a button', () => {
    expect(only(html, 'timelapse').tag).toBe('button');
  });

  it('AC-16-04 #timelapse reads "Time-lapse" before it runs (not "Stop")', () => {
    const text = innerText(html, only(html, 'timelapse'));
    expect(text).toBe('Time-lapse');
    expect(text).not.toBe('Stop');
  });

  it('AC-16-04 #timelapse is not disabled in the markup', () => {
    expect(only(html, 'timelapse').attrs.has('disabled')).toBe(false);
  });
});

describe('Path picker', () => {
  const html = loadHtml();

  it('AC-16-06 #path-from and #path-to are select elements', () => {
    expect(only(html, 'path-from').tag).toBe('select');
    expect(only(html, 'path-to').tag).toBe('select');
  });

  it('AC-16-06 the two topic selects pick a single topic each', () => {
    expect(only(html, 'path-from').attrs.has('multiple')).toBe(false);
    expect(only(html, 'path-to').attrs.has('multiple')).toBe(false);
  });

  it('AC-16-06 #path-go is a button labelled "Find path"', () => {
    const el = only(html, 'path-go');
    expect(el.tag).toBe('button');
    expect(innerText(html, el)).toBe('Find path');
  });

  it('AC-16-06 #path-result is a div that starts without the no-path message', () => {
    const el = only(html, 'path-result');
    expect(el.tag).toBe('div');
    expect(innerText(html, el)).not.toContain('No path between these topics');
  });
});

describe('build', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };

  it('AC-16-01 npm run build type-checks with tsc --noEmit and builds with vite', () => {
    const build = pkg.scripts?.build ?? '';
    expect(build).toContain('tsc --noEmit');
    expect(build).toContain('vite build');
  });

  it('AC-16-01 3d-force-graph and force-graph stay in dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(
      expect.arrayContaining(['3d-force-graph', 'force-graph']),
    );
  });
});
