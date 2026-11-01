# Phase 05: Knowledge graph builder (graph.json)

## Intent
Produce the data for the 3D knowledge graph: every session becomes a node connected to its
project, topics, touched files and used tools, so related conversations cluster together.

## Complexity
S - deterministic aggregation into nodes and links.

## Scope
- In scope: `Graph`, `GraphNode`, `GraphLink`, `build_graph`, `Graph::to_json`.
- Out of scope: rendering (phase 07), writing the file (phase 06).

## Interface contract
Tests in `core/tests/phase05_graph.rs`. Dev-dependencies available: `serde_json = "1"`.

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `GraphNode` | `kb_core::graph` | `pub struct GraphNode { pub id: String, pub kind: String, pub label: String, pub size: usize, pub meta: serde_json::Value }`; `kind` serialises as `"type"`; derives `Debug, Clone, PartialEq, Serialize, Deserialize` | - |
| `GraphLink` | `kb_core::graph` | `pub struct GraphLink { pub source: String, pub target: String, pub kind: String }`; `kind` serialises as `"type"`; same derives | - |
| `Graph` | `kb_core::graph` | `pub struct Graph { pub nodes: Vec<GraphNode>, pub links: Vec<GraphLink> }`; same derives | - |
| `build_graph` | `kb_core::graph` | `pub fn build_graph(sessions: &[(kb_core::Session, Vec<String>)]) -> Graph` (each session with its topics) | - |
| `Graph::to_json` | `kb_core::graph` | `pub fn to_json(&self) -> String` (pretty JSON, ends with `"\n"`) | - |

## Behaviour
1. Node ids and kinds:
   - `session:<session id>`, kind `"session"`, label = title, size = `max(turn_count, 1)`,
     meta = `{"source","project","started_at","ended_at","turns","models","tools","topics","node_file"}`
     (`node_file` = `kb_core::node::node_file_name(&session)`, `topics` = the given topics).
   - `project:<project>` for sessions with a project, kind `"project"`, label = project name.
   - `topic:<term>`, kind `"topic"`, label = term.
   - `file:<full path>`, kind `"file"`, label = last path component, meta `{"path": <full path>}`.
   - `tool:<name>`, kind `"tool"`, label = name.
   Non-session nodes have `size` = number of distinct sessions linked to them and, unless stated,
   `meta = {}`.
2. Links (from the session node): `in_project` -> project, `has_topic` -> each topic,
   `touched_file` -> each of `files_touched()`, `used_tool` -> each of `tools_used()`.
   Duplicate links are removed.
3. If two input sessions share an id, the later one replaces the earlier one.
4. Ordering: nodes sorted by kind in the order session, project, topic, file, tool, then by id;
   links sorted by (source, target, type). Every link's source and target exist as nodes.
5. Empty input -> `{"nodes": [], "links": []}`.

## Acceptance criteria
- AC-05-01: Two sessions in the same project sharing a topic and a tool produce one project node, one shared topic node and one shared tool node, each with size 2, plus links from both sessions.
- AC-05-02: Node ids/kinds/labels follow the rules; file nodes are labelled with the file name and carry the full path in meta.
- AC-05-03: Session node meta contains turns, source, project, models, topics and the node file name from `node_file_name`.
- AC-05-04: A claude.ai session (no project, no tools) gets topic links only and no project node.
- AC-05-05: No duplicate nodes or links; no dangling links; duplicate session ids keep the later session.
- AC-05-06: Output order is deterministic and `to_json` is identical for the same input; JSON uses the key `type` for kinds.
- AC-05-07: Empty input gives empty nodes and links.

## External systems to mock
- None.

## Dependencies on earlier phases
- Phase 01: `Session` helpers. Phase 03: `node_file_name`.
