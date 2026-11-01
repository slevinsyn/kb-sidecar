//! Claude Code transcript parser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::KbError;
use crate::model::{Block, Message, Role, Session, Source};

const OPEN_TAG: &str = "<system-reminder>";
const CLOSE_TAG: &str = "</system-reminder>";
const TITLE_MAX_CHARS: usize = 80;

/// Remove every `<system-reminder>...</system-reminder>` span and trim the rest.
fn strip_system_reminders(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN_TAG) {
        let after_open = &rest[start + OPEN_TAG.len()..];
        match after_open.find(CLOSE_TAG) {
            Some(end) => {
                out.push_str(&rest[..start]);
                rest = &after_open[end + CLOSE_TAG.len()..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Push a user text block after cleaning it; empty results are dropped.
fn push_user_text(blocks: &mut Vec<Block>, text: &str) {
    let cleaned = strip_system_reminders(text);
    if !cleaned.is_empty() {
        blocks.push(Block::Text(cleaned));
    }
}

/// Flatten the `content` of a tool result into one string.
fn tool_result_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text") => item.get("text").and_then(Value::as_str).map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn user_blocks(content: Option<&Value>) -> Vec<Block> {
    let mut blocks = Vec::new();
    match content {
        Some(Value::String(s)) => push_user_text(&mut blocks, s),
        Some(Value::Array(items)) => {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            push_user_text(&mut blocks, t);
                        }
                    }
                    Some("image") => blocks.push(Block::Text("[image]".to_string())),
                    Some("tool_result") => blocks.push(Block::ToolResult {
                        tool_use_id: item
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        content: tool_result_content(item.get("content")),
                        is_error: item
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    blocks
}

fn assistant_blocks(content: Option<&Value>) -> Vec<Block> {
    let mut blocks = Vec::new();
    match content {
        Some(Value::String(s)) => blocks.push(Block::Text(s.clone())),
        Some(Value::Array(items)) => {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            blocks.push(Block::Text(t.to_string()));
                        }
                    }
                    Some("thinking") => {
                        if let Some(t) = item.get("thinking").and_then(Value::as_str) {
                            if !t.trim().is_empty() {
                                blocks.push(Block::Thinking(t.to_string()));
                            }
                        }
                    }
                    Some("tool_use") => blocks.push(Block::ToolUse {
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        input: item.get("input").cloned().unwrap_or(Value::Null),
                    }),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    blocks
}

fn non_empty_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn flag_set(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn last_path_component(path: &str) -> Option<String> {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn push_distinct(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|v| v == value) {
        list.push(value.to_string());
    }
}

fn derive_title(
    custom_title: Option<String>,
    summary: Option<String>,
    messages: &[Message],
) -> String {
    if let Some(t) = custom_title {
        return t;
    }
    if let Some(s) = summary {
        return s;
    }
    let first_text = messages
        .iter()
        .filter(|m| m.role == Role::User)
        .flat_map(|m| m.blocks.iter())
        .find_map(|b| match b {
            Block::Text(t) => Some(t),
            _ => None,
        });
    if let Some(text) = first_text {
        let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let cut: String = collapsed.chars().take(TITLE_MAX_CHARS).collect();
        let cut = cut.trim().to_string();
        if !cut.is_empty() {
            return cut;
        }
    }
    "Untitled".to_string()
}

/// Parse the text of one transcript (JSON lines) into a session.
pub fn parse_transcript_str(text: &str, fallback_id: &str) -> Result<Session, KbError> {
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut prs: Vec<String> = Vec::new();
    let mut custom_title: Option<String> = None;
    let mut summary: Option<String> = None;

    // Messages in file order, each with the models of the records that built it.
    let mut entries: Vec<(Message, Vec<String>)> = Vec::new();
    let mut by_msg_id: HashMap<String, usize> = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !record.is_object() {
            continue;
        }
        let Some(kind) = record.get("type").and_then(Value::as_str) else {
            continue;
        };

        match kind {
            "custom-title" => {
                if let Some(t) = non_empty_str(&record, "customTitle") {
                    custom_title = Some(t.to_string());
                }
            }
            "summary" => {
                if let Some(s) = non_empty_str(&record, "summary") {
                    summary = Some(s.to_string());
                }
            }
            "pr-link" => {
                if let Some(url) =
                    non_empty_str(&record, "prUrl").or_else(|| non_empty_str(&record, "url"))
                {
                    push_distinct(&mut prs, url);
                }
            }
            "user" | "assistant" => {
                if flag_set(&record, "isSidechain") || flag_set(&record, "isMeta") {
                    continue;
                }
                let message = record.get("message");
                let model = message.and_then(|m| non_empty_str(m, "model"));
                let is_assistant = kind == "assistant";
                if is_assistant && model == Some("<synthetic>") {
                    continue;
                }

                if session_id.is_none() {
                    session_id = non_empty_str(&record, "sessionId").map(str::to_string);
                }
                if cwd.is_none() {
                    cwd = non_empty_str(&record, "cwd").map(str::to_string);
                }
                if git_branch.is_none() {
                    git_branch = non_empty_str(&record, "gitBranch").map(str::to_string);
                }

                let content = message.and_then(|m| m.get("content"));
                let record_models: Vec<String> = model.map(str::to_string).into_iter().collect();
                let (role, blocks, msg_id) = if is_assistant {
                    (
                        Role::Assistant,
                        assistant_blocks(content),
                        message
                            .and_then(|m| non_empty_str(m, "id"))
                            .map(str::to_string),
                    )
                } else {
                    (Role::User, user_blocks(content), None)
                };

                if let Some(id) = &msg_id {
                    if let Some(&idx) = by_msg_id.get(id) {
                        entries[idx].0.blocks.extend(blocks);
                        for m in &record_models {
                            push_distinct(&mut entries[idx].1, m);
                        }
                        continue;
                    }
                    by_msg_id.insert(id.clone(), entries.len());
                }

                let timestamp = non_empty_str(&record, "timestamp").map(str::to_string);
                entries.push((
                    Message {
                        role,
                        timestamp,
                        blocks,
                    },
                    record_models,
                ));
            }
            _ => {}
        }
    }

    // Messages left without blocks are dropped, and so are their models.
    let mut messages: Vec<Message> = Vec::new();
    let mut models: Vec<String> = Vec::new();
    for (message, entry_models) in entries {
        if message.blocks.is_empty() {
            continue;
        }
        for m in &entry_models {
            push_distinct(&mut models, m);
        }
        messages.push(message);
    }

    if messages.is_empty() {
        return Err(KbError::Empty(fallback_id.to_string()));
    }

    let started_at = messages.iter().filter_map(|m| m.timestamp.clone()).min();
    let ended_at = messages.iter().filter_map(|m| m.timestamp.clone()).max();
    let project = cwd.as_deref().and_then(last_path_component);
    let title = derive_title(custom_title, summary, &messages);

    Ok(Session {
        id: session_id.unwrap_or_else(|| fallback_id.to_string()),
        source: Source::ClaudeCode,
        title,
        project,
        cwd,
        git_branch,
        started_at,
        ended_at,
        models,
        messages,
        prs,
    })
}

/// Parse one transcript file; the file stem is the fallback id.
pub fn parse_transcript(path: &Path) -> Result<Session, KbError> {
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let fallback_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    parse_transcript_str(&text, &fallback_id)
}

/// List `dir/<project>/*.jsonl` files, sorted by path.
pub fn discover(projects_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(projects) = std::fs::read_dir(projects_dir) else {
        return found;
    };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&project_path) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let is_jsonl = path.extension().is_some_and(|e| e == "jsonl");
            if is_jsonl && path.is_file() {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}
