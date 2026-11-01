//! Phase 01 tests: session model + Claude Code transcript parser.
//!
//! All fixtures are built in memory or in a `tempfile::TempDir`; the real `~/.claude` is never read.

use std::fs;
use std::path::Path;

use kb_core::claude_code::{discover, parse_transcript, parse_transcript_str};
use kb_core::{Block, KbError, Message, Role, Session, Source};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------------

fn join(records: Vec<Value>) -> String {
    records
        .iter()
        .map(|r| r.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn user_rec(text: &str, ts: &str) -> Value {
    json!({
        "type": "user",
        "sessionId": "s1",
        "cwd": "/home/a/proj",
        "gitBranch": "main",
        "timestamp": ts,
        "isSidechain": false,
        "message": {"role": "user", "content": text}
    })
}

fn user_blocks(content: Value, ts: &str) -> Value {
    json!({
        "type": "user",
        "sessionId": "s1",
        "timestamp": ts,
        "message": {"role": "user", "content": content}
    })
}

fn asst_rec(id: Option<&str>, model: &str, ts: &str, content: Value) -> Value {
    let mut message = json!({"role": "assistant", "model": model, "content": content});
    if let Some(id) = id {
        message["id"] = json!(id);
    }
    json!({
        "type": "assistant",
        "sessionId": "s1",
        "timestamp": ts,
        "message": message
    })
}

fn text(s: &str) -> Block {
    Block::Text(s.to_string())
}

fn parse(records: Vec<Value>) -> Session {
    parse_transcript_str(&join(records), "fallback").expect("transcript should parse")
}

fn expect_empty(result: Result<Session, KbError>, expected_id: &str) {
    match result {
        Err(KbError::Empty(id)) => assert_eq!(id, expected_id),
        other => panic!("expected Err(KbError::Empty({expected_id:?})), got {other:?}"),
    }
}

fn tool_use_msg(name: &str, input: Value) -> Message {
    Message {
        role: Role::Assistant,
        timestamp: None,
        blocks: vec![Block::ToolUse {
            id: format!("id_{name}"),
            name: name.to_string(),
            input,
        }],
    }
}

fn bare_session(messages: Vec<Message>) -> Session {
    Session {
        id: "x".to_string(),
        source: Source::ClaudeCode,
        title: "t".to_string(),
        project: None,
        cwd: None,
        git_branch: None,
        started_at: None,
        ended_at: None,
        models: vec![],
        messages,
        prs: vec![],
    }
}

// ---------------------------------------------------------------------------------------------
// AC-01-01: a typical session
// ---------------------------------------------------------------------------------------------

fn typical_transcript() -> String {
    join(vec![
        user_rec("first prompt", "2026-10-01T10:00:00.000Z"),
        asst_rec(
            Some("msg_1"),
            "claude-opus-5-5",
            "2026-10-01T10:00:05.000Z",
            json!([
                {"type": "text", "text": "Let me look at the file."},
                {"type": "tool_use", "id": "tu_1", "name": "Read",
                 "input": {"file_path": "/home/a/proj/src/main.rs"}}
            ]),
        ),
        user_blocks(
            json!([{"type": "tool_result", "tool_use_id": "tu_1", "content": "fn main(){}", "is_error": false}]),
            "2026-10-01T10:00:06.000Z",
        ),
        asst_rec(
            Some("msg_2"),
            "claude-opus-5-5",
            "2026-10-01T10:00:07.000Z",
            json!([{"type": "text", "text": "It is an empty main."}]),
        ),
        user_rec("second prompt", "2026-10-01T10:01:00.000Z"),
        asst_rec(
            Some("msg_3"),
            "claude-opus-5-5",
            "2026-10-01T10:01:05.000Z",
            json!([{"type": "text", "text": "second answer"}]),
        ),
        user_rec("third prompt", "2026-10-01T10:02:00.000Z"),
        asst_rec(
            Some("msg_4"),
            "claude-opus-5-5",
            "2026-10-01T10:02:05.000Z",
            json!([{"type": "text", "text": "third answer"}]),
        ),
    ])
}

#[test]
fn test_AC_01_01_typical_session_metadata() {
    let s = parse_transcript_str(&typical_transcript(), "fallback").unwrap();
    assert_eq!(s.id, "s1");
    assert_eq!(s.source, Source::ClaudeCode);
    assert_eq!(s.cwd.as_deref(), Some("/home/a/proj"));
    assert_eq!(s.project.as_deref(), Some("proj"));
    assert_eq!(s.git_branch.as_deref(), Some("main"));
    assert_eq!(s.title, "first prompt");
}

#[test]
fn test_AC_01_01_typical_session_turns_tools_files() {
    let s = parse_transcript_str(&typical_transcript(), "fallback").unwrap();
    assert_eq!(s.turn_count(), 3);
    assert_eq!(s.tools_used(), vec!["Read".to_string()]);
    assert_eq!(
        s.files_touched(),
        vec!["/home/a/proj/src/main.rs".to_string()]
    );
}

#[test]
fn test_AC_01_01_typical_session_message_structure() {
    let s = parse_transcript_str(&typical_transcript(), "fallback").unwrap();
    let roles: Vec<Role> = s.messages.iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        vec![
            Role::User,
            Role::Assistant,
            Role::User,
            Role::Assistant,
            Role::User,
            Role::Assistant,
            Role::User,
            Role::Assistant
        ]
    );
    assert_eq!(s.messages[0].blocks, vec![text("first prompt")]);
    assert_eq!(
        s.messages[1].blocks,
        vec![
            text("Let me look at the file."),
            Block::ToolUse {
                id: "tu_1".to_string(),
                name: "Read".to_string(),
                input: json!({"file_path": "/home/a/proj/src/main.rs"}),
            }
        ]
    );
    assert_eq!(
        s.messages[2].blocks,
        vec![Block::ToolResult {
            tool_use_id: "tu_1".to_string(),
            content: "fn main(){}".to_string(),
            is_error: false,
        }]
    );
    assert_eq!(
        s.messages[0].timestamp.as_deref(),
        Some("2026-10-01T10:00:00.000Z")
    );
}

#[test]
fn test_AC_01_01_project_none_when_no_cwd() {
    let s = parse(vec![json!({
        "type": "user",
        "sessionId": "s1",
        "message": {"role": "user", "content": "hello"}
    })]);
    assert_eq!(s.cwd, None);
    assert_eq!(s.project, None);
    assert_eq!(s.git_branch, None);
}

#[test]
fn test_AC_01_01_cwd_and_branch_are_first_non_empty() {
    let s = parse(vec![
        json!({"type": "user", "sessionId": "s1", "cwd": "", "gitBranch": "",
               "message": {"role": "user", "content": "one"}}),
        json!({"type": "assistant", "sessionId": "s1", "cwd": "/work/alpha", "gitBranch": "dev",
               "message": {"id": "m1", "model": "m", "role": "assistant",
                           "content": [{"type": "text", "text": "two"}]}}),
        json!({"type": "user", "sessionId": "s1", "cwd": "/work/beta", "gitBranch": "other",
               "message": {"role": "user", "content": "three"}}),
    ]);
    assert_eq!(s.cwd.as_deref(), Some("/work/alpha"));
    assert_eq!(s.project.as_deref(), Some("alpha"));
    assert_eq!(s.git_branch.as_deref(), Some("dev"));
}

#[test]
fn test_AC_01_01_source_as_str() {
    assert_eq!(Source::ClaudeCode.as_str(), "claude-code");
    assert_eq!(Source::ClaudeAi.as_str(), "claude-ai");
}

#[test]
fn test_AC_01_01_tools_used_sorted_and_deduplicated() {
    let s = bare_session(vec![
        tool_use_msg("Write", json!({})),
        tool_use_msg("Bash", json!({})),
        tool_use_msg("Read", json!({})),
        tool_use_msg("Bash", json!({})),
        tool_use_msg("Edit", json!({})),
    ]);
    assert_eq!(
        s.tools_used(),
        vec![
            "Bash".to_string(),
            "Edit".to_string(),
            "Read".to_string(),
            "Write".to_string()
        ]
    );
}

#[test]
fn test_AC_01_01_tools_used_empty_without_tool_calls() {
    let s = bare_session(vec![Message {
        role: Role::Assistant,
        timestamp: None,
        blocks: vec![text("no tools here")],
    }]);
    assert!(s.tools_used().is_empty());
}

#[test]
fn test_AC_01_01_files_touched_keys_sorted_dedup_and_non_strings_ignored() {
    let s = bare_session(vec![
        tool_use_msg("Read", json!({"file_path": "/z/last.rs"})),
        tool_use_msg("Grep", json!({"path": "/a/dir"})),
        tool_use_msg("NotebookEdit", json!({"notebook_path": "/m/nb.ipynb"})),
        tool_use_msg("Edit", json!({"file_path": "/z/last.rs"})),
        tool_use_msg("Read", json!({"file_path": 42})),
        tool_use_msg("Read", json!({"path": null, "file_path": ["/x"]})),
        tool_use_msg("Bash", json!({"command": "ls /not/a/file"})),
    ]);
    assert_eq!(
        s.files_touched(),
        vec![
            "/a/dir".to_string(),
            "/m/nb.ipynb".to_string(),
            "/z/last.rs".to_string()
        ]
    );
}

#[test]
fn test_AC_01_01_files_touched_ignores_tool_results_and_text() {
    let s = bare_session(vec![
        Message {
            role: Role::User,
            timestamp: None,
            blocks: vec![
                text("/home/user/mentioned.rs"),
                Block::ToolResult {
                    tool_use_id: "t".to_string(),
                    content: "/home/user/result.rs".to_string(),
                    is_error: false,
                },
            ],
        },
        tool_use_msg("Read", json!({"file_path": "/only/this.rs"})),
    ]);
    assert_eq!(s.files_touched(), vec!["/only/this.rs".to_string()]);
}

#[test]
fn test_AC_01_01_turn_count_counts_only_user_messages_with_text() {
    let s = bare_session(vec![
        // user with text -> counts
        Message {
            role: Role::User,
            timestamp: None,
            blocks: vec![text("prompt one")],
        },
        // assistant text -> does not count
        Message {
            role: Role::Assistant,
            timestamp: None,
            blocks: vec![text("answer")],
        },
        // user with only a tool_result -> does not count
        Message {
            role: Role::User,
            timestamp: None,
            blocks: vec![Block::ToolResult {
                tool_use_id: "t".to_string(),
                content: "out".to_string(),
                is_error: false,
            }],
        },
        // user with tool_result and text -> counts once
        Message {
            role: Role::User,
            timestamp: None,
            blocks: vec![
                Block::ToolResult {
                    tool_use_id: "t".to_string(),
                    content: "out".to_string(),
                    is_error: false,
                },
                text("prompt two"),
                text("more"),
            ],
        },
    ]);
    assert_eq!(s.turn_count(), 2);
}

#[test]
fn test_AC_01_01_turn_count_zero_for_no_messages() {
    assert_eq!(bare_session(vec![]).turn_count(), 0);
}

// ---------------------------------------------------------------------------------------------
// AC-01-02: split assistant messages are merged
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_02_same_message_id_records_merge_in_order() {
    let s = parse(vec![
        user_rec("do it", "2026-10-01T10:00:00.000Z"),
        asst_rec(
            Some("msg_1"),
            "claude-opus-5-5",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "thinking", "thinking": "plan the work"}]),
        ),
        asst_rec(
            Some("msg_1"),
            "claude-opus-5-5",
            "2026-10-01T10:00:02.000Z",
            json!([{"type": "text", "text": "here is the answer"}]),
        ),
        asst_rec(
            Some("msg_1"),
            "claude-opus-5-5",
            "2026-10-01T10:00:03.000Z",
            json!([{"type": "tool_use", "id": "tu_1", "name": "Read",
                    "input": {"file_path": "/a/b.rs"}}]),
        ),
    ]);
    assert_eq!(s.messages.len(), 2);
    let m = &s.messages[1];
    assert_eq!(m.role, Role::Assistant);
    assert_eq!(
        m.blocks,
        vec![
            Block::Thinking("plan the work".to_string()),
            text("here is the answer"),
            Block::ToolUse {
                id: "tu_1".to_string(),
                name: "Read".to_string(),
                input: json!({"file_path": "/a/b.rs"}),
            }
        ]
    );
    // The merged message keeps the first record's timestamp.
    assert_eq!(m.timestamp.as_deref(), Some("2026-10-01T10:00:01.000Z"));
}

#[test]
fn test_AC_01_02_merge_into_first_even_with_records_in_between() {
    let s = parse(vec![
        asst_rec(
            Some("msg_a"),
            "m",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "part 1"}]),
        ),
        user_blocks(
            json!([{"type": "tool_result", "tool_use_id": "tu_9", "content": "res"}]),
            "2026-10-01T10:00:02.000Z",
        ),
        asst_rec(
            Some("msg_a"),
            "m",
            "2026-10-01T10:00:03.000Z",
            json!([{"type": "text", "text": "part 2"}]),
        ),
    ]);
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].role, Role::Assistant);
    assert_eq!(s.messages[0].blocks, vec![text("part 1"), text("part 2")]);
    assert_eq!(s.messages[1].role, Role::User);
}

#[test]
fn test_AC_01_02_different_ids_stay_separate() {
    let s = parse(vec![
        asst_rec(
            Some("msg_a"),
            "m",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "A"}]),
        ),
        asst_rec(
            Some("msg_b"),
            "m",
            "2026-10-01T10:00:02.000Z",
            json!([{"type": "text", "text": "B"}]),
        ),
    ]);
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].blocks, vec![text("A")]);
    assert_eq!(s.messages[1].blocks, vec![text("B")]);
}

#[test]
fn test_AC_01_02_records_without_message_id_never_merge() {
    let s = parse(vec![
        asst_rec(
            None,
            "m",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "one"}]),
        ),
        asst_rec(
            None,
            "m",
            "2026-10-01T10:00:02.000Z",
            json!([{"type": "text", "text": "two"}]),
        ),
    ]);
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].blocks, vec![text("one")]);
    assert_eq!(s.messages[1].blocks, vec![text("two")]);
}

// ---------------------------------------------------------------------------------------------
// AC-01-03: noise is ignored
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_03_noise_lines_are_ignored_without_error() {
    let mut lines: Vec<String> = Vec::new();
    lines.push(user_rec("keep this prompt", "2026-10-01T10:00:00.000Z").to_string());
    lines.push(String::new());
    lines.push("   ".to_string());
    lines.push("{this is not json".to_string());
    lines.push("[1,2,3]".to_string());
    lines.push("42".to_string());
    lines.push("\"just a string\"".to_string());
    lines.push(
        json!({"type": "user", "sessionId": "s1", "isSidechain": true, "timestamp": "2026-10-01T10:00:01.000Z",
               "message": {"role": "user", "content": "sidechain prompt"}})
        .to_string(),
    );
    lines.push(
        json!({"type": "assistant", "sessionId": "s1", "isSidechain": true, "timestamp": "2026-10-01T10:00:02.000Z",
               "message": {"id": "side", "model": "sidechain-model", "role": "assistant",
                           "content": [{"type": "text", "text": "sidechain answer"}]}})
        .to_string(),
    );
    lines.push(
        json!({"type": "user", "sessionId": "s1", "isMeta": true, "timestamp": "2026-10-01T10:00:03.000Z",
               "message": {"role": "user", "content": "meta caveat"}})
        .to_string(),
    );
    lines.push(
        json!({"type": "assistant", "sessionId": "s1", "timestamp": "2026-10-01T10:00:04.000Z",
               "message": {"id": "syn", "model": "<synthetic>", "role": "assistant",
                           "content": [{"type": "text", "text": "No response requested."}]}})
        .to_string(),
    );
    lines.push(json!({"type": "file-history-snapshot", "snapshot": {}}).to_string());
    lines.push(json!({"type": "system", "content": "system noise"}).to_string());
    lines.push(json!({"type": "queue-operation", "operation": "enqueue"}).to_string());
    lines.push(json!({"no_type_at_all": true}).to_string());
    lines.push(
        asst_rec(
            Some("real"),
            "claude-opus-5-5",
            "2026-10-01T10:00:05.000Z",
            json!([{"type": "text", "text": "real answer"}]),
        )
        .to_string(),
    );
    lines.push("{\"type\":\"user\",\"message\":{\"role\":\"us".to_string()); // truncated last line

    let s = parse_transcript_str(&lines.join("\n"), "fallback").unwrap();
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].blocks, vec![text("keep this prompt")]);
    assert_eq!(s.messages[1].blocks, vec![text("real answer")]);
    assert_eq!(s.models, vec!["claude-opus-5-5".to_string()]);
    assert_eq!(s.turn_count(), 1);
    assert_eq!(s.ended_at.as_deref(), Some("2026-10-01T10:00:05.000Z"));
}

#[test]
fn test_AC_01_03_sidechain_only_transcript_is_empty() {
    let text_in = join(vec![
        json!({"type": "user", "sessionId": "s1", "isSidechain": true,
               "message": {"role": "user", "content": "side"}}),
        json!({"type": "assistant", "sessionId": "s1", "isSidechain": true,
               "message": {"id": "a", "model": "m", "role": "assistant",
                           "content": [{"type": "text", "text": "side"}]}}),
    ]);
    expect_empty(parse_transcript_str(&text_in, "fb-side"), "fb-side");
}

#[test]
fn test_AC_01_03_meta_only_transcript_is_empty() {
    let text_in = join(vec![json!({
        "type": "user", "sessionId": "s1", "isMeta": true,
        "message": {"role": "user", "content": "Caveat: the messages below were generated by the user"}
    })]);
    expect_empty(parse_transcript_str(&text_in, "fb-meta"), "fb-meta");
}

#[test]
fn test_AC_01_03_synthetic_assistant_is_ignored_entirely() {
    let text_in = join(vec![json!({
        "type": "assistant", "sessionId": "s1", "timestamp": "2026-10-01T10:00:00.000Z",
        "message": {"id": "x", "model": "<synthetic>", "role": "assistant",
                    "content": [{"type": "text", "text": "No response requested."}]}
    })]);
    expect_empty(parse_transcript_str(&text_in, "fb-syn"), "fb-syn");
}

#[test]
fn test_AC_01_03_explicit_false_flags_are_kept() {
    let s = parse(vec![
        json!({"type": "user", "sessionId": "s1", "isSidechain": false, "isMeta": false,
               "message": {"role": "user", "content": "normal prompt"}}),
    ]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.messages[0].blocks, vec![text("normal prompt")]);
}

#[test]
fn test_AC_01_03_only_garbage_lines_is_empty_not_a_panic() {
    let garbage = "\n\n{{{{\nnull\ntrue\n[]\n{\"type\":\"nonsense\"}\n";
    expect_empty(parse_transcript_str(garbage, "fb-garbage"), "fb-garbage");
}

#[test]
fn test_AC_01_03_windows_line_endings_are_tolerated() {
    let raw = format!(
        "{}\r\n{}\r\n",
        user_rec("crlf prompt", "2026-10-01T10:00:00.000Z"),
        asst_rec(
            Some("m1"),
            "m",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "crlf answer"}])
        )
    );
    let s = parse_transcript_str(&raw, "fallback").unwrap();
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].blocks, vec![text("crlf prompt")]);
}

// ---------------------------------------------------------------------------------------------
// AC-01-04: system reminders
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_04_multiline_system_reminder_removed_and_text_trimmed() {
    let s = parse(vec![user_rec(
        "Fix the bug.\n<system-reminder>\nline one\nline two\n</system-reminder>\n",
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.messages[0].blocks, vec![text("Fix the bug.")]);
}

#[test]
fn test_AC_01_04_multiple_spans_all_removed() {
    let s = parse(vec![user_rec(
        "<system-reminder>a</system-reminder>Hello<system-reminder>\nb\n</system-reminder>",
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(s.messages[0].blocks, vec![text("Hello")]);
}

#[test]
fn test_AC_01_04_span_in_the_middle_is_cut_out() {
    let s = parse(vec![user_rec(
        "AB<system-reminder>secret instructions</system-reminder>CD",
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(s.messages[0].blocks, vec![text("ABCD")]);
}

#[test]
fn test_AC_01_04_message_with_only_reminder_disappears() {
    let s = parse(vec![
        user_rec(
            "<system-reminder>\nOnly a reminder here.\n</system-reminder>",
            "2026-10-01T10:00:00.000Z",
        ),
        user_rec("real prompt", "2026-10-01T10:00:01.000Z"),
    ]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.messages[0].blocks, vec![text("real prompt")]);
    assert_eq!(s.turn_count(), 1);
    // The dropped message must not leak into the timestamp range either.
    assert_eq!(s.started_at.as_deref(), Some("2026-10-01T10:00:01.000Z"));
}

#[test]
fn test_AC_01_04_reminder_only_transcript_is_empty() {
    let text_in = join(vec![user_rec(
        "<system-reminder>x</system-reminder>",
        "2026-10-01T10:00:00.000Z",
    )]);
    expect_empty(parse_transcript_str(&text_in, "fb-rem"), "fb-rem");
}

#[test]
fn test_AC_01_04_reminder_in_array_text_block_removed_other_blocks_stay() {
    let s = parse(vec![user_blocks(
        json!([
            {"type": "text", "text": "<system-reminder>hidden</system-reminder>"},
            {"type": "text", "text": "visible <system-reminder>hidden</system-reminder>"},
            {"type": "tool_result", "tool_use_id": "tu_1", "content": "result body"}
        ]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(
        s.messages[0].blocks,
        vec![
            text("visible"),
            Block::ToolResult {
                tool_use_id: "tu_1".to_string(),
                content: "result body".to_string(),
                is_error: false,
            }
        ]
    );
}

#[test]
fn test_AC_01_04_reminder_only_text_next_to_tool_result_keeps_tool_result_message() {
    let s = parse(vec![user_blocks(
        json!([
            {"type": "tool_result", "tool_use_id": "tu_1", "content": "ok"},
            {"type": "text", "text": "<system-reminder>noise</system-reminder>"}
        ]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "tu_1".to_string(),
            content: "ok".to_string(),
            is_error: false,
        }]
    );
    assert_eq!(s.turn_count(), 0);
}

#[test]
fn test_AC_01_04_text_without_reminder_is_only_trimmed() {
    let s = parse(vec![user_rec(
        "  keep <b>markup</b> as is \n",
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(s.messages[0].blocks, vec![text("keep <b>markup</b> as is")]);
}

// ---------------------------------------------------------------------------------------------
// AC-01-05: thinking blocks
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_05_empty_and_whitespace_thinking_dropped_nonempty_kept() {
    let s = parse(vec![asst_rec(
        Some("m1"),
        "m",
        "2026-10-01T10:00:00.000Z",
        json!([
            {"type": "thinking", "thinking": ""},
            {"type": "thinking", "thinking": "  \n\t "},
            {"type": "thinking", "thinking": "real reasoning"},
            {"type": "text", "text": "answer"}
        ]),
    )]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(
        s.messages[0].blocks,
        vec![
            Block::Thinking("real reasoning".to_string()),
            text("answer")
        ]
    );
}

#[test]
fn test_AC_01_05_message_with_only_empty_thinking_is_dropped() {
    let s = parse(vec![
        user_rec("prompt", "2026-10-01T10:00:00.000Z"),
        asst_rec(
            Some("m1"),
            "ghost-model",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "thinking", "thinking": ""}]),
        ),
    ]);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.messages[0].role, Role::User);
    // A dropped message contributes neither a timestamp nor a model.
    assert_eq!(s.ended_at.as_deref(), Some("2026-10-01T10:00:00.000Z"));
    assert!(s.models.is_empty());
}

#[test]
fn test_AC_01_05_redacted_thinking_and_unknown_items_dropped() {
    let s = parse(vec![asst_rec(
        Some("m1"),
        "m",
        "2026-10-01T10:00:00.000Z",
        json!([
            {"type": "redacted_thinking", "data": "abcdef"},
            {"type": "server_tool_use", "id": "x", "name": "web_search", "input": {}},
            {"type": "text", "text": "visible answer"}
        ]),
    )]);
    assert_eq!(s.messages[0].blocks, vec![text("visible answer")]);
}

#[test]
fn test_AC_01_05_thinking_text_is_preserved_verbatim() {
    let s = parse(vec![asst_rec(
        Some("m1"),
        "m",
        "2026-10-01T10:00:00.000Z",
        json!([{"type": "thinking", "thinking": "step 1\nstep 2", "signature": "sig"}]),
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::Thinking("step 1\nstep 2".to_string())]
    );
}

// ---------------------------------------------------------------------------------------------
// AC-01-06: tool_result content
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_06_array_content_joined_with_newlines_and_image_placeholder() {
    let s = parse(vec![user_blocks(
        json!([{
            "type": "tool_result",
            "tool_use_id": "tu_7",
            "content": [
                {"type": "text", "text": "line one"},
                {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
                {"type": "text", "text": "line two"}
            ]
        }]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "tu_7".to_string(),
            content: "line one\n[image]\nline two".to_string(),
            is_error: false,
        }]
    );
}

#[test]
fn test_AC_01_06_is_error_true_is_preserved() {
    let s = parse(vec![user_blocks(
        json!([{
            "type": "tool_result",
            "tool_use_id": "tu_8",
            "content": "command failed: exit 2",
            "is_error": true
        }]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "tu_8".to_string(),
            content: "command failed: exit 2".to_string(),
            is_error: true,
        }]
    );
}

#[test]
fn test_AC_01_06_missing_is_error_and_tool_use_id_use_defaults() {
    let s = parse(vec![user_blocks(
        json!([{"type": "tool_result", "content": "bare result"}]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: String::new(),
            content: "bare result".to_string(),
            is_error: false,
        }]
    );
}

#[test]
fn test_AC_01_06_string_content_used_as_is() {
    let s = parse(vec![user_blocks(
        json!([{"type": "tool_result", "tool_use_id": "t", "content": "  spaced\nout  \n"}]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "t".to_string(),
            content: "  spaced\nout  \n".to_string(),
            is_error: false,
        }]
    );
}

#[test]
fn test_AC_01_06_array_with_single_text_item_has_no_separator() {
    let s = parse(vec![user_blocks(
        json!([{"type": "tool_result", "tool_use_id": "t",
                "content": [{"type": "text", "text": "only"}]}]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "t".to_string(),
            content: "only".to_string(),
            is_error: false,
        }]
    );
}

#[test]
fn test_AC_01_06_two_images_become_two_placeholders() {
    let s = parse(vec![user_blocks(
        json!([{"type": "tool_result", "tool_use_id": "t",
                "content": [{"type": "image", "source": {}}, {"type": "image", "source": {}}]}]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "t".to_string(),
            content: "[image]\n[image]".to_string(),
            is_error: false,
        }]
    );
}

#[test]
fn test_AC_01_06_user_image_item_becomes_placeholder_text() {
    let s = parse(vec![user_blocks(
        json!([{"type": "text", "text": "look at this"}, {"type": "image", "source": {}}]),
        "2026-10-01T10:00:00.000Z",
    )]);
    assert_eq!(
        s.messages[0].blocks,
        vec![text("look at this"), text("[image]")]
    );
}

// ---------------------------------------------------------------------------------------------
// AC-01-07: title precedence
// ---------------------------------------------------------------------------------------------

fn title_base() -> Vec<Value> {
    vec![
        user_rec("  first   user\n\ttext  ", "2026-10-01T10:00:00.000Z"),
        asst_rec(
            Some("m1"),
            "m",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "assistant words"}]),
        ),
    ]
}

#[test]
fn test_AC_01_07_custom_title_beats_summary_and_user_text() {
    let mut recs = title_base();
    recs.push(json!({"type": "summary", "summary": "Short summary", "leafUuid": "u"}));
    recs.push(json!({"type": "custom-title", "sessionId": "s1", "customTitle": "My title"}));
    assert_eq!(parse(recs).title, "My title");
}

#[test]
fn test_AC_01_07_custom_title_before_messages_still_wins() {
    let mut recs = vec![
        json!({"type": "custom-title", "sessionId": "s1", "customTitle": "Early title"}),
        json!({"type": "summary", "summary": "Some summary"}),
    ];
    recs.extend(title_base());
    assert_eq!(parse(recs).title, "Early title");
}

#[test]
fn test_AC_01_07_last_custom_title_wins() {
    let mut recs = title_base();
    recs.push(json!({"type": "custom-title", "customTitle": "Old name"}));
    recs.push(json!({"type": "custom-title", "customTitle": "Newest name"}));
    assert_eq!(parse(recs).title, "Newest name");
}

#[test]
fn test_AC_01_07_summary_beats_user_text() {
    let mut recs = title_base();
    recs.push(json!({"type": "summary", "summary": "Short summary", "leafUuid": "u"}));
    assert_eq!(parse(recs).title, "Short summary");
}

#[test]
fn test_AC_01_07_last_summary_wins() {
    let mut recs = title_base();
    recs.push(json!({"type": "summary", "summary": "First summary"}));
    recs.push(json!({"type": "summary", "summary": "Second summary"}));
    assert_eq!(parse(recs).title, "Second summary");
}

#[test]
fn test_AC_01_07_empty_custom_title_falls_through_to_summary() {
    let mut recs = title_base();
    recs.push(json!({"type": "summary", "summary": "Fallback summary"}));
    recs.push(json!({"type": "custom-title", "customTitle": ""}));
    assert_eq!(parse(recs).title, "Fallback summary");
}

#[test]
fn test_AC_01_07_empty_summary_falls_through_to_user_text() {
    let mut recs = title_base();
    recs.push(json!({"type": "summary", "summary": ""}));
    assert_eq!(parse(recs).title, "first user text");
}

#[test]
fn test_AC_01_07_user_text_whitespace_collapsed_and_trimmed() {
    assert_eq!(parse(title_base()).title, "first user text");
}

#[test]
fn test_AC_01_07_title_cut_to_80_chars_not_bytes() {
    let long = "é".repeat(100);
    let s = parse(vec![user_rec(&long, "2026-10-01T10:00:00.000Z")]);
    assert_eq!(s.title.chars().count(), 80);
    assert_eq!(s.title, "é".repeat(80));
}

#[test]
fn test_AC_01_07_title_of_exactly_80_chars_is_kept_and_81_is_cut() {
    let eighty = "x".repeat(80);
    let s = parse(vec![user_rec(&eighty, "2026-10-01T10:00:00.000Z")]);
    assert_eq!(s.title, eighty);

    let s = parse(vec![user_rec(&"x".repeat(81), "2026-10-01T10:00:00.000Z")]);
    assert_eq!(s.title, eighty);
}

#[test]
fn test_AC_01_07_title_skips_dropped_reminder_message_and_uses_next_user_text() {
    let s = parse(vec![
        user_rec(
            "<system-reminder>boot</system-reminder>",
            "2026-10-01T10:00:00.000Z",
        ),
        user_rec("actual question", "2026-10-01T10:00:01.000Z"),
    ]);
    assert_eq!(s.title, "actual question");
}

#[test]
fn test_AC_01_07_title_untitled_when_no_user_text() {
    let s = parse(vec![asst_rec(
        Some("m1"),
        "m",
        "2026-10-01T10:00:00.000Z",
        json!([{"type": "text", "text": "assistant only"}]),
    )]);
    assert_eq!(s.title, "Untitled");
}

#[test]
fn test_AC_01_07_title_untitled_when_user_only_has_tool_results() {
    let s = parse(vec![
        user_blocks(
            json!([{"type": "tool_result", "tool_use_id": "t", "content": "res"}]),
            "2026-10-01T10:00:00.000Z",
        ),
        asst_rec(
            Some("m1"),
            "m",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "hi"}]),
        ),
    ]);
    assert_eq!(s.title, "Untitled");
}

// ---------------------------------------------------------------------------------------------
// AC-01-08: timestamps, models, prs
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_08_started_and_ended_are_min_and_max_of_kept_timestamps() {
    let s = parse(vec![
        user_rec("b", "2026-10-02T09:00:00.000Z"),
        asst_rec(
            Some("m1"),
            "m",
            "2026-10-01T08:30:00.000Z",
            json!([{"type": "text", "text": "earliest but listed second"}]),
        ),
        user_rec("c", "2026-10-05T23:59:59.000Z"),
        asst_rec(
            Some("m2"),
            "m",
            "2026-10-03T00:00:00.000Z",
            json!([{"type": "text", "text": "later in file, not the max"}]),
        ),
    ]);
    assert_eq!(s.started_at.as_deref(), Some("2026-10-01T08:30:00.000Z"));
    assert_eq!(s.ended_at.as_deref(), Some("2026-10-05T23:59:59.000Z"));
}

#[test]
fn test_AC_01_08_timestamps_of_ignored_records_do_not_count() {
    let s = parse(vec![
        user_rec("kept", "2026-10-02T10:00:00.000Z"),
        json!({"type": "user", "sessionId": "s1", "isSidechain": true, "timestamp": "2000-01-01T00:00:00.000Z",
               "message": {"role": "user", "content": "side"}}),
        json!({"type": "user", "sessionId": "s1", "isMeta": true, "timestamp": "2099-01-01T00:00:00.000Z",
               "message": {"role": "user", "content": "meta"}}),
    ]);
    assert_eq!(s.started_at.as_deref(), Some("2026-10-02T10:00:00.000Z"));
    assert_eq!(s.ended_at.as_deref(), Some("2026-10-02T10:00:00.000Z"));
}

#[test]
fn test_AC_01_08_timestamps_none_when_no_record_has_one() {
    let s = parse(vec![json!({
        "type": "user", "sessionId": "s1",
        "message": {"role": "user", "content": "no clock"}
    })]);
    assert_eq!(s.started_at, None);
    assert_eq!(s.ended_at, None);
    assert_eq!(s.messages[0].timestamp, None);
}

#[test]
fn test_AC_01_08_messages_without_timestamp_are_skipped_for_range() {
    let s = parse(vec![
        json!({"type": "user", "sessionId": "s1", "message": {"role": "user", "content": "no clock"}}),
        user_rec("clocked", "2026-10-04T10:00:00.000Z"),
    ]);
    assert_eq!(s.started_at.as_deref(), Some("2026-10-04T10:00:00.000Z"));
    assert_eq!(s.ended_at.as_deref(), Some("2026-10-04T10:00:00.000Z"));
}

#[test]
fn test_AC_01_08_models_distinct_in_first_seen_order_without_synthetic() {
    let s = parse(vec![
        user_rec("q", "2026-10-01T10:00:00.000Z"),
        asst_rec(
            Some("m1"),
            "claude-sonnet-5",
            "2026-10-01T10:00:01.000Z",
            json!([{"type": "text", "text": "a"}]),
        ),
        asst_rec(
            Some("m2"),
            "claude-opus-5-5",
            "2026-10-01T10:00:02.000Z",
            json!([{"type": "text", "text": "b"}]),
        ),
        asst_rec(
            Some("m3"),
            "<synthetic>",
            "2026-10-01T10:00:03.000Z",
            json!([{"type": "text", "text": "No response requested."}]),
        ),
        asst_rec(
            Some("m4"),
            "claude-sonnet-5",
            "2026-10-01T10:00:04.000Z",
            json!([{"type": "text", "text": "c"}]),
        ),
        asst_rec(
            Some("m5"),
            "claude-haiku-5",
            "2026-10-01T10:00:05.000Z",
            json!([{"type": "text", "text": "d"}]),
        ),
    ]);
    assert_eq!(
        s.models,
        vec![
            "claude-sonnet-5".to_string(),
            "claude-opus-5-5".to_string(),
            "claude-haiku-5".to_string()
        ]
    );
}

#[test]
fn test_AC_01_08_models_empty_when_no_assistant_message() {
    let s = parse(vec![user_rec("only me", "2026-10-01T10:00:00.000Z")]);
    assert!(s.models.is_empty());
}

#[test]
fn test_AC_01_08_prs_distinct_in_order_with_prurl_or_url() {
    let s = parse(vec![
        user_rec("q", "2026-10-01T10:00:00.000Z"),
        json!({"type": "pr-link", "sessionId": "s1", "prUrl": "https://github.com/o/r/pull/7"}),
        json!({"type": "pr-link", "sessionId": "s1", "url": "https://github.com/o/r/pull/3"}),
        json!({"type": "pr-link", "sessionId": "s1", "prUrl": "https://github.com/o/r/pull/7"}),
        json!({"type": "pr-link", "sessionId": "s1", "prUrl": "https://github.com/o/r/pull/9"}),
    ]);
    assert_eq!(
        s.prs,
        vec![
            "https://github.com/o/r/pull/7".to_string(),
            "https://github.com/o/r/pull/3".to_string(),
            "https://github.com/o/r/pull/9".to_string()
        ]
    );
}

#[test]
fn test_AC_01_08_prs_empty_without_pr_link_records() {
    let s = parse(vec![user_rec("q", "2026-10-01T10:00:00.000Z")]);
    assert!(s.prs.is_empty());
}

// ---------------------------------------------------------------------------------------------
// AC-01-09: empty and unreadable
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_09_no_user_or_assistant_records_is_empty_error_with_fallback_id() {
    let text_in = join(vec![
        json!({"type": "custom-title", "sessionId": "s1", "customTitle": "Only a title"}),
        json!({"type": "summary", "summary": "Only a summary"}),
        json!({"type": "pr-link", "sessionId": "s1", "prUrl": "https://github.com/o/r/pull/1"}),
    ]);
    expect_empty(parse_transcript_str(&text_in, "my-fallback"), "my-fallback");
}

#[test]
fn test_AC_01_09_empty_string_is_empty_error() {
    expect_empty(parse_transcript_str("", "blank"), "blank");
}

#[test]
fn test_AC_01_09_empty_file_via_parse_transcript_is_empty_error_with_stem() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("abc-123.jsonl");
    fs::write(&path, "").unwrap();
    expect_empty(parse_transcript(&path), "abc-123");
}

#[test]
fn test_AC_01_09_unreadable_path_is_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("does-not-exist.jsonl");
    match parse_transcript(&path) {
        Err(KbError::Io(_)) => {}
        other => panic!("expected Err(KbError::Io(_)), got {other:?}"),
    }
}

#[test]
fn test_AC_01_09_kb_error_from_io_error_and_display() {
    let io = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
    let err: KbError = io.into();
    assert!(matches!(err, KbError::Io(_)));
    assert!(!err.to_string().is_empty());

    for e in [
        KbError::Empty("sess".to_string()),
        KbError::Parse("bad".to_string()),
        KbError::Settings("broken".to_string()),
    ] {
        assert!(!e.to_string().is_empty());
        let as_dyn: &dyn std::error::Error = &e;
        assert!(!as_dyn.to_string().is_empty());
    }
}

// ---------------------------------------------------------------------------------------------
// AC-01-10: id and fallback
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_10_parse_transcript_uses_file_stem_when_no_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("0f3c-stem-id.jsonl");
    let content = join(vec![
        json!({"type": "user", "message": {"role": "user", "content": "hello"}}),
        json!({"type": "assistant",
               "message": {"id": "m1", "model": "m", "role": "assistant",
                           "content": [{"type": "text", "text": "hi"}]}}),
    ]);
    fs::write(&path, content).unwrap();
    let s = parse_transcript(&path).unwrap();
    assert_eq!(s.id, "0f3c-stem-id");
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.source, Source::ClaudeCode);
}

#[test]
fn test_AC_01_10_session_id_in_records_beats_file_stem() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file-name.jsonl");
    fs::write(&path, typical_transcript()).unwrap();
    let s = parse_transcript(&path).unwrap();
    assert_eq!(s.id, "s1");
    assert_eq!(s.project.as_deref(), Some("proj"));
    assert_eq!(s.turn_count(), 3);
}

#[test]
fn test_AC_01_10_parse_transcript_str_uses_fallback_id_when_no_session_id() {
    let s = parse_transcript_str(
        &json!({"type": "user", "message": {"role": "user", "content": "hi"}}).to_string(),
        "given-fallback",
    )
    .unwrap();
    assert_eq!(s.id, "given-fallback");
}

#[test]
fn test_AC_01_10_first_record_with_session_id_wins() {
    let s = parse(vec![
        json!({"type": "user", "message": {"role": "user", "content": "no id on this one"}}),
        json!({"type": "user", "sessionId": "first-id", "message": {"role": "user", "content": "a"}}),
        json!({"type": "user", "sessionId": "second-id", "message": {"role": "user", "content": "b"}}),
    ]);
    assert_eq!(s.id, "first-id");
}

// ---------------------------------------------------------------------------------------------
// AC-01-11: discover
// ---------------------------------------------------------------------------------------------

fn touch(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "{}\n").unwrap();
}

#[test]
fn test_AC_01_11_discover_returns_project_level_jsonl_sorted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();

    // Created deliberately out of order.
    touch(&root.join("proj-b").join("z.jsonl"));
    touch(&root.join("proj-a").join("y.jsonl"));
    touch(&root.join("proj-a").join("x.jsonl"));
    touch(&root.join("proj-c").join("m.jsonl"));

    let found = discover(&root);
    assert_eq!(
        found,
        vec![
            root.join("proj-a").join("x.jsonl"),
            root.join("proj-a").join("y.jsonl"),
            root.join("proj-b").join("z.jsonl"),
            root.join("proj-c").join("m.jsonl"),
        ]
    );
}

#[test]
fn test_AC_01_11_discover_ignores_subagents_deeper_files_other_extensions_and_top_level() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();

    touch(&root.join("proj").join("session1.jsonl"));
    touch(
        &root
            .join("proj")
            .join("session1")
            .join("subagents")
            .join("agent-1.jsonl"),
    );
    touch(&root.join("proj").join("session1").join("direct.jsonl"));
    touch(&root.join("proj").join("notes.txt"));
    touch(&root.join("proj").join("data.json"));
    touch(&root.join("proj").join("jsonl")); // no extension
    touch(&root.join("top-level.jsonl"));
    fs::create_dir_all(root.join("empty-project")).unwrap();

    let found = discover(&root);
    assert_eq!(found, vec![root.join("proj").join("session1.jsonl")]);
}

#[test]
fn test_AC_01_11_discover_missing_dir_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such-projects-dir");
    assert!(discover(&missing).is_empty());
}

#[test]
fn test_AC_01_11_discover_empty_dir_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(discover(dir.path()).is_empty());
}

#[test]
fn test_AC_01_11_discovered_files_can_be_parsed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let file = root.join("-home-a-proj").join("sess-xyz.jsonl");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, typical_transcript()).unwrap();

    let found = discover(&root);
    assert_eq!(found, vec![file.clone()]);
    let s = parse_transcript(&found[0]).unwrap();
    assert_eq!(s.id, "s1");
}

// ---------------------------------------------------------------------------------------------
// AC-01-12: serde round trip
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_01_12_parsed_session_round_trips_through_serde_json() {
    let s = parse_transcript_str(&typical_transcript(), "fallback").unwrap();
    let encoded = serde_json::to_string(&s).unwrap();
    let decoded: Session = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, s);
}

#[test]
fn test_AC_01_12_hand_built_session_with_every_block_variant_round_trips() {
    let s = Session {
        id: "round-trip".to_string(),
        source: Source::ClaudeAi,
        title: "Ünïcode ✓ title".to_string(),
        project: Some("proj".to_string()),
        cwd: Some("/x/proj".to_string()),
        git_branch: Some("feat/x".to_string()),
        started_at: Some("2026-10-01T00:00:00.000Z".to_string()),
        ended_at: Some("2026-10-02T00:00:00.000Z".to_string()),
        models: vec!["m1".to_string(), "m2".to_string()],
        messages: vec![
            Message {
                role: Role::User,
                timestamp: Some("2026-10-01T00:00:00.000Z".to_string()),
                blocks: vec![text("hello \"quoted\"\nnewline")],
            },
            Message {
                role: Role::Assistant,
                timestamp: None,
                blocks: vec![
                    Block::Thinking("hmm".to_string()),
                    text("answer"),
                    Block::ToolUse {
                        id: "tu".to_string(),
                        name: "Read".to_string(),
                        input: json!({"file_path": "/x", "nested": {"a": [1, 2, null]}}),
                    },
                ],
            },
            Message {
                role: Role::User,
                timestamp: None,
                blocks: vec![Block::ToolResult {
                    tool_use_id: "tu".to_string(),
                    content: "boom".to_string(),
                    is_error: true,
                }],
            },
        ],
        prs: vec!["https://github.com/o/r/pull/1".to_string()],
    };
    let encoded = serde_json::to_string(&s).unwrap();
    let decoded: Session = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, s);

    // Pretty form must decode to the same value too.
    let pretty = serde_json::to_string_pretty(&s).unwrap();
    let decoded_pretty: Session = serde_json::from_str(&pretty).unwrap();
    assert_eq!(decoded_pretty, s);
}

#[test]
fn test_AC_01_12_none_fields_and_enums_round_trip() {
    let s = bare_session(vec![]);
    let decoded: Session = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(decoded, s);

    for src in [Source::ClaudeCode, Source::ClaudeAi] {
        let back: Source = serde_json::from_str(&serde_json::to_string(&src).unwrap()).unwrap();
        assert_eq!(back, src);
    }
    for role in [Role::User, Role::Assistant] {
        let back: Role = serde_json::from_str(&serde_json::to_string(&role).unwrap()).unwrap();
        assert_eq!(back, role);
    }
}
