# Phase 08: Clean topics

## Intent
Topics today are full of noise words (number, evening, goal, say) and split plurals
(proposal / proposals). Add a cleaner topic pipeline next to the existing one and make ingest
use it, so graph.json and the session notes carry meaningful topics: merged plurals, more stop
words, technology terms preferred and words that appear in almost every session dropped.

## Complexity
M - text normalisation rules with edge cases plus wiring into ingest; the TF-IDF maths exists.

## Scope
- In scope: new items in `core/src/topics.rs` (`EXTRA_STOP_WORDS`, `TECH_TERMS`,
  `normalize_term`, `tokenize_clean`, `extract_topics_clean`); `core/src/store.rs` `publish`
  calls `extract_topics_clean` instead of `extract_topics`.
- Out of scope: changing `STOP_WORDS`, `tokenize` or `extract_topics` (they keep their current
  behaviour and tests); stemming beyond plurals; any LLM.

## Interface contract
Tests in `core/tests/phase08_topics.rs` (unit, `use kb_core::topics::*`) and, for the ingest
check, by running the `kb` binary (`env!("CARGO_BIN_EXE_kb")`) on a temporary `--claude-dir`
fixture built the same way as `core/tests/phase06_cli.rs` does, with `--out <tmp>`.

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `EXTRA_STOP_WORDS` | `kb_core::topics` | `pub const EXTRA_STOP_WORDS: &[&str]` - lowercase; must include at least: number, say, said, evening, morning, afternoon, night, today, tomorrow, yesterday, week, month, year, time, goal, focus, active, primary, pending, recap, home, date, index, ins, candidate, thing, something, think, know, look, sure, right, good, great, well, really, still, going, work, using, used, new, first, last, next, back, start, give, take, keep, try, show, tell, ask, help, run, set, check, add, change, update | - |
| `TECH_TERMS` | `kb_core::topics` | `pub const TECH_TERMS: &[&str]` - lowercase, already in normalised (singular) form; must include at least: rust, cargo, typescript, javascript, python, react, vite, node, npm, docker, kubernetes, aws, lambda, sap, abap, hana, fiori, sql, postgres, sqlite, redis, graphql, api, json, yaml, git, github, mcp, claude, llm, pdf, html, css, vitest, terraform, cdk | - |
| `normalize_term` | `kb_core::topics` | `pub fn normalize_term(t: &str) -> String` | - |
| `tokenize_clean` | `kb_core::topics` | `pub fn tokenize_clean(text: &str) -> Vec<String>` | - |
| `extract_topics_clean` | `kb_core::topics` | `pub fn extract_topics_clean(docs: &[String], k: usize) -> Vec<Vec<String>>` | - |

## Behaviour
1. `normalize_term(t)` (input is a lowercase token), first matching rule wins:
   - length <= 4 -> unchanged (`aws`, `data`, `bus`, `ios`);
   - ends with `ss`, `us`, `is` or `os` -> unchanged (`class`, `status`, `analysis`, `macos`);
   - ends with `ies` -> drop `ies`, add `y` (`queries` -> `query`, `entries` -> `entry`);
   - ends with `sses` -> drop the final `es` (`classes` -> `class`);
   - ends with `ches`, `shes` or `xes` -> drop `es` (`patches` -> `patch`, `boxes` -> `box`);
   - ends with `s` -> drop `s` (`proposals` -> `proposal`, `notes` -> `note`, `files` -> `file`);
   - otherwise unchanged.
2. `tokenize_clean(text)`: take `tokenize(text)` (phase 03 rules), map each token through
   `normalize_term`, and drop a token when the original token or its normalised form is in
   `STOP_WORDS` or `EXTRA_STOP_WORDS`, or when the normalised form is shorter than 3
   characters. Order preserved, duplicates kept. Result is lowercase normalised terms.
3. `extract_topics_clean(docs, k)`: one vector per doc, same order. Tokens come from
   `tokenize_clean`. `N` = number of docs, `df(t)` = number of docs containing t.
   - When `N >= 10`, a term with `df(t) / N > 0.4` is never a topic (too generic).
   - Score = `tf * idf * boost`, with `tf = count(t,d) / tokens(d)`,
     `idf = ln((1 + N) / (1 + df(t))) + 1`, `boost = 1.5` when t is in `TECH_TERMS`, else 1.
     (`tokens(d)` counts all clean tokens of d, including too-generic ones.)
   - Top `k` terms by score descending, ties by term ascending. Empty doc or `k == 0` -> empty
     vector. Same input -> same output.
4. `publish` (ingest and hook) uses `extract_topics_clean(&docs, 8)`; graph.json topic nodes
   (`topic:<term>`), session `meta.topics` and the session note `topics:` line all carry the
   clean terms.
5. `STOP_WORDS`, `tokenize` and `extract_topics` are unchanged.

## Acceptance criteria
- AC-08-01: `normalize_term` follows every rule in Behaviour 1, including the short-word and `ss/us/is/os` exceptions.
- AC-08-02: `tokenize_clean("Proposals and PROPOSAL notes this evening")` returns `["proposal", "proposal", "note"]`.
- AC-08-03: Every word in `EXTRA_STOP_WORDS` and `STOP_WORDS` (and its plural `<word>s`) is dropped by `tokenize_clean`; both lists are lowercase.
- AC-08-04: `extract_topics_clean` merges plural and singular counts into one topic: a doc with "proposal proposals proposals invoice" has `proposal` as its first topic.
- AC-08-05: With 10 or more docs, a term present in more than 40% of them never appears as a topic; with fewer than 10 docs no term is excluded for frequency.
- AC-08-06: At equal frequency in a doc, a `TECH_TERMS` term ranks above a non-tech term with the same document frequency.
- AC-08-07: `extract_topics_clean` returns at most k terms per doc, an empty vector for an empty doc or k = 0, ties alphabetical, deterministic.
- AC-08-08: `kb ingest` on a fixture whose sessions say "proposals" and "evening" writes graph.json with a `topic:proposal` node and no `topic:proposals` or `topic:evening` node.
- AC-08-09: The phase 03 functions keep their behaviour (existing phase 03 tests stay green).

## External systems to mock
- None (pure functions; the CLI test uses a temporary folder fixture).

## Dependencies on earlier phases
- Phase 03: `tokenize`, `STOP_WORDS`, TF-IDF definition.
- Phase 06: `kb ingest`, `--claude-dir`, `--out`, output layout `<out>/graph/graph.json`.
