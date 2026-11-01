# Phase 06: `kb` command - incremental ingest, SessionEnd hook, hook installer

## Intent
One command that does all three things for every conversation: writes session nodes, the
training dataset and the graph. It is incremental (only changed transcripts are re-read), can run
automatically at the end of every Claude Code session through a SessionEnd hook, and can install
that hook into a settings file without touching other settings.

## Complexity
M - file-system orchestration, caching, idempotency and a safe JSON settings edit.

## Scope
- In scope: binary `kb` with sub-commands `ingest`, `hook`, `install-hook`; output layout;
  incremental cache; stale node cleanup.
- Out of scope: the explorer (phase 07); installing into the real `~/.claude/settings.json`.

## Interface contract
Binary target `kb` (`core/src/main.rs`). Tests in `core/tests/phase06_cli.rs` run it with
`std::process::Command::new(env!("CARGO_BIN_EXE_kb"))`, always passing `--out` and setting
`HOME` to a temp dir and removing `KB_HOME`. Dev-dependencies available: `tempfile = "3"`,
`serde_json = "1"`.

| Item | Location | Signature or shape | Errors |
|---|---|---|---|
| `kb ingest` | CLI | `kb ingest [--claude-dir <dir>] [--claude-ai <path>]... [--out <dir>] [--no-redact]` | exit 1 if `--out` cannot be created/written; exit 2 on bad arguments |
| `kb hook` | CLI | `kb hook [--out <dir>] [--no-redact]`, reads one JSON object from stdin | never fails: always exit 0 |
| `kb install-hook` | CLI | `kb install-hook --settings <file> [--command <cmd>]` | exit 1 on invalid JSON (file untouched); exit 2 on bad arguments |
| output: nodes | `<out>/nodes/<node_file_name>.md` | one `render_node` file per session | - |
| output: dataset | `<out>/dataset/conversations.jsonl` | `to_jsonl` of all records, sessions sorted by id | - |
| output: graph | `<out>/graph/graph.json` | `Graph::to_json` of all sessions | - |
| internal cache | `<out>/cache/` | implementation-defined; tests must not depend on its format | - |

## Behaviour
### Defaults
1. `--out` default: `$KB_HOME` if set, else `$HOME/claude-kb`. `--claude-dir` default:
   `$HOME/.claude/projects` (silently skipped if it does not exist). No `--claude-ai` by default.

### ingest
2. Sources = `claude_code::discover(claude_dir)` files plus each `--claude-ai` path
   (`claude_ai::parse_export`).
3. A source file whose size and SHA-256 are unchanged since the last run is not re-parsed; its
   sessions come from the cache. Changed or new files are parsed. Sessions from source files that
   no longer exist are removed from the knowledge base.
4. Transcript files that fail with `KbError::Empty` or an I/O/parse error are counted as skipped,
   reported on stderr as `skipped <path>: <reason>`, and do not stop the run.
5. Topics are recomputed over all sessions every run: `extract_topics` with k = 8 over
   `session_text` of each session (sessions sorted by id).
6. Writes nodes, dataset (with `DatasetOptions::default()`, or `redact: false` with
   `--no-redact`) and graph. Node files that are no longer produced (renamed title, removed
   source) are deleted from `<out>/nodes/`; other files there that do not end in `.md` are left
   alone. Files are only rewritten when their content changes.
7. Prints exactly one summary line to stdout:
   `ingested: <new> new, <updated> updated, <unchanged> unchanged, <skipped> skipped` where
   new = sessions whose id was not in the knowledge base before, updated = existing sessions
   re-parsed from a changed file, unchanged = sessions taken from the cache, skipped = source
   files that produced no session. Exit 0.
8. Running `ingest` twice with no source changes prints `0 new, 0 updated, <n> unchanged` and
   leaves every output file byte-identical.

### hook
9. Reads stdin JSON like
   `{"session_id":"s1","transcript_path":"/…/s1.jsonl","cwd":"/…","hook_event_name":"SessionEnd","reason":"exit"}`.
   It parses `transcript_path`, adds or replaces that session in the knowledge base at `--out`
   (keeping all previously ingested sessions from the cache), recomputes topics and rewrites
   nodes, dataset and graph as in ingest. It does not scan `--claude-dir`.
10. Invalid stdin, a missing `transcript_path`, or a transcript that fails to parse -> message on
    stderr starting with `kb hook:`, nothing written, exit 0. Success prints the summary line.

### install-hook
11. Default `--command` = `"<absolute path of the running kb executable> hook"`.
12. Missing settings file -> created containing
    `{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"<cmd>"}]}]}}`.
13. Existing file: parsed as JSON; every existing key and value is kept (key order preserved);
    an entry `{"hooks":[{"type":"command","command":"<cmd>"}]}` is appended to
    `hooks.SessionEnd` (created if missing). If any existing `hooks.SessionEnd[*].hooks[*]` has
    `command` equal to `<cmd>`, nothing is written and stdout says `already installed`;
    otherwise stdout says `installed`. Written as pretty JSON (2-space indent) with a trailing
    newline. Exit 0.
14. Invalid JSON, or `hooks` / `hooks.SessionEnd` of the wrong JSON type -> stderr message,
    exit 1, file unchanged.

## Acceptance criteria
- AC-06-01: `kb ingest --claude-dir <fixture> --out <tmp>` on two valid transcripts in two projects writes two node files, a dataset with two lines and a graph.json containing both session nodes and both project nodes; prints `ingested: 2 new, 0 updated, 0 unchanged, 0 skipped`.
- AC-06-02: A second identical run prints `ingested: 0 new, 0 updated, 2 unchanged, 0 skipped` and all output files are byte-identical.
- AC-06-03: Appending a message to one transcript makes the next run report `1 updated, 1 unchanged`, and the new text appears in that node and the dataset.
- AC-06-04: Changing a transcript's custom-title removes the old node file and writes the new one; deleting a transcript removes its node, dataset line and graph node.
- AC-06-05: An empty or garbage transcript is counted as skipped, reported on stderr, and the run still exits 0 with the other sessions written.
- AC-06-06: `--claude-ai <conversations.json>` adds claude.ai sessions alongside Claude Code ones.
- AC-06-07: The dataset is redacted by default (an email in a prompt becomes `[EMAIL]`) and not with `--no-redact`.
- AC-06-08: `kb hook --out <tmp>` with SessionEnd JSON on stdin adds that session's node, dataset line and graph node while keeping previously ingested sessions.
- AC-06-09: `kb hook` with invalid stdin or a missing transcript exits 0, writes nothing and prints a `kb hook:` message on stderr.
- AC-06-10: `kb install-hook --settings <file> --command "kb hook"` on a settings file with other keys and other hooks keeps them all and adds the SessionEnd entry; a second run prints `already installed` and leaves the file byte-identical.
- AC-06-11: `install-hook` on a missing file creates it with only the SessionEnd hook; on invalid JSON exits 1 and leaves the file unchanged.

## External systems to mock
- File system: fixtures in `tempfile::TempDir`. Never touch the real `~/.claude` or `~/claude-kb`:
  always pass `--out`, `--claude-dir` (or a non-existent dir) and set `HOME` to the temp dir.
- stdin for `kb hook`: pipe JSON via `Stdio::piped()`.

## Dependencies on earlier phases
- Phases 01-05 (parsers, topics, nodes, dataset, graph).
