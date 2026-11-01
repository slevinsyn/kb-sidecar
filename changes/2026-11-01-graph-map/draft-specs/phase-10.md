# Phase 10: Explorer analysis - communities, rank, bridges, gaps, timeline

## Intent
Turn the raw graph into structure a person can read: themes (communities found with Louvain),
the most central sessions and topics (PageRank), bridges between themes, one-off topics, loose
ends (small themes left untouched) and a month-by-month timeline. Pure TypeScript in the
browser, no network.

## Complexity
L - Louvain community detection and PageRank must be correct and deterministic, with many
edge cases.

## Scope
- In scope: `explorer/src/analysis.ts` (pure functions, unit-tested).
- Out of scope: UI (phase 12), text summaries (phase 11), files and tools in communities.

## Interface contract
Visible tests `explorer/tests/analysis.test.ts`, hidden tests in `explorer/tests/holdout/`.
Tests import from `../src/analysis` and build graphs with `parseGraph` from `../src/graph`
(phase 07 types: `GraphData`, `GraphNode`, `NodeType`). No DOM.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `WeightedEdge` | `explorer/src/analysis.ts` | `export interface WeightedEdge { a: string; b: string; w: number }` | - |
| `sessionTopicGraph` | same | `export function sessionTopicGraph(g: GraphData): { nodes: string[]; edges: WeightedEdge[] }` | - |
| `louvain` | same | `export function louvain(nodes: string[], edges: WeightedEdge[]): Map<string, number>` | - |
| `pageRank` | same | `export function pageRank(nodes: string[], edges: WeightedEdge[], opts?: { damping?: number; iterations?: number }): Map<string, number>` | - |
| `Community` | same | `export interface Community { id: number; label: string; topics: string[]; sessions: string[]; size: number; projects: string[]; firstAt: string \| null; lastAt: string \| null }` | - |
| `Bridge` | same | `export interface Bridge { id: string; label: string; type: NodeType; communities: number[] }` | - |
| `TimelineBucket` | same | `export interface TimelineBucket { month: string; sessions: number; topTopics: string[] }` | - |
| `Analysis` | same | `export interface Analysis { communityOf: Map<string, number>; communities: Community[]; rank: Map<string, number>; bridges: Bridge[]; oneOffTopics: GraphNode[]; looseEnds: Community[]; timeline: TimelineBucket[]; latestAt: string \| null }` | - |
| `LOOSE_END_DAYS` | same | `export const LOOSE_END_DAYS = 30` | - |
| `analyzeGraph` | same | `export function analyzeGraph(g: GraphData): Analysis` | never throws for a parsed graph |

## Behaviour
1. `sessionTopicGraph(g)`: `nodes` = ids of all `session` and `topic` nodes, sorted ascending;
   `edges` = one edge per distinct session-topic pair joined by any link (either direction),
   `a` = session id, `b` = topic id, `w = 1`, sorted by `a` then `b`.
2. `louvain(nodes, edges)`: undirected weighted modularity optimisation (resolution 1).
   Edges whose endpoints are not in `nodes`, self-loops and zero/negative weights are ignored;
   parallel edges add up. Phase 1: visit nodes in the given order, move each to the
   neighbouring community with the largest positive modularity gain (ties: lower community
   index), repeat passes until no node moves. Phase 2: aggregate communities into nodes and
   repeat until nothing changes. Every input node gets exactly one community; nodes with no
   edges are alone. Final ids are renumbered 0..k-1 by member count descending, then by the
   smallest member id ascending. Same input -> same output. Empty input -> empty map.
3. `pageRank(nodes, edges, opts)`: undirected weighted, `damping` default 0.85, `iterations`
   default 50, start uniform; a node with no edges spreads its rank evenly over all nodes. Values
   sum to 1 (within 1e-6). Empty input -> empty map.
4. `analyzeGraph(g)` uses `sessionTopicGraph`, `louvain` and `pageRank` on it (`rank` has
   session and topic ids only).
   - Communities = louvain groups that contain at least one session, re-ordered by session
     count descending, then member count descending, then smallest member id; `id` is the new
     index 0..; `communityOf` maps every session and topic id in those groups to that id.
   - `sessions` = session ids, sorted ascending; `size` = number of sessions.
   - `topics` = labels of the community's topic nodes ordered by the number of the community's
     sessions linked to them, descending, then label ascending.
   - `label` = first up to 3 `topics` joined with `" · "`; when there are none, the first
     `projects` entry; else `"Community <id + 1>"`.
   - `projects` = distinct string `meta.project` values of its sessions, by count descending
     then name ascending.
   - `firstAt` / `lastAt` = smallest / largest `meta.started_at` string of its sessions that
     `Date.parse` accepts; `null` if none.
   - `latestAt` = largest valid `started_at` of all sessions, `null` if none.
5. `bridges`: topic and project nodes whose linked sessions belong to 2 or more communities;
   `communities` = those ids ascending; ordered by number of communities descending, then
   `rank` descending (projects count as 0), then id ascending; at most 20.
6. `oneOffTopics`: topic nodes linked to exactly one session, sorted by label then id.
7. `looseEnds`: communities with `size <= 3`, `lastAt` not null, and
   `Date.parse(latestAt) - Date.parse(lastAt) > LOOSE_END_DAYS * 86400000`; ordered by
   `lastAt` descending, then id.
8. `timeline`: sessions with a valid `started_at` grouped by its first 7 characters (`YYYY-MM`),
   months ascending, only months that have sessions; `sessions` = count; `topTopics` = up to 3
   topic labels linked to the most sessions that month, ties by label.
9. Inputs are not mutated; link endpoints may be strings or `{id}` objects (use `linkEnd`).

## Acceptance criteria
- AC-10-01: `sessionTopicGraph` keeps only session-topic pairs, deduplicated and sorted, ignoring files, tools and projects.
- AC-10-02: `louvain` splits two 4-node cliques joined by one edge into two communities, puts every node in exactly one community, isolates nodes without edges, and returns an empty map for empty input.
- AC-10-03: `louvain` is deterministic and numbers communities by size descending, then smallest member id.
- AC-10-04: `pageRank` values sum to 1, the centre of a star ranks highest, and an empty graph gives an empty map.
- AC-10-05: `analyzeGraph` builds communities with the label rule (top 3 topics, else project, else `Community N`), sorted topics, projects, `firstAt`/`lastAt` and ids ordered by session count.
- AC-10-06: A topic shared by sessions of two communities is a bridge listing both community ids; a topic in one community is not.
- AC-10-07: A topic used by exactly one session is in `oneOffTopics`; one used by two is not.
- AC-10-08: A community of at most 3 sessions last active more than 30 days before `latestAt` is a loose end; one active within 30 days, or larger than 3 sessions, is not.
- AC-10-09: `timeline` groups by month in ascending order with counts and top 3 topics, skipping undated sessions.
- AC-10-10: An empty graph gives empty communities, bridges, timeline and `latestAt === null`; the input graph is not mutated and `{id}` link endpoints work.

## External systems to mock
- None (pure functions, no DOM, no WebGL, no clock - "now" is `latestAt`).

## Dependencies on earlier phases
- Phase 07: `explorer/src/graph.ts` types, `parseGraph`, `linkEnd`.
- Phase 05: graph.json shape (session `meta.started_at`, `meta.project`).
