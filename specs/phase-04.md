# Phase 04: Training dataset records + redaction

## Intent
Turn every conversation into one line of an LLM-trainable dataset in the widely supported
OpenAI chat `messages` format (text, tool calls, tool results and thinking), with secrets and
email addresses redacted by default so the dataset is safe to keep and share.

## Complexity
M - message re-shaping with tool-call pairing rules, truncation and regex-based redaction.

## Scope
- In scope: `DatasetOptions`, `redact`, `to_record`, `to_jsonl`.
- Out of scope: writing the file (phase 06), train/validation splits, uploading.

## Interface contract
Tests in `core/tests/phase04_dataset.rs`. Dev-dependencies available: `serde_json = "1"`.

| Item | Location (file / module) | Signature or shape | Errors |
|---|---|---|---|
| `DatasetOptions` | `kb_core::dataset` | `pub struct DatasetOptions { pub redact: bool, pub max_tool_chars: usize, pub include_thinking: bool }`; `impl Default` = `{ redact: true, max_tool_chars: 2000, include_thinking: true }`; derives `Debug, Clone` | - |
| `redact` | `kb_core::dataset` | `pub fn redact(text: &str) -> String` | - |
| `to_record` | `kb_core::dataset` | `pub fn to_record(s: &kb_core::Session, opts: &DatasetOptions) -> Option<serde_json::Value>` | `None` when no usable exchange (see 6) |
| `to_jsonl` | `kb_core::dataset` | `pub fn to_jsonl(records: &[serde_json::Value]) -> String` | - |

### Record shape
```json
{"id":"s1","source":"claude-code","title":"…","project":"proj","messages":[
  {"role":"user","content":"read main.rs"},
  {"role":"assistant","content":"Reading it.","reasoning_content":"plan","tool_calls":[{"id":"tu_1","type":"function","function":{"name":"Read","arguments":"{\"file_path\":\"/p/main.rs\"}"}}]},
  {"role":"tool","tool_call_id":"tu_1","content":"fn main(){}"},
  {"role":"assistant","content":"It prints nothing."}]}
```

## Behaviour
1. Messages are converted in order:
   - `User` message: each `ToolResult` block -> `{"role":"tool","tool_call_id":…,"content":…}`
     (in block order, emitted first); then, if it has Text blocks, one
     `{"role":"user","content": <texts joined with "\n\n">}`.
   - `Assistant` message: one `{"role":"assistant","content": <texts joined with "\n\n", or "">}`;
     key `reasoning_content` = thinking blocks joined with `"\n\n"`, present only when
     `include_thinking` is true and there is non-empty thinking; key `tool_calls` present only
     when the message has ToolUse blocks, each
     `{"id":…,"type":"function","function":{"name":…,"arguments": <input as compact JSON string>}}`.
2. Tool message content longer than `max_tool_chars` characters is cut to `max_tool_chars`
   characters and `"\n…[truncated]"` appended.
3. A `tool` message whose `tool_call_id` was not issued by an earlier assistant `tool_calls`
   entry in this record is dropped.
4. Leading messages before the first `user` message are dropped. Trailing messages after the
   last `assistant` message are dropped.
5. An assistant message with empty content, no tool_calls and no reasoning_content is dropped.
6. Returns `None` when the result has no `user` message or no `assistant` message.
7. Top-level keys: `id`, `source` (`"claude-code"`/`"claude-ai"`), `title`, `project`
   (string or null), `messages`.
8. When `opts.redact` is true, `redact` is applied to `title` and to every string in the
   messages (`content`, `reasoning_content`, and each `arguments` string before it is stored).
9. `redact(text)` replaces, in this order:
   - PEM private keys `-----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----` -> `[SECRET]`;
   - `sk-ant-[A-Za-z0-9_-]{10,}`, `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`,
     `gh[pousr]_[A-Za-z0-9]{20,}`, `xox[baprs]-[A-Za-z0-9-]{10,}`,
     JWTs `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` -> `[SECRET]`;
   - case-insensitive `(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)(\S+)` -> the
     key and separator kept, the value replaced: `password=hunter2` -> `password=[SECRET]`,
     `API_KEY: abc` -> `API_KEY: [SECRET]`;
   - email addresses `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` -> `[EMAIL]`.
   Text without matches is returned unchanged.
10. `to_jsonl` = each record as compact JSON on its own line, each line ending in `"\n"`;
    empty slice -> `""`.

## Acceptance criteria
- AC-04-01: A session with user text, assistant thinking + text + tool_use, a tool_result and a final assistant reply converts to exactly user / assistant(tool_calls, reasoning_content) / tool / assistant.
- AC-04-02: `arguments` is a string containing the compact JSON of the tool input; `type` is `"function"`.
- AC-04-03: With `include_thinking: false` no message has `reasoning_content`.
- AC-04-04: Tool output over `max_tool_chars` is truncated with `"\n…[truncated]"`; shorter output is unchanged.
- AC-04-05: Orphan tool results, leading non-user messages and trailing non-assistant messages are removed.
- AC-04-06: A session with only user messages (or only assistant messages) returns `None`.
- AC-04-07: `redact` replaces emails with `[EMAIL]` and each listed secret kind (sk-ant, sk-, AKIA, ghp_, xoxb-, JWT, PEM, password=/token:/api_key=) with `[SECRET]`, keeping surrounding text.
- AC-04-08: With default options secrets in user text, assistant text, thinking, tool arguments and the title are redacted; with `redact: false` they are kept verbatim.
- AC-04-09: `to_jsonl` writes one parseable JSON object per line, newline-terminated.

## External systems to mock
- None (pure functions).

## Dependencies on earlier phases
- Phase 01: `Session`, `Message`, `Block`, `Source`, `Role`.
