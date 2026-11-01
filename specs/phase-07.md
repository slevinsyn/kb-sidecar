# Phase 07: 3D explorer web app

## Intent
Let the person explore their conversation knowledge graph in 3D in the browser: sessions,
projects, topics, files and tools as coloured nodes, with search, type filters, a details
panel and neighbour highlighting.

## Complexity
M - pure graph functions with edge cases plus a rendering shell around a 3D library.

## Scope
- In scope: pure functions in `explorer/src/graph.ts` (tested), the app shell
  (`explorer/index.html`, `explorer/src/main.ts`, `explorer/vite.config.ts`) using
  `3d-force-graph`, serving `graph.json` from the knowledge base folder, and a file picker
  fallback.
- Out of scope: editing the graph, any backend beyond the Vite dev server.

## Interface contract
Component `explorer/` (TypeScript, ES modules, vitest). Visible tests in
`explorer/tests/*.test.ts`, hidden tests in `explorer/tests/holdout/`. Tests import from
`../src/graph` (or `../../src/graph` from holdout). Only `src/graph.ts` is unit-tested.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `NodeType` | `explorer/src/graph.ts` | `export type NodeType = 'session' \| 'project' \| 'topic' \| 'file' \| 'tool'` | - |
| `NODE_TYPES` | same | `export const NODE_TYPES: readonly NodeType[] = ['session','project','topic','file','tool']` | - |
| `GraphNode` | same | `export interface GraphNode { id: string; type: NodeType; label: string; size: number; meta: Record<string, unknown> }` | - |
| `GraphLink` | same | `export interface GraphLink { source: string \| { id: string }; target: string \| { id: string }; type: string }` | - |
| `GraphData` | same | `export interface GraphData { nodes: GraphNode[]; links: GraphLink[] }` | - |
| `GraphError` | same | `export class GraphError extends Error` (`name === 'GraphError'`) | - |
| `TYPE_COLORS` | same | `export const TYPE_COLORS: Record<NodeType, string>` - five distinct `#rrggbb` colours | - |
| `linkEnd` | same | `export function linkEnd(end: string \| { id: string }): string` | - |
| `parseGraph` | same | `export function parseGraph(input: unknown): GraphData` | throws `GraphError` with message starting `Invalid graph` |
| `filterByTypes` | same | `export function filterByTypes(g: GraphData, types: Iterable<NodeType>): GraphData` | - |
| `searchNodes` | same | `export function searchNodes(g: GraphData, query: string, limit?: number): GraphNode[]` (default limit 20) | - |
| `neighbors` | same | `export function neighbors(g: GraphData, id: string): { nodes: GraphNode[]; links: GraphLink[] }` | - |
| `nodeDetails` | same | `export function nodeDetails(g: GraphData, id: string): { node: GraphNode; neighborsByType: Record<NodeType, GraphNode[]> } \| null` | - |

## Behaviour
1. `parseGraph(input)`: `input` is a JSON string or an already-parsed object. It must be an
   object with array `nodes` and array `links`; each node needs string `id`, a `type` in
   `NODE_TYPES` and string `label`; `size` defaults to 1 when missing or not a positive number;
   `meta` defaults to `{}`. Duplicate node ids: first one kept. Links need string (or `{id}`)
   `source`/`target`; `type` defaults to `""`; links whose endpoints are not node ids are dropped.
   Anything else (bad JSON, missing arrays, bad node) -> `GraphError("Invalid graph: <reason>")`.
   Returns new objects (input not mutated) with link endpoints as strings.
2. `linkEnd` returns the string itself or the object's `id` (3d-force-graph replaces endpoint
   strings with node objects after rendering; every function must accept both forms).
3. `filterByTypes(g, types)` keeps nodes whose type is in `types` and links whose both
   endpoints are kept. Input not mutated.
4. `searchNodes(g, query, limit)`: query trimmed and lower-cased; empty -> `[]`. Matches nodes
   whose label or id contains the query (case-insensitive). Ranking: label starts with query,
   then label contains query, then id-only match; ties by label (locale-insensitive `<`
   comparison of lower-cased labels), then id. At most `limit` results.
5. `neighbors(g, id)`: nodes directly linked to `id` in either direction (excluding `id`
   itself, no duplicates, sorted by id) and the links touching `id`. Unknown id -> empty arrays.
6. `nodeDetails(g, id)`: `null` for unknown id; otherwise the node and its neighbours grouped by
   type, every `NodeType` key present (empty arrays allowed), each group sorted by label.
7. App shell (not unit-tested): `npm run dev` serves the app; `GET /graph.json` returns
   `$KB_HOME/graph/graph.json` or `~/claude-kb/graph/graph.json`; if that fails or is invalid the
   page shows the `parseGraph` error text and a file picker to load a graph.json manually. Nodes
   coloured by `TYPE_COLORS`, sized by `size`; clicking a node opens a details panel (label,
   type, meta, neighbours grouped by type) and highlights it and its neighbours; a search box
   lists `searchNodes` results and flies the camera to the chosen node; checkboxes per type
   apply `filterByTypes`. Dependency `3d-force-graph` added to `package.json`.

## Acceptance criteria
- AC-07-01: `parseGraph` accepts a valid graph as a JSON string and as an object, defaults `size` and `meta`, and returns string link endpoints.
- AC-07-02: `parseGraph` throws `GraphError` with a message starting `Invalid graph` for bad JSON, missing `nodes`/`links`, a node without id, or an unknown node type.
- AC-07-03: `parseGraph` drops links to unknown nodes and duplicate node ids, and does not mutate its input.
- AC-07-04: `filterByTypes` removes nodes of other types and every link touching them, accepting both string and `{id}` link endpoints.
- AC-07-05: `searchNodes` is case-insensitive, ranks prefix label matches before substring matches before id-only matches, honours `limit`, and returns `[]` for a blank query.
- AC-07-06: `neighbors` returns direct neighbours in both link directions, sorted, without duplicates or the node itself; unknown id gives empty arrays.
- AC-07-07: `nodeDetails` returns `null` for unknown ids and groups neighbours by type with all five keys present.
- AC-07-08: `TYPE_COLORS` has five distinct hex colours, one per node type.

## External systems to mock
- None for unit tests (pure functions, no DOM, no WebGL). Do not import `3d-force-graph` in tests.

## Dependencies on earlier phases
- Phase 05: the `graph.json` shape (`nodes[{id,type,label,size,meta}]`, `links[{source,target,type}]`).
