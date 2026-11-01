//! Phase 06 tests: the `kb` binary (ingest, hook, install-hook).
//!
//! Every run sets HOME to a temp dir, removes KB_HOME and passes --out, so the real
//! ~/.claude and ~/claude-kb are never touched.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};
use tempfile::TempDir;

const KB: &str = env!("CARGO_BIN_EXE_kb");

const A_ID: &str = "aaaaaaaa-1111";
const A_NODE: &str = "2026-10-01-fix-the-parser-bug-aaaaaaaa.md";
const B_ID: &str = "bbbbbbbb-2222";
const B_NODE: &str = "2026-10-02-write-the-deployment-script-bbbbbbbb.md";
const C_ID: &str = "cccccccc-3333";
const C_NODE: &str = "2026-10-03-review-the-migration-plan-cccccccc.md";

// ---------------------------------------------------------------------------
// Sandbox and process helpers
// ---------------------------------------------------------------------------

struct Sandbox {
    root: TempDir,
}

impl Sandbox {
    fn new() -> Sandbox {
        let root = TempDir::new().expect("tempdir");
        fs::create_dir_all(root.path().join("home")).expect("home dir");
        fs::create_dir_all(root.path().join("projects")).expect("projects dir");
        Sandbox { root }
    }

    fn p(&self, rel: &str) -> PathBuf {
        self.root.path().join(rel)
    }

    fn home(&self) -> PathBuf {
        self.p("home")
    }

    fn claude(&self) -> PathBuf {
        self.p("projects")
    }

    fn out(&self) -> PathBuf {
        self.p("out")
    }

    fn run(&self, args: &[String], stdin: Option<&str>) -> Output {
        let mut cmd = Command::new(KB);
        cmd.args(args)
            .env("HOME", self.home())
            .env_remove("KB_HOME")
            .current_dir(self.root.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        let mut child = cmd.spawn().expect("spawn kb");
        if let Some(text) = stdin {
            let mut pipe = child.stdin.take().expect("stdin pipe");
            let _ = pipe.write_all(text.as_bytes());
            drop(pipe);
        }
        child.wait_with_output().expect("wait for kb")
    }

    fn ingest(&self, out: &Path, extra: &[&str]) -> Output {
        let mut args = vec![
            "ingest".to_string(),
            "--claude-dir".to_string(),
            s(&self.claude()),
            "--out".to_string(),
            s(out),
        ];
        args.extend(extra.iter().map(|x| x.to_string()));
        self.run(&args, None)
    }

    fn hook(&self, out: &Path, stdin: &str, extra: &[&str]) -> Output {
        let mut args = vec!["hook".to_string(), "--out".to_string(), s(out)];
        args.extend(extra.iter().map(|x| x.to_string()));
        self.run(&args, Some(stdin))
    }

    fn install(&self, settings: &Path, extra: &[&str]) -> Output {
        let mut args = vec![
            "install-hook".to_string(),
            "--settings".to_string(),
            s(settings),
        ];
        args.extend(extra.iter().map(|x| x.to_string()));
        self.run(&args, None)
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn code(o: &Output) -> i32 {
    o.status.code().expect("process exit code")
}

fn stdout_of(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr_of(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn summary(new: usize, updated: usize, unchanged: usize, skipped: usize) -> String {
    format!("ingested: {new} new, {updated} updated, {unchanged} unchanged, {skipped} skipped")
}

fn assert_summary(o: &Output, expected: &str) {
    assert_eq!(code(o), 0, "stderr: {}", stderr_of(o));
    let so = stdout_of(o);
    assert_eq!(so.lines().count(), 1, "expected exactly one stdout line, got: {so:?}");
    assert_eq!(so.trim_end(), expected);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

fn user_line(sid: &str, cwd: &str, ts: &str, text: &str) -> String {
    json!({
        "type": "user",
        "sessionId": sid,
        "cwd": cwd,
        "gitBranch": "main",
        "timestamp": ts,
        "isSidechain": false,
        "message": {"role": "user", "content": text}
    })
    .to_string()
}

fn assistant_line(sid: &str, ts: &str, msg_id: &str, text: &str) -> String {
    json!({
        "type": "assistant",
        "sessionId": sid,
        "timestamp": ts,
        "message": {
            "id": msg_id,
            "model": "claude-opus-5-5",
            "role": "assistant",
            "content": [{"type": "text", "text": text}]
        }
    })
    .to_string()
}

fn write_lines(path: &Path, lines: &[String]) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(path, body).expect("write transcript");
}

fn append_lines(path: &Path, lines: &[String]) {
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open for append");
    for l in lines {
        writeln!(f, "{l}").expect("append line");
    }
}

/// Writes `<dir>/<sid>.jsonl` holding one user prompt and one assistant reply on `day`.
fn write_session(dir: &Path, sid: &str, cwd: &str, prompt: &str, reply: &str, day: &str) -> PathBuf {
    let path = dir.join(format!("{sid}.jsonl"));
    write_lines(
        &path,
        &[
            user_line(sid, cwd, &format!("{day}T10:00:00.000Z"), prompt),
            assistant_line(sid, &format!("{day}T10:00:05.000Z"), &format!("msg_{sid}"), reply),
        ],
    );
    path
}

fn seed_a(sb: &Sandbox) -> PathBuf {
    write_session(
        &sb.claude().join("proj-a"),
        A_ID,
        "/home/a/alpha",
        "Fix the parser bug",
        "Fixed the parser by trimming input",
        "2026-10-01",
    )
}

fn seed_b(sb: &Sandbox) -> PathBuf {
    write_session(
        &sb.claude().join("proj-b"),
        B_ID,
        "/home/a/beta",
        "Write the deployment script",
        "Created the script with rollback",
        "2026-10-02",
    )
}

/// Transcript C lives outside the claude dir (hook gets its path on stdin).
fn seed_c(sb: &Sandbox) -> PathBuf {
    write_session(
        &sb.p("elsewhere"),
        C_ID,
        "/home/a/gamma",
        "Review the migration plan",
        "The migration plan looks sound",
        "2026-10-03",
    )
}

fn conversation(uuid: &str, name: &str, day: &str, human: &str, assistant: &str) -> Value {
    json!({
        "uuid": uuid,
        "name": name,
        "created_at": format!("{day}T08:00:00Z"),
        "updated_at": format!("{day}T09:00:00Z"),
        "chat_messages": [
            {"uuid": format!("{uuid}-m1"), "sender": "human", "text": human,
             "created_at": format!("{day}T08:00:00Z"),
             "content": [{"type": "text", "text": human}]},
            {"uuid": format!("{uuid}-m2"), "sender": "assistant", "text": assistant,
             "created_at": format!("{day}T08:00:05Z"),
             "content": [{"type": "text", "text": assistant}]}
        ]
    })
}

fn hook_json(sid: &str, transcript: &Path) -> String {
    json!({
        "session_id": sid,
        "transcript_path": s(transcript),
        "cwd": "/home/a/gamma",
        "hook_event_name": "SessionEnd",
        "reason": "exit"
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Output readers
// ---------------------------------------------------------------------------

fn node_names(out: &Path) -> Vec<String> {
    let dir = out.join("nodes");
    let mut names = Vec::new();
    if dir.is_dir() {
        for e in fs::read_dir(&dir).expect("read nodes dir") {
            let name = e.expect("entry").file_name().to_string_lossy().into_owned();
            if name.ends_with(".md") {
                names.push(name);
            }
        }
    }
    names.sort();
    names
}

fn read_node(out: &Path, name: &str) -> String {
    fs::read_to_string(out.join("nodes").join(name)).unwrap_or_else(|e| panic!("node {name}: {e}"))
}

fn dataset_text(out: &Path) -> String {
    fs::read_to_string(out.join("dataset").join("conversations.jsonl")).expect("dataset file")
}

fn dataset_records(out: &Path) -> Vec<Value> {
    dataset_text(out)
        .lines()
        .map(|l| serde_json::from_str(l).expect("dataset line is JSON"))
        .collect()
}

fn dataset_ids(out: &Path) -> Vec<String> {
    dataset_records(out)
        .iter()
        .map(|r| r["id"].as_str().expect("record id").to_string())
        .collect()
}

fn read_graph(out: &Path) -> Value {
    let text = fs::read_to_string(out.join("graph").join("graph.json")).expect("graph file");
    serde_json::from_str(&text).expect("graph.json is JSON")
}

fn graph_ids(out: &Path) -> Vec<String> {
    read_graph(out)["nodes"]
        .as_array()
        .expect("nodes array")
        .iter()
        .map(|n| n["id"].as_str().expect("node id").to_string())
        .collect()
}

/// Bytes of every node file, the dataset and the graph, keyed by relative path.
fn snapshot(out: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut m = BTreeMap::new();
    let nodes = out.join("nodes");
    if nodes.is_dir() {
        for e in fs::read_dir(&nodes).expect("read nodes") {
            let e = e.expect("entry");
            if e.path().is_file() {
                m.insert(
                    format!("nodes/{}", e.file_name().to_string_lossy()),
                    fs::read(e.path()).expect("read node"),
                );
            }
        }
    }
    for rel in ["dataset/conversations.jsonl", "graph/graph.json"] {
        let p = out.join(rel);
        if p.is_file() {
            m.insert(rel.to_string(), fs::read(&p).expect("read output"));
        }
    }
    m
}

fn nothing_written(out: &Path) -> bool {
    node_names(out).is_empty()
        && !out.join("dataset").join("conversations.jsonl").exists()
        && !out.join("graph").join("graph.json").exists()
}

// ---------------------------------------------------------------------------
// AC-06-01
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_01_ingest_two_transcripts_writes_nodes_dataset_graph() {
    let sb = Sandbox::new();
    seed_a(&sb);
    seed_b(&sb);
    let out = sb.out();

    let o = sb.ingest(&out, &[]);
    assert_summary(&o, &summary(2, 0, 0, 0));

    assert_eq!(node_names(&out), vec![A_NODE.to_string(), B_NODE.to_string()]);
    assert!(read_node(&out, A_NODE).contains("Fix the parser bug"));
    assert!(read_node(&out, B_NODE).contains("Write the deployment script"));

    let text = dataset_text(&out);
    assert!(text.ends_with('\n'));
    assert_eq!(text.lines().count(), 2);
    assert_eq!(dataset_ids(&out), vec![A_ID.to_string(), B_ID.to_string()]);

    let ids = graph_ids(&out);
    for expected in [
        format!("session:{A_ID}"),
        format!("session:{B_ID}"),
        "project:alpha".to_string(),
        "project:beta".to_string(),
    ] {
        assert!(ids.contains(&expected), "graph lacks {expected}: {ids:?}");
    }
}

#[test]
fn test_AC_06_01_ingest_dataset_sorted_by_session_id() {
    let sb = Sandbox::new();
    // Created in reverse id order and in project folders sorted the other way round.
    write_session(
        &sb.claude().join("proj-a"),
        "zzzzzzzz-9999",
        "/home/a/zed",
        "Zed question",
        "Zed answer",
        "2026-10-05",
    );
    write_session(
        &sb.claude().join("proj-z"),
        "mmmmmmmm-5555",
        "/home/a/mid",
        "Mid question",
        "Mid answer",
        "2026-10-04",
    );
    seed_a(&sb);
    let out = sb.out();

    let o = sb.ingest(&out, &[]);
    assert_summary(&o, &summary(3, 0, 0, 0));
    assert_eq!(
        dataset_ids(&out),
        vec![A_ID.to_string(), "mmmmmmmm-5555".to_string(), "zzzzzzzz-9999".to_string()]
    );
}

#[test]
fn test_AC_06_01_ingest_missing_claude_dir_is_silently_skipped() {
    let sb = Sandbox::new();
    let out = sb.out();
    let args = vec![
        "ingest".to_string(),
        "--claude-dir".to_string(),
        s(&sb.p("does-not-exist")),
        "--out".to_string(),
        s(&out),
    ];
    let o = sb.run(&args, None);
    assert_summary(&o, &summary(0, 0, 0, 0));
}

#[test]
fn test_AC_06_01_ingest_unwritable_out_exits_1() {
    let sb = Sandbox::new();
    seed_a(&sb);
    let blocker = sb.p("blocker");
    fs::write(&blocker, "i am a file").unwrap();
    let out = blocker.join("sub");

    let o = sb.ingest(&out, &[]);
    assert_eq!(code(&o), 1, "stderr: {}", stderr_of(&o));
    assert!(!stderr_of(&o).trim().is_empty());
}

#[test]
fn test_AC_06_01_ingest_bad_arguments_exit_2() {
    let sb = Sandbox::new();
    let out = sb.out();

    let o = sb.ingest(&out, &["--definitely-not-a-flag"]);
    assert_eq!(code(&o), 2, "stderr: {}", stderr_of(&o));
    assert!(!out.join("graph").join("graph.json").exists());
}

// ---------------------------------------------------------------------------
// AC-06-02
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_02_second_run_is_all_unchanged_and_byte_identical() {
    let sb = Sandbox::new();
    seed_a(&sb);
    seed_b(&sb);
    let out = sb.out();

    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));
    let first = snapshot(&out);
    assert_eq!(first.len(), 4, "2 nodes + dataset + graph expected: {:?}", first.keys());

    assert_summary(&sb.ingest(&out, &[]), &summary(0, 0, 2, 0));
    assert_eq!(snapshot(&out), first);

    // A third run stays stable too.
    assert_summary(&sb.ingest(&out, &[]), &summary(0, 0, 2, 0));
    assert_eq!(snapshot(&out), first);
}

// ---------------------------------------------------------------------------
// AC-06-03
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_03_appended_message_is_reported_as_updated() {
    let sb = Sandbox::new();
    let a = seed_a(&sb);
    seed_b(&sb);
    let out = sb.out();
    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));
    let b_before = fs::read(out.join("nodes").join(B_NODE)).unwrap();

    append_lines(
        &a,
        &[
            user_line(A_ID, "/home/a/alpha", "2026-10-01T11:00:00.000Z", "Also handle the zebra case"),
            assistant_line(A_ID, "2026-10-01T11:00:05.000Z", "msg_second", "Zebra case handled"),
        ],
    );

    assert_summary(&sb.ingest(&out, &[]), &summary(0, 1, 1, 0));

    // File name is unchanged (same date, title, id), content grew.
    assert_eq!(node_names(&out), vec![A_NODE.to_string(), B_NODE.to_string()]);
    let node = read_node(&out, A_NODE);
    assert!(node.contains("Also handle the zebra case"));
    assert!(node.contains("Zebra case handled"));

    let records = dataset_records(&out);
    assert_eq!(records.len(), 2);
    let rec_a = records.iter().find(|r| r["id"] == A_ID).expect("record for A");
    assert!(rec_a.to_string().contains("Also handle the zebra case"));
    let rec_b = records.iter().find(|r| r["id"] == B_ID).expect("record for B");
    assert!(!rec_b.to_string().contains("zebra"));

    assert_eq!(fs::read(out.join("nodes").join(B_NODE)).unwrap(), b_before);
}

#[test]
fn test_AC_06_03_same_size_edit_is_detected_by_content_hash() {
    let sb = Sandbox::new();
    let path = write_session(
        &sb.claude().join("proj-a"),
        A_ID,
        "/home/a/alpha",
        "Fix the parser bug",
        "Fixed it. Marker: QQQQ1",
        "2026-10-01",
    );
    seed_b(&sb);
    let out = sb.out();
    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));
    assert!(read_node(&out, A_NODE).contains("QQQQ1"));

    let before = fs::read_to_string(&path).unwrap();
    let after = before.replace("QQQQ1", "QQQQ2");
    assert_eq!(before.len(), after.len());
    fs::write(&path, after).unwrap();

    assert_summary(&sb.ingest(&out, &[]), &summary(0, 1, 1, 0));
    let node = read_node(&out, A_NODE);
    assert!(node.contains("QQQQ2"));
    assert!(!node.contains("QQQQ1"));
    assert!(dataset_text(&out).contains("QQQQ2"));
    assert!(!dataset_text(&out).contains("QQQQ1"));
}

// ---------------------------------------------------------------------------
// AC-06-04
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_04_custom_title_change_replaces_node_file() {
    let sb = Sandbox::new();
    let a = seed_a(&sb);
    seed_b(&sb);
    let out = sb.out();
    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));

    // Files that are not .md are left alone by the stale node cleanup.
    let keep = out.join("nodes").join("notes.txt");
    fs::write(&keep, "keep me").unwrap();

    append_lines(
        &a,
        &[json!({"type": "custom-title", "sessionId": A_ID, "customTitle": "Renamed Session"}).to_string()],
    );
    assert_summary(&sb.ingest(&out, &[]), &summary(0, 1, 1, 0));

    let new_name = "2026-10-01-renamed-session-aaaaaaaa.md";
    assert_eq!(node_names(&out), vec![new_name.to_string(), B_NODE.to_string()]);
    assert!(!out.join("nodes").join(A_NODE).exists(), "old node file must be deleted");
    assert!(read_node(&out, new_name).contains("# Renamed Session"));
    assert_eq!(fs::read_to_string(&keep).unwrap(), "keep me");

    let records = dataset_records(&out);
    assert_eq!(records.len(), 2);
    let rec_a = records.iter().find(|r| r["id"] == A_ID).expect("record for A");
    assert_eq!(rec_a["title"], "Renamed Session");
}

#[test]
fn test_AC_06_04_deleted_transcript_is_removed_everywhere() {
    let sb = Sandbox::new();
    seed_a(&sb);
    let b = seed_b(&sb);
    let out = sb.out();
    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));

    fs::remove_file(&b).unwrap();
    assert_summary(&sb.ingest(&out, &[]), &summary(0, 0, 1, 0));

    assert_eq!(node_names(&out), vec![A_NODE.to_string()]);
    assert!(!out.join("nodes").join(B_NODE).exists());
    assert_eq!(dataset_ids(&out), vec![A_ID.to_string()]);
    assert_eq!(dataset_text(&out).lines().count(), 1);

    let ids = graph_ids(&out);
    assert!(ids.contains(&format!("session:{A_ID}")));
    assert!(!ids.contains(&format!("session:{B_ID}")), "graph still has B: {ids:?}");
    assert!(!ids.contains(&"project:beta".to_string()), "project of deleted session lingers: {ids:?}");
}

// ---------------------------------------------------------------------------
// AC-06-05
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_05_empty_and_garbage_transcripts_are_skipped() {
    let sb = Sandbox::new();
    seed_a(&sb);
    seed_b(&sb);
    let garbage = sb.claude().join("proj-c").join("garbage.jsonl");
    fs::create_dir_all(garbage.parent().unwrap()).unwrap();
    fs::write(&garbage, "this is not json\n{{{{ nope\n").unwrap();
    let empty = sb.claude().join("proj-d").join("empty.jsonl");
    fs::create_dir_all(empty.parent().unwrap()).unwrap();
    fs::write(&empty, "").unwrap();
    let out = sb.out();

    let o = sb.ingest(&out, &[]);
    assert_summary(&o, &summary(2, 0, 0, 2));

    let err = stderr_of(&o);
    let skipped: Vec<&str> = err.lines().filter(|l| l.starts_with("skipped ")).collect();
    assert_eq!(skipped.len(), 2, "stderr was: {err:?}");
    assert!(
        skipped.iter().any(|l| l.contains("garbage.jsonl: ")),
        "no skipped line for garbage.jsonl: {skipped:?}"
    );
    assert!(
        skipped.iter().any(|l| l.contains("empty.jsonl: ")),
        "no skipped line for empty.jsonl: {skipped:?}"
    );

    assert_eq!(node_names(&out), vec![A_NODE.to_string(), B_NODE.to_string()]);
    assert_eq!(dataset_ids(&out), vec![A_ID.to_string(), B_ID.to_string()]);
}

#[test]
fn test_AC_06_05_only_bad_transcripts_still_exit_0() {
    let sb = Sandbox::new();
    let garbage = sb.claude().join("proj-c").join("garbage.jsonl");
    fs::create_dir_all(garbage.parent().unwrap()).unwrap();
    fs::write(&garbage, "][ definitely not jsonl\n").unwrap();
    let out = sb.out();

    let o = sb.ingest(&out, &[]);
    assert_summary(&o, &summary(0, 0, 0, 1));
    assert!(stderr_of(&o).lines().any(|l| l.starts_with("skipped ") && l.contains("garbage.jsonl: ")));
    assert!(node_names(&out).is_empty());
}

// ---------------------------------------------------------------------------
// AC-06-06
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_06_claude_ai_exports_are_added_next_to_claude_code() {
    let sb = Sandbox::new();
    seed_a(&sb);

    // A conversations.json file and an unzipped export folder.
    let json_file = sb.p("export1").join("conversations.json");
    fs::create_dir_all(json_file.parent().unwrap()).unwrap();
    let conv1 = conversation(
        "conv-0001",
        "Rust lifetimes",
        "2026-09-01",
        "explain lifetimes",
        "Lifetimes are scopes of validity",
    );
    fs::write(&json_file, Value::Array(vec![conv1]).to_string()).unwrap();

    let folder = sb.p("export2");
    fs::create_dir_all(&folder).unwrap();
    let conv2 = conversation(
        "conv-0002",
        "Borrow checker",
        "2026-09-05",
        "what does the borrow checker do",
        "It tracks ownership of references",
    );
    fs::write(folder.join("conversations.json"), Value::Array(vec![conv2]).to_string()).unwrap();

    let out = sb.out();
    let o = sb.ingest(&out, &["--claude-ai", &s(&json_file), "--claude-ai", &s(&folder)]);
    assert_summary(&o, &summary(3, 0, 0, 0));

    let ai1 = "2026-09-01-rust-lifetimes-conv-000.md";
    let ai2 = "2026-09-05-borrow-checker-conv-000.md";
    assert_eq!(node_names(&out), vec![ai1.to_string(), ai2.to_string(), A_NODE.to_string()]);
    assert!(read_node(&out, ai1).contains("Lifetimes are scopes of validity"));
    assert!(read_node(&out, ai1).contains("claude-ai"));
    assert!(read_node(&out, ai2).contains("It tracks ownership of references"));

    let records = dataset_records(&out);
    assert_eq!(records.len(), 3);
    let source_of = |id: &str| -> String {
        records
            .iter()
            .find(|r| r["id"] == id)
            .unwrap_or_else(|| panic!("no record {id}"))["source"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(source_of("conv-0001"), "claude-ai");
    assert_eq!(source_of("conv-0002"), "claude-ai");
    assert_eq!(source_of(A_ID), "claude-code");

    let ids = graph_ids(&out);
    for expected in ["session:conv-0001", "session:conv-0002", "session:aaaaaaaa-1111", "project:alpha"] {
        assert!(ids.contains(&expected.to_string()), "graph lacks {expected}: {ids:?}");
    }

    // Re-running with the same exports takes everything from the cache.
    let before = snapshot(&out);
    let o2 = sb.ingest(&out, &["--claude-ai", &s(&json_file), "--claude-ai", &s(&folder)]);
    assert_summary(&o2, &summary(0, 0, 3, 0));
    assert_eq!(snapshot(&out), before);
}

#[test]
fn test_AC_06_06_claude_ai_only_with_missing_claude_dir() {
    let sb = Sandbox::new();
    let json_file = sb.p("conversations.json");
    let conv = conversation("conv-0007", "Sourdough starter", "2026-08-15", "how do I feed it", "Feed it daily");
    fs::write(&json_file, Value::Array(vec![conv]).to_string()).unwrap();
    let out = sb.out();

    let args = vec![
        "ingest".to_string(),
        "--claude-dir".to_string(),
        s(&sb.p("no-such-dir")),
        "--claude-ai".to_string(),
        s(&json_file),
        "--out".to_string(),
        s(&out),
    ];
    let o = sb.run(&args, None);
    assert_summary(&o, &summary(1, 0, 0, 0));
    assert_eq!(node_names(&out), vec!["2026-08-15-sourdough-starter-conv-000.md".to_string()]);
    assert_eq!(dataset_ids(&out), vec!["conv-0007".to_string()]);
}

// ---------------------------------------------------------------------------
// AC-06-07
// ---------------------------------------------------------------------------

fn seed_email_session(sb: &Sandbox) {
    write_session(
        &sb.claude().join("proj-e"),
        "eeeeeeee-5555",
        "/home/a/mail",
        "Please email jane.doe@example.com about the release",
        "I will draft the message",
        "2026-10-06",
    );
}

#[test]
fn test_AC_06_07_dataset_is_redacted_by_default() {
    let sb = Sandbox::new();
    seed_email_session(&sb);
    let out = sb.out();

    assert_summary(&sb.ingest(&out, &[]), &summary(1, 0, 0, 0));
    let text = dataset_text(&out);
    assert!(text.contains("[EMAIL]"), "dataset: {text}");
    assert!(!text.contains("jane.doe@example.com"));
}

#[test]
fn test_AC_06_07_no_redact_keeps_the_email() {
    let sb = Sandbox::new();
    seed_email_session(&sb);
    let out = sb.out();

    assert_summary(&sb.ingest(&out, &["--no-redact"]), &summary(1, 0, 0, 0));
    let text = dataset_text(&out);
    assert!(text.contains("jane.doe@example.com"), "dataset: {text}");
    assert!(!text.contains("[EMAIL]"));
}

#[test]
fn test_AC_06_07_redaction_mode_applies_on_every_run() {
    let sb = Sandbox::new();
    seed_email_session(&sb);
    let out = sb.out();

    sb.ingest(&out, &[]);
    assert!(!dataset_text(&out).contains("jane.doe@example.com"));

    // Same sources, different mode: the dataset must follow the flag.
    assert_summary(&sb.ingest(&out, &["--no-redact"]), &summary(0, 0, 1, 0));
    assert!(dataset_text(&out).contains("jane.doe@example.com"));

    assert_summary(&sb.ingest(&out, &[]), &summary(0, 0, 1, 0));
    assert!(dataset_text(&out).contains("[EMAIL]"));
    assert!(!dataset_text(&out).contains("jane.doe@example.com"));
}

#[test]
fn test_AC_06_07_hook_redacts_by_default_and_honours_no_redact() {
    let sb = Sandbox::new();
    let transcript = write_session(
        &sb.p("elsewhere"),
        "ffffffff-6666",
        "/home/a/mail",
        "Ping bob.smith@corp.example.org when done",
        "Will do",
        "2026-10-07",
    );
    let stdin = hook_json("ffffffff-6666", &transcript);

    let out_default = sb.p("out-default");
    assert_eq!(code(&sb.hook(&out_default, &stdin, &[])), 0);
    let text = dataset_text(&out_default);
    assert!(text.contains("[EMAIL]"));
    assert!(!text.contains("bob.smith@corp.example.org"));

    let out_raw = sb.p("out-raw");
    assert_eq!(code(&sb.hook(&out_raw, &stdin, &["--no-redact"])), 0);
    let text = dataset_text(&out_raw);
    assert!(text.contains("bob.smith@corp.example.org"));
    assert!(!text.contains("[EMAIL]"));
}

// ---------------------------------------------------------------------------
// AC-06-08
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_08_hook_adds_session_and_keeps_previous_ones() {
    let sb = Sandbox::new();
    seed_a(&sb);
    seed_b(&sb);
    let out = sb.out();
    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));
    let a_before = fs::read(out.join("nodes").join(A_NODE)).unwrap();
    let b_before = fs::read(out.join("nodes").join(B_NODE)).unwrap();

    let c = seed_c(&sb);
    let o = sb.hook(&out, &hook_json(C_ID, &c), &[]);
    assert_summary(&o, &summary(1, 0, 2, 0));

    assert_eq!(
        node_names(&out),
        vec![A_NODE.to_string(), B_NODE.to_string(), C_NODE.to_string()]
    );
    assert!(read_node(&out, C_NODE).contains("Review the migration plan"));
    assert_eq!(fs::read(out.join("nodes").join(A_NODE)).unwrap(), a_before);
    assert_eq!(fs::read(out.join("nodes").join(B_NODE)).unwrap(), b_before);

    assert_eq!(
        dataset_ids(&out),
        vec![A_ID.to_string(), B_ID.to_string(), C_ID.to_string()]
    );

    let ids = graph_ids(&out);
    for expected in [
        format!("session:{A_ID}"),
        format!("session:{B_ID}"),
        format!("session:{C_ID}"),
        "project:gamma".to_string(),
    ] {
        assert!(ids.contains(&expected), "graph lacks {expected}: {ids:?}");
    }
}

#[test]
fn test_AC_06_08_hook_on_empty_out_does_not_scan_claude_dir() {
    let sb = Sandbox::new();
    // A transcript sitting in the default claude dir ($HOME/.claude/projects) must be ignored.
    write_session(
        &sb.home().join(".claude").join("projects").join("decoy"),
        "dddddddd-4444",
        "/home/a/decoy",
        "Decoy prompt",
        "Decoy reply",
        "2026-10-09",
    );
    // So must one in the sandbox projects dir, which hook is never pointed at.
    seed_a(&sb);

    let c = seed_c(&sb);
    let out = sb.out();
    let args = vec![
        "hook".to_string(),
        "--out".to_string(),
        s(&out),
    ];
    let o = sb.run(&args, Some(&hook_json(C_ID, &c)));
    assert_summary(&o, &summary(1, 0, 0, 0));

    assert_eq!(node_names(&out), vec![C_NODE.to_string()]);
    assert_eq!(dataset_ids(&out), vec![C_ID.to_string()]);
    let ids = graph_ids(&out);
    assert!(ids.contains(&format!("session:{C_ID}")));
    assert!(!ids.iter().any(|i| i.contains("dddddddd") || i.contains("aaaaaaaa")), "{ids:?}");
}

#[test]
fn test_AC_06_08_hook_replaces_an_existing_session() {
    let sb = Sandbox::new();
    let c = seed_c(&sb);
    let out = sb.out();
    assert_summary(&sb.hook(&out, &hook_json(C_ID, &c), &[]), &summary(1, 0, 0, 0));

    append_lines(
        &c,
        &[
            user_line(C_ID, "/home/a/gamma", "2026-10-03T12:00:00.000Z", "Now check the rollback walrus"),
            assistant_line(C_ID, "2026-10-03T12:00:05.000Z", "msg_again", "Rollback walrus verified"),
        ],
    );
    let o = sb.hook(&out, &hook_json(C_ID, &c), &[]);
    assert_summary(&o, &summary(0, 1, 0, 0));

    assert_eq!(node_names(&out), vec![C_NODE.to_string()]);
    assert!(read_node(&out, C_NODE).contains("Rollback walrus verified"));
    assert_eq!(dataset_text(&out).lines().count(), 1);
    assert!(dataset_text(&out).contains("rollback walrus"));
    assert_eq!(graph_ids(&out).iter().filter(|i| i.starts_with("session:")).count(), 1);
}

// ---------------------------------------------------------------------------
// AC-06-09
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_09_hook_bad_input_exits_0_writes_nothing() {
    let sb = Sandbox::new();
    let garbage = sb.p("elsewhere").join("garbage.jsonl");
    fs::create_dir_all(garbage.parent().unwrap()).unwrap();
    fs::write(&garbage, "not a transcript\n{{{\n").unwrap();
    let empty = sb.p("elsewhere").join("empty.jsonl");
    fs::write(&empty, "").unwrap();
    let missing = sb.p("elsewhere").join("missing.jsonl");

    let cases: Vec<(&str, String)> = vec![
        ("not json", "this is not json".to_string()),
        ("empty stdin", String::new()),
        ("no transcript_path", json!({"session_id": "s1", "hook_event_name": "SessionEnd"}).to_string()),
        ("empty object", "{}".to_string()),
        ("missing transcript", hook_json("s1", &missing)),
        ("garbage transcript", hook_json("s1", &garbage)),
        ("empty transcript", hook_json("s1", &empty)),
    ];

    for (i, (label, stdin)) in cases.iter().enumerate() {
        let out = sb.p(&format!("out-{i}"));
        let o = sb.hook(&out, stdin, &[]);
        assert_eq!(code(&o), 0, "{label}: exit code, stderr: {}", stderr_of(&o));
        let err = stderr_of(&o);
        assert!(err.starts_with("kb hook:"), "{label}: stderr was {err:?}");
        assert!(nothing_written(&out), "{label}: files were written");
    }
}

#[test]
fn test_AC_06_09_failed_hook_leaves_existing_knowledge_base_untouched() {
    let sb = Sandbox::new();
    seed_a(&sb);
    seed_b(&sb);
    let out = sb.out();
    assert_summary(&sb.ingest(&out, &[]), &summary(2, 0, 0, 0));
    let before = snapshot(&out);

    let o = sb.hook(&out, "{ definitely not json", &[]);
    assert_eq!(code(&o), 0);
    assert!(stderr_of(&o).starts_with("kb hook:"));
    assert_eq!(snapshot(&out), before);

    let missing = sb.p("elsewhere").join("nope.jsonl");
    let o = sb.hook(&out, &hook_json("nope", &missing), &[]);
    assert_eq!(code(&o), 0);
    assert!(stderr_of(&o).starts_with("kb hook:"));
    assert_eq!(snapshot(&out), before);
}

// ---------------------------------------------------------------------------
// AC-06-10
// ---------------------------------------------------------------------------

fn read_json_file(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).expect("settings file is JSON")
}

fn pos(text: &str, needle: &str) -> usize {
    text.find(needle).unwrap_or_else(|| panic!("{needle} not found in:\n{text}"))
}

#[test]
fn test_AC_06_10_install_keeps_other_settings_and_is_idempotent() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");
    let original = json!({
        "theme": "dark",
        "hooks": {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo pre"}]}
            ],
            "SessionEnd": [
                {"hooks": [{"type": "command", "command": "echo bye"}]}
            ]
        },
        "model": "opus",
        "permissions": {"allow": ["Read", "Bash(ls:*)"], "deny": []}
    });
    // Compact text, deliberately not pretty, with non-alphabetical key order.
    let raw = r#"{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo pre"}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"echo bye"}]}]},"model":"opus","permissions":{"allow":["Read","Bash(ls:*)"],"deny":[]}}"#;
    assert_eq!(serde_json::from_str::<Value>(raw).unwrap(), original);
    fs::write(&settings, raw).unwrap();

    let o = sb.install(&settings, &["--command", "kb hook"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    let so = stdout_of(&o);
    assert!(so.contains("installed"), "stdout: {so:?}");
    assert!(!so.contains("already installed"), "stdout: {so:?}");

    let mut expected = original.clone();
    expected["hooks"]["SessionEnd"]
        .as_array_mut()
        .unwrap()
        .push(json!({"hooks": [{"type": "command", "command": "kb hook"}]}));
    assert_eq!(read_json_file(&settings), expected);

    let text = fs::read_to_string(&settings).unwrap();
    assert!(text.ends_with("}\n"), "must end with a single newline: {text:?}");
    assert!(text.contains("\n  \"theme\": \"dark\","), "2-space indent expected:\n{text}");
    assert!(text.contains("\n  \"hooks\": {\n    \"PreToolUse\": ["), "nested indent:\n{text}");
    assert!(!text.contains('\t'));

    // Key order of the existing content is preserved.
    assert!(pos(&text, "\"theme\"") < pos(&text, "\"hooks\""));
    assert!(pos(&text, "\"hooks\"") < pos(&text, "\"model\""));
    assert!(pos(&text, "\"model\"") < pos(&text, "\"permissions\""));
    assert!(pos(&text, "\"PreToolUse\"") < pos(&text, "\"SessionEnd\""));
    assert!(pos(&text, "echo bye") < pos(&text, "kb hook"));

    // Second run: nothing changes.
    let bytes = fs::read(&settings).unwrap();
    let o2 = sb.install(&settings, &["--command", "kb hook"]);
    assert_eq!(code(&o2), 0, "stderr: {}", stderr_of(&o2));
    assert!(stdout_of(&o2).contains("already installed"), "stdout: {:?}", stdout_of(&o2));
    assert_eq!(fs::read(&settings).unwrap(), bytes);
}

#[test]
fn test_AC_06_10_existing_identical_command_is_not_rewritten() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");
    // Odd formatting that a rewrite would normalise; the command sits in a later entry.
    let raw = "{\"hooks\":{\"SessionEnd\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"other\"}]},\n {\"hooks\":[{\"type\":\"command\",\"command\":\"my-kb hook\"}]}]}}";
    fs::write(&settings, raw).unwrap();

    let o = sb.install(&settings, &["--command", "my-kb hook"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(stdout_of(&o).contains("already installed"), "stdout: {:?}", stdout_of(&o));
    assert_eq!(fs::read_to_string(&settings).unwrap(), raw);
}

#[test]
fn test_AC_06_10_different_command_is_appended_as_second_entry() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");
    fs::write(
        &settings,
        r#"{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"kb hook --no-redact"}]}]}}"#,
    )
    .unwrap();

    let o = sb.install(&settings, &["--command", "kb hook"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(!stdout_of(&o).contains("already installed"));
    assert!(stdout_of(&o).contains("installed"));
    assert_eq!(
        read_json_file(&settings),
        json!({"hooks": {"SessionEnd": [
            {"hooks": [{"type": "command", "command": "kb hook --no-redact"}]},
            {"hooks": [{"type": "command", "command": "kb hook"}]}
        ]}})
    );
}

#[test]
fn test_AC_06_10_same_command_under_other_event_does_not_count() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");
    fs::write(
        &settings,
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"kb hook"}]}]},"x":1}"#,
    )
    .unwrap();

    let o = sb.install(&settings, &["--command", "kb hook"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(!stdout_of(&o).contains("already installed"));
    assert_eq!(
        read_json_file(&settings),
        json!({
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "kb hook"}]}],
                "SessionEnd": [{"hooks": [{"type": "command", "command": "kb hook"}]}]
            },
            "x": 1
        })
    );
}

#[test]
fn test_AC_06_10_settings_without_hooks_key_gets_one() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");
    fs::write(&settings, "{\n  \"env\": {\"A\": \"1\"}\n}\n").unwrap();

    let o = sb.install(&settings, &["--command", "/opt/kb/bin/kb hook"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(stdout_of(&o).contains("installed"));
    assert_eq!(
        read_json_file(&settings),
        json!({
            "env": {"A": "1"},
            "hooks": {"SessionEnd": [{"hooks": [{"type": "command", "command": "/opt/kb/bin/kb hook"}]}]}
        })
    );
    let text = fs::read_to_string(&settings).unwrap();
    assert!(pos(&text, "\"env\"") < pos(&text, "\"hooks\""));
}

#[test]
fn test_AC_06_10_default_command_is_running_executable_plus_hook() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");

    let o = sb.install(&settings, &[]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));

    let v = read_json_file(&settings);
    let cmd = v["hooks"]["SessionEnd"][0]["hooks"][0]["command"]
        .as_str()
        .expect("command string")
        .to_string();
    let exe = cmd.strip_suffix(" hook").unwrap_or_else(|| panic!("command must end with ' hook': {cmd}"));
    assert!(Path::new(exe).is_absolute(), "not absolute: {exe}");
    assert_eq!(
        Path::new(exe).canonicalize().unwrap(),
        Path::new(KB).canonicalize().unwrap()
    );

    // Running it again with the default command is a no-op.
    let bytes = fs::read(&settings).unwrap();
    let o2 = sb.install(&settings, &[]);
    assert!(stdout_of(&o2).contains("already installed"));
    assert_eq!(fs::read(&settings).unwrap(), bytes);
}

// ---------------------------------------------------------------------------
// AC-06-11
// ---------------------------------------------------------------------------

#[test]
fn test_AC_06_11_missing_settings_file_is_created_with_only_the_hook() {
    let sb = Sandbox::new();
    let settings = sb.p("new-settings.json");
    assert!(!settings.exists());

    let o = sb.install(&settings, &["--command", "kb hook"]);
    assert_eq!(code(&o), 0, "stderr: {}", stderr_of(&o));
    assert!(stdout_of(&o).contains("installed"));
    assert!(!stdout_of(&o).contains("already installed"));

    assert_eq!(
        read_json_file(&settings),
        json!({"hooks": {"SessionEnd": [{"hooks": [{"type": "command", "command": "kb hook"}]}]}})
    );
    let expected_text = "{\n  \"hooks\": {\n    \"SessionEnd\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"kb hook\"\n          }\n        ]\n      }\n    ]\n  }\n}\n";
    assert_eq!(fs::read_to_string(&settings).unwrap(), expected_text);
}

#[test]
fn test_AC_06_11_invalid_json_exits_1_and_leaves_file_unchanged() {
    let sb = Sandbox::new();
    let settings = sb.p("settings.json");
    let raw = "{ \"theme\": \"dark\", \"hooks\": ";
    fs::write(&settings, raw).unwrap();

    let o = sb.install(&settings, &["--command", "kb hook"]);
    assert_eq!(code(&o), 1, "stdout: {}", stdout_of(&o));
    assert!(!stderr_of(&o).trim().is_empty());
    assert_eq!(fs::read_to_string(&settings).unwrap(), raw);
}

#[test]
fn test_AC_06_11_wrong_json_types_exit_1_and_leave_file_unchanged() {
    let sb = Sandbox::new();
    let cases = [
        r#"{"hooks":[]}"#,
        r#"{"hooks":"nope"}"#,
        r#"{"hooks":null}"#,
        r#"{"hooks":{"SessionEnd":{}}}"#,
        r#"{"hooks":{"SessionEnd":"nope"}}"#,
    ];
    for (i, raw) in cases.iter().enumerate() {
        let settings = sb.p(&format!("settings-{i}.json"));
        fs::write(&settings, raw).unwrap();

        let o = sb.install(&settings, &["--command", "kb hook"]);
        assert_eq!(code(&o), 1, "case {raw}: stdout {}", stdout_of(&o));
        assert!(!stderr_of(&o).trim().is_empty(), "case {raw}: empty stderr");
        assert_eq!(fs::read_to_string(&settings).unwrap(), *raw, "case {raw}: file changed");
    }
}

#[test]
fn test_AC_06_11_install_hook_without_settings_argument_exits_2() {
    let sb = Sandbox::new();
    let o = sb.run(&["install-hook".to_string()], None);
    assert_eq!(code(&o), 2, "stderr: {}", stderr_of(&o));

    let o = sb.run(
        &[
            "install-hook".to_string(),
            "--settings".to_string(),
            s(&sb.p("s.json")),
            "--bogus-flag".to_string(),
        ],
        None,
    );
    assert_eq!(code(&o), 2, "stderr: {}", stderr_of(&o));
    assert!(!sb.p("s.json").exists());
}
