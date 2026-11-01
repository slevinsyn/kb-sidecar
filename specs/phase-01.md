# Phase 01: Session model + Claude Code transcript parser

## Intent
Turn one Claude Code transcript file (`~/.claude/projects/<project>/<session>.jsonl`) into a
clean `Session` value that every later phase (nodes, dataset, graph) builds on. The parser must
survive real-world noise: split assistant messages, sidechains, meta lines, system reminders,
broken lines and unknown record types.

## Complexity
M - JSON-lines parsing with merging and many filtering edge cases, but no concurrency or I/O beyond reading one file.

## Scope
- In scope: the shared data model (`Session`, `Message`, `Block`, `Source`, `Role`, `KbError`),
  `parse_transcript`, `parse_transcript_str`, `discover`, and the `Session` helper methods.
- Out of scope: claude.ai export (phase 02), any output files, the CLI.

## Interface contract
Crate `kb-core` in `core/`, library name `kb_core`. Tests are integration tests in
`core/tests/*.rs` (e.g. `core/tests/phase01_claude_code.rs`). Dev-dependencies available to
tests: `tempfile = "3"`, `serde_json = "1"`. All types below are re-exported at the crate root
(`use kb_core::{Session, Message, Block, Source, Role, KbError};`).

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `Source` | `kb_core::model` | `pub enum Source { ClaudeCode, ClaudeAi }` derives `Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize`; `pub fn as_str(&self) -> &'static str` returns `"claude-code"` / `"claude-ai"` | - |
| `Role` | `kb_core::model` | `pub enum Role { User, Assistant }` derives `Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize` | - |
| `Block` | `kb_core::model` | `pub enum Block { Text(String), Thinking(String), ToolUse { id: String, name: String, input: serde_json::Value }, ToolResult { tool_use_id: String, content: String, is_error: bool } }` derives `Debug, Clone, PartialEq, Serialize, Deserialize` | - |
| `Message` | `kb_core::model` | `pub struct Message { pub role: Role, pub timestamp: Option<String>, pub blocks: Vec<Block> }` derives `Debug, Clone, PartialEq, Serialize, Deserialize` | - |
| `Session` | `kb_core::model` | `pub struct Session { pub id: String, pub source: Source, pub title: String, pub project: Option<String>, pub cwd: Option<String>, pub git_branch: Option<String>, pub started_at: Option<String>, pub ended_at: Option<String>, pub models: Vec<String>, pub messages: Vec<Message>, pub prs: Vec<String> }` derives `Debug, Clone, PartialEq, Serialize, Deserialize` | - |
| `Session::tools_used` | `kb_core::model` | `pub fn tools_used(&self) -> Vec<String>` | - |
| `Session::files_touched` | `kb_core::model` | `pub fn files_touched(&self) -> Vec<String>` | - |
| `Session::turn_count` | `kb_core::model` | `pub fn turn_count(&self) -> usize` | - |
| `KbError` | `kb_core::error` | `pub enum KbError { Io(std::io::Error), Empty(String), Parse(String), Settings(String) }`; implements `Display`, `std::error::Error`, `From<std::io::Error>` | - |
| `parse_transcript_str` | `kb_core::claude_code` | `pub fn parse_transcript_str(text: &str, fallback_id: &str) -> Result<Session, KbError>` | `KbError::Empty(fallback_id)` when no message survives filtering |
| `parse_transcript` | `kb_core::claude_code` | `pub fn parse_transcript(path: &std::path::Path) -> Result<Session, KbError>`; fallback id = file stem | `KbError::Io` if unreadable; `KbError::Empty` as above |
| `discover` | `kb_core::claude_code` | `pub fn discover(projects_dir: &std::path::Path) -> Vec<std::path::PathBuf>` | missing dir -> empty vec |

### Input record shapes (one JSON object per line)
```json
{"type":"user","sessionId":"s1","cwd":"/home/a/proj","gitBranch":"main","timestamp":"2026-10-01T10:00:00.000Z","isSidechain":false,"message":{"role":"user","content":"hello"}}
{"type":"user","sessionId":"s1","timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","source":{}}]}}
{"type":"assistant","sessionId":"s1","timestamp":"...","message":{"id":"msg_1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"answer"},{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/home/a/proj/src/main.rs"}}]}}
{"type":"user","sessionId":"s1","timestamp":"...","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"fn main(){}","is_error":false}]}}
{"type":"custom-title","sessionId":"s1","customTitle":"My title"}
{"type":"summary","summary":"Short summary","leafUuid":"..."}
{"type":"pr-link","sessionId":"s1","prUrl":"https://github.com/o/r/pull/7"}
```
`tool_result.content` may be a string or an array of `{"type":"text","text":…}` / `{"type":"image",…}` items.

## Behaviour
1. Each line is parsed independently. Blank lines and lines that are not valid JSON objects are
   ignored. Records whose `type` is not one of `user`, `assistant`, `custom-title`, `summary`,
   `pr-link` are ignored.
2. `user` / `assistant` records with `"isSidechain": true` or `"isMeta": true` are ignored.
3. `assistant` records whose `message.model` is `"<synthetic>"` are ignored entirely.
4. User content: a string becomes one `Text`; array items map `text` -> `Text`,
   `image` -> `Text("[image]")`, `tool_result` -> `ToolResult`. Assistant content items map
   `text` -> `Text`, `thinking` -> `Thinking` (dropped when the thinking string is empty or
   whitespace), `tool_use` -> `ToolUse`; `redacted_thinking` and unknown item types are dropped.
5. Every `<system-reminder>…</system-reminder>` span (may be multi-line) is removed from Text
   blocks of user messages; the remaining text is trimmed; a Text block that is then empty is
   dropped.
6. `ToolResult.content`: a string is used as is; an array is joined with `"\n"`, where text items
   contribute their `text` and image items contribute `"[image]"`. `is_error` defaults to false;
   `tool_use_id` defaults to `""`.
7. Assistant records sharing the same `message.id` are merged into the first message with that
   id, blocks appended in file order. Records without `message.id` are never merged.
8. A message with zero blocks after filtering is dropped. Messages keep file order.
   `Message.timestamp` is the record's `timestamp` (the first record's for merged messages).
9. `id` = `sessionId` of the first user/assistant record that has one, else `fallback_id`.
10. `cwd` / `git_branch` = first non-empty `cwd` / `gitBranch` seen on a user/assistant record.
    `project` = last path component of `cwd` (`None` when `cwd` is `None`).
11. `started_at` / `ended_at` = lexicographically smallest / largest `timestamp` among the kept
    messages (`None` if none has one).
12. `models` = distinct `message.model` values of kept assistant records, in order of first
    appearance.
13. `title`: the last `custom-title` record's `customTitle` (non-empty), else the last `summary`
    record's `summary` (non-empty), else the first user Text with runs of whitespace collapsed to
    one space, trimmed and cut to at most 80 characters (chars, not bytes), else `"Untitled"`.
14. `prs` = distinct `prUrl` (or `url`) values from `pr-link` records, in order of appearance.
15. No kept message -> `Err(KbError::Empty(fallback_id))`.
16. `source` = `Source::ClaudeCode`.
17. `tools_used()` = sorted, de-duplicated names of all `ToolUse` blocks.
18. `files_touched()` = sorted, de-duplicated string values of the input keys `file_path`,
    `path` and `notebook_path` of all `ToolUse` blocks (non-string values ignored).
19. `turn_count()` = number of `User` messages that contain at least one `Text` block.
20. `discover(dir)` returns every `*.jsonl` file exactly one folder below `dir`
    (`dir/<project>/<file>.jsonl`), sorted by path; deeper files (for example
    `dir/<project>/<session>/subagents/x.jsonl`) and files directly in `dir` are not returned.

## Acceptance criteria
- AC-01-01: A transcript with 3 plain user prompts, assistant replies, one `Read` tool_use and its tool_result parses to a Session with the transcript's `sessionId`, `project` = last folder of `cwd`, `git_branch`, `turn_count() == 3`, `tools_used() == ["Read"]` and `files_touched()` containing the read file path.
- AC-01-02: Three assistant records with the same `message.id` (thinking, text, tool_use) become one assistant Message with the three blocks in order.
- AC-01-03: Sidechain records, `isMeta` records, `<synthetic>` assistant records, blank lines, invalid JSON lines and unknown record types are ignored without error.
- AC-01-04: `<system-reminder>` spans are removed from user text; a user message that only held a system reminder disappears.
- AC-01-05: Empty thinking blocks are dropped; non-empty thinking is kept as `Block::Thinking`.
- AC-01-06: `tool_result` content given as an array of text and image items becomes one string joined with newlines, with `[image]` for images; `is_error: true` is preserved.
- AC-01-07: Title precedence: custom-title beats summary beats first user text (collapsed, max 80 chars) beats `"Untitled"`.
- AC-01-08: `started_at`/`ended_at` are the min/max kept timestamps; `models` lists distinct models in first-seen order without `<synthetic>`; `prs` lists pr-link URLs.
- AC-01-09: A file with no user/assistant messages returns `Err(KbError::Empty(_))`; an unreadable path returns `Err(KbError::Io(_))`.
- AC-01-10: `parse_transcript` uses the file stem as id when no record has a `sessionId`.
- AC-01-11: `discover` returns only `<dir>/<project>/*.jsonl`, sorted, ignoring subagent folders, other extensions and a missing dir.
- AC-01-12: `Session` round-trips through `serde_json` unchanged.

## External systems to mock
- File system: build transcripts as strings or in a `tempfile::TempDir`. Never read the real `~/.claude`.

## Dependencies on earlier phases
- None
