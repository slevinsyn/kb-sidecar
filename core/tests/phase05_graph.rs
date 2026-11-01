use kb_core::graph::{build_graph, Graph, GraphLink, GraphNode};
use kb_core::node::node_file_name;
use kb_core::{Block, Message, Role, Session, Source};
use serde_json::{json, Value};
use std::collections::HashSet;

fn user_msg(text: &str) -> Message {
    Message {
        role: Role::User,
        timestamp: None,
        blocks: vec![Block::Text(text.to_string())],
    }
}

fn assistant_tools(tools: &[(&str, Option<&str>)]) -> Message {
    let blocks = tools
        .iter()
        .enumerate()
        .map(|(i, (name, file))| Block::ToolUse {
            id: format!("tu_{i}"),
            name: (*name).to_string(),
            input: match file {
                Some(f) => json!({ "file_path": f }),
                None => json!({ "command": "ls" }),
            },
        })
        .collect();
    Message {
        role: Role::Assistant,
        timestamp: None,
        blocks,
    }
}

fn make_session(
    id: &str,
    title: &str,
    project: Option<&str>,
    turns: usize,
    tools: &[(&str, Option<&str>)],
) -> Session {
    let mut messages = Vec::new();
    for i in 0..turns {
        messages.push(user_msg(&format!("question {i}")));
        if i == 0 && !tools.is_empty() {
            messages.push(assistant_tools(tools));
        }
    }
    if turns == 0 && !tools.is_empty() {
        messages.push(assistant_tools(tools));
    }
    Session {
        id: id.to_string(),
        source: if project.is_some() {
            Source::ClaudeCode
        } else {
            Source::ClaudeAi
        },
        title: title.to_string(),
        project: project.map(|p| p.to_string()),
        cwd: project.map(|p| format!("/home/a/{p}")),
        git_branch: None,
        started_at: Some("2026-10-01T10:00:00.000Z".to_string()),
        ended_at: Some("2026-10-01T11:00:00.000Z".to_string()),
        models: vec!["claude-opus-5-5".to_string()],
        messages,
        prs: vec![],
    }
}

fn topics(t: &[&str]) -> Vec<String> {
    t.iter().map(|s| s.to_string()).collect()
}

fn node<'a>(g: &'a Graph, id: &str) -> &'a GraphNode {
    g.nodes
        .iter()
        .find(|n| n.id == id)
        .unwrap_or_else(|| panic!("node {id} missing"))
}

fn has_link(g: &Graph, source: &str, target: &str, kind: &str) -> bool {
    g.links
        .iter()
        .any(|l| l.source == source && l.target == target && l.kind == kind)
}

fn count_kind(g: &Graph, kind: &str) -> usize {
    g.nodes.iter().filter(|n| n.kind == kind).count()
}

fn assert_no_dangling_or_dups(g: &Graph) {
    let ids: HashSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids.len(), g.nodes.len(), "duplicate node ids");
    let mut seen = HashSet::new();
    for l in &g.links {
        assert!(ids.contains(l.source.as_str()), "dangling source {}", l.source);
        assert!(ids.contains(l.target.as_str()), "dangling target {}", l.target);
        assert!(
            seen.insert((l.source.clone(), l.target.clone(), l.kind.clone())),
            "duplicate link {:?}",
            l
        );
    }
}

fn kind_rank(kind: &str) -> usize {
    ["session", "project", "topic", "file", "tool"]
        .iter()
        .position(|k| *k == kind)
        .unwrap_or_else(|| panic!("unexpected node kind {kind}"))
}

fn assert_sorted(g: &Graph) {
    for w in g.nodes.windows(2) {
        let a = (kind_rank(&w[0].kind), w[0].id.clone());
        let b = (kind_rank(&w[1].kind), w[1].id.clone());
        assert!(a < b, "nodes out of order: {} before {}", w[0].id, w[1].id);
    }
    for w in g.links.windows(2) {
        let a = (&w[0].source, &w[0].target, &w[0].kind);
        let b = (&w[1].source, &w[1].target, &w[1].kind);
        assert!(a < b, "links out of order: {:?} before {:?}", w[0], w[1]);
    }
}

#[test]
fn test_AC_05_01_shared_project_topic_and_tool_have_size_two() {
    let s1 = make_session(
        "s1",
        "Ingress setup",
        Some("alpha"),
        2,
        &[("Read", Some("/home/a/alpha/a.txt"))],
    );
    let s2 = make_session(
        "s2",
        "Helm charts",
        Some("alpha"),
        1,
        &[("Read", Some("/home/a/alpha/b.txt"))],
    );
    let input = vec![
        (s1, topics(&["kubernetes", "ingress"])),
        (s2, topics(&["kubernetes", "helm"])),
    ];
    let g = build_graph(&input);

    assert_eq!(count_kind(&g, "project"), 1);
    assert_eq!(node(&g, "project:alpha").size, 2);
    assert_eq!(count_kind(&g, "topic"), 3);
    assert_eq!(node(&g, "topic:kubernetes").size, 2);
    assert_eq!(node(&g, "topic:ingress").size, 1);
    assert_eq!(node(&g, "topic:helm").size, 1);
    assert_eq!(count_kind(&g, "tool"), 1);
    assert_eq!(node(&g, "tool:Read").size, 2);
    assert_eq!(count_kind(&g, "session"), 2);
    assert_eq!(count_kind(&g, "file"), 2);

    for sid in ["session:s1", "session:s2"] {
        assert!(has_link(&g, sid, "project:alpha", "in_project"));
        assert!(has_link(&g, sid, "topic:kubernetes", "has_topic"));
        assert!(has_link(&g, sid, "tool:Read", "used_tool"));
    }
    assert!(has_link(&g, "session:s1", "topic:ingress", "has_topic"));
    assert!(has_link(&g, "session:s2", "topic:helm", "has_topic"));
    assert!(!has_link(&g, "session:s2", "topic:ingress", "has_topic"));
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_02_ids_kinds_labels_and_file_meta() {
    let s = make_session(
        "abc-123",
        "Fix the parser",
        Some("my-proj"),
        3,
        &[
            ("Read", Some("/home/a/my-proj/src/main.rs")),
            ("Edit", Some("/home/a/my-proj/src/main.rs")),
            ("Bash", None),
        ],
    );
    let input = vec![(s, topics(&["parser"]))];
    let g = build_graph(&input);

    let sn = node(&g, "session:abc-123");
    assert_eq!(sn.kind, "session");
    assert_eq!(sn.label, "Fix the parser");
    assert_eq!(sn.size, 3);

    let pn = node(&g, "project:my-proj");
    assert_eq!(pn.kind, "project");
    assert_eq!(pn.label, "my-proj");
    assert_eq!(pn.size, 1);
    assert_eq!(pn.meta, json!({}));

    let tn = node(&g, "topic:parser");
    assert_eq!(tn.kind, "topic");
    assert_eq!(tn.label, "parser");
    assert_eq!(tn.size, 1);
    assert_eq!(tn.meta, json!({}));

    let fnode = node(&g, "file:/home/a/my-proj/src/main.rs");
    assert_eq!(fnode.kind, "file");
    assert_eq!(fnode.label, "main.rs");
    assert_eq!(fnode.size, 1);
    assert_eq!(fnode.meta, json!({ "path": "/home/a/my-proj/src/main.rs" }));
    assert_eq!(count_kind(&g, "file"), 1);

    for name in ["Read", "Edit", "Bash"] {
        let t = node(&g, &format!("tool:{name}"));
        assert_eq!(t.kind, "tool");
        assert_eq!(t.label, name);
        assert_eq!(t.size, 1);
        assert_eq!(t.meta, json!({}));
        assert!(has_link(&g, "session:abc-123", &format!("tool:{name}"), "used_tool"));
    }
    assert!(has_link(
        &g,
        "session:abc-123",
        "file:/home/a/my-proj/src/main.rs",
        "touched_file"
    ));
    assert!(has_link(&g, "session:abc-123", "project:my-proj", "in_project"));
    assert!(has_link(&g, "session:abc-123", "topic:parser", "has_topic"));
    assert_eq!(g.nodes.len(), 1 + 1 + 1 + 1 + 3);
    assert_eq!(g.links.len(), 1 + 1 + 1 + 3);
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_02_session_size_is_at_least_one_and_file_size_counts_sessions() {
    let zero_turns = make_session(
        "z1",
        "Assistant only",
        Some("p"),
        0,
        &[("Read", Some("/x/y/shared.rs"))],
    );
    assert_eq!(zero_turns.turn_count(), 0);
    let other = make_session(
        "z2",
        "Another",
        Some("p"),
        5,
        &[("Write", Some("/x/y/shared.rs"))],
    );
    let input = vec![(zero_turns, vec![]), (other, vec![])];
    let g = build_graph(&input);

    assert_eq!(node(&g, "session:z1").size, 1);
    assert_eq!(node(&g, "session:z2").size, 5);
    let f = node(&g, "file:/x/y/shared.rs");
    assert_eq!(f.size, 2);
    assert_eq!(f.label, "shared.rs");
    assert_eq!(node(&g, "project:p").size, 2);
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_03_session_meta_contains_all_fields() {
    let mut s = make_session(
        "meta-1",
        "Meta check",
        Some("proj-m"),
        2,
        &[("Read", Some("/a/b.rs")), ("Grep", None)],
    );
    s.models = vec!["claude-opus-5-5".to_string(), "claude-haiku-5".to_string()];
    s.started_at = Some("2026-09-15T08:00:00.000Z".to_string());
    s.ended_at = Some("2026-09-15T09:30:00.000Z".to_string());
    let expected_file = node_file_name(&s);
    let tools = s.tools_used();
    let input = vec![(s, topics(&["alpha", "beta"]))];
    let g = build_graph(&input);

    let meta = &node(&g, "session:meta-1").meta;
    assert_eq!(meta["source"], json!("claude-code"));
    assert_eq!(meta["project"], json!("proj-m"));
    assert_eq!(meta["started_at"], json!("2026-09-15T08:00:00.000Z"));
    assert_eq!(meta["ended_at"], json!("2026-09-15T09:30:00.000Z"));
    assert_eq!(meta["turns"], json!(2));
    assert_eq!(
        meta["models"],
        json!(["claude-opus-5-5", "claude-haiku-5"])
    );
    assert_eq!(meta["tools"], json!(tools));
    assert_eq!(meta["tools"], json!(["Grep", "Read"]));
    assert_eq!(meta["topics"], json!(["alpha", "beta"]));
    assert_eq!(meta["node_file"], json!(expected_file));
    assert!(expected_file.starts_with("2026-09-15-meta-check-"));
    assert_eq!(meta.as_object().map(|o| o.len()), Some(9));
}

#[test]
fn test_AC_05_04_claude_ai_session_has_topic_links_only() {
    let s = make_session("chat-9", "Cooking pasta", None, 2, &[]);
    assert_eq!(s.source, Source::ClaudeAi);
    let input = vec![(s, topics(&["pasta", "sauce"]))];
    let g = build_graph(&input);

    assert_eq!(count_kind(&g, "project"), 0);
    assert_eq!(count_kind(&g, "tool"), 0);
    assert_eq!(count_kind(&g, "file"), 0);
    assert_eq!(count_kind(&g, "session"), 1);
    assert_eq!(count_kind(&g, "topic"), 2);
    assert_eq!(g.nodes.len(), 3);
    assert_eq!(g.links.len(), 2);
    assert!(has_link(&g, "session:chat-9", "topic:pasta", "has_topic"));
    assert!(has_link(&g, "session:chat-9", "topic:sauce", "has_topic"));
    let meta = &node(&g, "session:chat-9").meta;
    assert_eq!(meta["project"], Value::Null);
    assert_eq!(meta["source"], json!("claude-ai"));
    assert_eq!(meta["tools"], json!([]));
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_05_no_duplicate_nodes_or_links() {
    let s = make_session(
        "d1",
        "Dupes",
        Some("dp"),
        1,
        &[
            ("Read", Some("/f/one.rs")),
            ("Read", Some("/f/one.rs")),
            ("Read", Some("/f/one.rs")),
        ],
    );
    let input = vec![(s, topics(&["same", "same", "other"]))];
    let g = build_graph(&input);

    assert_eq!(count_kind(&g, "topic"), 2);
    assert_eq!(node(&g, "topic:same").size, 1);
    assert_eq!(node(&g, "tool:Read").size, 1);
    assert_eq!(node(&g, "file:/f/one.rs").size, 1);
    let topic_links = g
        .links
        .iter()
        .filter(|l| l.target == "topic:same")
        .count();
    assert_eq!(topic_links, 1);
    let tool_links = g.links.iter().filter(|l| l.kind == "used_tool").count();
    assert_eq!(tool_links, 1);
    assert_eq!(g.links.len(), 1 + 2 + 1 + 1);
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_05_duplicate_session_id_keeps_later_session() {
    let earlier = make_session(
        "dup",
        "Old title",
        Some("old-proj"),
        1,
        &[("Bash", None)],
    );
    let later = make_session(
        "dup",
        "New title",
        Some("new-proj"),
        4,
        &[("Read", Some("/n/new.rs"))],
    );
    let input = vec![
        (earlier, topics(&["oldtopic"])),
        (later, topics(&["newtopic"])),
    ];
    let g = build_graph(&input);

    assert_eq!(count_kind(&g, "session"), 1);
    let sn = node(&g, "session:dup");
    assert_eq!(sn.label, "New title");
    assert_eq!(sn.size, 4);
    assert_eq!(sn.meta["topics"], json!(["newtopic"]));
    assert!(g.nodes.iter().all(|n| n.id != "project:old-proj"));
    assert!(g.nodes.iter().all(|n| n.id != "topic:oldtopic"));
    assert!(g.nodes.iter().all(|n| n.id != "tool:Bash"));
    assert!(has_link(&g, "session:dup", "project:new-proj", "in_project"));
    assert!(has_link(&g, "session:dup", "topic:newtopic", "has_topic"));
    assert!(has_link(&g, "session:dup", "tool:Read", "used_tool"));
    assert_eq!(g.links.len(), 4);
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_06_nodes_and_links_are_sorted() {
    let a = make_session(
        "zeta",
        "Zeta",
        Some("proj-b"),
        1,
        &[("Write", Some("/z/last.rs")), ("Read", Some("/a/first.rs"))],
    );
    let b = make_session(
        "alpha",
        "Alpha",
        Some("proj-a"),
        2,
        &[("Edit", Some("/m/mid.rs"))],
    );
    let c = make_session("mid", "Mid", None, 1, &[]);
    let input = vec![
        (a, topics(&["zebra", "apple"])),
        (b, topics(&["mango"])),
        (c, topics(&["banana"])),
    ];
    let g = build_graph(&input);

    assert_sorted(&g);
    let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "session:alpha",
            "session:mid",
            "session:zeta",
            "project:proj-a",
            "project:proj-b",
            "topic:apple",
            "topic:banana",
            "topic:mango",
            "topic:zebra",
            "file:/a/first.rs",
            "file:/m/mid.rs",
            "file:/z/last.rs",
            "tool:Edit",
            "tool:Read",
            "tool:Write",
        ]
    );
    assert_no_dangling_or_dups(&g);
}

#[test]
fn test_AC_05_06_to_json_is_deterministic_and_uses_type_key() {
    let a = make_session("s-a", "A", Some("p1"), 1, &[("Read", Some("/q/r.rs"))]);
    let b = make_session("s-b", "B", Some("p1"), 2, &[("Bash", None)]);
    let forward = vec![
        (a.clone(), topics(&["one", "two"])),
        (b.clone(), topics(&["two"])),
    ];
    let reversed = vec![(b, topics(&["two"])), (a, topics(&["one", "two"]))];

    let j1 = build_graph(&forward).to_json();
    let j2 = build_graph(&forward).to_json();
    assert_eq!(j1, j2);
    assert_eq!(j1, build_graph(&reversed).to_json());

    assert!(j1.ends_with("}\n"));
    assert!(!j1.ends_with("\n\n"));
    assert!(j1.contains("\n  "), "expected pretty-printed JSON");

    let v: Value = serde_json::from_str(&j1).expect("valid json");
    let nodes = v["nodes"].as_array().expect("nodes array");
    let links = v["links"].as_array().expect("links array");
    assert!(!nodes.is_empty());
    assert!(!links.is_empty());
    for n in nodes {
        assert!(n["type"].is_string());
        assert!(n.get("kind").is_none());
        assert!(n["id"].is_string());
        assert!(n["label"].is_string());
        assert!(n["size"].is_u64());
        assert!(n["meta"].is_object());
    }
    for l in links {
        assert!(l["type"].is_string());
        assert!(l.get("kind").is_none());
        assert!(l["source"].is_string());
        assert!(l["target"].is_string());
    }
    assert_eq!(nodes[0]["id"], json!("session:s-a"));
    assert_eq!(nodes[0]["type"], json!("session"));

    let back: Graph = serde_json::from_str(&j1).expect("graph round trip");
    assert_eq!(back, build_graph(&forward));
}

#[test]
fn test_AC_05_06_link_json_shape() {
    let l = GraphLink {
        source: "session:x".to_string(),
        target: "tool:Read".to_string(),
        kind: "used_tool".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&l).expect("serialise"),
        json!({ "source": "session:x", "target": "tool:Read", "type": "used_tool" })
    );
}

#[test]
fn test_AC_05_07_empty_input_gives_empty_graph() {
    let g = build_graph(&[]);
    assert!(g.nodes.is_empty());
    assert!(g.links.is_empty());
    let v: Value = serde_json::from_str(&g.to_json()).expect("valid json");
    assert_eq!(v, json!({ "nodes": [], "links": [] }));
    assert!(g.to_json().ends_with('\n'));
}
