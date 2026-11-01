# Phase 03: Topic keywords (TF-IDF) + Markdown session nodes

## Intent
Give every conversation a readable "node": a Markdown file with machine-readable frontmatter,
wiki links to its project and topics, and the full conversation. Topics are keywords computed
offline with TF-IDF across all sessions, so no LLM or network is needed.

## Complexity
M - TF-IDF and deterministic rendering with several formatting edge cases.

## Scope
- In scope: tokenizer, stop words, TF-IDF topic extraction, session text, slug, node file name,
  node rendering.
- Out of scope: writing files (phase 06).

## Interface contract
Tests in `core/tests/phase03_nodes.rs`. Dev-dependencies available: `serde_json = "1"`.

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `STOP_WORDS` | `kb_core::topics` | `pub const STOP_WORDS: &[&str]` - lowercase words; must include at least: the, and, for, that, this, with, you, are, was, but, not, have, can, will, just, what, from, use, file, code, make, need, want, like, yes, okay, please, thanks, let, now, here, there, also, would, should, could | - |
| `tokenize` | `kb_core::topics` | `pub fn tokenize(text: &str) -> Vec<String>` | - |
| `extract_topics` | `kb_core::topics` | `pub fn extract_topics(docs: &[String], k: usize) -> Vec<Vec<String>>` | - |
| `session_text` | `kb_core::topics` | `pub fn session_text(s: &kb_core::Session) -> String` | - |
| `slug` | `kb_core::node` | `pub fn slug(s: &str) -> String` | - |
| `node_file_name` | `kb_core::node` | `pub fn node_file_name(s: &kb_core::Session) -> String` | - |
| `render_node` | `kb_core::node` | `pub fn render_node(s: &kb_core::Session, topics: &[String]) -> String` | - |

## Behaviour
### Topics
1. `tokenize`: lowercase; split on every character that is not ASCII alphanumeric (so `_`, `-`,
   `.`, `/` split words); keep tokens of 3..=30 characters that are not all digits and are not
   in `STOP_WORDS`. Order preserved, duplicates kept.
2. `extract_topics(docs, k)`: returns one vector per doc (same order). For term t in doc d:
   `tf = count(t,d) / tokens(d)`, `idf = ln((1 + N) / (1 + df(t))) + 1` (N = number of docs,
   df = number of docs containing t), score = `tf * idf`. Returns the top `k` terms by score
   descending, ties broken by term ascending. A doc with no tokens gets an empty vector. Same
   input -> same output.
3. `session_text(s)` = all `Text` blocks of all messages (user and assistant, not thinking, not
   tool blocks) joined with `"\n"`, prefixed by the title and a `"\n"`.

### Node file
4. `slug(s)`: lowercase; every run of non-ASCII-alphanumeric characters becomes one `-`; leading
   and trailing `-` removed; cut to 60 characters then trailing `-` removed again; empty ->
   `"untitled"`. Example: `"Fix: Totals are rounded wrongly!"` -> `"fix-totals-are-rounded-wrongly"`.
5. `node_file_name(s)` = `"{date}-{slug(title)}-{id8}.md"` where date = first 10 chars of
   `started_at` (or `"undated"`), id8 = first 8 chars of `slug(id)`.
6. `render_node(s, topics)` output, exactly in this order:
   ```
   ---
   id: <json>
   source: <json>            ("claude-code" | "claude-ai")
   title: <json>
   project: <json>           (string or null)
   branch: <json>
   cwd: <json>
   started_at: <json>
   ended_at: <json>
   models: <json array>
   turns: <json number>      (turn_count)
   tools: <json array>       (tools_used)
   files: <json array>       (files_touched)
   prs: <json array>
   topics: <json array>      (the topics argument, in order)
   ---

   # <title>

   Project: [[project/<slug(project)>]]
   Topics: [[topic/<t1>]] · [[topic/<t2>]]
   Tools: <tool1>, <tool2>

   ## Conversation
   ```
   Every frontmatter value is compact `serde_json` output, so each line is `key: <valid JSON>`.
   The `Project:` line is omitted when project is None, `Topics:` when topics is empty, `Tools:`
   when no tools were used. Then for each message in order:
   - a heading `### User` or `### Assistant`, followed by ` · <timestamp>` when it has one;
   - each Text block as its own paragraph (raw text);
   - each Thinking block as `<details><summary>Thinking</summary>\n\n<text>\n\n</details>`;
   - each ToolUse as `**Tool call** \`<name>\`` followed by a fenced ` ```json ` block with the
     input pretty-printed;
   - each ToolResult as `**Tool result**` (plus ` (error)` when is_error) followed by a fenced
     block with the content; content longer than 2000 characters is cut to 2000 characters and
     `\n… [truncated <N> chars]` appended (N = number of characters removed).
   Fences around tool input/result use one more backtick than the longest run of backticks in
   the content (minimum 3). Blocks are separated by a blank line. Output ends with exactly one
   `\n`. Same input -> byte-identical output.

## Acceptance criteria
- AC-03-01: `tokenize` lowercases, splits on punctuation/underscores, drops stop words, short tokens and pure numbers.
- AC-03-02: For a corpus where one doc repeats "kubernetes" and "ingress" and others do not, those two terms are that doc's top topics; a term present in every doc ranks below a term unique to the doc at equal frequency.
- AC-03-03: `extract_topics` returns at most k terms per doc, an empty vec for empty docs, ties ordered alphabetically, and is deterministic.
- AC-03-04: Stop words never appear in topics.
- AC-03-05: `slug` and `node_file_name` follow the rules (including `"undated"` and `"untitled"`).
- AC-03-06: Frontmatter lines parse as `key: <JSON>` with all 14 keys in order and correct values (null project for claude.ai sessions).
- AC-03-07: Body contains `# <title>`, `[[project/<slug>]]`, one `[[topic/<t>]]` per topic, and every user and assistant text in order.
- AC-03-08: Thinking renders inside `<details>`; tool calls show the tool name and JSON input; error results are marked `(error)`; results over 2000 chars are truncated with the marker.
- AC-03-09: Content containing triple backticks is wrapped in a longer fence.
- AC-03-10: `render_node` is byte-identical across calls and ends with a single newline.

## External systems to mock
- None (pure functions; build `Session` values in the test).

## Dependencies on earlier phases
- Phase 01: `Session` and its helper methods.
