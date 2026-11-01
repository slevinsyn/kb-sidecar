//! Training dataset records (OpenAI chat `messages` format) and redaction.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::{Block, Role, Session};

/// Options controlling how sessions become dataset records.
#[derive(Debug, Clone)]
pub struct DatasetOptions {
    pub redact: bool,
    pub max_tool_chars: usize,
    pub include_thinking: bool,
}

impl Default for DatasetOptions {
    fn default() -> Self {
        DatasetOptions {
            redact: true,
            max_tool_chars: 2000,
            include_thinking: true,
        }
    }
}

const SECRET: &str = "[SECRET]";
const EMAIL: &str = "[EMAIL]";
const TRUNCATED: &str = "\n…[truncated]";

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

/// A matcher anchored at a byte offset. Returns `(keep_end, end)`: the text up to `keep_end` is
/// kept, the text from `keep_end` to `end` is replaced.
type Matcher = fn(&str, usize) -> Option<(usize, usize)>;

/// Scan `text` left to right; at each position try `matcher`, replacing the matched part.
fn replace_with(text: &str, matcher: Matcher, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if let Some((keep_end, end)) = matcher(text, i) {
            if end > i {
                out.push_str(&text[i..keep_end]);
                out.push_str(replacement);
                i = end;
                continue;
            }
        }
        // Copy one character.
        let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// Number of bytes from `start` while `pred` holds (ASCII classes only).
fn run_len(bytes: &[u8], start: usize, pred: impl Fn(u8) -> bool) -> usize {
    bytes[start..].iter().take_while(|&&b| pred(b)).count()
}

fn is_alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

fn is_alnum_dash_us(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn is_alnum_dash(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-'
}

/// `prefix` followed by a run of `class` bytes at least `min` long.
fn prefixed_run(
    text: &str,
    i: usize,
    prefix: &[u8],
    class: fn(u8) -> bool,
    min: usize,
) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes[i..].starts_with(prefix) {
        return None;
    }
    let start = i + prefix.len();
    let n = run_len(bytes, start, class);
    (n >= min).then_some(start + n)
}

fn m_pem(text: &str, i: usize) -> Option<(usize, usize)> {
    const BEGIN: &str = "-----BEGIN ";
    const END: &str = "-----END ";
    const KEY: &str = "PRIVATE KEY-----";
    let rest = &text[i..];
    let after_begin = rest.strip_prefix(BEGIN)?;
    let key_at = after_begin.find(KEY)?;
    if !after_begin[..key_at]
        .bytes()
        .all(|b| b.is_ascii_uppercase() || b == b' ')
    {
        return None;
    }
    let body_start = BEGIN.len() + key_at + KEY.len();
    let mut search = body_start;
    while let Some(rel) = rest[search..].find(END) {
        let end_at = search + rel;
        let label_start = end_at + END.len();
        if let Some(k) = rest[label_start..].find(KEY) {
            let label = &rest[label_start..label_start + k];
            if label.bytes().all(|b| b.is_ascii_uppercase() || b == b' ') {
                let end = i + label_start + k + KEY.len();
                return Some((i, end));
            }
        }
        search = end_at + 1;
    }
    None
}

fn m_sk_ant(text: &str, i: usize) -> Option<(usize, usize)> {
    prefixed_run(text, i, b"sk-ant-", is_alnum_dash_us, 10).map(|e| (i, e))
}

fn m_sk(text: &str, i: usize) -> Option<(usize, usize)> {
    prefixed_run(text, i, b"sk-", is_alnum, 20).map(|e| (i, e))
}

fn m_akia(text: &str, i: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if !bytes[i..].starts_with(b"AKIA") {
        return None;
    }
    let tail = bytes.get(i + 4..i + 20)?;
    tail.iter()
        .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
        .then_some((i, i + 20))
}

fn m_github(text: &str, i: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if bytes.get(i) != Some(&b'g') || bytes.get(i + 1) != Some(&b'h') {
        return None;
    }
    if !matches!(bytes.get(i + 2), Some(b'p' | b'o' | b'u' | b's' | b'r')) {
        return None;
    }
    prefixed_run(text, i + 3, b"_", is_alnum, 20).map(|e| (i, e))
}

fn m_slack(text: &str, i: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if !bytes[i..].starts_with(b"xox") {
        return None;
    }
    if !matches!(bytes.get(i + 3), Some(b'b' | b'a' | b'p' | b'r' | b's')) {
        return None;
    }
    prefixed_run(text, i + 4, b"-", is_alnum_dash, 10).map(|e| (i, e))
}

fn m_jwt(text: &str, i: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if !bytes[i..].starts_with(b"eyJ") {
        return None;
    }
    let mut pos = i + 3;
    for part in 0..3 {
        let n = run_len(bytes, pos, is_alnum_dash_us);
        if n < 10 {
            return None;
        }
        pos += n;
        if part < 2 {
            if bytes.get(pos) != Some(&b'.') {
                return None;
            }
            pos += 1;
        }
    }
    Some((i, pos))
}

/// `(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)(\S+)`, case-insensitive.
fn m_keyword(text: &str, i: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let starts_ci = |pos: usize, word: &str| -> bool {
        bytes
            .get(pos..pos + word.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(word.as_bytes()))
    };
    let kw_end = ["password", "passwd", "pwd", "secret", "token"]
        .iter()
        .find(|w| starts_ci(i, w))
        .map(|w| i + w.len())
        .or_else(|| {
            if !starts_ci(i, "api") {
                return None;
            }
            let mut p = i + 3;
            if matches!(bytes.get(p), Some(b'_' | b'-')) {
                p += 1;
            }
            starts_ci(p, "key").then_some(p + 3)
        })?;
    // Optional whitespace, one of `:` `=`, optional whitespace, then a non-empty value.
    let skip_ws = |mut p: usize| -> usize {
        while let Some(c) = text[p..].chars().next() {
            if !c.is_whitespace() {
                break;
            }
            p += c.len_utf8();
        }
        p
    };
    let sep_at = skip_ws(kw_end);
    if !matches!(bytes.get(sep_at), Some(b':' | b'=')) {
        return None;
    }
    let value_start = skip_ws(sep_at + 1);
    let mut end = value_start;
    while let Some(c) = text[end..].chars().next() {
        if c.is_whitespace() {
            break;
        }
        end += c.len_utf8();
    }
    (end > value_start).then_some((value_start, end))
}

fn is_email_local(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_email_domain(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'-'
}

/// Replace `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` matches.
fn replace_emails(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut search = 0;
    while let Some(rel) = text[search..].find('@') {
        let at = search + rel;
        search = at + 1;
        // Local part: maximal run of local characters ending at `@`, not before the cursor.
        let mut local_start = at;
        while local_start > cursor && is_email_local(bytes[local_start - 1]) {
            local_start -= 1;
        }
        if local_start == at {
            continue;
        }
        // Domain: longest `[A-Za-z0-9.-]+` followed by `.` and at least two letters.
        let run = run_len(bytes, at + 1, is_email_domain);
        let domain = &bytes[at + 1..at + 1 + run];
        let mut found = None;
        for k in (1..run).rev() {
            if domain[k] != b'.' {
                continue;
            }
            let letters = domain[k + 1..]
                .iter()
                .take_while(|b| b.is_ascii_alphabetic())
                .count();
            if letters >= 2 {
                found = Some(at + 1 + k + 1 + letters);
                break;
            }
        }
        if let Some(end) = found {
            out.push_str(&text[cursor..local_start]);
            out.push_str(EMAIL);
            cursor = end;
            search = end;
        }
    }
    out.push_str(&text[cursor..]);
    out
}

/// Replace secrets and email addresses.
pub fn redact(text: &str) -> String {
    let mut s = replace_with(text, m_pem, SECRET);
    for m in [m_sk_ant, m_sk, m_akia, m_github, m_slack, m_jwt] {
        s = replace_with(&s, m, SECRET);
    }
    s = replace_with(&s, m_keyword, SECRET);
    replace_emails(&s)
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((byte_idx, _)) => format!("{}{}", &text[..byte_idx], TRUNCATED),
        None => text.to_string(),
    }
}

/// Convert a session to one dataset record.
pub fn to_record(s: &Session, opts: &DatasetOptions) -> Option<Value> {
    let clean = |t: &str| -> String {
        if opts.redact {
            redact(t)
        } else {
            t.to_string()
        }
    };

    // 1. Convert in order (tool results are checked for orphans after trimming).
    let mut msgs: Vec<Value> = Vec::new();
    for m in &s.messages {
        match m.role {
            Role::User => {
                let mut texts: Vec<&str> = Vec::new();
                for b in &m.blocks {
                    match b {
                        Block::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            let c = truncate_chars(&clean(content), opts.max_tool_chars);
                            msgs.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": c,
                            }));
                        }
                        Block::Text(t) => texts.push(t),
                        _ => {}
                    }
                }
                let has_text = m.blocks.iter().any(|b| matches!(b, Block::Text(_)));
                if has_text {
                    msgs.push(json!({"role": "user", "content": clean(&texts.join("\n\n"))}));
                }
            }
            Role::Assistant => {
                let mut texts: Vec<&str> = Vec::new();
                let mut thoughts: Vec<&str> = Vec::new();
                let mut calls: Vec<Value> = Vec::new();
                for b in &m.blocks {
                    match b {
                        Block::Text(t) => texts.push(t),
                        Block::Thinking(t) => thoughts.push(t),
                        Block::ToolUse { id, name, input } => {
                            let args = clean(&input.to_string());
                            calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": {"name": name, "arguments": args},
                            }));
                        }
                        Block::ToolResult { .. } => {}
                    }
                }
                let content = clean(&texts.join("\n\n"));
                let reasoning = thoughts.join("\n\n");
                let mut obj = Map::new();
                obj.insert("role".into(), json!("assistant"));
                let has_reasoning = opts.include_thinking && !reasoning.is_empty();
                if content.is_empty() && calls.is_empty() && !has_reasoning {
                    continue;
                }
                obj.insert("content".into(), Value::String(content));
                if has_reasoning {
                    obj.insert("reasoning_content".into(), Value::String(clean(&reasoning)));
                }
                if !calls.is_empty() {
                    obj.insert("tool_calls".into(), Value::Array(calls));
                }
                msgs.push(Value::Object(obj));
            }
        }
    }

    // 4. Drop leading messages before the first user and trailing ones after the last assistant.
    let role_of = |v: &Value| v["role"].as_str().unwrap_or("").to_string();
    let first_user = msgs.iter().position(|v| role_of(v) == "user")?;
    let last_assistant = msgs.iter().rposition(|v| role_of(v) == "assistant")?;
    if first_user >= last_assistant {
        return None;
    }

    // 3. Drop tool messages whose call was not issued earlier in this record.
    let mut issued: HashSet<String> = HashSet::new();
    let mut kept: Vec<Value> = Vec::new();
    for v in msgs.drain(first_user..=last_assistant) {
        match role_of(&v).as_str() {
            "assistant" => {
                if let Some(calls) = v.get("tool_calls").and_then(Value::as_array) {
                    for c in calls {
                        if let Some(id) = c["id"].as_str() {
                            issued.insert(id.to_string());
                        }
                    }
                }
                kept.push(v);
            }
            "tool" => {
                if v["tool_call_id"]
                    .as_str()
                    .is_some_and(|id| issued.contains(id))
                {
                    kept.push(v);
                }
            }
            _ => kept.push(v),
        }
    }

    Some(json!({
        "id": s.id,
        "source": s.source.as_str(),
        "title": clean(&s.title),
        "project": s.project,
        "messages": kept,
    }))
}

/// One compact JSON object per line.
pub fn to_jsonl(records: &[Value]) -> String {
    let mut out = String::new();
    for r in records {
        out.push_str(&r.to_string());
        out.push('\n');
    }
    out
}
