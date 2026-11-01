//! Phase 08 hidden tests: clean topics. Self-contained; inputs differ from the visible tests.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use kb_core::topics::*;
use serde_json::{json, Value};
use tempfile::TempDir;

const KB: &str = env!("CARGO_BIN_EXE_kb");

fn v(items: &[&str]) -> Vec<String> {
    items.iter().map(|x| x.to_string()).collect()
}

// ---------------------------------------------------------------------------------------------
// AC-08-01 / AC-08-02
// ---------------------------------------------------------------------------------------------

#[test]
fn hidden_AC_08_01_normalize_term_on_other_words() {
    let cases = [
        ("invoices", "invoice"),
        ("ledgers", "ledger"),
        ("wires", "wire"),
        ("pipes", "pipe"),
        ("companies", "company"),
        ("agencies", "agency"),
        ("batteries", "battery"),
        ("glasses", "glass"),
        ("watches", "watch"),
        ("bushes", "bush"),
        ("mixes", "mix"),
        ("foxes", "fox"),
        ("virus", "virus"),
        ("oasis", "oasis"),
        ("logos", "logos"),
        ("pods", "pods"),
        ("apis", "apis"),
        ("lens", "lens"),
        ("sql", "sql"),
        ("ledger", "ledger"),
        ("quarterly", "quarterly"),
    ];
    for (input, expected) in cases {
        assert_eq!(normalize_term(input), expected, "normalize_term({input:?})");
    }
}

#[test]
fn hidden_AC_08_02_tokenize_clean_on_other_sentences() {
    assert_eq!(
        tokenize_clean("Invoices, INVOICE; ledgers (quarterly) tomorrow goals"),
        v(&["invoice", "invoice", "ledger", "quarterly"])
    );
    assert_eq!(
        tokenize_clean("Today we said that the yesterday's morning meetings"),
        v(&["meeting"])
    );
    assert_eq!(
        tokenize_clean("update the deployments and check queries"),
        v(&["deployment", "query"])
    );
}

// ---------------------------------------------------------------------------------------------
// AC-08-03
// ---------------------------------------------------------------------------------------------

#[test]
fn hidden_AC_08_03_capitalised_plurals_and_lists() {
    assert!(tokenize_clean("Goals MONTHS Evenings Candidates Weeks Numbers").is_empty());
    for w in ["recap", "candidate", "primary", "pending", "afternoon", "update", "change"] {
        assert!(EXTRA_STOP_WORDS.contains(&w), "missing {w}");
        assert!(tokenize_clean(&w.to_uppercase()).is_empty());
    }
    for w in ["rust", "terraform", "vitest", "mcp", "llm", "fiori", "abap", "hana", "cdk"] {
        assert!(TECH_TERMS.contains(&w), "TECH_TERMS missing {w}");
    }
    let all: Vec<&str> = EXTRA_STOP_WORDS
        .iter()
        .chain(STOP_WORDS.iter())
        .copied()
        .filter(|w| w.chars().all(|c| c.is_ascii_alphanumeric()))
        .collect();
    let text = format!("zebra {} giraffe", all.join(", "));
    assert_eq!(tokenize_clean(&text), v(&["zebra", "giraffe"]));
}

// ---------------------------------------------------------------------------------------------
// AC-08-04 / AC-08-07
// ---------------------------------------------------------------------------------------------

#[test]
fn hidden_AC_08_04_AC_08_07_merge_limit_and_empty_docs() {
    let docs = v(&["ledgers ledger ledgers audit audit", "", "pasta"]);
    assert_eq!(
        extract_topics_clean(&docs, 2),
        vec![v(&["ledger", "audit"]), vec![], v(&["pasta"])]
    );
    assert_eq!(
        extract_topics_clean(&docs, 1),
        vec![v(&["ledger"]), vec![], v(&["pasta"])]
    );
    assert_eq!(extract_topics_clean(&docs, 0), vec![Vec::<String>::new(); 3]);
    assert_eq!(extract_topics_clean(&docs, 2), extract_topics_clean(&docs, 2));
    // Ties: the three singles are equal, alphabetical order decides.
    assert_eq!(
        extract_topics_clean(&v(&["warden quiver mantle"]), 2),
        vec![v(&["mantle", "quiver"])]
    );
}

// ---------------------------------------------------------------------------------------------
// AC-08-05
// ---------------------------------------------------------------------------------------------

#[test]
fn hidden_AC_08_05_frequency_cut_with_twelve_docs_and_not_with_nine() {
    // N = 12: gadget in 5 docs (41.7% > 40%) is dropped, sprocket in 4 docs (33%) is kept.
    let mut docs = Vec::new();
    for i in 0..4 {
        if i % 2 == 0 {
            docs.push(format!("gadget sprocket sprocket zork{i}"));
        } else {
            docs.push(format!("gadget sprockets sprocket zork{i}"));
        }
    }
    docs.push("gadget gadget zork4".to_string());
    for i in 5..12 {
        docs.push(format!("zork{i}"));
    }
    let topics = extract_topics_clean(&docs, 5);
    assert_eq!(topics.len(), 12);
    for i in 0..4 {
        assert_eq!(topics[i], vec!["sprocket".to_string(), format!("zork{i}")], "doc {i}");
    }
    for i in 4..12 {
        assert_eq!(topics[i], vec![format!("zork{i}")], "doc {i}");
    }

    // N = 9: no frequency cut at all, even for a term in every doc.
    let small: Vec<String> = (0..9).map(|i| format!("gadget gadget zork{i}")).collect();
    for (i, t) in extract_topics_clean(&small, 2).iter().enumerate() {
        assert_eq!(t, &vec![format!("zork{i}"), "gadget".to_string()], "doc {i}");
    }
}

// ---------------------------------------------------------------------------------------------
// AC-08-06
// ---------------------------------------------------------------------------------------------

#[test]
fn hidden_AC_08_06_tech_boost_on_other_terms() {
    assert_eq!(
        extract_topics_clean(&v(&["bagel cdk"]), 2),
        vec![v(&["cdk", "bagel"])]
    );
    assert_eq!(
        extract_topics_clean(&v(&["bagel lambdas"]), 2),
        vec![v(&["lambda", "bagel"])]
    );
    assert_eq!(
        extract_topics_clean(&v(&["avocado github", "avocado github"]), 2),
        vec![v(&["github", "avocado"]), v(&["github", "avocado"])]
    );
    // The boost is bounded: bagel tf 2/3 beats graphql tf 1/3 * 1.5.
    assert_eq!(
        extract_topics_clean(&v(&["bagel bagel graphql"]), 2),
        vec![v(&["bagel", "graphql"])]
    );
}

// ---------------------------------------------------------------------------------------------
// AC-08-09
// ---------------------------------------------------------------------------------------------

#[test]
fn hidden_AC_08_09_phase_03_functions_unchanged() {
    assert_eq!(
        tokenize("Invoices, queries; morning"),
        v(&["invoices", "queries", "morning"])
    );
    // Old pipeline: ledgers 2/4, audit 1/4, ledger 1/4 (tie -> alphabetical).
    assert_eq!(
        extract_topics(&v(&["ledger ledgers ledgers audit"]), 4),
        vec![v(&["ledgers", "audit", "ledger"])]
    );
}

// ---------------------------------------------------------------------------------------------
// AC-08-08
// ---------------------------------------------------------------------------------------------

fn user_line(sid: &str, cwd: &str, ts: &str, text: &str) -> String {
    json!({
        "type": "user", "sessionId": sid, "cwd": cwd, "gitBranch": "main",
        "timestamp": ts, "isSidechain": false,
        "message": {"role": "user", "content": text}
    })
    .to_string()
}

fn assistant_line(sid: &str, ts: &str, msg_id: &str, text: &str) -> String {
    json!({
        "type": "assistant", "sessionId": sid, "timestamp": ts,
        "message": {"id": msg_id, "model": "claude-opus-5-5", "role": "assistant",
                    "content": [{"type": "text", "text": text}]}
    })
    .to_string()
}

fn write_session(dir: &Path, sid: &str, cwd: &str, prompt: &str, reply: &str, day: &str) {
    fs::create_dir_all(dir).expect("create dir");
    let lines = [
        user_line(sid, cwd, &format!("{day}T10:00:00.000Z"), prompt),
        assistant_line(sid, &format!("{day}T10:00:05.000Z"), &format!("msg_{sid}"), reply),
    ];
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(dir.join(format!("{sid}.jsonl")), body).expect("write transcript");
}

fn run_kb(root: &Path, args: &[String]) -> Output {
    let mut cmd = Command::new(KB);
    cmd.args(args)
        .env("HOME", root.join("home"))
        .env_remove("KB_HOME")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.output().expect("run kb")
}

#[test]
fn hidden_AC_08_08_ingest_publishes_clean_topics_for_other_words() {
    let tmp = TempDir::new().expect("tempdir");
    let root: PathBuf = tmp.path().to_path_buf();
    fs::create_dir_all(root.join("home")).unwrap();
    let claude = root.join("projects");
    write_session(
        &claude.join("p1"),
        "11111111-aaaa",
        "/home/a/ledgerapp",
        "Invoices invoices ready every morning",
        "Invoices sent this morning",
        "2026-09-10",
    );
    write_session(
        &claude.join("p2"),
        "22222222-bbbb",
        "/home/a/dbtools",
        "Optimise slow queries",
        "Queries now run quickly",
        "2026-09-11",
    );
    write_session(
        &claude.join("p3"),
        "33333333-cccc",
        "/home/a/ledgerapp",
        "Invoice export",
        "The invoice export finished",
        "2026-09-12",
    );
    let out = root.join("out");
    let o = run_kb(
        &root,
        &[
            "ingest".to_string(),
            "--claude-dir".to_string(),
            claude.to_string_lossy().into_owned(),
            "--out".to_string(),
            out.to_string_lossy().into_owned(),
        ],
    );
    assert_eq!(o.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&o.stderr));

    let text = fs::read_to_string(out.join("graph").join("graph.json")).expect("graph.json");
    let graph: Value = serde_json::from_str(&text).expect("valid json");
    let nodes = graph["nodes"].as_array().expect("nodes");
    let ids: Vec<&str> = nodes.iter().map(|n| n["id"].as_str().unwrap()).collect();
    for want in ["topic:invoice", "topic:query"] {
        assert!(ids.contains(&want), "missing {want} in {ids:?}");
    }
    for banned in ["topic:invoices", "topic:queries", "topic:morning"] {
        assert!(!ids.contains(&banned), "unexpected {banned} in {ids:?}");
    }
    let invoice = nodes.iter().find(|n| n["id"] == "topic:invoice").unwrap();
    assert_eq!(invoice["size"], 2);

    let sess = nodes.iter().find(|n| n["id"] == "session:11111111-aaaa").unwrap();
    let topics: Vec<&str> = sess["meta"]["topics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert!(topics.contains(&"invoice"), "{topics:?}");
    assert!(!topics.contains(&"invoices") && !topics.contains(&"morning"), "{topics:?}");

    let node_file = sess["meta"]["node_file"].as_str().unwrap();
    let note = fs::read_to_string(out.join("nodes").join(node_file)).expect("note");
    let line = note.lines().find(|l| l.starts_with("topics: ")).expect("topics line");
    let note_topics: Vec<String> = serde_json::from_str(line.trim_start_matches("topics: ")).unwrap();
    assert_eq!(note_topics, topics.iter().map(|t| t.to_string()).collect::<Vec<_>>());
}
