## Conversation knowledge base (`kb`) with a 3D explorer

## Why

Keep every conversation with Claude in one searchable place. For each conversation, `kb ingest`:

1. writes one Markdown node per session,
2. appends a record to an LLM-trainable dataset (text, tool calls, thinking), redacted by default,
3. adds the session to a knowledge graph that can be explored in 3D in the browser.

Sources: Claude Code transcripts (`~/.claude/projects`) and claude.ai exports. Topics are offline TF-IDF keywords. An optional SessionEnd hook keeps the knowledge base current.

## What changed

| Phase | Title | Size | Review rounds | Bugs found and fixed |
|---|---|---|---|---|
| 01 | Session model + Claude Code transcript parser | medium | 1 | 0 |
| 02 | claude.ai export parser | small | 1 | 0 |
| 03 | Topic keywords (TF-IDF) + Markdown session nodes | medium | 2 | 2 |
| 04 | Training dataset records + redaction | medium | 1 | 0 |
| 05 | Knowledge graph builder (graph.json) | small | 1 | 0 |
| 06 | `kb` command: incremental ingest, SessionEnd hook, hook installer | medium | 2 | 1 |
| 07 | 3D explorer web app | medium | 2 | 1 |

7 of 7 phases done, one commit per phase.

## Risk and approvals

High, because `core/src/install.rs` changed (it edits a Claude Code settings file). **2 approvals needed.**

## How to run the checks

```bash
cd core && cargo test && cargo clippy -- -D warnings
cd ../explorer && npm install && npx vitest run
```

Try it:

```bash
cd core && cargo run --bin kb -- ingest
cd ../explorer && npm run dev
```

The explorer serves `$KB_HOME/graph/graph.json`, or `~/claude-kb/graph/graph.json`.

## Notes for reviewers

- The knowledge base holds private chat content. It lives outside the repo and must never be committed.
- The ingest summary counts "new" per source file, so resumed or forked chats (duplicate session ids) can make it higher than the node count. The later session wins.
- Known, not blocking: unbounded zip entry read; a BOM in `conversations.json` gives a parse error; JSON `"password"` keys are not redacted; an unterminated PEM block leaks its body.

## Links

- Report: `changes/2026-11-01-conversation-kb/report.md`
- Knowledge base article: `changes/2026-11-01-conversation-kb/kba/kba.docx`
