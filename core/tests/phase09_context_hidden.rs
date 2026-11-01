//! Phase 09 hidden (holdout) tests for `kb_core::context` and `kb context`.
//! Self-contained; inputs differ from `phase09_context.rs`.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use kb_core::context::{build_context, ContextOptions};
use kb_core::KbError;
use serde_json::{json, Map, Value};
use tempfile::TempDir;

const KB: &str = env!("CARGO_BIN_EXE_kb");

// (id, label, started_at (None = JSON null), project, topics, files, node_file)
type Row<'a> = (
    &'a str,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    Vec<&'a str>,
    Vec<&'a str>,
    &'a str,
);

fn graph(rows: &[Row]) -> String {
    let mut nodes: Vec<Value> = Vec::new();
    let mut links: Vec<Value> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (id, label, at, project, topics, files, note) in rows {
        let sid = format!("session:{id}");
        let mut meta = Map::new();
        meta.insert("started_at".into(), at.map(|v| json!(v)).unwrap_or(Value::Null));
        meta.insert("project".into(), project.map(|v| json!(v)).unwrap_or(Value::Null));
        meta.insert("topics".into(), json!(topics));
        meta.insert("node_file".into(), json!(note));
        nodes.push(json!({"id": sid, "type": "session", "label": label, "size": 1,
                          "meta": Value::Object(meta)}));
        for t in topics {
            let tid = format!("topic:{t}");
            if seen.insert(tid.clone()) {
                nodes.push(json!({"id": tid, "type": "topic", "label": t, "size": 1, "meta": {}}));
            }
            links.push(json!({"source": sid, "target": tid, "type": "has_topic"}));
        }
        for f in files {
            let fid = format!("file:{f}");
            if seen.insert(fid.clone()) {
                nodes.push(json!({"id": fid, "type": "file", "label": f, "size": 1, "meta": {}}));
            }
            links.push(json!({"source": sid, "target": fid, "type": "touched_file"}));
        }
        if let Some(p) = project {
            let pid = format!("project:{p}");
            if seen.insert(pid.clone()) {
                nodes.push(json!({"id": pid, "type": "project", "label": p, "size": 1, "meta": {}}));
            }
            links.push(json!({"source": sid, "target": pid, "type": "in_project"}));
        }
    }
    json!({"nodes": nodes, "links": links}).to_string()
}

fn run(rows: &[Row], query: &str, limit: usize, max_chars: usize) -> String {
    build_context(&graph(rows), query, &ContextOptions { limit, max_chars }).expect("valid graph")
}

fn section(out: &str, header: &str) -> Vec<String> {
    let mut res = Vec::new();
    let mut found = false;
    for l in out.lines() {
        if found {
            if l.is_empty() {
                break;
            }
            res.push(l.to_string());
        } else if l == header {
            found = true;
        }
    }
    res
}

fn labels(out: &str) -> Vec<String> {
    section(out, "## Sessions")
        .iter()
        .map(|l| l.split(" · ").nth(1).unwrap().to_string())
        .collect()
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn compose_rows() -> Vec<Row<'static>> {
    vec![
        (
            "k1",
            "Compose migration",
            Some("2026-08-14T23:59:59Z"),
            Some("infra"),
            vec!["docker", "migration"],
            vec!["deploy/docker-compose.yml"],
            "2026-08-14-compose-migration-k1.md",
        ),
        (
            "k2",
            "Docker tips",
            Some("2026-08-14T08:00:00Z"),
            Some("infra"),
            vec!["containers", "docker"],
            vec![],
            "2026-08-14-docker-tips-k2.md",
        ),
        ("k3", "Gardening", None, None, vec![], vec![], "undated-gardening-k3.md"),
    ]
}

#[test]
fn hidden_AC_09_01_scoring_weights_and_ordering() {
    // query "ledger audit":
    //   r1: topic ledger 3 + title audit 2             = 5
    //   r2: project "audit-team" (audit 2) + file ledger 1 = 3
    //   r3: title "Ledger audit" 2 + 2                 = 4
    //   r4: file "reports/AUDIT_ledger.csv" 1 + 1      = 2
    //   r5: topics "ledgers" (3) + "audits" (3)         = 6
    let rows: Vec<Row> = vec![
        ("r4", "Misc", Some("2026-12-31"), None, vec![], vec!["reports/AUDIT_ledger.csv"], "r4.md"),
        ("r2", "Plain", Some("2026-12-30"), Some("audit-team"), vec![], vec!["db/ledger.sql"], "r2.md"),
        ("r3", "Ledger audit", Some("2026-12-29"), None, vec![], vec![], "r3.md"),
        ("r1", "Audit follow-up", Some("2026-12-28"), None, vec!["ledger"], vec![], "r1.md"),
        ("r5", "Xylophone", Some("2026-12-27"), None, vec!["ledgers", "audits"], vec![], "r5.md"),
    ];
    let out = run(&rows, "ledger audit", 10, 100_000);
    assert_eq!(
        labels(&out),
        strs(&["Xylophone", "Audit follow-up", "Ledger audit", "Plain", "Misc"])
    );
}

#[test]
fn hidden_AC_09_02_tie_order() {
    let rows: Vec<Row> = vec![
        ("b", "Router fix B", Some("2026-01-02T00:00:00Z"), None, vec![], vec![], "b.md"),
        ("c", "Router fix C", None, None, vec![], vec![], "c.md"),
        ("a", "Router fix A", Some("2026-01-02T00:00:00Z"), None, vec![], vec![], "a.md"),
        ("d", "Router fix D", Some("2026-01-03T00:00:00Z"), None, vec![], vec![], "d.md"),
        ("0", "Router fix Zero", None, None, vec![], vec![], "0.md"),
    ];
    let out = run(&rows, "router", 10, 100_000);
    assert_eq!(
        labels(&out),
        strs(&["Router fix D", "Router fix A", "Router fix B", "Router fix Zero", "Router fix C"])
    );
}

#[test]
fn hidden_AC_09_03_exact_layout() {
    let out = run(&compose_rows(), " Docker Compose\t", 8, 4000);
    let expected = [
        "# Context: Docker Compose",
        "",
        "Matched 2 of 3 sessions (showing 2).",
        "",
        "## Sessions",
        "- 2026-08-14 · Compose migration · project: infra · topics: docker, migration · note: 2026-08-14-compose-migration-k1.md",
        "- 2026-08-14 · Docker tips · project: infra · topics: containers, docker · note: 2026-08-14-docker-tips-k2.md",
        "",
        "## Related topics",
        "- containers (1)",
        "- migration (1)",
        "",
        "## Files",
        "- deploy/docker-compose.yml (1)",
        "",
        "## Projects",
        "- infra (2)",
    ]
    .join("\n")
        + "\n";
    assert_eq!(out, expected);
    let again = run(&compose_rows(), " Docker Compose\t", 8, 4000);
    assert_eq!(out, again);
}

#[test]
fn hidden_AC_09_04_caps_and_exclusions() {
    // 11 topics, 11 files, 6 projects across 6 shown sessions.
    let topic_names: Vec<String> = (1..=11).map(|i| format!("topic-{i:02}")).collect();
    let file_names: Vec<String> = (1..=11).map(|i| format!("lib/m{i:02}.rs")).collect();
    let projects = ["q1", "q2", "q3", "q4", "q5", "q6"];
    let mut rows: Vec<Row> = Vec::new();
    let labels_src = [
        "Server one", "Server two", "Server three", "Server four", "Server five", "Server six",
    ];
    let ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    for i in 0..6 {
        // "servers" normalises to "server" (plain trailing-s rule) = the query term: excluded
        let mut topics: Vec<&str> = vec!["servers"];
        let mut files: Vec<&str> = vec![];
        if i == 0 {
            topics.extend(topic_names.iter().map(|s| s.as_str()));
            files.extend(file_names.iter().map(|s| s.as_str()));
        }
        if i < 3 {
            topics.push("topic-11"); // gives topic-11 a count of 3 (incl. session 0)
            files.push("lib/m11.rs");
        }
        rows.push((ids[i], labels_src[i], None, Some(projects[i]), topics, files, "x.md"));
    }
    // Remove duplicate "topic-11" in session 0 (it was added by the extend and the push).
    if let Some(r) = rows.get_mut(0) {
        r.4.pop();
        r.5.pop();
    }
    let out = run(&rows, "server", 10, 100_000);
    let t = section(&out, "## Related topics");
    // topic-11: sessions c1,c2,c3 = 3; topic-01..topic-09 = 1 each (c1 only) -> cap 10 total.
    let mut want = vec!["- topic-11 (3)".to_string()];
    for i in 1..=9 {
        want.push(format!("- topic-{i:02} (1)"));
    }
    assert_eq!(t, want);
    assert!(!t.iter().any(|l| l.contains("topic-10")));
    assert!(!t.iter().any(|l| l.contains("servers")));

    let f = section(&out, "## Files");
    let mut want_f = vec!["- lib/m11.rs (3)".to_string()];
    for i in 1..=9 {
        want_f.push(format!("- lib/m{i:02}.rs (1)"));
    }
    assert_eq!(f, want_f);
    assert!(!out.contains("lib/m10.rs"));

    assert_eq!(
        section(&out, "## Projects"),
        strs(&["- q1 (1)", "- q2 (1)", "- q3 (1)", "- q4 (1)", "- q5 (1)"])
    );
}

#[test]
fn hidden_AC_09_05_limit_and_hand_computed_truncation() {
    // limit
    let rows: Vec<Row> = vec![
        ("a", "Mailer 1", Some("2026-02-03"), None, vec!["shown"], vec![], "a.md"),
        ("b", "Mailer 2", Some("2026-02-02"), None, vec!["also-hidden"], vec![], "b.md"),
        ("c", "Mailer 3", Some("2026-02-01"), None, vec![], vec![], "c.md"),
    ];
    let out = run(&rows, "mailer", 1, 100_000);
    assert!(out.contains("Matched 3 of 3 sessions (showing 1)."));
    assert_eq!(labels(&out), strs(&["Mailer 1"]));
    assert_eq!(section(&out, "## Related topics"), strs(&["- shown (1)"]));

    // truncation: "# Context: payroll\n" = 19, "\n" = 1, "Matched ... .\n" = 37, marker = 14.
    let one: Vec<Row> = vec![("p", "Payroll run", None, None, vec![], vec![], "p.md")];
    let out71 = run(&one, "payroll", 8, 71);
    assert_eq!(
        out71,
        "# Context: payroll\n\nMatched 1 of 1 sessions (showing 1).\n… [truncated]\n"
    );
    let out72 = run(&one, "payroll", 8, 72);
    assert_eq!(
        out72,
        "# Context: payroll\n\nMatched 1 of 1 sessions (showing 1).\n\n… [truncated]\n"
    );
    // A generous limit leaves the output alone and keeps the single trailing newline.
    let full = run(&one, "payroll", 8, 4000);
    assert!(full.ends_with("note: p.md\n"));
    assert!(!full.ends_with("\n\n"));
    assert!(!full.contains("truncated"));
}

#[test]
fn hidden_AC_09_06_no_match_forms() {
    let rows = compose_rows();
    assert_eq!(run(&rows, "quantum", 8, 4000), "No sessions match \"quantum\".\n");
    assert_eq!(run(&rows, "  to be or not  ", 8, 4000), "No sessions match \"to be or not\".\n");
    assert_eq!(run(&rows, "", 8, 4000), "No sessions match \"\".\n");
    assert_eq!(run(&[], "docker", 8, 4000), "No sessions match \"docker\".\n");
}

#[test]
fn hidden_AC_09_07_parse_errors() {
    for text in ["nope", "null", "{\"nodes\":[],\"link\":[]}", "{\"nodes\":1,\"links\":2}", "[{\"nodes\":[]}]"] {
        let r = build_context(text, "docker", &ContextOptions::default());
        assert!(matches!(r, Err(KbError::Parse(_))), "{text}: {r:?}");
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

fn kb(tmp: &TempDir, args: &[&str]) -> Output {
    Command::new(KB)
        .args(args)
        .env("HOME", tmp.path().join("home"))
        .env_remove("KB_HOME")
        .current_dir(tmp.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run kb")
}

fn put_graph(out: &Path, text: &str) {
    fs::create_dir_all(out.join("graph")).unwrap();
    fs::write(out.join("graph").join("graph.json"), text).unwrap();
}

#[test]
fn hidden_AC_09_08_cli_end_to_end() {
    let tmp = TempDir::new().unwrap();
    let out = tmp.path().join("kbout");
    put_graph(&out, &graph(&compose_rows()));
    let outs = out.to_string_lossy().into_owned();

    let o = kb(&tmp, &["context", "--max-chars", "5000", "docker", "compose", "--out", &outs, "--limit", "1"]);
    assert_eq!(o.status.code(), Some(0));
    let text = String::from_utf8_lossy(&o.stdout).into_owned();
    assert!(text.starts_with("# Context: docker compose\n\nMatched 2 of 3 sessions (showing 1).\n\n## Sessions\n"));
    assert_eq!(labels(&text), strs(&["Compose migration"]));
    assert_eq!(section(&text, "## Related topics"), strs(&["- migration (1)"]));
    assert_eq!(section(&text, "## Projects"), strs(&["- infra (1)"]));

    let none = kb(&tmp, &["context", "quantum", "physics", "--out", &outs]);
    assert_eq!(none.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&none.stdout), "No sessions match \"quantum physics\".\n");
}

#[test]
fn hidden_AC_09_09_cli_errors() {
    let tmp = TempDir::new().unwrap();
    let out = tmp.path().join("kbout");
    let outs = out.to_string_lossy().into_owned();

    // missing graph.json -> 1 with the file name in the message
    let o = kb(&tmp, &["context", "docker", "--out", &outs]);
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("graph.json"));

    put_graph(&out, &graph(&compose_rows()));

    for args in [
        vec!["context"],
        vec!["context", "--out", outs.as_str()],
        vec!["context", "docker", "--verbose", "--out", outs.as_str()],
        vec!["context", "docker", "--out", outs.as_str(), "--limit", "0"],
        vec!["context", "docker", "--out", outs.as_str(), "--max-chars", "0"],
        vec!["context", "docker", "--out", outs.as_str(), "--max-chars", "many"],
        vec!["context", "docker", "--out", outs.as_str(), "--limit"],
    ] {
        let o = kb(&tmp, &args);
        assert_eq!(o.status.code(), Some(2), "args {args:?}");
        assert!(o.stdout.is_empty(), "args {args:?}");
        assert!(!o.stderr.is_empty(), "args {args:?}");
    }

    put_graph(&out, "{\"nodes\": []}");
    let o = kb(&tmp, &["context", "docker", "--out", &outs]);
    assert_eq!(o.status.code(), Some(1));
    assert!(!o.stderr.is_empty());
}
