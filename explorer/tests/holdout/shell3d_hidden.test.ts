import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Hidden checks for the phase 16 shell markup. Self-contained: own tiny parser.

function markup(): string {
  return readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

interface El {
  tag: string;
  attrs: Record<string, string>;
  at: number;
  after: number;
}

function elements(html: string): El[] {
  const list: El[] = [];
  const tagRe = /<([a-zA-Z][\w-]*)(\s[^>]*)?>/g;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(html)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
    let a: RegExpExecArray | null;
    const src = t[2] ?? '';
    while ((a = attrRe.exec(src)) !== null) {
      const key = a[1].toLowerCase();
      if (!(key in attrs)) attrs[key] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    list.push({ tag: t[1].toLowerCase(), attrs, at: t.index, after: t.index + t[0].length });
  }
  return list;
}

function single(html: string, id: string): El {
  const hits = elements(html).filter((e) => e.attrs.id === id);
  expect(hits.length, `id="${id}" count`).toBe(1);
  return hits[0];
}

function contentText(html: string, el: El): string {
  const end = html.toLowerCase().indexOf(`</${el.tag}>`, el.after);
  expect(end).toBeGreaterThan(el.after - 1);
  return html
    .slice(el.after, end)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('phase 16 shell markup (hidden)', () => {
  const html = markup();

  it('AC-16-03 layers checkbox: unticked, enabled, labelled exactly "Layers"', () => {
    const box = single(html, 'layers-mode');
    expect(box.tag).toBe('input');
    expect(box.attrs.type?.toLowerCase()).toBe('checkbox');
    expect('checked' in box.attrs).toBe(false);
    expect('disabled' in box.attrs).toBe(false);

    const labels: string[] = [];
    const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
    let m: RegExpExecArray | null;
    while ((m = labelRe.exec(html)) !== null) {
      const forMatch = /\bfor\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
      const wraps = /\bid\s*=\s*["']?layers-mode["'\s>/]/.test(m[2]);
      if ((forMatch && forMatch[1] === 'layers-mode') || wraps) {
        labels.push(m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
      }
    }
    expect(labels).toEqual(['Layers']);
  });

  it('AC-16-04 time-lapse control is a <button> whose resting caption is "Time-lapse"', () => {
    const btn = single(html, 'timelapse');
    expect(btn.tag).toBe('button');
    expect(contentText(html, btn)).toBe('Time-lapse');
    // The month filter it drives is a distinct, still-present select.
    const to = single(html, 'to-month');
    expect(to.tag).toBe('select');
    expect(to.at).not.toBe(btn.at);
  });

  it('AC-16-06 path picker: two separate single selects, a "Find path" button, a result div', () => {
    const from = single(html, 'path-from');
    const to = single(html, 'path-to');
    const go = single(html, 'path-go');
    const result = single(html, 'path-result');

    expect([from.tag, to.tag, go.tag, result.tag]).toEqual(['select', 'select', 'button', 'div']);
    expect(from.at).not.toBe(to.at);
    expect('multiple' in from.attrs || 'multiple' in to.attrs).toBe(false);
    expect(contentText(html, go)).toBe('Find path');

    // The path selects are not the month filter selects.
    expect(single(html, 'from-month').at).not.toBe(from.at);
    expect(single(html, 'to-month').at).not.toBe(to.at);
  });

  it('AC-16-01 every phase 16 id and the existing shell ids are unique in the page', () => {
    const ids = elements(html)
      .map((e) => e.attrs.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const wanted = [
      'layers-mode',
      'timelapse',
      'path-from',
      'path-to',
      'path-go',
      'path-result',
      'from-month',
      'to-month',
      'mode-toggle',
    ];
    for (const id of wanted) {
      expect(ids.filter((x) => x === id), id).toEqual([id]);
    }
  });
});
