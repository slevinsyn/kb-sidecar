# Graph insights, part 1 - clean topics and `kb context` - Knowledge base article

Waddaya Solutions Private Limited · KBA · 2026-11-01-graph-insights

| Field | Value |
|---|---|
| Article ID | KBA-2026-11-01-graph-insights |
| Type | How-to (it explains how topics are cleaned and how to use the new `kb context` command) |
| Version | 1.0 |
| Date | 2026-11-02 |
| Status | Complete |
| Risk level | High - 2 people approve the merge |
| Phases | 2 of 2 |
| Commits | e0c156e, 9ea9520 |

## Summary in plain words
The knowledge base reads past conversations and builds a graph (a map of sessions, topics, files and projects). That graph had too many noise topics, such as "number", "evening", "goal" and "say". It also split "proposal" and "proposals" into two topics. This change adds a cleaner topic step and makes `kb ingest` use it. It also adds a new command, `kb context "<query>"`. The command prints a short Markdown block of the best-matching past sessions, so an assistant does not have to read whole transcripts. Everything runs on this computer and nothing is sent anywhere. We know it works because the new tests failed first, then passed. The automatic check (the gate) passed twice for each phase, and the final review round passed for both phases.

## When to use this article (trigger)
- You need to know why topics now look different after `kb ingest`.
- You want to pull past context about a subject with `kb context`.
- You are changing the topic word lists or the `kb context` scoring and want to know the traps we hit.
- You need to undo this change (see "How to undo").

Expected behaviour, from change.md:
- "proposals" and "proposal" PDFs give one topic, `proposal`.
- Words like number, say, evening, morning, today and goal never become topics.
- `kb context "proposal app"` prints at most 4,000 characters by default.
- No match prints `No sessions match "proposal app".` and exits 0.
- A missing graph.json gives a clear error and exits 1.
- No query prints the usage and exits 2.

## Prerequisites and access
- A checkout of the kb-sidecar repository (branch `build/conversation-kb` was used).
- Commands from the project:
  - Rust tests: `cargo test --quiet`
  - Rust lint: `cargo clippy --quiet -- -D warnings`
  - Explorer tests: `npx vitest run --exclude 'tests/holdout/**'` (run in the `explorer` folder)
  - Explorer type check: `npx tsc --noEmit`
- `kb context` reads `<out>/graph/graph.json`. It uses the same `--out` / `KB_HOME` default as ingest. Run `kb ingest` first so this file exists.
- This change reads private conversation data (titles, topics, file paths). Keep the output on this computer.
- Approval: 2 people approve the merge (risk is High).

## Procedure
| # | Time | What we did | Why | Evidence / screenshot |
|---|---|---|---|---|
| 1 | 2026-11-01 23:41 | Wrote the plan for this change (two phases, 08 and 09). | Split the work: fix the data first, then add the command. | Plan event recorded. |
| 2 | 2026-11-01 23:49 | Plan approved for phases 08 and 09. | Work may only start after approval. | Approval event recorded. |
| 3 | 2026-11-01 23:59 | Phase 08 "Clean topics" started. Spec approved (AC-08-01 to AC-08-09, pre-approved). 3 test files moved in. | The acceptance criteria (AC) are the checklist the tests prove. | Spec approved, 3 test files. |
| 4 | 2026-11-02 00:00 | Phase 08 tests run before any code and failed (red). | Proves the tests really check the new behaviour. | "error: test failed, to rerun pass `--test holdout`". Explorer side: 49 passed, 9 hidden passed. |
| 5 | 2026-11-02 00:01 | Phase 08 built. Gate passed. Review round 1 prepared. | Gate checks tests and lint before review. | Gate: PASS at 00:01. |
| 6 | 2026-11-02 00:02 | Phase 08 review round 1: FAIL, 1 Important finding. | The reviewer found tech terms were mangled. | See error E1. |
| 7 | 2026-11-02 00:03 | Fix made. Gate passed again (00:03). Review round 2: PASS, 0 Important. | Confirm the fix. | Gate: PASS. Review: PASS. |
| 8 | 2026-11-02 00:04 | Phase 08 committed as `e0c156e`. | Save the phase. | Commit "Phase 08: Clean topics". |
| 9 | 2026-11-02 00:04 | Phase 09 "`kb context`" started. Spec approved (AC-09-01 to AC-09-09, pre-approved). 2 test files moved in. | Same flow as phase 08. | Spec approved, 2 test files. |
| 10 | 2026-11-02 00:04 | Phase 09 tests run before any code and failed (red). | Prove the tests check the new command. | "error: test failed, to rerun pass `--test phase09_context`". Explorer side: 49 passed, 9 hidden passed. |
| 11 | 2026-11-02 00:05 | Phase 09 built. Gate passed (00:05). Review round 1 prepared. | Same as step 5. | Gate: PASS. |
| 12 | 2026-11-02 00:06 | Phase 09 review round 1: FAIL, 1 Important finding. | Topic matching used different word forms. | See error E5. |
| 13 | 2026-11-02 00:07 | Fix made. Gate passed (00:07). Review round 2 at 00:08: PASS, 0 Important. | Confirm the fix. | Gate: PASS. Review: PASS. |
| 14 | 2026-11-02 00:08 | Phase 09 committed as `9ea9520`. Final report written. | Save the phase and summarise. | Commit "Phase 09: `kb context` - token-light context for assistants (GraphRAG)". |

No screenshots are recorded for this change.

What phase 08 does: adds new "clean" topic functions next to the old ones (the old ones stay as they are, because their tests are locked). The clean step adds more stop words (see "Words explained"), merges plurals, prefers technology terms, and drops generic words. With 10 or more sessions, a term in more than 40% of them is not a topic. Ingest now uses the clean functions.

## Errors and how they were solved
| # | Time | What went wrong | Cause | How it was solved | How to avoid it next time |
|---|---|---|---|---|---|
| E1 | 2026-11-02 00:02 | Phase 08 review round 1 FAIL (1 Important). Tech terms such as kubernetes and postgres lost their 1.5 boost and topic names were misspelt. | `normalize_term` stripped the trailing "s" before the lookup in the tech terms list. | `tokenize_clean` now returns tech terms unchanged and skips normalising. No new test was added because the spec and tests are locked. | Look up tech terms before any plural clean-up. |
| E2 | Phase 08, time not recorded | Risk that ordinary words (meeting, deployment, reviewer, query, invoice, partition, server) would be dropped. | The extra stop word list could grow too large. | The extra stop word list holds exactly the spec's word list and nothing more. | Keep the list equal to the spec. |
| E3 | Phase 08, time not recorded | Risk that a stop word slips through as a plural (goals, indexes, tries). | Plurals change the word form. | `tokenize_clean` checks both the original token and its normalised form against the stop word lists. | Always test both forms. |
| E4 | Phase 08, time not recorded | One finding in phase 08 is marked "preexisting" (1). | Details not recorded. | Not recorded. | Not recorded. |
| E5 | 2026-11-02 00:06 | Phase 09 review round 1 FAIL (1 Important). Topic matching lost the topic score, and a topic was listed as related to itself (kubernetes vs kubernete). | Stored topics were always normalised, but query terms kept tech terms as typed. | One helper, `topic_matches_term` (lowercase or normalised form), is used in scoring and in the related-topics exclusion. No new test was added because the spec and tests are locked. | Compare both sides in the same word form. |
| E6 | Phase 09, time not recorded | Truncated output could break the 4,000 limit or cut a line. | Bytes and characters differ. | Count with `chars().count()` and split on `split_inclusive('\n')`. Whole lines are kept and the "... [truncated]" marker fits inside max_chars. | Count characters, not bytes. |
| E7 | Phase 09, time not recorded | A query word could look like a flag, and flag values could become query words. | Command line parsing is ambiguous. | Any argument starting with "-" (other than a lone "-") is a flag. Unknown flags exit 2. Flag values are consumed with their flag. Usage errors are checked before graph.json is read. | Check usage before reading files. |
| E8 | Phase 09, time not recorded | A session with duplicate or plural topics (proposal and proposals) could score 3 twice or be counted twice in related topics. | Duplicates were not merged. | Topic matches go into a set of normalised forms. Related-topic and file counts are per session. | Deduplicate before scoring. |

Retests: 0 in both phases. Failed gate attempts: none (all four gate attempts passed).

## Verification
- Tests that failed first: phase 08 (3 test files) and phase 09 (2 test files) were run before the code and failed. After the build, the gate passed.
- Gate passes: phase 08 at 2026-11-02 00:01 and 00:03; phase 09 at 00:05 and 00:07.
- Review: both phases failed round 1 with 1 Important finding each. Both passed round 2 with 0 Important findings.
- Explorer side, at the failing-first run: 49 tests passed and 9 hidden tests passed.
- Each phase took 4.3 minutes (recorded).
- Number of passing Rust tests after the build: not recorded.

## How to undo
Revert the phase commits (`9ea9520` and `e0c156e`), then re-run `kb ingest`. This regenerates graph.json and the notes with the old topics.

## Words explained
| Word | Meaning in plain English |
|---|---|
| Knowledge base (KB) | The tool that stores notes about past conversations. |
| Graph / graph.json | A map file of sessions, topics, files and projects, and how they link. |
| Session | One past conversation. |
| Topic | A key word or theme taken from a session. |
| Ingest (`kb ingest`) | The command that reads conversations and rebuilds the graph and notes. |
| Stop word | A common or noise word (like "say") that is never used as a topic. |
| Plural merging | Treating "proposals" and "proposal" as one topic. |
| Tech terms (TECH_TERMS) | A list of technology words (such as kubernetes, postgres) that get a 1.5 score boost. |
| Normalise | Reduce a word to a standard form, for example by removing a trailing "s". |
| `kb context` | New command that prints a short Markdown summary of matching sessions. |
| GraphRAG | Using the graph to find relevant context for an assistant. |
| Markdown | Simple text format with headings and lists. |
| Phase | One numbered slice of the work (08 and 09 here). |
| Acceptance criteria (AC) | Numbered checks that say what "done" means, such as AC-08-01. |
| Spec | The written description of what a phase must do. |
| Locked tests | Tests that must not be edited. |
| Hidden test | A test whose details are not shown to the builder. |
| Failing first (red) | Running new tests before the code exists, to prove they fail. |
| Gate | The automatic check (tests and lint) that must pass before review. |
| Lint (clippy) | A tool that flags risky or untidy code. |
| Review round | One pass by a reviewer. A FAIL means fixes are needed. |
| Important finding | A review problem serious enough to fail the round. |
| Pre-existing | A problem that was already there before this change. |
| Commit | A saved snapshot of the code with a message. |
| Revert | Undo a commit by adding a commit that reverses it. |
| Flag | A command option that starts with "-". |
| Exit code | A number a command returns: 0 is success, 1 is an error, 2 is a usage error. |
| Truncate | Cut text short to fit a limit. |
| Risk level (High) | Shows how much care is needed. High here means 2 approvals. |
