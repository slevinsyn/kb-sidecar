# Change: Graph insights, part 2 - analysis, insights and the 2D map

Date: 2026-11-02 · Requested by: Sarthak Bhatt · Status: draft
Client: Internal
Linked: changes/2026-11-01-graph-insights/change.md (part 1: clean topics and `kb context`, merged);
changes/2026-11-01-conversation-kb/change.md

## Why
The explorer shows 2,571 nodes as a 3D hairball. Sarthak wants to see the main themes versus
one-off topics, the bridges and gaps between themes, how interests changed over time, and a short
offline summary with a roadmap. Part 1 cleaned the topics; this part builds the analysis, the
insights and a readable 2D map on top of them.

## Must work
- Analysis (in the browser, from graph.json only):
  - Two groups of sessions sharing topics inside each group, joined by one weak link, come out as
    two themes; every session and topic belongs to exactly one theme.
  - A theme is named after its top three topics (`proposal · pdf · invoice`); with no topics it
    takes its project name, else `Community 3`.
  - A topic used by sessions of two themes is a bridge listing both; a topic used by one session
    is a one-off topic; a theme of at most 3 sessions untouched for over 30 days before the
    latest session is a loose end.
  - Sessions are counted per month (`2026-03`: 12 sessions, top topics ...); undated sessions are
    skipped. An empty graph gives empty results and never fails.
- Insights (plain words, no AI call):
  - Headline `41 sessions across 6 themes, 2026-01 to 2026-10`; `1 session across 1 theme` when
    singular; `No sessions yet` for an empty graph.
  - Summary lines: main themes with sizes, most active month, recent focus, bridges, loose ends,
    one-off count; each omitted when it has no data.
  - Roadmap: `Continue: <theme>` for recently active themes, then `Decide: <theme>` for loose ends.
  - "Copy Markdown" and "Download insights.md" give the same text as `insightsMarkdown`.
- Map:
  - Opens in 2D, coloured by theme, theme names drawn on the map; files and tools hidden until
    ticked.
  - A from/to month filter keeps only sessions inside the range and drops topics and projects left
    without a session.
  - A "3D" toggle goes to the existing 3D view and back; search, details, the error panel and the
    file picker still work. Labels are escaped before they go into HTML.

## Steps
| Phase | What it delivers | Size |
|---|---|---|
| 10 | `explorer/src/analysis.ts`: themes (Louvain), PageRank, bridges, one-off topics, loose ends, timeline | L |
| 11 | `explorer/src/insights.ts`: headline, summary, themes, roadmap, Markdown export | M |
| 12 | `explorer/src/view.ts` + app shell: 2D labelled map, insights panel, month filter, 3D toggle | M |

## Risk: Medium
Normal product change to the explorer; it reads private conversation data but only in the browser,
nothing is sent anywhere. Adds one dependency (`force-graph`), which touches `package.json`.

## Undo
Revert the phase commits. graph.json and the notes are not changed by this part.

## Not in this change
- Changing graph.json, `kb ingest` or `kb context` (part 1 is merged and stays as it is).
- Calling any AI model or online service; saving layouts; files and tools inside themes.
- An MCP server or HTTP API.

## Assumptions
- Work continues on a new branch `build/graph-map` cut from `main`, because the part 1 branch was
  already merged.
- The draft specs in `changes/2026-11-01-graph-map/draft-specs/` are adopted unchanged as the
  phase 10-12 specs.
- The 2D library is `force-graph` (same maker and licence as the `3d-force-graph` already used);
  installing it needs the npm registry once.
- "Now" for loose ends and recent focus is the latest session date in the graph, not the clock.
- The app shell (`main.ts`, `index.html`) is checked by `npm run build` and `tsc --noEmit`, not by
  unit tests; I will also open it in a browser at the end.

## Still open
