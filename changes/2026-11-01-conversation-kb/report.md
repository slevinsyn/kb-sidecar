# Report: 2026-11-01-conversation-kb

_Written by `.phased/bin/phase.py report` on 2026-11-01T21:08._

| Phase | Title | Size | Model | Minutes | Test files | Review rounds | Bugs found and fixed | Retests | Commit |
|---|---|---|---|---|---|---|---|---|---|
| 01 | Session model + Claude Code transcript parser | medium | sonnet | 135.5 | 1 | 1 | 0 | 0 | 60ffef4201 |
| 02 | claude.ai export parser | small | sonnet | 12.8 | 1 | 1 | 0 | 0 | 09e9496d93 |
| 03 | Topic keywords (TF-IDF) + Markdown session nodes | medium | sonnet | 113.2 | 1 | 2 | 2 | 0 | c38e8c0e4c |
| 04 | Training dataset records + redaction | medium | sonnet | 8.9 | 1 | 1 | 0 | 0 | 492606be3f |
| 05 | Knowledge graph builder (graph.json) | small | sonnet | 4.1 | 1 | 1 | 0 | 0 | 4bb96b7e8a |
| 06 | `kb` command - incremental ingest, SessionEnd hook, hook installer | medium | sonnet | 14.3 | 1 | 2 | 1 | 0 | bcfb5f9081 |
| 07 | 3D explorer web app | medium | sonnet | 8.7 | 2 | 2 | 1 | 0 | b56b27d900 |

| Total | Value |
|---|---|
| Phases done | 7 of 7 |
| Time | about 298 minutes |
| Risk | High -> 2 people approve the merge |
| Old problems seen, not blocking | 1 |

## Problems met and how they were solved

- Phase 01: models were collected per record, so a message dropped for having only empty thinking still contributed its model (AC-01-05 test failed) -> models are now tracked per message and only counted when the message survives filtering
- Phase 01: Spec is silent on whether sidechain/meta/synthetic records can supply sessionId/cwd/gitBranch -> treated them as fully ignored, so they supply nothing
- Phase 01: Unclosed system-reminder tag is not specified -> left in the text unchanged, since it is not a complete span
- Phase 01: locked test file changed after locking (cause unknown) -> user approved re-locking the current file
- Phase 02: The first single-shell command that edited several files was blocked by the phased lock hook (it flagged a protected path passed through variables) -> redid the edits with separate Write/Edit calls.
- Phase 02: The locked tests build their own stored zip files, so they don't use the zip dev-dependency -> added zip only as a library dependency (v2, default features off, deflate enabled so real claude.ai exports can be read).
- Phase 03: review round 1: missing input normalisation (output not ending in exactly one newline) -> fixed
- Phase 03: review round 1: path traversal via unvalidated date in file name -> fixed
- Phase 03: test review verdict was not recorded by the hook (reviewer reports via a handback block); recorded with review-verdict after the parser was patched
- Phase 04: No regex crate in Cargo.lock/dependencies and the spec fixes the dependency list -> redact() uses hand-written anchored matchers (PEM, token prefixes, JWT, keyword=value, email with greedy-then-backtrack domain matching) that mirror the specified regexes
- Phase 04: Spec orders orphan-tool dropping (3) before leading/trailing trimming (4), but a tool result can survive trimming while its tool call is trimmed away -> orphan filtering runs after trimming, in order, so only calls kept in the record count as issued
- Phase 04: Spec does not say whether redaction or truncation of tool output comes first -> redact first, then truncate, so a secret can never be left half-cut and unredacted
- Phase 04: Keyword rule value is \S+, so redacting tool-call arguments JSON can swallow closing quotes (e.g. password=abc"} ) -> kept as specified, since redaction is defined on the stored arguments string
- Phase 06: No SHA-256 crate in the dependency set -> small self-contained SHA-256 module (src/sha256.rs) with a unit test on the standard test vectors
- Phase 06: install-hook must keep the key order of existing settings -> enabled serde_json "preserve_order" (indexmap was already in the local registry)
- Phase 06: Cache format is free -> single <out>/cache/index.json keyed by canonical source path, holding size, SHA-256 and the parsed sessions; this lets hook add or replace a session and keep all others
- Phase 06: First gate run failed in my own sha256 unit test -> the expected digest I typed for the two-block vector was wrong; the implementation was right (matches the NIST value), so I fixed the test constant
- Phase 06: Spec says only sources whose file no longer exists are dropped -> cache entries outside the current sources (such as hooked transcripts) stay while their file exists and count as unchanged
- Phase 06: Hook must never fail or write on bad input -> all validation (stdin JSON, transcript_path, transcript parse) happens before anything is written, and the hook returns exit 0 with a "kb hook:" message
- Phase 06: review round 1: missing panic guard on must-never-fail path -> fixed
- Phase 07: `@types/node` was missing, so `vite.config.ts` could not use `node:fs` types -> added it as a devDependency and type-checked the config separately, because the project tsconfig only covers src and tests
- Phase 07: Spec leaves a malformed link (non-string or non-`{id}` endpoint) undefined -> chose `GraphError("Invalid graph: ...")`; links that merely point at unknown nodes are dropped
- Phase 07: Spec says `nodeDetails` groups are "sorted by label" without a case rule -> used the same lower-cased label, then id, as `searchNodes`
- Phase 07: 3d-force-graph replaces link endpoint strings with node objects at render time -> `main.ts` passes copies of the data on every filter change; all pure functions accept both forms through `linkEnd`
- Phase 07: review round 1: HTML injection (XSS) through unescaped untrusted text -> fixed (escaped hover labels, blanked default link label)
- Phase 07: Filtering left the highlight and details panel stale for a still-visible selected node -> re-run `select` after `applyFilters`
- Phase 07: Dev server 404/500 bodies leaked the home path -> generic bodies, detail logged server-side only
- Phase 07: Search results were not refreshed after loading a new graph, and re-picking the same file did not fire `change` -> call `renderResults()` in `setGraph` and clear `filePicker.value`
- Phase 07: Camera distance divided by a zero length when a node sat at the origin -> `Math.hypot(x, y, z) || 1`

## High-risk files changed

- `core/src/install.rs`
