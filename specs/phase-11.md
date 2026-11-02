# Phase 11: Offline insights - executive summary, roadmap, Markdown export

## Intent
Turn the analysis into plain words Sarthak can act on: a headline, a short executive summary,
main themes with their share, bridges, loose ends and roadmap milestones (continue active
themes, decide on idle ones), exportable as Markdown. Computed from the graph only - no AI
call, nothing leaves the computer.

## Complexity
M - deterministic text assembly with several omission and pluralisation rules.

## Scope
- In scope: `explorer/src/insights.ts` (pure, unit-tested).
- Out of scope: UI (phase 12), any network or model call.

## Interface contract
Visible tests `explorer/tests/insights.test.ts`, hidden tests in `explorer/tests/holdout/`.
Tests import `buildInsights`, `insightsMarkdown` from `../src/insights`, and may build input
with `parseGraph` (`../src/graph`) and `analyzeGraph` (`../src/analysis`), or hand-build an
`Analysis` object.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `Theme` | `explorer/src/insights.ts` | `export interface Theme { label: string; sessions: number; share: number; lastAt: string \| null }` | - |
| `Milestone` | same | `export interface Milestone { title: string; detail: string; community: number }` | - |
| `Insights` | same | `export interface Insights { headline: string; summary: string[]; themes: Theme[]; bridges: string[]; looseEnds: string[]; oneOffCount: number; roadmap: Milestone[] }` | - |
| `buildInsights` | same | `export function buildInsights(g: GraphData, a: Analysis): Insights` | - |
| `insightsMarkdown` | same | `export function insightsMarkdown(ins: Insights): string` | - |

## Behaviour
Let S = number of session nodes in `g`, C = `a.communities.length`, "recent" = a date whose
`Date.parse` is within `LOOSE_END_DAYS` (30) days at or before `a.latestAt`.
1. `headline`: S = 0 -> `"No sessions yet"`. Otherwise
   `"<S> sessions across <C> themes, <first month> to <last month>"` using the first and last
   `a.timeline` months; without a timeline `"<S> sessions across <C> themes"`. Use `session` /
   `theme` (singular) when the number is 1.
2. `themes`: the first 5 communities (in `a.communities` order): `label`, `sessions` = size,
   `share` = `Math.round(size / S * 100)`, `lastAt`.
3. `summary`, in this order, each line omitted when its data is empty:
   - `Main themes: <label> (<size>), ...` - up to 3 communities, joined with `", "`, ends with `.`
   - `Most active month: <YYYY-MM> (<n> sessions).` - timeline bucket with most sessions,
     earliest month on a tie; `session` when n = 1.
   - `Recent focus: <label>.` - community with the most sessions whose `started_at` is recent
     (ties: lower id).
   - `Bridges: <l1>, <l2>, <l3> link separate themes.` - up to 3 bridge labels.
   - `Loose ends: <n> small themes not touched for over 30 days.` (`theme` when n = 1).
   - `One-off topics: <n>.`
4. `bridges` = labels of `a.bridges` in order, at most 10. `oneOffCount` = `a.oneOffTopics.length`.
5. `looseEnds`: per loose end `"<label> - last touched <lastAt first 10 chars>, <size> session(s)"`
   with `session` when size = 1, else `sessions`.
6. `roadmap`: first, for each of the first 5 communities whose `lastAt` is recent:
   `{ title: "Continue: <label>", detail: "<size> sessions, last <lastAt first 10>", community: id }`
   (`session` when size = 1); then for each of the first 5 loose ends:
   `{ title: "Decide: <label>", detail: "Finish or drop - idle since <lastAt first 10>", community: id }`.
7. `insightsMarkdown(ins)`:
   ```
   # Knowledge graph insights

   <headline>

   ## Summary
   - <line>

   ## Main themes
   | Theme | Sessions | Share | Last active |
   |---|---|---|---|
   | <label> | <sessions> | <share>% | <lastAt first 10 or -> |

   ## Bridges
   - <label>

   ## Loose ends
   - <line>

   ## Roadmap
   1. **<title>** - <detail>
   ```
   Sections (and their blank line) are omitted when their list is empty; roadmap items are
   numbered from 1. `|` inside table cells is written `\|`. Output ends with exactly one `\n`.
8. Pure: same input -> same output; inputs not mutated; no clock.

## Acceptance criteria
- AC-11-01: `headline` covers zero sessions, singular/plural, and the month range from the timeline.
- AC-11-02: `themes` lists up to 5 communities with integer percentage shares and `lastAt`.
- AC-11-03: `summary` lines appear in the stated order with the exact wording and are omitted when their data is empty.
- AC-11-04: "Most active month" picks the earliest month on a tie; "Recent focus" counts only sessions within 30 days of `latestAt`.
- AC-11-05: `looseEnds` lines use the exact wording with singular/plural `session`.
- AC-11-06: `roadmap` lists "Continue:" milestones for recently active themes before "Decide:" milestones for loose ends, at most 5 of each.
- AC-11-07: `insightsMarkdown` matches the layout exactly, omits empty sections, escapes `|` in table cells and ends with one newline.
- AC-11-08: An empty graph produces `headline` "No sessions yet", empty lists and Markdown with only the title and headline.

## External systems to mock
- None (pure functions; no clock - "now" is `a.latestAt`).

## Dependencies on earlier phases
- Phase 07: `GraphData`, `parseGraph`. Phase 10: `Analysis`, `analyzeGraph`, `LOOSE_END_DAYS`.
