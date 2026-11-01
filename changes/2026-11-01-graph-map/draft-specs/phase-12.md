# Phase 12: Explorer UI - 2D labelled community map, insights panel, month filter

## Intent
Replace the 3D hairball with a flat, readable map: sessions, projects and topics coloured by
theme, theme labels on the map, files and tools hidden until switched on, a panel with the
summary, themes, bridges, loose ends, roadmap and timeline, a month range filter, Markdown
export, and a toggle back to 3D.

## Complexity
M - small pure view helpers plus wiring two rendering libraries and panels.

## Scope
- In scope: `explorer/src/view.ts` (pure, unit-tested); `explorer/src/main.ts`,
  `explorer/index.html` (app shell, not unit-tested); add dependency `force-graph` to
  `explorer/package.json`.
- Out of scope: changing `graph.ts`, `analysis.ts`, `insights.ts` behaviour; saving layouts.

## Interface contract
Visible tests `explorer/tests/view.test.ts`, hidden tests in `explorer/tests/holdout/`. Tests
import from `../src/view` and may use `parseGraph` (`../src/graph`) and `analyzeGraph`
(`../src/analysis`). No DOM, do not import `force-graph` or `3d-force-graph` in tests.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `COMMUNITY_PALETTE` | `explorer/src/view.ts` | `export const COMMUNITY_PALETTE: readonly string[]` - 12 distinct `#rrggbb` colours | - |
| `UNASSIGNED_COLOR` | same | `export const UNASSIGNED_COLOR = '#8a8f98'` | - |
| `communityColor` | same | `export function communityColor(id: number \| undefined): string` | - |
| `DEFAULT_VIEW_TYPES` | same | `export const DEFAULT_VIEW_TYPES: readonly NodeType[] = ['session', 'project', 'topic']` | - |
| `ViewOptions` | same | `export interface ViewOptions { types: Iterable<NodeType>; fromMonth?: string \| null; toMonth?: string \| null }` | - |
| `viewGraph` | same | `export function viewGraph(g: GraphData, opts: ViewOptions): GraphData` | - |
| `ClusterLabel` | same | `export interface ClusterLabel { community: number; label: string; nodeId: string }` | - |
| `clusterLabels` | same | `export function clusterLabels(a: Analysis, limit?: number): ClusterLabel[]` (default 12) | - |
| `monthRange` | same | `export function monthRange(a: Analysis): string[]` | - |

## Behaviour
1. `communityColor(id)`: `COMMUNITY_PALETTE[id % 12]` for an integer `id >= 0`; otherwise
   (undefined, negative, not an integer) `UNASSIGNED_COLOR`.
2. `viewGraph(g, opts)`: start from `filterByTypes(g, opts.types)`. A month range is set when
   `fromMonth` or `toMonth` is a non-empty string (`YYYY-MM`). With a range, drop session nodes
   whose `meta.started_at` is missing/invalid or whose first 7 characters are before
   `fromMonth` or after `toMonth` (string comparison, open ends allowed). Then, if `'session'`
   is among the types, drop every non-session node left with no link to a remaining session,
   and every link whose endpoints are not both kept. Link endpoints are returned as strings;
   input not mutated; node order kept.
3. `clusterLabels(a, limit)`: for the first `limit` communities in `a.communities` order:
   `community` = id, `label` = community label, `nodeId` = its session with the highest
   `a.rank` (ties: smallest id). Communities with no sessions are skipped.
4. `monthRange(a)`: `a.timeline` months in order (empty for no timeline).
5. App shell (not unit-tested):
   - Default view is 2D (`force-graph`), showing `DEFAULT_VIEW_TYPES`; a "3D" toggle switches to
     the existing `3d-force-graph` view with the same filtered data, and back.
   - Nodes coloured by `communityColor(analysis.communityOf.get(id))`, sized by `size`;
     `clusterLabels` drawn as text at their anchor node in 2D; node labels shown on hover and
     for the top 30 nodes by rank when zoomed in.
   - Type checkboxes default to `DEFAULT_VIEW_TYPES` checked, file and tool unchecked.
   - Month filter: two selects (from / to) filled from `monthRange`, applied with `viewGraph`.
   - Insights panel with tabs: Summary (headline and summary lines), Themes (click focuses the
     theme's anchor node), Bridges, Loose ends, Roadmap, Timeline (sessions per month as
     bars with top topics); a "Copy Markdown" and a "Download insights.md" button using
     `insightsMarkdown`.
   - Search, details panel, error panel and file picker keep working as in phase 07.
     Labels and text are escaped before they go into HTML.
   - Analysis and insights are computed once per loaded graph, in the browser only.

## Acceptance criteria
- AC-12-01: `COMMUNITY_PALETTE` has 12 distinct hex colours; `communityColor` wraps around after 12 and returns `UNASSIGNED_COLOR` for undefined, negative or fractional ids.
- AC-12-02: `viewGraph` with `DEFAULT_VIEW_TYPES` removes file and tool nodes and every link touching them.
- AC-12-03: `viewGraph` with a month range keeps only sessions inside the range (inclusive, open ends allowed), drops undated sessions, and removes topics/projects no longer linked to a kept session.
- AC-12-04: `viewGraph` without a range keeps undated sessions; without `'session'` in the types no orphan pruning happens; the input is not mutated and `{id}` endpoints work.
- AC-12-05: `clusterLabels` returns one label per community up to `limit`, anchored at the community's highest-ranked session.
- AC-12-06: `monthRange` returns the timeline months in order and `[]` for an empty analysis.
- AC-12-07: `npm run build` succeeds with `force-graph` in `package.json` dependencies and `npx tsc --noEmit` passes.

## External systems to mock
- None for unit tests (pure functions, no DOM or WebGL).

## Dependencies on earlier phases
- Phase 07: `graph.ts` (`filterByTypes`, `linkEnd`, types), the app shell.
- Phase 10: `Analysis`, `analyzeGraph`. Phase 11: `buildInsights`, `insightsMarkdown`.
