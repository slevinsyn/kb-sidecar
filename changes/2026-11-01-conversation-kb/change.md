# Change: Conversation knowledge base (session nodes, training dataset, 3D graph)

Date: 2026-11-01 · Requested by: Sarthak Bhatt · Status: draft
Client: Internal
Linked: none

## Why
Conversations with Claude (Claude Code sessions and claude.ai chats) disappear into raw log
files that nobody can browse, search or reuse. Sarthak wants one knowledge base that, for every
conversation, (1) creates a readable node for the session, (2) turns it into an LLM-trainable
dataset record, and (3) adds it to a 3D knowledge graph that can be explored visually.

## Must work
- A Claude Code transcript (`~/.claude/projects/<proj>/<session>.jsonl`) with 3 user prompts,
  assistant replies, a `Read` tool call and its result -> one session with title, project
  (last folder of `cwd`), branch, start/end time, models, 3 turns, tools `[Read]`, the file
  that was read.
- Assistant replies split over several jsonl lines with the same message id -> one assistant
  message.
- Sidechain lines, `isMeta` lines, `<system-reminder>` text, blank and broken JSON lines ->
  ignored, no crash.
- A transcript with no user/assistant lines -> skipped, not an error for the whole run.
- A claude.ai export as a folder, `conversations.json` or `.zip` -> one session per
  conversation (empty conversations skipped).
- Every session -> a Markdown node file with JSON-valued frontmatter (id, title, project,
  branch, dates, models, turns, tools, files, PRs, topics), `[[project/..]]` and
  `[[topic/..]]` links, and the full conversation.
- Every session -> one JSONL line in OpenAI chat format: `user` / `assistant` (with
  `tool_calls` and `reasoning_content`) / `tool` messages, long tool output truncated, ending
  on an assistant turn.
- `alice@example.com`, `sk-ant-…`, `AKIA…`, `ghp_…`, JWTs, `password=…` in any conversation ->
  `[EMAIL]` / `[SECRET]` in the dataset (redaction on by default, `--no-redact` turns it off).
- Offline topic keywords (TF-IDF over all sessions): a session that talks mostly about
  "kubernetes" and "ingress" gets those as topics; stop words never become topics.
- `graph.json` with nodes `session`, `project`, `topic`, `file`, `tool` and links
  session->project/topic/file/tool, deterministic order, no dangling links.
- `kb ingest` run twice with no changes -> second run reports everything unchanged and
  produces identical output files; a changed transcript is re-parsed; a renamed title leaves
  no stale node file.
- `kb hook` given the Claude Code SessionEnd JSON on stdin -> ingests that transcript and
  updates nodes, dataset and graph; it always exits 0 so it can never break Claude Code.
- `kb install-hook --settings <file>` -> adds the SessionEnd hook, keeps every other setting,
  running it twice adds nothing; invalid JSON -> exit 1 and the file is untouched.
- Explorer (`npm run dev` in `explorer/`) -> 3D force graph of `graph.json`, colour per node
  type, click a node for details, search box, type filters, neighbours highlighted.
- Explorer given malformed graph JSON -> clear "Invalid graph" error, not a blank page.

## Steps
| Phase | What it delivers | Size |
|---|---|---|
| 01 | Session model + Claude Code transcript parser | M |
| 02 | claude.ai export parser (folder / json / zip) | S |
| 03 | Topic keywords (TF-IDF) + Markdown session nodes | M |
| 04 | Training dataset records (OpenAI chat JSONL) + secret/email redaction | M |
| 05 | Knowledge graph builder (`graph.json`) | S |
| 06 | `kb` command: incremental ingest, SessionEnd hook, hook installer | M |
| 07 | 3D explorer web app (search, filters, details) | M |

## Risk: High
It reads and stores private conversations (personal data) and writes a Claude Code settings
file; everything stays on this computer and nothing is sent anywhere.

## Undo
Revert the phase commits. Delete the output folder (`~/claude-kb` or `$KB_HOME`). If the hook
was installed, remove the `kb hook` entry under `hooks.SessionEnd` in the settings file.

## Not in this change
- Calling any LLM (topics are computed offline).
- Uploading the dataset anywhere or starting a fine-tune.
- Installing the hook into the real `~/.claude/settings.json` (the person runs
  `kb install-hook` themselves when ready).
- Other chat sources (ChatGPT, Cursor) and subagent transcripts.
- Python: not needed; Rust core + TypeScript/Node explorer cover everything.

## Assumptions
- Output goes to `$KB_HOME`, else `~/claude-kb` (outside the repo; `kb-data/` is git-ignored too).
- Dataset format is OpenAI-style chat `messages` JSONL, with thinking as `reasoning_content`;
  tool results truncated to 2000 characters by default.
- Redaction is on by default.
- Topics: top 8 TF-IDF keywords per session.
- Images inside conversations are replaced by `[image]`.
- Subagent transcripts (`…/subagents/`) are skipped; only the main session is a node.
- Unknown record types in transcripts are ignored, so newer Claude Code versions keep working.

## Still open
