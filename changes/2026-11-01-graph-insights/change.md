# Change: Graph insights, part 1 - clean topics and `kb context`

Date: 2026-11-01 · Requested by: Sarthak Bhatt · Status: draft
Client: Internal
Linked: changes/2026-11-01-conversation-kb/change.md (builds on it);
changes/2026-11-01-graph-map/ (part 2: analysis, insights and the new map - planned after this one)

## Why
The explorer finds clusters, but the picture makes no sense: 2,571 nodes in a 3D hairball, most
of them files and tools, and topics full of noise words (number, evening, goal, say). Sarthak
wants to see the main themes versus one-off topics, the bridges and gaps, how interests changed
over time, a short offline summary and roadmap, and a way for future assistants to pull past
context from the graph instead of reading whole transcripts.

The work is split in two. This first part fixes the data and adds the context command:
1. Clean topics, which everything else depends on.
2. `kb context` (GraphRAG).

Part 2 builds the analysis, the insights and the readable 2D map on top of the cleaner topics.

## Must work
- Topics:
  - A session about "proposals" and "proposal" PDFs gets one topic, `proposal`.
  - Words like number, say, evening, morning, today and goal never become topics.
  - Re-running `kb ingest` writes the cleaner topics to graph.json and to the session notes.
- `kb context "proposal app"`:
  - Prints a short Markdown block, at most 4,000 characters by default. It lists the
    best-matching sessions (date, title, project, topics, note file) and their related topics,
    files and projects.
  - No match prints `No sessions match "proposal app".` and exits 0.
  - A missing graph.json gives a clear error and exits 1.
  - No query prints the usage and exits 2.

## Steps
| Phase | What it delivers | Size |
|---|---|---|
| 08 | Clean topics: more stop words, plurals merged, technology terms preferred, generic words dropped; ingest uses them | M |
| 09 | `kb context <query>` command: a short Markdown context block built from graph.json | M |

## Risk: High
This reads private conversation data (titles, topics, file paths) and changes what the knowledge
base writes. Everything stays on this computer; nothing is sent anywhere.

## Undo
Revert the phase commits, then re-run `kb ingest` to regenerate graph.json and the notes with
the old topics.

## Not in this change
- Part 2 (changes/2026-11-01-graph-map/):
  - Communities (Louvain), PageRank, bridges, one-off topics, loose ends and the timeline.
  - The executive summary and roadmap.
  - The 2D map and the insights panel.
- Calling any AI model or online service.
- An MCP server or HTTP API for GraphRAG (only the `kb context` command).

## Assumptions
- The existing topic functions stay as they are, because their tests are locked. New "clean"
  functions are added next to them, and ingest switches to the new ones.
- Generic words are also dropped automatically: with 10 or more sessions, a term that appears in
  more than 40% of them is not a topic.
- `kb context` reads `<out>/graph/graph.json`, with the same `--out` / `KB_HOME` default as
  ingest.

## Still open
