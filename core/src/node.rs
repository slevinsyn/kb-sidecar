//! Markdown session nodes.

use serde_json::Value;

use crate::{Block, Role, Session};

const MAX_RESULT_CHARS: usize = 2000;

/// File-name safe slug.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    // `out` is pure ASCII here, so byte and character counts agree.
    out.truncate(60);
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `{date}-{slug(title)}-{id8}.md`
pub fn node_file_name(s: &Session) -> String {
    let date: String = match &s.started_at {
        Some(t) => {
            let d: String = t
                .chars()
                .take(10)
                .filter(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            if d.is_empty() {
                "undated".to_string()
            } else {
                d
            }
        }
        None => "undated".to_string(),
    };
    let id8: String = slug(&s.id).chars().take(8).collect();
    format!("{}-{}-{}.md", date, slug(&s.title), id8)
}

fn json<T: serde::Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".to_string())
}

/// Wrap `content` in a fence one backtick longer than its longest backtick run (min 3).
fn fenced(lang: &str, content: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for c in content.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}{lang}\n{content}\n{fence}")
}

fn render_block(block: &Block) -> String {
    match block {
        Block::Text(t) => t.clone(),
        Block::Thinking(t) => format!("<details><summary>Thinking</summary>\n\n{t}\n\n</details>"),
        Block::ToolUse { name, input, .. } => {
            let pretty = serde_json::to_string_pretty::<Value>(input)
                .unwrap_or_else(|_| "null".to_string());
            format!("**Tool call** `{}`\n{}", name, fenced("json", &pretty))
        }
        Block::ToolResult {
            content, is_error, ..
        } => {
            let total = content.chars().count();
            let body = if total > MAX_RESULT_CHARS {
                let cut: String = content.chars().take(MAX_RESULT_CHARS).collect();
                format!("{cut}\n\u{2026} [truncated {} chars]", total - MAX_RESULT_CHARS)
            } else {
                content.clone()
            };
            let label = if *is_error {
                "**Tool result** (error)"
            } else {
                "**Tool result**"
            };
            format!("{label}\n{}", fenced("", &body))
        }
    }
}

/// Render a session as a Markdown node.
pub fn render_node(s: &Session, topics: &[String]) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", json(&s.id)));
    out.push_str(&format!("source: {}\n", json(s.source.as_str())));
    out.push_str(&format!("title: {}\n", json(&s.title)));
    out.push_str(&format!("project: {}\n", json(&s.project)));
    out.push_str(&format!("branch: {}\n", json(&s.git_branch)));
    out.push_str(&format!("cwd: {}\n", json(&s.cwd)));
    out.push_str(&format!("started_at: {}\n", json(&s.started_at)));
    out.push_str(&format!("ended_at: {}\n", json(&s.ended_at)));
    out.push_str(&format!("models: {}\n", json(&s.models)));
    out.push_str(&format!("turns: {}\n", s.turn_count()));
    let tools = s.tools_used();
    out.push_str(&format!("tools: {}\n", json(&tools)));
    out.push_str(&format!("files: {}\n", json(&s.files_touched())));
    out.push_str(&format!("prs: {}\n", json(&s.prs)));
    out.push_str(&format!("topics: {}\n", json(topics)));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", s.title));

    if let Some(p) = &s.project {
        out.push_str(&format!("Project: [[project/{}]]\n", slug(p)));
    }
    if !topics.is_empty() {
        let links: Vec<String> = topics.iter().map(|t| format!("[[topic/{t}]]")).collect();
        out.push_str(&format!("Topics: {}\n", links.join(" \u{b7} ")));
    }
    if !tools.is_empty() {
        out.push_str(&format!("Tools: {}\n", tools.join(", ")));
    }
    if s.project.is_some() || !topics.is_empty() || !tools.is_empty() {
        out.push('\n');
    }
    out.push_str("## Conversation\n");

    for m in &s.messages {
        let who = match m.role {
            Role::User => "User",
            Role::Assistant => "Assistant",
        };
        let heading = match &m.timestamp {
            Some(ts) => format!("### {who} \u{b7} {ts}"),
            None => format!("### {who}"),
        };
        out.push('\n');
        out.push_str(&heading);
        out.push('\n');
        for b in &m.blocks {
            out.push('\n');
            out.push_str(&render_block(b));
            out.push('\n');
        }
    }
    // Canonical ending: exactly one trailing newline.
    let trimmed_len = out.trim_end_matches('\n').len();
    out.truncate(trimmed_len);
    out.push('\n');
    out
}
