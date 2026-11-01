# Phase 02: claude.ai export parser

## Intent
Bring claude.ai chats into the same `Session` model, from the data export the person downloads
from claude.ai (a `.zip`, the unzipped folder, or `conversations.json` itself).

## Complexity
S - straightforward JSON mapping plus zip reading.

## Scope
- In scope: `parse_conversations_json`, `parse_export` (folder / json file / zip).
- Out of scope: `projects.json`, `users.json`, attachments and files inside the export.

## Interface contract
Tests in `core/tests/phase02_claude_ai.rs`. Dev-dependencies available: `tempfile = "3"`,
`serde_json = "1"`, `zip` (same crate the library uses, to build test zips).

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `parse_conversations_json` | `kb_core::claude_ai` | `pub fn parse_conversations_json(text: &str) -> Result<Vec<kb_core::Session>, kb_core::KbError>` | `KbError::Parse` if not JSON or the top level is not an array |
| `parse_export` | `kb_core::claude_ai` | `pub fn parse_export(path: &std::path::Path) -> Result<Vec<kb_core::Session>, kb_core::KbError>` | `KbError::Io` if missing/unreadable; `KbError::Parse` if a zip or folder has no `conversations.json` or the zip is corrupt |

### Input shape (`conversations.json`)
```json
[{"uuid":"c1","name":"Rust lifetimes","created_at":"2026-09-01T08:00:00Z","updated_at":"2026-09-01T09:00:00Z",
  "chat_messages":[
    {"uuid":"m1","sender":"human","text":"explain lifetimes","created_at":"2026-09-01T08:00:00Z","content":[{"type":"text","text":"explain lifetimes"}]},
    {"uuid":"m2","sender":"assistant","text":"...","created_at":"2026-09-01T08:00:05Z","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"Lifetimes are..."},{"type":"tool_use","id":"t1","name":"web_search","input":{"query":"x"}},{"type":"tool_result","tool_use_id":"t1","name":"web_search","content":[{"type":"text","text":"result"}],"is_error":false}]}]}]
```

## Behaviour
1. One `Session` per conversation, in input order, `source = Source::ClaudeAi`, `id = uuid`.
2. `sender` `"human"` -> `Role::User`, `"assistant"` -> `Role::Assistant`; other senders skipped.
3. Blocks: when `content` is a non-empty array, map items `text` -> `Text`, `thinking` ->
   `Thinking` (dropped if empty), `tool_use` -> `ToolUse{id (default ""), name, input (default null)}`,
   `tool_result` -> `ToolResult{tool_use_id (default ""), content, is_error (default false)}` where
   content is a string as is or an array whose text items' `text` are joined with `"\n"` (other
   items ignored); other item types dropped. Otherwise a non-empty `text` field becomes one `Text`.
   Text blocks that are empty after trimming are dropped; messages with no blocks are dropped.
4. `Message.timestamp` = message `created_at`.
5. `title` = `name` if non-empty, else the first user Text (whitespace collapsed, max 80 chars),
   else `"Untitled"`.
6. `started_at` = conversation `created_at` (falls back to the first message timestamp);
   `ended_at` = `updated_at` (falls back to the last message timestamp).
7. `project`, `cwd`, `git_branch` = `None`; `models`, `prs` = empty.
8. Conversations with no remaining messages are skipped (not an error).
9. `parse_export(path)`: a directory -> reads `path/conversations.json`; a file ending in
   `.zip` (case-insensitive) -> reads the first zip entry whose file name is
   `conversations.json` (at any folder depth); any other file -> read as `conversations.json`.

## Acceptance criteria
- AC-02-01: A conversations.json with two conversations yields two Sessions with source `ClaudeAi`, ids = uuids, titles = names, correct roles and timestamps.
- AC-02-02: `content` arrays map to Text / Thinking / ToolUse / ToolResult blocks in order; array tool_result content is joined text.
- AC-02-03: A message with no `content` array uses its `text` field.
- AC-02-04: A conversation with an empty name gets its title from the first human message; with no messages it is skipped.
- AC-02-05: `parse_export` gives the same result for the folder, the json file and a zip (including a zip with the file inside a subfolder).
- AC-02-06: Invalid JSON or a non-array top level returns `Err(KbError::Parse(_))`; a missing path returns `Err(KbError::Io(_))`; a zip without conversations.json returns `Err(KbError::Parse(_))`.

## External systems to mock
- File system only: build exports in a `tempfile::TempDir`, build zips with the `zip` crate.

## Dependencies on earlier phases
- Phase 01: `Session`, `Message`, `Block`, `Source`, `Role`, `KbError`.
