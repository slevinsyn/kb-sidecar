//! Token-light context for assistants, built from graph.json.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::Value;

use crate::topics::{normalize_term, tokenize_clean};
use crate::KbError;

/// Options for `build_context`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextOptions {
    /// Most sessions shown.
    pub limit: usize,
    /// Most characters in the output.
    pub max_chars: usize,
}

impl Default for ContextOptions {
    fn default() -> Self {
        ContextOptions {
            limit: 8,
            max_chars: 4000,
        }
    }
}

const TRUNCATED: &str = "… [truncated]\n";
const MAX_RELATED_TOPICS: usize = 10;
const MAX_FILES: usize = 10;
const MAX_PROJECTS: usize = 5;

/// A session node, reduced to what the context needs.
struct SessionInfo {
    id: String,
    label: String,
    started_at: Option<String>,
    project: Option<String>,
    topics: Vec<String>,
    node_file: String,
    files: Vec<String>,
    score: usize,
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

fn no_match(query: &str) -> String {
    format!("No sessions match \"{query}\".\n")
}

fn parse_sessions(root: &Value) -> Result<Vec<SessionInfo>, KbError> {
    let nodes = root
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| KbError::Parse("graph has no `nodes` array".to_string()))?;
    let links = root
        .get("links")
        .and_then(Value::as_array)
        .ok_or_else(|| KbError::Parse("graph has no `links` array".to_string()))?;

    let labels: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|n| {
            Some((
                n.get("id")?.as_str()?,
                n.get("label").and_then(Value::as_str).unwrap_or(""),
            ))
        })
        .collect();

    let mut files: HashMap<&str, Vec<String>> = HashMap::new();
    for link in links {
        if link.get("type").and_then(Value::as_str) != Some("touched_file") {
            continue;
        }
        let (Some(src), Some(dst)) = (
            link.get("source").and_then(Value::as_str),
            link.get("target").and_then(Value::as_str),
        ) else {
            continue;
        };
        let label = match labels.get(dst) {
            Some(l) if !l.is_empty() => (*l).to_string(),
            _ => dst.strip_prefix("file:").unwrap_or(dst).to_string(),
        };
        let list = files.entry(src).or_default();
        if !list.contains(&label) {
            list.push(label);
        }
    }

    let mut sessions = Vec::new();
    for n in nodes {
        if n.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let Some(id) = n.get("id").and_then(Value::as_str) else {
            continue;
        };
        let meta = n.get("meta");
        let topics = meta
            .and_then(|m| m.get("topics"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        sessions.push(SessionInfo {
            id: id.to_string(),
            label: str_of(n.get("label")).unwrap_or_default(),
            started_at: str_of(meta.and_then(|m| m.get("started_at"))),
            project: str_of(meta.and_then(|m| m.get("project"))),
            topics,
            node_file: str_of(meta.and_then(|m| m.get("node_file"))).unwrap_or_default(),
            files: files.remove(id).unwrap_or_default(),
            score: 0,
        });
    }
    Ok(sessions)
}

/// True if a stored topic equals a query term. Query terms come from
/// `tokenize_clean`, which keeps tech terms verbatim and normalizes the rest,
/// so both the lowercased topic and its normalized form are compared.
fn topic_matches_term(topic: &str, term: &str) -> bool {
    let lower = topic.to_ascii_lowercase();
    term == lower || term == normalize_term(&lower)
}

fn score(s: &SessionInfo, terms: &[String]) -> usize {
    let title: BTreeSet<String> = tokenize_clean(&s.label).into_iter().collect();
    let project: BTreeSet<String> = s
        .project
        .as_deref()
        .map(|p| tokenize_clean(p).into_iter().collect())
        .unwrap_or_default();
    let files: Vec<String> = s.files.iter().map(|f| f.to_lowercase()).collect();

    terms
        .iter()
        .map(|t| {
            let mut sc = 0;
            if s.topics.iter().any(|topic| topic_matches_term(topic, t)) {
                sc += 3;
            }
            if title.contains(t) {
                sc += 2;
            }
            if project.contains(t) {
                sc += 2;
            }
            if files.iter().any(|f| f.contains(t.as_str())) {
                sc += 1;
            }
            sc
        })
        .sum()
}

/// `(name, count)` pairs: count descending, name ascending, at most `cap`.
fn ranked(counts: BTreeMap<String, usize>, cap: usize) -> Vec<(String, usize)> {
    let mut v: Vec<(String, usize)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v.truncate(cap);
    v
}

fn push_section(sections: &mut Vec<String>, title: &str, items: Vec<(String, usize)>) {
    if items.is_empty() {
        return;
    }
    let lines: Vec<String> = items
        .into_iter()
        .map(|(name, count)| format!("- {name} ({count})"))
        .collect();
    sections.push(format!("## {title}\n{}", lines.join("\n")));
}

fn truncate(text: String, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text;
    }
    let marker_len = TRUNCATED.chars().count();
    let mut kept = String::new();
    let mut used = 0usize;
    for line in text.split_inclusive('\n') {
        let len = line.chars().count();
        if used + len + marker_len > max_chars {
            break;
        }
        kept.push_str(line);
        used += len;
    }
    kept.push_str(TRUNCATED);
    kept
}

/// Build the Markdown context block for `query` from the graph JSON text.
pub fn build_context(
    graph_json: &str,
    query: &str,
    opts: &ContextOptions,
) -> Result<String, KbError> {
    let root: Value =
        serde_json::from_str(graph_json).map_err(|e| KbError::Parse(format!("graph: {e}")))?;
    let mut sessions = parse_sessions(&root)?;
    let query = query.trim();

    let mut terms: Vec<String> = Vec::new();
    for t in tokenize_clean(query) {
        if !terms.contains(&t) {
            terms.push(t);
        }
    }
    if terms.is_empty() {
        return Ok(no_match(query));
    }

    let total = sessions.len();
    for s in &mut sessions {
        s.score = score(s, &terms);
    }
    sessions.retain(|s| s.score > 0);
    if sessions.is_empty() {
        return Ok(no_match(query));
    }
    sessions.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.started_at.cmp(&a.started_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let matched = sessions.len();
    sessions.truncate(opts.limit);
    let shown = sessions.len();

    let mut topic_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut file_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut project_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut lines = Vec::new();
    for s in &sessions {
        let date: String = s
            .started_at
            .as_deref()
            .map(|d| d.chars().take(10).collect())
            .unwrap_or_else(|| "undated".to_string());
        let topics = if s.topics.is_empty() {
            "-".to_string()
        } else {
            s.topics.join(", ")
        };
        lines.push(format!(
            "- {date} · {} · project: {} · topics: {topics} · note: {}",
            s.label,
            s.project.as_deref().unwrap_or("-"),
            s.node_file
        ));

        let distinct: BTreeSet<&String> = s.topics.iter().collect();
        for t in distinct {
            if !terms.iter().any(|term| topic_matches_term(t, term)) {
                *topic_counts.entry(t.clone()).or_insert(0) += 1;
            }
        }
        for f in &s.files {
            *file_counts.entry(f.clone()).or_insert(0) += 1;
        }
        if let Some(p) = &s.project {
            *project_counts.entry(p.clone()).or_insert(0) += 1;
        }
    }

    let mut sections = vec![
        format!("# Context: {query}"),
        format!("Matched {matched} of {total} sessions (showing {shown})."),
        format!("## Sessions\n{}", lines.join("\n")),
    ];
    push_section(
        &mut sections,
        "Related topics",
        ranked(topic_counts, MAX_RELATED_TOPICS),
    );
    push_section(&mut sections, "Files", ranked(file_counts, MAX_FILES));
    push_section(
        &mut sections,
        "Projects",
        ranked(project_counts, MAX_PROJECTS),
    );

    let mut out = sections.join("\n\n");
    out.push('\n');
    Ok(truncate(out, opts.max_chars))
}
