//! Knowledge graph data (graph.json).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::node::node_file_name;
use crate::Session;

/// One node of the graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    pub size: usize,
    pub meta: serde_json::Value,
}

/// One link of the graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphLink {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// Nodes and links.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
}

const KIND_ORDER: [&str; 5] = ["session", "project", "topic", "file", "tool"];

fn kind_rank(kind: &str) -> usize {
    KIND_ORDER
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(KIND_ORDER.len())
}

/// A non-session node a session links to.
struct Target {
    id: String,
    kind: &'static str,
    label: String,
    meta: serde_json::Value,
    link_kind: &'static str,
}

fn targets_of(session: &Session, topics: &[String], tools: &[String]) -> Vec<Target> {
    let mut targets = Vec::new();
    if let Some(project) = &session.project {
        targets.push(Target {
            id: format!("project:{project}"),
            kind: "project",
            label: project.clone(),
            meta: json!({}),
            link_kind: "in_project",
        });
    }
    for topic in topics {
        targets.push(Target {
            id: format!("topic:{topic}"),
            kind: "topic",
            label: topic.clone(),
            meta: json!({}),
            link_kind: "has_topic",
        });
    }
    for path in session.files_touched() {
        let label = path.rsplit('/').next().unwrap_or(&path).to_string();
        targets.push(Target {
            id: format!("file:{path}"),
            kind: "file",
            label,
            meta: json!({ "path": path }),
            link_kind: "touched_file",
        });
    }
    for tool in tools {
        targets.push(Target {
            id: format!("tool:{tool}"),
            kind: "tool",
            label: tool.clone(),
            meta: json!({}),
            link_kind: "used_tool",
        });
    }
    targets
}

/// Build the graph from sessions with their topics.
pub fn build_graph(sessions: &[(Session, Vec<String>)]) -> Graph {
    // Later sessions replace earlier ones with the same id.
    let mut unique: BTreeMap<&str, &(Session, Vec<String>)> = BTreeMap::new();
    for entry in sessions {
        unique.insert(entry.0.id.as_str(), entry);
    }

    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut links: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut others: BTreeMap<String, GraphNode> = BTreeMap::new();

    for entry in unique.values() {
        let (session, topics) = (&entry.0, &entry.1);
        let sid = format!("session:{}", session.id);
        let tools = session.tools_used();
        let turns = session.turn_count();
        nodes.push(GraphNode {
            id: sid.clone(),
            kind: "session".to_string(),
            label: session.title.clone(),
            size: turns.max(1),
            meta: json!({
                "source": session.source.as_str(),
                "project": session.project,
                "started_at": session.started_at,
                "ended_at": session.ended_at,
                "turns": turns,
                "models": session.models,
                "tools": tools,
                "topics": topics,
                "node_file": node_file_name(session),
            }),
        });

        for t in targets_of(session, topics, &tools) {
            let is_new = links.insert((sid.clone(), t.id.clone(), t.link_kind.to_string()));
            let node = others.entry(t.id.clone()).or_insert_with(|| GraphNode {
                id: t.id,
                kind: t.kind.to_string(),
                label: t.label,
                size: 0,
                meta: t.meta,
            });
            if is_new {
                node.size += 1;
            }
        }
    }

    nodes.extend(others.into_values());
    nodes.sort_by(|a, b| (kind_rank(&a.kind), &a.id).cmp(&(kind_rank(&b.kind), &b.id)));

    Graph {
        nodes,
        links: links
            .into_iter()
            .map(|(source, target, kind)| GraphLink {
                source,
                target,
                kind,
            })
            .collect(),
    }
}

impl Graph {
    /// Pretty JSON ending with a newline.
    pub fn to_json(&self) -> String {
        let mut out = serde_json::to_string_pretty(self).unwrap_or_default();
        out.push('\n');
        out
    }
}
