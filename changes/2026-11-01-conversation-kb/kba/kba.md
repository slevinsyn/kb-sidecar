# Conversation knowledge base (session nodes, training dataset, 3D graph) - Knowledge base article

Waddaya Solutions Private Limited · KBA · 2026-11-01-conversation-kb

| Field | Value |
|---|---|
| Article ID | KBA-2026-11-01-conversation-kb |
| Type | Runbook - it records how the `kb` tool was built, phase by phase, and how to run, check and undo it |
| Version | 1.0 |
| Date | 2026-11-01 |
| Status | Complete |
| Risk level | High - 2 people approve the merge |
| Phases | 7 of 7 |
| Commits | 60ffef4201, 09e9496d93, c38e8c0e4c, 492606be3f, 4bb96b7e8a, bcfb5f9081, b56b27d900 |

All times are 2026-11-01 in the +05:30 time zone, as recorded.

## Summary in plain words
Our conversations with Claude (Claude Code sessions and claude.ai chats) sat in raw log files that nobody could browse, search or reuse. We built a tool called `kb` that reads those conversations. For each one it writes a readable Markdown "node" file, adds a line to a training dataset (OpenAI chat format, with secrets and email addresses hidden), and adds the conversation to a graph file. A small web app, the "explorer", shows that graph in 3D. The work was done in 7 phases (small steps), each with tests written first, a quality check (gate), a code review and its own commit. All 7 phases finished and passed their gate and review. Everything stays on the local computer and nothing is sent anywhere.

## When to use this article (trigger)
- You need to understand how the conversation knowledge base was built, or why a design choice was made.
- You are changing the parser, nodes, dataset, graph, `kb` command or explorer and need the history and known pitfalls.
- You need to undo the change (see "How to undo").
- You are reviewing the merge. The risk is High because the tool reads private conversations and can write a Claude Code settings file.

## Prerequisites and access
- Rust toolchain (`cargo`) for the core in `core/`.
- Node.js (`npx`, `npm`) for the explorer in `explorer/`.
- Commands recorded for this change:
  - Core tests: `cargo test --quiet`
  - Core lint: `cargo clippy --quiet -- -D warnings`
  - Explorer tests: `npx vitest run --exclude 'tests/holdout/**'`
  - Explorer type check: `npx tsc --noEmit`
  - Explorer run: `npm run dev` in `explorer/`
- Output goes to `$KB_HOME`, otherwise `~/claude-kb`.
- Read access to `~/.claude/projects/<project>/<session>.jsonl`. A claude.ai export can be a folder, `conversations.json` or a `.zip`.
- To install the hook, run `kb install-hook --settings <file>` yourself. This change did not touch the real `~/.claude/settings.json`.
- Approval: 2 people approve the merge. High-risk file: `core/src/install.rs`.
- Base commit before the change: 97877cff28daa93eb258682c5d2d65b7515d3da0.

## Procedure
Reviews without a round number ran before the build (a review of the tests). "NO VERDICT" means the reviewer gave no usable result.

| # | Time | What we did | Why | Evidence / screenshot |
|---|---|---|---|---|
| 1 | 2026-11-01 15:51 | Wrote the plan (7 phases) | Agree scope before coding | change folder created |
| 2 | 2026-11-01 15:59 | Plan approved for phases 01-07 | Needed before any phase starts | approve-plan event |
| 3 | 2026-11-01 16:10 | Phase 01 started; spec approved (AC-01-01 to AC-01-12) | Define "done" for the Claude Code parser | spec pre-approved |
| 4 | 2026-11-01 16:15 - 17:29 | Phase 01 test reviews: three NO VERDICT, then PASS at 17:29 | Check the tests before building | final verdict PASS |
| 5 | 2026-11-01 18:19 | Phase 01 tests proven to fail first (1 test file) | Shows the tests really test something | "error: test failed, to rerun pass `--test phase01_claude_code`" |
| 6 | 2026-11-01 18:20 - 18:21 | Phase 01 gate PASS (18:20:18); review round 1 | Check the finished code | PASS, 0 Important findings |
| 7 | 2026-11-01 18:26 | Phase 01 test file re-locked (user approved), then committed | Locked test file had changed (see Errors #4) | commit 60ffef4201 |
| 8 | 2026-11-01 18:26 | Phase 02 started; spec approved (AC-02-01 to AC-02-06) | claude.ai export parser (folder, json, zip) | spec pre-approved |
| 9 | 2026-11-01 18:27 - 18:37 | Phase 02 test reviews: NO VERDICT, then PASS | Check the tests | PASS |
| 10 | 2026-11-01 18:37 | Phase 02 tests failed first | Prove the tests work | "error: test failed, to rerun pass `--test phase02_claude_ai`" |
| 11 | 2026-11-01 18:38 - 18:39 | Phase 02 gate PASS (18:38:15); review round 1 | Check the code | PASS, 0 Important; commit 09e9496d93 |
| 12 | 2026-11-01 18:39 | Phase 03 started; spec approved (AC-03-01 to AC-03-10) | Topic keywords (TF-IDF) and Markdown nodes | spec pre-approved |
| 13 | 2026-11-01 18:45 - 20:28 | Phase 03 test reviews: three NO VERDICT, then PASS at 20:28 | Check the tests | PASS |
| 14 | 2026-11-01 20:28 | Phase 03 tests failed first | Prove the tests work | "error: test failed, to rerun pass `--test phase03_nodes`" |
| 15 | 2026-11-01 20:29 | Phase 03 gate: FAIL at 20:29:07, PASS at 20:29:18 | Quality check | see Errors #5 |
| 16 | 2026-11-01 20:30 | Phase 03 review round 1: FAIL, 2 Important findings | Reviewer found two bugs | see Errors #6, #7 |
| 17 | 2026-11-01 20:30 - 20:32 | Fixed; gate PASS (20:30:35); review round 2 PASS; commit c38e8c0e4c | Confirm fixes | PASS, 0 Important |
| 18 | 2026-11-01 20:32 | Phase 04 started; spec approved (AC-04-01 to AC-04-09) | Dataset records and redaction | spec pre-approved |
| 19 | 2026-11-01 20:35 - 20:37 | Phase 04 test review PASS; tests failed first | Check and prove the tests | "error: test failed, to rerun pass `--test phase04_dataset`" |
| 20 | 2026-11-01 20:37 - 20:41 | Phase 04 gate PASS (20:37:46); review round 1 PASS, 0 Important; commit 492606be3f | Check the code | PASS |
| 21 | 2026-11-01 20:41 | Phase 05 started; spec approved (AC-05-01 to AC-05-07) | Graph builder (`graph.json`) | spec pre-approved |
| 22 | 2026-11-01 20:43 - 20:45 | Phase 05 test review PASS; tests failed first; gate PASS (20:44:14); review round 1 PASS, 0 Important; commit 4bb96b7e8a | Build and check the graph | "error: test failed, to rerun pass `--test phase05_graph`" |
| 23 | 2026-11-01 20:45 | Phase 06 started; spec approved (AC-06-01 to AC-06-11) | `kb` command, hook and hook installer | spec pre-approved |
| 24 | 2026-11-01 20:51 - 20:52 | Phase 06 test review PASS; tests failed first | Check and prove the tests | "error: test failed, to rerun pass `--test phase06_cli`" |
| 25 | 2026-11-01 20:54 | Phase 06 gate: FAIL at 20:54:24, PASS at 20:54:41 | Quality check | see Errors #14 |
| 26 | 2026-11-01 20:57 | Phase 06 review round 1: FAIL, 1 Important finding | Reviewer found a missing safety guard | see Errors #15 |
| 27 | 2026-11-01 20:57 - 20:59 | Fixed; gate PASS (20:57:51); review round 2 PASS; commit bcfb5f9081 | Confirm fix | PASS, 0 Important |
| 28 | 2026-11-01 20:59 | Phase 07 started; spec approved (AC-07-01 to AC-07-08) | 3D explorer web app | spec pre-approved |
| 29 | 2026-11-01 21:02 | Phase 07 test review PASS; tests failed first (2 test files) | Check and prove the tests | "expected 1 to be 5" (colours test); hidden tests "9 failed (9)" |
| 30 | 2026-11-01 21:04 - 21:06 | Phase 07 gate PASS (21:04:26); review round 1 FAIL, 1 Important finding | Reviewer found an XSS bug | see Errors #20 |
| 31 | 2026-11-01 21:07 - 21:08 | Fixed; gate PASS (21:07:16); review round 2 PASS; commit b56b27d900 | Confirm fix | PASS, 0 Important |
| 32 | 2026-11-01 21:08 | Report written | Close the change | report event |

No screenshots were recorded for any phase.

## Errors and how they were solved
Gate and review times are recorded. Where a time is "not recorded", the problem is listed under its phase.

| # | Time | What went wrong | Cause | How it was solved | How to avoid it next time |
|---|---|---|---|---|---|
| 1 | Phase 01, not recorded | AC-01-05 test failed: a message dropped for having only empty thinking still added its model | Models were collected per record, not per message | Models are tracked per message and counted only if the message survives filtering | Track data at the same level you filter it |
| 2 | Phase 01, not recorded | Spec silent on whether sidechain, meta or synthetic records can supply sessionId, cwd, gitBranch | Gap in the spec | Treated them as fully ignored | Ask for the spec to cover this edge case |
| 3 | Phase 01, not recorded | Spec silent on an unclosed system-reminder tag | Gap in the spec | Left the text unchanged (not a complete span) | Same as above |
| 4 | Phase 01, before 18:26 | Locked test file changed after locking | Not recorded ("cause unknown") | User approved re-locking the current file | Find out why a locked file changes before re-locking |
| 5 | Phase 02, not recorded | A single shell command editing several files was blocked by the lock hook (it flagged a protected path passed through variables) | Lock hook guards protected paths | Redid the edits with separate Write/Edit calls | Edit files one at a time |
| 6 | Phase 02, not recorded | Locked tests build their own zip files, so the zip dev-dependency was not used | Test design | Added `zip` only as a library dependency (v2, default features off, deflate on) so real claude.ai exports can be read | Keep dependencies limited to what the code needs |
| 7 | 2026-11-01 20:29 | Phase 03 gate FAIL at 20:29:07 (check "tests pass 2x in a row (+ hidden tests)") | Not recorded beyond the gate message | Passed on the next run at 20:29:18 | Cause not recorded |
| 8 | 2026-11-01 20:30 | Review round 1 Important finding: output did not end in exactly one newline | Missing input normalisation | Fixed; round 2 PASS | Normalise output endings and test for them |
| 9 | 2026-11-01 20:30 | Review round 1 Important finding: path traversal through an unvalidated date in a file name | Date used in a file name without checking | Fixed; round 2 PASS | Validate any text that becomes part of a file path |
| 10 | Phase 03, not recorded | Test review verdict was not recorded by the hook | Reviewer reports through a handback block | Recorded with `review-verdict` after the parser was patched | Check the verdict is in the log after each review |
| 11 | Phase 04, not recorded | No regex crate and the spec fixes the dependency list | Dependency limit | `redact()` uses hand-written matchers (PEM, token prefixes, JWT, keyword=value, email) that mirror the specified regexes | Check the dependency list early |
| 12 | Phase 04, not recorded | Spec order (drop orphan tool results, then trim) could leave a result whose call was trimmed away | Spec order conflict | Orphan filtering runs after trimming | Resolve ordering conflicts in the spec |
| 13 | Phase 04, not recorded | Spec silent on whether redaction or truncation comes first | Gap in the spec | Redact first, then truncate, so a secret is never left half-cut and unredacted | Always redact before cutting text |
| 14 | Phase 04, not recorded | Keyword rule value `\S+` can swallow closing quotes in tool-call argument JSON (for example `password=abc"}`) | Rule as specified | Kept as specified; redaction is defined on the stored arguments string | Known behaviour, not fixed |
| 15 | Phase 06, not recorded | No SHA-256 crate available | Dependency limit | Small own module `src/sha256.rs` with a unit test on standard test vectors | Check the dependency list early |
| 16 | Phase 06, not recorded | `install-hook` must keep the key order of existing settings | Default JSON handling reorders keys | Enabled serde_json `preserve_order` (indexmap was already in the local registry) | Keep user files in their original order |
| 17 | Phase 06, not recorded | Cache format and hooked transcripts needed a decision | Spec leaves cache format free; only deleted sources may be dropped | One `<out>/cache/index.json` keyed by canonical source path (size, SHA-256, parsed sessions); entries outside the current sources stay while their file exists | Document cache rules |
| 18 | 2026-11-01 20:54 | Phase 06 gate FAIL at 20:54:24 | The expected digest typed in the author's own sha256 unit test (two-block vector) was wrong; the code matched the NIST value | Fixed the test constant; gate PASS at 20:54:41 | Copy test vectors from the standard |
| 19 | Phase 06, not recorded | Hook must never fail or write on bad input | Hook runs inside Claude Code | All checks (stdin JSON, transcript_path, parse) happen before any write; the hook exits 0 with a "kb hook:" message | Validate first, write last |
| 20 | 2026-11-01 20:57 | Review round 1 Important finding: missing panic guard on a must-never-fail path | Hook could still crash on a panic | Fixed; round 2 PASS at 20:59 | Wrap must-never-fail code in a panic guard |
| 21 | Phase 07, not recorded | `@types/node` missing, so `vite.config.ts` could not use `node:fs` types | Missing dev dependency | Added it; type-checked the config separately because the project tsconfig only covers src and tests | Add types with the first Node import |
| 22 | Phase 07, not recorded | Spec leaves malformed links undefined | Gap in the spec | Throw `GraphError("Invalid graph: ...")`; links to unknown nodes are dropped | Ask for the spec to cover this edge case |
| 23 | Phase 07, not recorded | Spec has no case rule for "sorted by label" | Gap in the spec | Used the lower-cased label, then id, same as `searchNodes` | Same as above |
| 24 | Phase 07, not recorded | 3d-force-graph replaces link endpoint strings with node objects | Library behaviour | `main.ts` passes copies of the data on each filter change; pure functions accept both forms via `linkEnd` | Do not share data with libraries that change it |
| 25 | 2026-11-01 21:06 | Review round 1 Important finding: HTML injection (XSS) through unescaped untrusted text | Hover labels not escaped | Escaped hover labels and blanked the default link label; round 2 PASS at 21:08 | Escape all untrusted text shown as HTML |
| 26 | Phase 07, not recorded | Highlight and details panel stale for a still-visible selected node after filtering | Selection not refreshed | Re-run `select` after `applyFilters` | Refresh dependent views after a filter change |
| 27 | Phase 07, not recorded | Dev server 404/500 bodies leaked the home path | Detailed error text sent to the browser | Generic bodies; detail logged server-side only | Never return paths in error bodies |
| 28 | Phase 07, not recorded | Search results not refreshed after loading a new graph; re-picking the same file did not fire `change` | Missing refresh and file-picker reset | Call `renderResults()` in `setGraph` and clear `filePicker.value` | Test the load-twice case |
| 29 | Phase 07, not recorded | Camera distance divided by zero when a node sat at the origin | No guard | `Math.hypot(x, y, z) || 1` | Guard divisions by a length |

Phase 05 recorded no problems. No retests were recorded in any phase.

## Verification
- Tests failed first in every phase (the "red" step: phases 01-06 one test file each, phase 07 two). Phase 07 evidence: "expected 1 to be 5" and hidden tests "9 failed (9)".
- Every phase gate ended in PASS. Failed attempts: phase 03 (20:29:07) and phase 06 (20:54:24), both followed by a PASS.
- Final review verdicts: phases 01, 02, 04, 05 PASS in round 1; phases 03, 06, 07 FAIL in round 1 and PASS in round 2. Each final round had 0 Important findings.
- Pre-existing issues: 1 recorded in phase 01, none elsewhere.
- Bug types found by review: missing input normalisation, path traversal, missing panic guard, HTML injection (XSS).
- Re-run any time: `cargo test --quiet`, `cargo clippy --quiet -- -D warnings`, `npx vitest run --exclude 'tests/holdout/**'`, `npx tsc --noEmit`.
- Whether the tests pass at the final state outside the recorded gates: not recorded.

## How to undo
1. Revert the phase commits (60ffef4201, 09e9496d93, c38e8c0e4c, 492606be3f, 4bb96b7e8a, bcfb5f9081, b56b27d900).
2. Delete the output folder (`~/claude-kb` or `$KB_HOME`).
3. If the hook was installed, remove the `kb hook` entry under `hooks.SessionEnd` in the settings file.

## Words explained
| Word | Meaning in plain English |
|---|---|
| KBA | Knowledge base article: this document |
| Runbook | A step-by-step record of how to do or repeat a job |
| Session | One conversation (a Claude Code transcript or a claude.ai chat) |
| Transcript / jsonl | A log file with one JSON record per line |
| Node | A Markdown file that describes one session, with links to its project and topics |
| Frontmatter | A block of machine-readable data at the top of a Markdown file |
| Dataset | The file of training examples, one line per session |
| OpenAI chat format | A common layout of `user`, `assistant` and `tool` messages |
| Redaction | Replacing emails and secrets with `[EMAIL]` or `[SECRET]` |
| TF-IDF | An offline way to pick the words that best describe a session |
| Graph / `graph.json` | A file of nodes (session, project, topic, file, tool) and links between them |
| Explorer | The web app that shows the graph in 3D |
| SessionEnd hook | A command Claude Code runs when a session ends |
| Phase | One small, separately built and checked step of the plan |
| Acceptance criteria (AC) | Numbered rules a phase must meet, for example AC-01-05 |
| Spec | The written description of a phase and its criteria |
| Failing first ("red") | Tests are run before the code exists and must fail, to prove they test something |
| Locked test | A test file that cannot be changed during the build |
| Hidden test | A test the builder cannot see, used by the gate as an extra check |
| Gate | An automatic quality check (tests, run twice in a row, plus hidden tests) that must pass |
| Review round | One pass of a reviewer over the finished code |
| Important finding | A review problem that must be fixed before the phase passes |
| Verdict | The review result: PASS, FAIL or NO VERDICT |
| Commit | A saved, named snapshot of the code |
| Path traversal | A bug where crafted text makes a program reach files outside its folder |
| XSS / HTML injection | A bug where untrusted text is shown as web page code |
| Panic guard | Code that stops a crash from escaping and breaking the caller |
| SHA-256 | A way to turn a file into a short fingerprint, used to spot changed transcripts |
| Cache | Saved results used to skip work on unchanged files |
| Dev dependency | A tool used while building, not shipped |
| Lint (clippy) | An automatic check for code style and likely mistakes |
| Type check (tsc) | An automatic check of TypeScript types |
| Sidechain | Side conversation lines in a transcript that are ignored |
