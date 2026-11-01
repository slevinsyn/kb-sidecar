//! Phase 09 tests: `kb_core::context::build_context` and the `kb context` command.
//!
//! Graph JSON is built inside the tests (phase 05 shape). CLI tests write
//! `<tmp>/graph/graph.json` themselves and always pass `--out` (or set HOME / KB_HOME to temp
//! folders), so the real ~/claude-kb is never read.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use kb_core::context::{build_context, ContextOptions};
use kb_core::KbError;
use serde_json::{json, Map, Value};
use tempfile::TempDir;

const KB: &str = env!("CARGO_BIN_EXE_kb");
const MARKER: &str = "… [truncated]\n";

// ---------------------------------------------------------------------------
// Graph fixture helpers
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Sess {
    id: String,
    label: String,
    started_at: Option<String>,
    omit_started: bool,
    project: Option<String>,
    topics: Vec<String>,
    files: Vec<String>,
    note: String,
}

fn sess(id: &str, label: &str) -> Sess {
    Sess {
        id: id.to_string(),
        label: label.to_string(),
        started_at: None,
        omit_started: false,
        project: None,
        topics: vec![],
        files: vec![],
        note: format!("{id}.md"),
    }
}

impl Sess {
    fn at(mut self, v: &str) -> Sess {
        self.started_at = Some(v.to_string());
        self
    }
    fn no_started_key(mut self) -> Sess {
        self.omit_started = true;
        self
    }
    fn project(mut self, v: &str) -> Sess {
        self.project = Some(v.to_string());
        self
    }
    fn topics(mut self, v: &[&str]) -> Sess {
        self.topics = v.iter().map(|x| x.to_string()).collect();
        self
    }
    fn files(mut self, v: &[&str]) -> Sess {
        self.files = v.iter().map(|x| x.to_string()).collect();
        self
    }
    fn note(mut self, v: &str) -> Sess {
        self.note = v.to_string();
        self
    }
}

fn graph_json(sessions: &[Sess]) -> String {
    let mut nodes: Vec<Value> = Vec::new();
    let mut links: Vec<Value> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for s in sessions {
        let sid = format!("session:{}", s.id);
        let mut meta = Map::new();
        if !s.omit_started {
            meta.insert(
                "started_at".to_string(),
                match &s.started_at {
                    Some(v) => json!(v),
                    None => Value::Null,
                },
            );
        }
        meta.insert(
            "project".to_string(),
            match &s.project {
                Some(v) => json!(v),
                None => Value::Null,
            },
        );
        meta.insert("topics".to_string(), json!(s.topics));
        meta.insert("node_file".to_string(), json!(s.note));
        nodes.push(json!({
            "id": sid, "type": "session", "label": s.label, "size": 1,
            "meta": Value::Object(meta)
        }));
        for t in &s.topics {
            let tid = format!("topic:{t}");
            if seen.insert(tid.clone()) {
                nodes.push(json!({"id": tid, "type": "topic", "label": t, "size": 1, "meta": {}}));
            }
            links.push(json!({"source": sid, "target": tid, "type": "has_topic"}));
        }
        for f in &s.files {
            let fid = format!("file:{f}");
            if seen.insert(fid.clone()) {
                nodes.push(json!({"id": fid, "type": "file", "label": f, "size": 1, "meta": {}}));
            }
            links.push(json!({"source": sid, "target": fid, "type": "touched_file"}));
        }
        if let Some(p) = &s.project {
            let pid = format!("project:{p}");
            if seen.insert(pid.clone()) {
                nodes.push(json!({"id": pid, "type": "project", "label": p, "size": 1, "meta": {}}));
            }
            links.push(json!({"source": sid, "target": pid, "type": "in_project"}));
        }
    }
    json!({"nodes": nodes, "links": links}).to_string()
}

fn ctx(sessions: &[Sess], query: &str, limit: usize, max_chars: usize) -> String {
    build_context(&graph_json(sessions), query, &ContextOptions { limit, max_chars })
        .expect("valid graph must build a context")
}

fn ctx_big(sessions: &[Sess], query: &str) -> String {
    ctx(sessions, query, 1000, 1_000_000)
}

/// Lines of a section: the lines after `header` up to the next blank line.
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

/// Labels (second " · " field) of the session lines.
fn labels(out: &str) -> Vec<String> {
    section(out, "## Sessions")
        .iter()
        .map(|l| l.split(" · ").nth(1).expect("session line has a label").to_string())
        .collect()
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn lines_out(lines: &[&str]) -> String {
    let mut s = lines.join("\n");
    s.push('\n');
    s
}

/// Three-session fixture used for the exact-layout checks.
fn fixture_three() -> Vec<Sess> {
    vec![
        sess("s1", "Proposal app review")
            .at("2026-10-05T09:30:00.000Z")
            .project("web-shop")
            .topics(&["proposal", "checkout"])
            .files(&["src/app.rs"])
            .note("2026-10-05-proposal-app-review-s1.md"),
        sess("s2", "Quick note")
            .files(&["notes/proposal.md"])
            .note("undated-quick-note-s2.md"),
        sess("s3", "Billing dashboard")
            .at("2026-09-01T00:00:00Z")
            .project("web-shop")
            .topics(&["billing"])
            .files(&["src/dash.rs"])
            .note("2026-09-01-billing-dashboard-s3.md"),
    ]
}

fn expected_three(header_query: &str) -> String {
    let header = format!("# Context: {header_query}");
    lines_out(&[
        header.as_str(),
        "",
        "Matched 2 of 3 sessions (showing 2).",
        "",
        "## Sessions",
        "- 2026-10-05 · Proposal app review · project: web-shop · topics: proposal, checkout · note: 2026-10-05-proposal-app-review-s1.md",
        "- undated · Quick note · project: - · topics: - · note: undated-quick-note-s2.md",
        "",
        "## Related topics",
        "- checkout (1)",
        "",
        "## Files",
        "- notes/proposal.md (1)",
        "- src/app.rs (1)",
        "",
        "## Projects",
        "- web-shop (1)",
    ])
}

fn docker_session() -> Vec<Sess> {
    vec![sess("d1", "Docker setup").note("n.md")]
}

fn expected_truncation(full: &str, max: usize) -> String {
    let mlen = MARKER.chars().count();
    let mut kept = String::new();
    let mut n = 0usize;
    for line in full.split_inclusive('\n') {
        let l = line.chars().count();
        if n + l + mlen <= max {
            kept.push_str(line);
            n += l;
        } else {
            break;
        }
    }
    kept.push_str(MARKER);
    kept
}

// ---------------------------------------------------------------------------
// ContextOptions
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_05_default_options_are_8_and_4000() {
    let d = ContextOptions::default();
    assert_eq!(d.limit, 8);
    assert_eq!(d.max_chars, 4000);
}

// ---------------------------------------------------------------------------
// AC-09-01: scoring
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_01_topic_beats_title_beats_file() {
    // Dates and ids are arranged so that any other ordering rule gives a different order.
    let sessions = vec![
        sess("a-file", "Zeta").at("2026-10-09T00:00:00Z").files(&["src/invoice.rs"]),
        sess("b-title", "Invoice cleanup").at("2026-10-05T00:00:00Z"),
        sess("c-topic", "Alpha").at("2026-10-01T00:00:00Z").topics(&["invoice"]),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(labels(&out), strs(&["Alpha", "Invoice cleanup", "Zeta"]));
    assert!(out.contains("Matched 3 of 3 sessions (showing 3)."));
}

#[test]
fn test_AC_09_01_project_name_match_counts_two() {
    // topic (3) > project (2) > file (1); the project session sits between them by date, so a
    // project score of 1 or 3 would change the order.
    let sessions = vec![
        sess("t", "Third").at("2026-10-01T00:00:00Z").topics(&["billing"]),
        sess("p", "Plain").at("2026-10-05T00:00:00Z").project("billing-api"),
        sess("f", "Other").at("2026-10-09T00:00:00Z").files(&["docs/billing.md"]),
    ];
    let out = ctx_big(&sessions, "billing");
    assert_eq!(labels(&out), strs(&["Third", "Plain", "Other"]));
}

#[test]
fn test_AC_09_01_project_two_equals_title_two() {
    // Same score 2 -> newest first decides; project session is the newer one.
    let sessions = vec![
        sess("a", "Billing page").at("2026-10-01T00:00:00Z"),
        sess("b", "Plain").at("2026-10-05T00:00:00Z").project("billing-api"),
    ];
    let out = ctx_big(&sessions, "billing");
    assert_eq!(labels(&out), strs(&["Plain", "Billing page"]));
}

#[test]
fn test_AC_09_01_scores_sum_over_query_terms() {
    // query "invoice parser":
    //   Y: topic invoice 3 + topic parser 3 = 6
    //   X: topic invoice 3 + title parser 2 = 5
    //   Z: title invoice 2 + title parser 2 = 4
    //   V: project invoice 2 + file parser 1 = 3
    //   W: one file containing both = 1 + 1 = 2
    // Dates run in the opposite direction (W newest) so only the score can give this order.
    let sessions = vec![
        sess("w", "Odd").at("2026-10-09T00:00:00Z").files(&["src/Invoice_Parser.rs"]),
        sess("v", "Misc")
            .at("2026-10-08T00:00:00Z")
            .project("invoice")
            .files(&["lib/parser.rs"]),
        sess("z", "Invoice parser").at("2026-10-07T00:00:00Z"),
        sess("x", "Parser rewrite").at("2026-10-06T00:00:00Z").topics(&["invoice"]),
        sess("y", "Zeta").at("2026-10-05T00:00:00Z").topics(&["invoice", "parser"]),
    ];
    let out = ctx_big(&sessions, "invoice parser");
    assert_eq!(
        labels(&out),
        strs(&["Zeta", "Parser rewrite", "Invoice parser", "Misc", "Odd"])
    );
}

#[test]
fn test_AC_09_01_file_match_counts_once_per_term_not_per_file() {
    // Two matching files still score 1 for the term; the title match (2) must win even though
    // the two-file session is newer.
    let sessions = vec![
        sess("a", "Two files")
            .at("2026-10-09T00:00:00Z")
            .files(&["a/invoice1.rs", "b/invoice2.rs"]),
        sess("b", "Invoice title").at("2026-10-01T00:00:00Z"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(labels(&out), strs(&["Invoice title", "Two files"]));
}

#[test]
fn test_AC_09_01_file_match_is_case_insensitive_substring() {
    let sessions = vec![sess("a", "Misc").files(&["Docs/INVOICE-notes.md"])];
    let out = ctx_big(&sessions, "invoice");
    assert!(out.contains("Matched 1 of 1 sessions (showing 1)."), "got: {out}");
    assert_eq!(section(&out, "## Files"), strs(&["- Docs/INVOICE-notes.md (1)"]));
}

#[test]
fn test_AC_09_01_topic_must_equal_normalised_term_not_substring() {
    let sessions = vec![
        sess("a", "Zzz").topics(&["invoicing"]),
        sess("b", "Reinvoiced items"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(out, "No sessions match \"invoice\".\n");
}

#[test]
fn test_AC_09_01_plural_topic_in_meta_matches_singular_query() {
    // meta.topics holds the raw value "invoices"; normalize_term gives "invoice" -> 3 points,
    // which beats the (newer) title match worth 2.
    let sessions = vec![
        sess("a", "Invoice list").at("2026-10-09T00:00:00Z"),
        sess("b", "Zeta").at("2026-10-01T00:00:00Z").topics(&["invoices"]),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(labels(&out), strs(&["Zeta", "Invoice list"]));
}

#[test]
fn test_AC_09_01_plural_query_is_normalised_before_matching() {
    let sessions = vec![sess("a", "Proposal draft").topics(&["proposal"])];
    let out = ctx_big(&sessions, "proposals");
    assert_eq!(labels(&out), strs(&["Proposal draft"]));
    assert!(out.starts_with("# Context: proposals\n"));
}

#[test]
fn test_AC_09_01_title_tokens_are_normalised() {
    // "Invoices" in the title normalises to "invoice" (2) and beats a file hit (1) that is newer.
    let sessions = vec![
        sess("a", "Misc").at("2026-10-09T00:00:00Z").files(&["x/invoice.txt"]),
        sess("b", "Invoices and Proposals").at("2026-10-01T00:00:00Z"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(labels(&out), strs(&["Invoices and Proposals", "Misc"]));
}

#[test]
fn test_AC_09_01_two_topics_with_same_normal_form_count_three_once() {
    // A: topics proposal + proposals -> 3 (once).  B: title 2 + project 2 = 4 -> B first although
    // A is newer.
    let sessions = vec![
        sess("a", "Zeta").at("2026-10-09T00:00:00Z").topics(&["proposal", "proposals"]),
        sess("b", "Proposal draft").at("2026-10-01T00:00:00Z").project("proposal"),
    ];
    let out = ctx_big(&sessions, "proposal");
    assert_eq!(labels(&out), strs(&["Proposal draft", "Zeta"]));
}

#[test]
fn test_AC_09_01_repeated_query_terms_are_counted_once() {
    // Query terms {invoice, parser}.
    //   S1: topic invoice = 3.   S2: title parser 2 + project parser 2 = 4.
    // If "invoice" were counted twice S1 would reach 6 and win.
    let sessions = vec![
        sess("s1", "Zeta").at("2026-10-09T00:00:00Z").topics(&["invoice"]),
        sess("s2", "Parser").at("2026-10-01T00:00:00Z").project("parser"),
    ];
    let out = ctx_big(&sessions, "invoice invoice parser");
    assert_eq!(labels(&out), strs(&["Parser", "Zeta"]));
    assert!(out.starts_with("# Context: invoice invoice parser\n"));
}

#[test]
fn test_AC_09_01_score_zero_sessions_are_not_matches() {
    let sessions = vec![
        sess("a", "Invoice thing"),
        sess("b", "Gardening tips"),
        sess("c", "Cooking"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert!(out.contains("Matched 1 of 3 sessions (showing 1)."), "got: {out}");
    assert_eq!(labels(&out), strs(&["Invoice thing"]));
}

// ---------------------------------------------------------------------------
// AC-09-02: tie ordering
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_02_ties_newest_first_undated_last_then_id() {
    // Every session scores 2 (title). Input order is scrambled on purpose.
    let sessions = vec![
        sess("s2", "Invoice U1"),
        sess("s9", "Invoice D1").at("2026-10-05T10:00:00Z"),
        sess("s0", "Invoice U2").no_started_key(),
        sess("s5", "Invoice D3").at("2026-10-05T12:00:00Z"),
        sess("s1", "Invoice D2").at("2026-10-03T08:00:00Z"),
        sess("s4", "Invoice T4").at("2026-10-05T12:00:00Z"),
        sess("s3", "Invoice T3").at("2026-10-05T12:00:00Z"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(
        labels(&out),
        strs(&[
            "Invoice T3", // 12:00, id s3
            "Invoice T4", // 12:00, id s4
            "Invoice D3", // 12:00, id s5
            "Invoice D1", // 10:00
            "Invoice D2", // 10-03
            "Invoice U2", // undated (key missing), id s0
            "Invoice U1", // undated (null), id s2
        ])
    );
}

#[test]
fn test_AC_09_02_undated_with_small_id_still_after_dated() {
    let sessions = vec![
        sess("a", "Invoice undated"),
        sess("z", "Invoice dated").at("2020-01-01T00:00:00Z"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(labels(&out), strs(&["Invoice dated", "Invoice undated"]));
}

#[test]
fn test_AC_09_02_score_beats_date() {
    let sessions = vec![
        sess("a", "Invoice old").at("2019-01-01T00:00:00Z").topics(&["invoice"]),
        sess("b", "Invoice new").at("2026-10-31T00:00:00Z"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(labels(&out), strs(&["Invoice old", "Invoice new"]));
}

// ---------------------------------------------------------------------------
// AC-09-03: exact layout
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_03_exact_layout_all_sections() {
    let out = ctx(&fixture_three(), "  Proposal app  ", 8, 4000);
    assert_eq!(out, expected_three("Proposal app"));
}

#[test]
fn test_AC_09_03_minimal_output_has_only_sessions_section() {
    let out = ctx_big(&docker_session(), "docker");
    assert_eq!(
        out,
        lines_out(&[
            "# Context: docker",
            "",
            "Matched 1 of 1 sessions (showing 1).",
            "",
            "## Sessions",
            "- undated · Docker setup · project: - · topics: - · note: n.md",
        ])
    );
}

#[test]
fn test_AC_09_03_session_line_with_project_but_no_topics() {
    let sessions = vec![sess("p", "Docker notes")
        .at("2026-03-04T05:06:07Z")
        .project("infra")
        .note("2026-03-04-docker-notes-p.md")];
    let out = ctx_big(&sessions, "docker");
    assert_eq!(
        section(&out, "## Sessions"),
        strs(&["- 2026-03-04 · Docker notes · project: infra · topics: - · note: 2026-03-04-docker-notes-p.md"])
    );
}

#[test]
fn test_AC_09_03_session_line_topics_joined_in_meta_order() {
    let sessions = vec![sess("p", "Docker notes")
        .at("2026-03-04")
        .topics(&["zebra", "docker", "alpha"])];
    let out = ctx_big(&sessions, "docker");
    assert_eq!(
        section(&out, "## Sessions"),
        strs(&["- 2026-03-04 · Docker notes · project: - · topics: zebra, docker, alpha · note: p.md"])
    );
}

#[test]
fn test_AC_09_03_output_ends_with_exactly_one_newline_and_is_deterministic() {
    let a = ctx(&fixture_three(), "proposal app", 8, 4000);
    let b = ctx(&fixture_three(), "proposal app", 8, 4000);
    assert_eq!(a, b);
    assert!(a.ends_with('\n'));
    assert!(!a.ends_with("\n\n"));
}

#[test]
fn test_AC_09_03_stats_count_all_session_nodes_not_other_nodes() {
    // Topic/file/project nodes in the graph must not count towards N.
    let sessions = vec![
        sess("a", "Docker one").topics(&["x1", "x2"]).files(&["f/a.rs"]).project("proj"),
        sess("b", "Other"),
    ];
    let out = ctx_big(&sessions, "docker");
    assert!(out.contains("\nMatched 1 of 2 sessions (showing 1).\n"), "got: {out}");
}

// ---------------------------------------------------------------------------
// AC-09-04: related topics / files / projects
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_04_related_topics_exclude_query_terms_and_plural_forms() {
    let sessions = vec![
        sess("a", "Proposal one").topics(&["proposals", "billing", "proposal"]),
        sess("b", "Proposal two").topics(&["billing", "audit"]),
    ];
    let out = ctx_big(&sessions, "proposal");
    assert_eq!(
        section(&out, "## Related topics"),
        strs(&["- billing (2)", "- audit (1)"])
    );
    assert!(!out.contains("- proposals"));
    assert!(!out.contains("- proposal ("));
}

#[test]
fn test_AC_09_04_related_topics_counted_per_session_ties_alphabetical() {
    let sessions = vec![
        sess("a", "Invoice a").topics(&["zulu", "mike", "alpha"]),
        sess("b", "Invoice b").topics(&["mike", "zulu"]),
        sess("c", "Invoice c").topics(&["zulu", "bravo"]),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(
        section(&out, "## Related topics"),
        strs(&["- zulu (3)", "- mike (2)", "- alpha (1)", "- bravo (1)"])
    );
}

#[test]
fn test_AC_09_04_related_topics_capped_at_ten() {
    let all: Vec<String> = (1..=12).map(|i| format!("t{i:02}")).collect();
    let all_refs: Vec<&str> = all.iter().map(|s| s.as_str()).collect();
    let sessions = vec![
        sess("a", "Invoice one").topics(&all_refs),
        sess("b", "Invoice two").topics(&["t12", "t11"]),
        sess("c", "Invoice three").topics(&["t12"]),
    ];
    let out = ctx_big(&sessions, "invoice");
    let got = section(&out, "## Related topics");
    let mut want = strs(&["- t12 (3)", "- t11 (2)"]);
    for i in 1..=8 {
        want.push(format!("- t{i:02} (1)"));
    }
    assert_eq!(got.len(), 10);
    assert_eq!(got, want);
    assert!(!out.contains("- t09 "));
    assert!(!out.contains("- t10 "));
}

#[test]
fn test_AC_09_04_files_capped_at_ten_with_counts() {
    let all: Vec<String> = (1..=12).map(|i| format!("src/f{i:02}.rs")).collect();
    let all_refs: Vec<&str> = all.iter().map(|s| s.as_str()).collect();
    let sessions = vec![
        sess("a", "Invoice one").files(&all_refs),
        sess("b", "Invoice two").files(&["src/f12.rs"]),
    ];
    let out = ctx_big(&sessions, "invoice");
    let got = section(&out, "## Files");
    let mut want = strs(&["- src/f12.rs (2)"]);
    for i in 1..=9 {
        want.push(format!("- src/f{i:02}.rs (1)"));
    }
    assert_eq!(got.len(), 10);
    assert_eq!(got, want);
    assert!(!out.contains("src/f10.rs"));
    assert!(!out.contains("src/f11.rs"));
}

#[test]
fn test_AC_09_04_projects_capped_at_five() {
    let sessions = vec![
        sess("s1", "Invoice 1").project("pa"),
        sess("s2", "Invoice 2").project("pb"),
        sess("s3", "Invoice 3").project("pc"),
        sess("s4", "Invoice 4").project("pd"),
        sess("s5", "Invoice 5").project("pe"),
        sess("s6", "Invoice 6").project("pg"),
        sess("s7", "Invoice 7").project("pg"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(
        section(&out, "## Projects"),
        strs(&["- pg (2)", "- pa (1)", "- pb (1)", "- pc (1)", "- pd (1)"])
    );
    assert!(!out.contains("- pe ("));
}

#[test]
fn test_AC_09_04_empty_sections_are_omitted() {
    let sessions = vec![sess("a", "Invoice only").project("acme")];
    let out = ctx_big(&sessions, "invoice");
    assert!(out.contains("## Sessions"));
    assert!(out.contains("## Projects"));
    assert!(!out.contains("## Related topics"));
    assert!(!out.contains("## Files"));
}

#[test]
fn test_AC_09_04_related_topics_omitted_when_all_topics_are_query_terms() {
    let sessions = vec![sess("a", "Misc").topics(&["invoice", "invoices"])];
    let out = ctx_big(&sessions, "invoice");
    assert!(out.contains("Matched 1 of 1 sessions (showing 1)."));
    assert!(!out.contains("## Related topics"), "got: {out}");
}

#[test]
fn test_AC_09_04_files_and_projects_count_sessions() {
    let sessions = vec![
        sess("a", "Invoice a").project("acme").files(&["x/shared.rs", "x/only_a.rs"]),
        sess("b", "Invoice b").project("acme").files(&["x/shared.rs"]),
        sess("c", "Invoice c").project("zeta"),
    ];
    let out = ctx_big(&sessions, "invoice");
    assert_eq!(
        section(&out, "## Files"),
        strs(&["- x/shared.rs (2)", "- x/only_a.rs (1)"])
    );
    assert_eq!(section(&out, "## Projects"), strs(&["- acme (2)", "- zeta (1)"]));
}

// ---------------------------------------------------------------------------
// AC-09-05: limit and truncation
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_05_limit_caps_shown_sessions_and_aggregates_use_shown_only() {
    let sessions = vec![
        sess("a", "Invoice 1").at("2026-10-05T00:00:00Z").topics(&["shown1"]).project("p1"),
        sess("b", "Invoice 2").at("2026-10-04T00:00:00Z").topics(&["shown2"]),
        sess("c", "Invoice 3").at("2026-10-03T00:00:00Z").topics(&["hidden3"]).project("p3"),
        sess("d", "Invoice 4").at("2026-10-02T00:00:00Z"),
        sess("e", "Invoice 5").at("2026-10-01T00:00:00Z"),
        sess("f", "Gardening").at("2026-10-06T00:00:00Z"),
    ];
    let out = ctx(&sessions, "invoice", 2, 100_000);
    assert!(out.contains("\nMatched 5 of 6 sessions (showing 2).\n"), "got: {out}");
    assert_eq!(labels(&out), strs(&["Invoice 1", "Invoice 2"]));
    assert_eq!(
        section(&out, "## Related topics"),
        strs(&["- shown1 (1)", "- shown2 (1)"])
    );
    assert_eq!(section(&out, "## Projects"), strs(&["- p1 (1)"]));
    assert!(!out.contains("hidden3"));
}

#[test]
fn test_AC_09_05_limit_larger_than_matches_shows_all_matches() {
    let sessions = vec![sess("a", "Invoice 1"), sess("b", "Invoice 2"), sess("c", "Other")];
    let out = ctx(&sessions, "invoice", 50, 100_000);
    assert!(out.contains("Matched 2 of 3 sessions (showing 2)."), "got: {out}");
}

#[test]
fn test_AC_09_05_default_limit_shows_eight() {
    let sessions: Vec<Sess> = (0..10)
        .map(|i| sess(&format!("s{i}"), &format!("Invoice {i}")).at(&format!("2026-10-{:02}", i + 1)))
        .collect();
    let out = build_context(&graph_json(&sessions), "invoice", &ContextOptions::default())
        .expect("valid graph");
    assert!(out.contains("Matched 10 of 10 sessions (showing 8)."), "got: {out}");
    assert_eq!(section(&out, "## Sessions").len(), 8);
}

#[test]
fn test_AC_09_05_truncation_hand_computed_exact() {
    // Full output lines (chars incl. newline): 18, 1, 37, 1, 12, ...
    // marker "… [truncated]\n" is 14 chars.
    let g = docker_session();
    let full = ctx_big(&g, "docker");
    assert!(full.chars().count() > 71);

    // 18 + 1 + 37 + 14 = 70 fits, the blank line after it would need 71.
    let out70 = ctx(&g, "docker", 8, 70);
    assert_eq!(
        out70,
        "# Context: docker\n\nMatched 1 of 1 sessions (showing 1).\n… [truncated]\n"
    );
    assert_eq!(out70.chars().count(), 70);

    // With 71 the blank line fits too, "## Sessions\n" (12 more) does not.
    let out71 = ctx(&g, "docker", 8, 71);
    assert_eq!(
        out71,
        "# Context: docker\n\nMatched 1 of 1 sessions (showing 1).\n\n… [truncated]\n"
    );
    assert_eq!(out71.chars().count(), 71);
}

#[test]
fn test_AC_09_05_no_truncation_when_output_fits_exactly() {
    let g = docker_session();
    let full = ctx_big(&g, "docker");
    let n = full.chars().count();
    assert_eq!(ctx(&g, "docker", 8, n), full);
    let cut = ctx(&g, "docker", 8, n - 1);
    assert_ne!(cut, full);
    assert!(cut.ends_with(MARKER));
    assert!(cut.chars().count() <= n - 1);
}

#[test]
fn test_AC_09_05_truncation_keeps_whole_lines_and_fits_limit() {
    let sessions: Vec<Sess> = (0..20)
        .map(|i| {
            sess(&format!("s{i:02}"), &format!("Invoice session number {i}"))
                .at(&format!("2026-10-{:02}T00:00:00Z", i + 1))
                .project("acme")
                .topics(&["billing"])
                .note(&format!("2026-10-{:02}-invoice-session-number-{i}-s{i:02}.md", i + 1))
        })
        .collect();
    let full = ctx(&sessions, "invoice", 20, 1_000_000);
    assert!(full.chars().count() > 1500, "fixture too small to truncate");
    for max in [200usize, 333, 500, 1000] {
        let out = ctx(&sessions, "invoice", 20, max);
        assert!(out.ends_with(MARKER), "max {max}");
        assert!(out.chars().count() <= max, "max {max}: {} chars", out.chars().count());
        assert_eq!(out, expected_truncation(&full, max), "max {max}");
        let body = &out[..out.len() - MARKER.len()];
        assert!(full.starts_with(body), "kept text must be a prefix, max {max}");
        assert!(body.ends_with('\n'), "kept text must end on a line boundary, max {max}");
    }
}

#[test]
fn test_AC_09_05_default_max_chars_truncates_long_output() {
    let long = format!("Invoice {}", "lorem ".repeat(100));
    let sessions: Vec<Sess> = (0..8)
        .map(|i| sess(&format!("s{i}"), &format!("{long}{i}")).at(&format!("2026-10-{:02}", i + 1)))
        .collect();
    let full = ctx(&sessions, "invoice", 8, 1_000_000);
    assert!(full.chars().count() > 4000, "fixture too small");
    let out = build_context(&graph_json(&sessions), "invoice", &ContextOptions::default())
        .expect("valid graph");
    assert!(out.chars().count() <= 4000);
    assert!(out.ends_with(MARKER));
    assert_eq!(out, expected_truncation(&full, 4000));
}

// ---------------------------------------------------------------------------
// AC-09-06: no match
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_06_no_match_exact_text_with_trimmed_query() {
    let out = ctx_big(&fixture_three(), "  zzzunknown  ");
    assert_eq!(out, "No sessions match \"zzzunknown\".\n");
}

#[test]
fn test_AC_09_06_stop_word_only_query() {
    let sessions = vec![sess("a", "The and for this evening").topics(&["the"])];
    let out = ctx_big(&sessions, "the and for");
    assert_eq!(out, "No sessions match \"the and for\".\n");
}

#[test]
fn test_AC_09_06_extra_stop_word_query() {
    let sessions = vec![sess("a", "Evening recap")];
    let out = ctx_big(&sessions, " evening ");
    assert_eq!(out, "No sessions match \"evening\".\n");
}

#[test]
fn test_AC_09_06_blank_query() {
    let out = ctx_big(&fixture_three(), "   ");
    assert_eq!(out, "No sessions match \"\".\n");
}

#[test]
fn test_AC_09_06_graph_without_sessions() {
    let out = build_context(r#"{"nodes":[],"links":[]}"#, "docker", &ContextOptions::default())
        .expect("empty but valid graph");
    assert_eq!(out, "No sessions match \"docker\".\n");
}

// ---------------------------------------------------------------------------
// AC-09-07: invalid graph text
// ---------------------------------------------------------------------------

fn assert_parse_err(text: &str) {
    let r = build_context(text, "docker", &ContextOptions::default());
    assert!(
        matches!(r, Err(KbError::Parse(_))),
        "expected KbError::Parse for {text:?}, got {r:?}"
    );
}

#[test]
fn test_AC_09_07_not_json_is_parse_error() {
    assert_parse_err("this is not json");
    assert_parse_err("");
    assert_parse_err("{\"nodes\": [");
}

#[test]
fn test_AC_09_07_json_without_nodes_or_links_is_parse_error() {
    assert_parse_err("{}");
    assert_parse_err("[]");
    assert_parse_err("42");
    assert_parse_err(r#"{"nodes":[]}"#);
    assert_parse_err(r#"{"links":[]}"#);
    assert_parse_err(r#"{"nodes":{},"links":[]}"#);
    assert_parse_err(r#"{"nodes":[],"links":"x"}"#);
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

struct Cli {
    root: TempDir,
}

impl Cli {
    fn new() -> Cli {
        let root = TempDir::new().expect("tempdir");
        fs::create_dir_all(root.path().join("home")).expect("home");
        Cli { root }
    }
    fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }
    fn out(&self) -> PathBuf {
        self.root.path().join("out")
    }
    fn write_graph_at(&self, out: &Path, text: &str) {
        fs::create_dir_all(out.join("graph")).expect("graph dir");
        fs::write(out.join("graph").join("graph.json"), text).expect("write graph");
    }
    fn write_graph(&self, text: &str) {
        let out = self.out();
        self.write_graph_at(&out, text);
    }
    fn run(&self, args: &[&str]) -> Output {
        self.run_env(args, None)
    }
    fn run_env(&self, args: &[&str], kb_home: Option<&Path>) -> Output {
        let mut cmd = Command::new(KB);
        cmd.args(args)
            .env("HOME", self.home())
            .env_remove("KB_HOME")
            .current_dir(self.root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(k) = kb_home {
            cmd.env("KB_HOME", k);
        }
        cmd.output().expect("run kb")
    }
}

fn sp(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn code(o: &Output) -> i32 {
    o.status.code().expect("exit code")
}

fn stdout_of(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr_of(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

// ---------------------------------------------------------------------------
// AC-09-08: CLI success paths
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_08_cli_prints_context_and_exits_zero() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "app", "--out", &out]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert_eq!(stdout_of(&o), expected_three("proposal app"));
}

#[test]
fn test_AC_09_08_cli_flags_before_and_between_query_words() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&[
        "context", "--limit", "1", "proposal", "--out", &out, "app", "--max-chars", "4000",
    ]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert_eq!(
        stdout_of(&o),
        lines_out(&[
            "# Context: proposal app",
            "",
            "Matched 2 of 3 sessions (showing 1).",
            "",
            "## Sessions",
            "- 2026-10-05 · Proposal app review · project: web-shop · topics: proposal, checkout · note: 2026-10-05-proposal-app-review-s1.md",
            "",
            "## Related topics",
            "- checkout (1)",
            "",
            "## Files",
            "- src/app.rs (1)",
            "",
            "## Projects",
            "- web-shop (1)",
        ])
    );
}

#[test]
fn test_AC_09_08_cli_flags_after_query() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "app", "--limit", "1", "--out", &out]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    let text = stdout_of(&o);
    assert!(text.starts_with("# Context: proposal app\n"));
    assert!(text.contains("Matched 2 of 3 sessions (showing 1)."));
}

#[test]
fn test_AC_09_08_cli_max_chars_truncates() {
    let c = Cli::new();
    c.write_graph(&graph_json(&docker_session()));
    let out = sp(&c.out());
    let o = c.run(&["context", "docker", "--max-chars", "70", "--out", &out]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert_eq!(
        stdout_of(&o),
        "# Context: docker\n\nMatched 1 of 1 sessions (showing 1).\n… [truncated]\n"
    );
}

#[test]
fn test_AC_09_08_cli_no_match_exits_zero_with_message() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "zzzunknown", "--out", &out]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert_eq!(stdout_of(&o), "No sessions match \"zzzunknown\".\n");
}

#[test]
fn test_AC_09_08_cli_default_out_uses_kb_home() {
    let c = Cli::new();
    let kb_home = c.root.path().join("kbhome");
    c.write_graph_at(&kb_home, &graph_json(&docker_session()));
    let o = c.run_env(&["context", "docker"], Some(&kb_home));
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(stdout_of(&o).contains("Matched 1 of 1 sessions (showing 1)."));
}

#[test]
fn test_AC_09_08_cli_default_out_uses_home_claude_kb() {
    let c = Cli::new();
    let default_out = c.home().join("claude-kb");
    c.write_graph_at(&default_out, &graph_json(&docker_session()));
    let o = c.run(&["context", "docker"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(stdout_of(&o).contains("Docker setup"));
}

#[test]
fn test_AC_09_08_cli_is_read_only() {
    let c = Cli::new();
    let text = graph_json(&fixture_three());
    c.write_graph(&text);
    let out = c.out();
    let o = c.run(&["context", "proposal", "--out", &sp(&out)]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert_eq!(fs::read_to_string(out.join("graph").join("graph.json")).unwrap(), text);
    let top: Vec<String> = fs::read_dir(&out)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(top, vec!["graph".to_string()]);
    let inner: Vec<String> = fs::read_dir(out.join("graph"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(inner, vec!["graph.json".to_string()]);
}

#[test]
fn test_AC_09_08_help_mentions_kb_context() {
    let c = Cli::new();
    let o = c.run(&["help"]);
    let all = format!("{}{}", stdout_of(&o), stderr_of(&o));
    assert!(all.contains("kb context"), "help text was: {all}");
}

// ---------------------------------------------------------------------------
// AC-09-09: CLI error paths
// ---------------------------------------------------------------------------

#[test]
fn test_AC_09_09_cli_no_query_exits_2() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "--out", &out]);
    assert_eq!(code(&o), 2);
    assert!(!stderr_of(&o).trim().is_empty());
    assert!(stdout_of(&o).is_empty());
}

#[test]
fn test_AC_09_09_cli_flag_value_is_not_a_query_word() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "--limit", "3", "--out", &out]);
    assert_eq!(code(&o), 2);
    assert!(!stderr_of(&o).trim().is_empty());
}

#[test]
fn test_AC_09_09_cli_unknown_flag_exits_2() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "--bogus", "--out", &out]);
    assert_eq!(code(&o), 2);
    assert!(!stderr_of(&o).trim().is_empty());
    assert!(stdout_of(&o).is_empty());
}

#[test]
fn test_AC_09_09_cli_limit_zero_exits_2() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "--limit", "0", "--out", &out]);
    assert_eq!(code(&o), 2);
    assert!(!stderr_of(&o).trim().is_empty());
}

#[test]
fn test_AC_09_09_cli_non_positive_or_non_numeric_numbers_exit_2() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let out = out.as_str();
    for args in [
        ["context", "proposal", "--limit", "abc", "--out", out],
        ["context", "proposal", "--limit", "-1", "--out", out],
        ["context", "proposal", "--limit", "2.5", "--out", out],
        ["context", "proposal", "--max-chars", "0", "--out", out],
        ["context", "proposal", "--max-chars", "lots", "--out", out],
    ] {
        let o = c.run(&args);
        assert_eq!(code(&o), 2, "args {args:?}; stdout: {}", stdout_of(&o));
    }
}

#[test]
fn test_AC_09_09_cli_missing_flag_value_exits_2() {
    let c = Cli::new();
    c.write_graph(&graph_json(&fixture_three()));
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "--out", &out, "--limit"]);
    assert_eq!(code(&o), 2);
    let o = c.run(&["context", "proposal", "--out", &out, "--max-chars"]);
    assert_eq!(code(&o), 2);
    let o = c.run(&["context", "proposal", "--out"]);
    assert_eq!(code(&o), 2);
}

#[test]
fn test_AC_09_09_cli_missing_graph_exits_1_mentioning_graph_json() {
    let c = Cli::new();
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "--out", &out]);
    assert_eq!(code(&o), 1);
    assert!(stderr_of(&o).contains("graph.json"), "stderr: {}", stderr_of(&o));
    assert!(stdout_of(&o).is_empty());
}

#[test]
fn test_AC_09_09_cli_unreadable_graph_exits_1_mentioning_graph_json() {
    let c = Cli::new();
    // graph.json is a directory: it exists but cannot be read as a file.
    fs::create_dir_all(c.out().join("graph").join("graph.json")).unwrap();
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "--out", &out]);
    assert_eq!(code(&o), 1);
    assert!(stderr_of(&o).contains("graph.json"), "stderr: {}", stderr_of(&o));
}

#[test]
fn test_AC_09_09_cli_invalid_graph_exits_1() {
    let c = Cli::new();
    c.write_graph("this is not json");
    let out = sp(&c.out());
    let o = c.run(&["context", "proposal", "--out", &out]);
    assert_eq!(code(&o), 1);
    assert!(!stderr_of(&o).trim().is_empty());
    assert!(stdout_of(&o).is_empty());

    c.write_graph(r#"{"nodes":[]}"#);
    let o = c.run(&["context", "proposal", "--out", &out]);
    assert_eq!(code(&o), 1);
    assert!(!stderr_of(&o).trim().is_empty());
}

#[test]
fn test_AC_09_09_cli_usage_error_wins_over_missing_graph() {
    let c = Cli::new();
    let out = sp(&c.out());
    let o = c.run(&["context", "--out", &out]);
    assert_eq!(code(&o), 2);
}
