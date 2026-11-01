//! claude.ai data export parser.

use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::error::KbError;
use crate::model::{Block, Message, Role, Session, Source};

const TITLE_MAX_CHARS: usize = 80;
const CONVERSATIONS_FILE: &str = "conversations.json";

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn opt_string(v: &Value, key: &str) -> Option<String> {
    str_field(v, key)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn text_block(text: &str) -> Option<Block> {
    if text.trim().is_empty() {
        None
    } else {
        Some(Block::Text(text.to_string()))
    }
}

/// Flatten the `content` of a tool result into one string.
fn tool_result_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| str_field(item, "type") == Some("text"))
            .filter_map(|item| str_field(item, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn item_block(item: &Value) -> Option<Block> {
    match str_field(item, "type")? {
        "text" => text_block(str_field(item, "text").unwrap_or("")),
        "thinking" => {
            let t = str_field(item, "thinking").unwrap_or("");
            if t.is_empty() {
                None
            } else {
                Some(Block::Thinking(t.to_string()))
            }
        }
        "tool_use" => Some(Block::ToolUse {
            id: str_field(item, "id").unwrap_or("").to_string(),
            name: str_field(item, "name").unwrap_or("").to_string(),
            input: item.get("input").cloned().unwrap_or(Value::Null),
        }),
        "tool_result" => Some(Block::ToolResult {
            tool_use_id: str_field(item, "tool_use_id").unwrap_or("").to_string(),
            content: tool_result_content(item.get("content")),
            is_error: item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        _ => None,
    }
}

fn message_blocks(msg: &Value) -> Vec<Block> {
    match msg.get("content").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items.iter().filter_map(item_block).collect(),
        _ => text_block(str_field(msg, "text").unwrap_or(""))
            .into_iter()
            .collect(),
    }
}

fn parse_message(msg: &Value) -> Option<Message> {
    let role = match str_field(msg, "sender")? {
        "human" => Role::User,
        "assistant" => Role::Assistant,
        _ => return None,
    };
    let blocks = message_blocks(msg);
    if blocks.is_empty() {
        return None;
    }
    Some(Message {
        role,
        timestamp: opt_string(msg, "created_at"),
        blocks,
    })
}

fn derive_title(conv: &Value, messages: &[Message]) -> String {
    if let Some(name) = str_field(conv, "name").filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let first_user_text = messages
        .iter()
        .filter(|m| m.role == Role::User)
        .flat_map(|m| m.blocks.iter())
        .find_map(|b| match b {
            Block::Text(t) => Some(t),
            _ => None,
        });
    match first_user_text {
        Some(t) => {
            let collapsed = t.split_whitespace().collect::<Vec<_>>().join(" ");
            let title: String = collapsed.chars().take(TITLE_MAX_CHARS).collect();
            if title.is_empty() {
                "Untitled".to_string()
            } else {
                title
            }
        }
        None => "Untitled".to_string(),
    }
}

fn parse_conversation(conv: &Value) -> Option<Session> {
    let messages: Vec<Message> = conv
        .get("chat_messages")
        .and_then(Value::as_array)
        .map(|msgs| msgs.iter().filter_map(parse_message).collect())
        .unwrap_or_default();
    if messages.is_empty() {
        return None;
    }
    let started_at = opt_string(conv, "created_at")
        .or_else(|| messages.first().and_then(|m| m.timestamp.clone()));
    let ended_at = opt_string(conv, "updated_at")
        .or_else(|| messages.last().and_then(|m| m.timestamp.clone()));
    Some(Session {
        id: str_field(conv, "uuid").unwrap_or("").to_string(),
        source: Source::ClaudeAi,
        title: derive_title(conv, &messages),
        project: None,
        cwd: None,
        git_branch: None,
        started_at,
        ended_at,
        models: Vec::new(),
        messages,
        prs: Vec::new(),
    })
}

/// Parse the text of `conversations.json`.
pub fn parse_conversations_json(text: &str) -> Result<Vec<Session>, KbError> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| KbError::Parse(format!("invalid JSON: {e}")))?;
    let convs = value
        .as_array()
        .ok_or_else(|| KbError::Parse("conversations.json must be a JSON array".to_string()))?;
    Ok(convs.iter().filter_map(parse_conversation).collect())
}

fn read_zip(path: &Path) -> Result<String, KbError> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| KbError::Parse(format!("cannot read zip: {e}")))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| KbError::Parse(format!("cannot read zip entry: {e}")))?;
        let name = entry.name().replace('\\', "/");
        if name.rsplit('/').next() != Some(CONVERSATIONS_FILE) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| KbError::Parse(format!("cannot read {CONVERSATIONS_FILE}: {e}")))?;
        return String::from_utf8(bytes)
            .map_err(|e| KbError::Parse(format!("{CONVERSATIONS_FILE} is not UTF-8: {e}")));
    }
    Err(KbError::Parse(format!("zip has no {CONVERSATIONS_FILE}")))
}

/// Parse an export: a folder, a `conversations.json` file or a `.zip`.
pub fn parse_export(path: &Path) -> Result<Vec<Session>, KbError> {
    let meta = std::fs::metadata(path)?;
    let text = if meta.is_dir() {
        let file = path.join(CONVERSATIONS_FILE);
        if !file.is_file() {
            return Err(KbError::Parse(format!(
                "no {CONVERSATIONS_FILE} in {}",
                path.display()
            )));
        }
        std::fs::read_to_string(file)?
    } else if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        read_zip(path)?
    } else {
        std::fs::read_to_string(path)?
    };
    parse_conversations_json(&text)
}
