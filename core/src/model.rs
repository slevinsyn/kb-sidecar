//! Shared data model: sessions, messages and blocks.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// Where a session came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Source {
    ClaudeCode,
    ClaudeAi,
}

impl Source {
    /// Stable string form used in output files.
    pub fn as_str(&self) -> &'static str {
        match self {
            Source::ClaudeCode => "claude-code",
            Source::ClaudeAi => "claude-ai",
        }
    }
}

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    User,
    Assistant,
}

/// One content block of a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Block {
    Text(String),
    Thinking(String),
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

/// One message of a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub timestamp: Option<String>,
    pub blocks: Vec<Block>,
}

/// One conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub source: Source,
    pub title: String,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub models: Vec<String>,
    pub messages: Vec<Message>,
    pub prs: Vec<String>,
}

impl Session {
    /// Sorted, de-duplicated names of all tools called in the session.
    pub fn tools_used(&self) -> Vec<String> {
        let names: BTreeSet<String> = self
            .messages
            .iter()
            .flat_map(|m| m.blocks.iter())
            .filter_map(|b| match b {
                Block::ToolUse { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect();
        names.into_iter().collect()
    }

    /// Sorted, de-duplicated file paths named in tool inputs.
    pub fn files_touched(&self) -> Vec<String> {
        let mut files = BTreeSet::new();
        for block in self.messages.iter().flat_map(|m| m.blocks.iter()) {
            if let Block::ToolUse { input, .. } = block {
                for key in ["file_path", "path", "notebook_path"] {
                    if let Some(path) = input.get(key).and_then(serde_json::Value::as_str) {
                        files.insert(path.to_string());
                    }
                }
            }
        }
        files.into_iter().collect()
    }

    /// Number of user messages that contain at least one text block.
    pub fn turn_count(&self) -> usize {
        self.messages
            .iter()
            .filter(|m| {
                m.role == Role::User && m.blocks.iter().any(|b| matches!(b, Block::Text(_)))
            })
            .count()
    }
}
