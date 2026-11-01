# Phase 09: `kb context` - token-light context for assistants (GraphRAG)

## Intent
Let a future assistant (or Sarthak) ask "what do I already know about X?" and get a short
Markdown block built from the knowledge graph - matching sessions, related topics, files and
projects - instead of reading whole transcripts. Offline, read-only.

## Complexity
M - scoring, ranking and exact rendering with truncation, plus a new CLI command.

## Scope
- In scope: library module `kb_core::context` (pure) and the `kb context` command in
  `core/src/main.rs` (plus a usage line).
- Out of scope: embeddings, MCP/HTTP servers, writing anything to disk.

## Interface contract
Tests in `core/tests/phase09_context.rs`: unit tests on `kb_core::context` with graph JSON
strings built in the test, and CLI tests running `env!("CARGO_BIN_EXE_kb")` with `--out <tmp>`
where the test writes `<tmp>/graph/graph.json` itself.

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `ContextOptions` | `kb_core::context` | `pub struct ContextOptions { pub limit: usize, pub max_chars: usize }`, `impl Default` = `{ limit: 8, max_chars: 4000 }` | - |
| `build_context` | `kb_core::context` | `pub fn build_context(graph_json: &str, query: &str, opts: &ContextOptions) -> Result<String, kb_core::KbError>` | `KbError::Parse(_)` when the text is not JSON or has no `nodes`/`links` arrays |
| CLI | `kb` binary | `kb context <query words...> [--out <dir>] [--limit <n>] [--max-chars <n>]` | exit 2 usage errors, exit 1 runtime errors |

Graph shape (phase 05): `{"nodes":[{"id","type","label","size","meta"}],"links":[{"source","target","type"}]}`.
Session nodes: `id` `session:<id>`, `label` = title, `meta.started_at` (string or null),
`meta.project` (string or null), `meta.topics` (array of strings), `meta.node_file` (string).
Links from a session: `has_topic` -> `topic:<t>`, `touched_file` -> `file:<path>` (label = path),
`in_project` -> `project:<name>`.

## Behaviour
1. Query terms = `tokenize_clean(query)` (phase 08), duplicates removed, first-seen order. No
   terms -> `No sessions match "<query>".\n` (query shown trimmed).
2. Score of a session = sum over query terms t of:
   3 if t equals `normalize_term` of one of its `meta.topics`;
   2 if t is in `tokenize_clean(label)`;
   2 if t is in `tokenize_clean(meta.project)` (when project is a string);
   1 if the lowercase label of any file node it links to via `touched_file` contains t.
   Sessions with score 0 are not matches.
3. Order: score descending, then `started_at` descending (missing/null last), then id
   ascending. Show the first `opts.limit` matches.
4. Output (sections with no items are omitted, items separated by `\n`, sections by a blank line):
   ```
   # Context: <query trimmed>

   Matched <M> of <N> sessions (showing <S>).

   ## Sessions
   - <first 10 chars of started_at or "undated"> · <label> · project: <project or "-"> · topics: <meta.topics joined ", " or "-"> · note: <meta.node_file>

   ## Related topics
   - <topic> (<count>)

   ## Files
   - <path> (<count>)

   ## Projects
   - <name> (<count>)
   ```
   N = number of session nodes, M = matches, S = shown. Related topics: across shown sessions,
   count of sessions per `meta.topics` value, excluding values whose normalised form is a
   query term; count descending then name ascending; at most 10. Files: `touched_file` labels
   of shown sessions, count of sessions, same order, at most 10. Projects: `meta.project` of
   shown sessions, same order, at most 5. No matches -> exactly `No sessions match "<query>".\n`.
5. Output ends with exactly one `\n`. When longer than `max_chars` characters, keep whole lines
   from the top while the kept text plus `… [truncated]\n` fits in `max_chars`, then append
   `… [truncated]\n`. Same input -> byte-identical output.
6. CLI: arguments that are not flags (or flag values) are query words, joined with one space;
   flags may come before or after them. `--out` as for ingest (default `$KB_HOME`, else
   `~/claude-kb`); reads `<out>/graph/graph.json`; prints the result to stdout, exit 0
   (also for no matches). No query words, unknown flag, missing flag value, or a `--limit` /
   `--max-chars` that is not a positive integer -> message on stderr, exit 2. Missing or
   unreadable graph.json -> stderr message containing `graph.json`, exit 1. Invalid graph ->
   stderr message, exit 1. `kb help` usage text gains a `kb context` line.

## Acceptance criteria
- AC-09-01: Topic matches outweigh title matches, which outweigh file-path matches (3/2/1 scoring), and a project-name match counts 2.
- AC-09-02: Ties are ordered by newest `started_at` first, undated last, then id.
- AC-09-03: The output follows the exact layout, including `Matched M of N sessions (showing S).` and the session line format with `undated`, `-` project and `-` topics.
- AC-09-04: Related topics exclude the query terms (also their plural forms), are counted per session and capped at 10; files capped at 10, projects at 5; empty sections are omitted.
- AC-09-05: `limit` caps the shown sessions; `max_chars` truncation keeps whole lines and ends with `… [truncated]\n` within the limit.
- AC-09-06: No match (or a query of only stop words) gives exactly `No sessions match "<query>".\n`.
- AC-09-07: `build_context` returns `KbError::Parse` for non-JSON and for JSON without `nodes`/`links`.
- AC-09-08: `kb context proposal app --out <dir>` prints the context and exits 0; flags after the query work.
- AC-09-09: `kb context` with no query, an unknown flag or `--limit 0` exits 2; a missing graph.json exits 1 with a message mentioning `graph.json`.

## External systems to mock
- None (graph.json written by the test into a temporary folder).

## Dependencies on earlier phases
- Phase 05: graph.json shape. Phase 06: `--out` / `KB_HOME` default. Phase 08: `tokenize_clean`, `normalize_term`.
