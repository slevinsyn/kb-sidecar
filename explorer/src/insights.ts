import type { GraphData } from './graph';
import { LOOSE_END_DAYS } from './analysis';
import type { Analysis, Community } from './analysis';

export interface Theme {
  label: string;
  sessions: number;
  share: number;
  lastAt: string | null;
}

export interface Milestone {
  title: string;
  detail: string;
  community: number;
}

export interface Insights {
  headline: string;
  summary: string[];
  themes: Theme[];
  bridges: string[];
  looseEnds: string[];
  oneOffCount: number;
  roadmap: Milestone[];
}

const DAY_MS = 86400000;
const MAX_THEMES = 5;
const MAX_SUMMARY_THEMES = 3;
const MAX_SUMMARY_BRIDGES = 3;
const MAX_BRIDGES = 10;
const MAX_MILESTONES = 5;
const DATE_CHARS = 10;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${plural(n, one, many)}`;
}

function day(date: string | null): string {
  return date === null ? '-' : date.slice(0, DATE_CHARS);
}

/** True when `date` is a parseable date at most LOOSE_END_DAYS days at or before `latest`
 *  (epoch milliseconds, or null when there is no usable latest date). */
function isRecent(date: unknown, latest: number | null): boolean {
  if (latest === null || typeof date !== 'string') return false;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return false;
  return t <= latest && latest - t <= LOOSE_END_DAYS * DAY_MS;
}

function latestMillis(a: Analysis): number | null {
  if (a.latestAt === null) return null;
  const t = Date.parse(a.latestAt);
  return Number.isNaN(t) ? null : t;
}

function headlineOf(sessionCount: number, a: Analysis): string {
  if (sessionCount === 0) return 'No sessions yet';
  const base = `${count(sessionCount, 'session', 'sessions')} across ${count(
    a.communities.length,
    'theme',
    'themes',
  )}`;
  if (a.timeline.length === 0) return base;
  return `${base}, ${a.timeline[0].month} to ${a.timeline[a.timeline.length - 1].month}`;
}

function recentFocus(g: GraphData, a: Analysis, latest: number | null): string | null {
  if (latest === null) return null;
  const startedAt = new Map<string, unknown>();
  for (const n of g.nodes) {
    if (n.type === 'session' && !startedAt.has(n.id)) startedAt.set(n.id, n.meta?.started_at);
  }
  let best: Community | null = null;
  let bestCount = 0;
  for (const c of a.communities) {
    let recent = 0;
    for (const s of c.sessions) if (isRecent(startedAt.get(s), latest)) recent++;
    if (recent > bestCount || (recent === bestCount && recent > 0 && best !== null && c.id < best.id)) {
      best = c;
      bestCount = recent;
    }
  }
  return best === null ? null : best.label;
}

function summaryOf(g: GraphData, a: Analysis, latest: number | null): string[] {
  const lines: string[] = [];

  if (a.communities.length > 0) {
    const named = a.communities
      .slice(0, MAX_SUMMARY_THEMES)
      .map((c) => `${c.label} (${c.size})`)
      .join(', ');
    lines.push(`Main themes: ${named}.`);
  }

  if (a.timeline.length > 0) {
    let best = a.timeline[0];
    for (const b of a.timeline) {
      if (b.sessions > best.sessions || (b.sessions === best.sessions && b.month < best.month)) {
        best = b;
      }
    }
    lines.push(`Most active month: ${best.month} (${count(best.sessions, 'session', 'sessions')}).`);
  }

  const focus = recentFocus(g, a, latest);
  if (focus !== null) lines.push(`Recent focus: ${focus}.`);

  if (a.bridges.length > 0) {
    const names = a.bridges
      .slice(0, MAX_SUMMARY_BRIDGES)
      .map((b) => b.label)
      .join(', ');
    lines.push(`Bridges: ${names} link separate themes.`);
  }

  if (a.looseEnds.length > 0) {
    lines.push(
      `Loose ends: ${count(a.looseEnds.length, 'small theme', 'small themes')} not touched for over ${LOOSE_END_DAYS} days.`,
    );
  }

  if (a.oneOffTopics.length > 0) lines.push(`One-off topics: ${a.oneOffTopics.length}.`);

  return lines;
}

function roadmapOf(a: Analysis, latest: number | null): Milestone[] {
  const road: Milestone[] = [];
  for (const c of a.communities.slice(0, MAX_THEMES)) {
    if (!isRecent(c.lastAt, latest)) continue;
    road.push({
      title: `Continue: ${c.label}`,
      detail: `${count(c.size, 'session', 'sessions')}, last ${day(c.lastAt)}`,
      community: c.id,
    });
  }
  for (const c of a.looseEnds.slice(0, MAX_MILESTONES)) {
    road.push({
      title: `Decide: ${c.label}`,
      detail: `Finish or drop - idle since ${day(c.lastAt)}`,
      community: c.id,
    });
  }
  return road;
}

export function buildInsights(g: GraphData, a: Analysis): Insights {
  let sessionCount = 0;
  for (const n of g.nodes) if (n.type === 'session') sessionCount++;
  const latest = latestMillis(a);

  const themes: Theme[] = a.communities.slice(0, MAX_THEMES).map((c) => ({
    label: c.label,
    sessions: c.size,
    share: sessionCount > 0 ? Math.round((c.size / sessionCount) * 100) : 0,
    lastAt: c.lastAt,
  }));

  return {
    headline: headlineOf(sessionCount, a),
    summary: summaryOf(g, a, latest),
    themes,
    bridges: a.bridges.slice(0, MAX_BRIDGES).map((b) => b.label),
    looseEnds: a.looseEnds.map(
      (c) =>
        `${c.label} - last touched ${day(c.lastAt)}, ${count(c.size, 'session', 'sessions')}`,
    ),
    oneOffCount: a.oneOffTopics.length,
    roadmap: roadmapOf(a, latest),
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

export function insightsMarkdown(ins: Insights): string {
  const blocks: string[] = [`# Knowledge graph insights\n\n${ins.headline}`];

  if (ins.summary.length > 0) {
    blocks.push(['## Summary', ...ins.summary.map((l) => `- ${l}`)].join('\n'));
  }
  if (ins.themes.length > 0) {
    blocks.push(
      [
        '## Main themes',
        '| Theme | Sessions | Share | Last active |',
        '|---|---|---|---|',
        ...ins.themes.map(
          (t) => `| ${cell(t.label)} | ${t.sessions} | ${t.share}% | ${day(t.lastAt)} |`,
        ),
      ].join('\n'),
    );
  }
  if (ins.bridges.length > 0) {
    blocks.push(['## Bridges', ...ins.bridges.map((b) => `- ${b}`)].join('\n'));
  }
  if (ins.looseEnds.length > 0) {
    blocks.push(['## Loose ends', ...ins.looseEnds.map((l) => `- ${l}`)].join('\n'));
  }
  if (ins.roadmap.length > 0) {
    blocks.push(
      [
        '## Roadmap',
        ...ins.roadmap.map((m, i) => `${i + 1}. **${m.title}** - ${m.detail}`),
      ].join('\n'),
    );
  }
  return `${blocks.join('\n\n')}\n`;
}
