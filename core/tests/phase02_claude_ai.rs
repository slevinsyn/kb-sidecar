//! Phase 02 tests: claude.ai export parser.
//!
//! All fixtures are built in a `tempfile::TempDir`. Zips are written by a tiny in-file "stored"
//! (uncompressed) zip writer so the tests do not depend on a particular `zip` crate version.

use std::fs;
use std::path::{Path, PathBuf};

use kb_core::claude_ai::{parse_conversations_json, parse_export};
use kb_core::{Block, KbError, Role, Session, Source};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (!(crc & 1)).wrapping_add(1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn le16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn le32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// Build a zip archive (stored, no compression) with the given entries in order.
fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let name_bytes = name.as_bytes();

        le32(&mut out, 0x0403_4b50);
        le16(&mut out, 20);
        le16(&mut out, 0);
        le16(&mut out, 0);
        le16(&mut out, 0);
        le16(&mut out, 0x21);
        le32(&mut out, crc);
        le32(&mut out, data.len() as u32);
        le32(&mut out, data.len() as u32);
        le16(&mut out, name_bytes.len() as u16);
        le16(&mut out, 0);
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        le32(&mut central, 0x0201_4b50);
        le16(&mut central, 20);
        le16(&mut central, 20);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0x21);
        le32(&mut central, crc);
        le32(&mut central, data.len() as u32);
        le32(&mut central, data.len() as u32);
        le16(&mut central, name_bytes.len() as u16);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le32(&mut central, 0);
        le32(&mut central, offset);
        central.extend_from_slice(name_bytes);
    }
    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    le32(&mut out, 0x0605_4b50);
    le16(&mut out, 0);
    le16(&mut out, 0);
    le16(&mut out, entries.len() as u16);
    le16(&mut out, entries.len() as u16);
    le32(&mut out, cd_size);
    le32(&mut out, cd_offset);
    le16(&mut out, 0);
    out
}

fn human(uuid: &str, text: &str, ts: &str) -> Value {
    json!({
        "uuid": uuid, "sender": "human", "text": text, "created_at": ts,
        "content": [{"type": "text", "text": text}]
    })
}

fn assistant(uuid: &str, text: &str, ts: &str) -> Value {
    json!({
        "uuid": uuid, "sender": "assistant", "text": text, "created_at": ts,
        "content": [{"type": "text", "text": text}]
    })
}

fn conv(uuid: &str, name: &str, created: &str, updated: &str, msgs: Vec<Value>) -> Value {
    json!({
        "uuid": uuid, "name": name, "created_at": created, "updated_at": updated,
        "chat_messages": msgs
    })
}

fn to_text(convs: Vec<Value>) -> String {
    Value::Array(convs).to_string()
}

fn parse(convs: Vec<Value>) -> Vec<Session> {
    parse_conversations_json(&to_text(convs)).expect("conversations.json should parse")
}

fn text(s: &str) -> Block {
    Block::Text(s.to_string())
}

fn two_conversations() -> Vec<Value> {
    vec![
        conv(
            "c1",
            "Rust lifetimes",
            "2026-09-01T08:00:00Z",
            "2026-09-01T09:00:00Z",
            vec![
                human("m1", "explain lifetimes", "2026-09-01T08:00:00Z"),
                assistant("m2", "Lifetimes are...", "2026-09-01T08:00:05Z"),
            ],
        ),
        conv(
            "c2",
            "Cooking pasta",
            "2026-09-02T12:00:00Z",
            "2026-09-02T12:30:00Z",
            vec![
                human("m3", "how long to boil penne", "2026-09-02T12:00:00Z"),
                assistant("m4", "About 11 minutes.", "2026-09-02T12:00:09Z"),
            ],
        ),
    ]
}

fn assert_parse_err(result: Result<Vec<Session>, KbError>) {
    match result {
        Err(KbError::Parse(_)) => {}
        other => panic!("expected Err(KbError::Parse(_)), got {other:?}"),
    }
}

fn assert_io_err(result: Result<Vec<Session>, KbError>) {
    match result {
        Err(KbError::Io(_)) => {}
        other => panic!("expected Err(KbError::Io(_)), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------
// AC-02-01: two conversations
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_02_01_two_conversations_yield_two_sessions() {
    let sessions = parse(two_conversations());
    assert_eq!(sessions.len(), 2);

    let a = &sessions[0];
    assert_eq!(a.id, "c1");
    assert_eq!(a.source, Source::ClaudeAi);
    assert_eq!(a.title, "Rust lifetimes");
    assert_eq!(a.messages.len(), 2);
    assert_eq!(a.messages[0].role, Role::User);
    assert_eq!(a.messages[0].timestamp.as_deref(), Some("2026-09-01T08:00:00Z"));
    assert_eq!(a.messages[0].blocks, vec![text("explain lifetimes")]);
    assert_eq!(a.messages[1].role, Role::Assistant);
    assert_eq!(a.messages[1].timestamp.as_deref(), Some("2026-09-01T08:00:05Z"));
    assert_eq!(a.messages[1].blocks, vec![text("Lifetimes are...")]);
    assert_eq!(a.started_at.as_deref(), Some("2026-09-01T08:00:00Z"));
    assert_eq!(a.ended_at.as_deref(), Some("2026-09-01T09:00:00Z"));

    let b = &sessions[1];
    assert_eq!(b.id, "c2");
    assert_eq!(b.source, Source::ClaudeAi);
    assert_eq!(b.title, "Cooking pasta");
    assert_eq!(b.messages[1].timestamp.as_deref(), Some("2026-09-02T12:00:09Z"));
    assert_eq!(b.started_at.as_deref(), Some("2026-09-02T12:00:00Z"));
    assert_eq!(b.ended_at.as_deref(), Some("2026-09-02T12:30:00Z"));
}

#[test]
fn test_AC_02_01_order_is_input_order() {
    let mut convs = two_conversations();
    convs.reverse();
    let sessions = parse(convs);
    let ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["c2", "c1"]);
}

#[test]
fn test_AC_02_01_fixed_fields_and_unknown_senders() {
    let sessions = parse(vec![conv(
        "c1",
        "T",
        "2026-09-01T08:00:00Z",
        "2026-09-01T09:00:00Z",
        vec![
            human("m1", "hi", "2026-09-01T08:00:00Z"),
            json!({"uuid": "m2", "sender": "system", "text": "ignored",
                   "created_at": "2026-09-01T08:00:01Z"}),
            assistant("m3", "hello", "2026-09-01T08:00:02Z"),
        ],
    )]);
    let s = &sessions[0];
    assert_eq!(s.project, None);
    assert_eq!(s.cwd, None);
    assert_eq!(s.git_branch, None);
    assert!(s.models.is_empty());
    assert!(s.prs.is_empty());
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.messages[0].role, Role::User);
    assert_eq!(s.messages[1].role, Role::Assistant);
}

#[test]
fn test_AC_02_01_empty_array_gives_no_sessions() {
    let sessions = parse_conversations_json("[]").expect("empty array is valid");
    assert!(sessions.is_empty());
}

// ---------------------------------------------------------------------------------------------
// AC-02-02: content arrays
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_02_02_content_blocks_map_in_order() {
    let msg = json!({
        "uuid": "m2", "sender": "assistant", "text": "ignored when content present",
        "created_at": "2026-09-01T08:00:05Z",
        "content": [
            {"type": "thinking", "thinking": "plan it"},
            {"type": "text", "text": "Lifetimes are..."},
            {"type": "tool_use", "id": "t1", "name": "web_search", "input": {"query": "x"}},
            {"type": "tool_result", "tool_use_id": "t1", "name": "web_search",
             "content": [{"type": "text", "text": "result"}], "is_error": false}
        ]
    });
    let sessions = parse(vec![conv(
        "c1",
        "T",
        "2026-09-01T08:00:00Z",
        "2026-09-01T09:00:00Z",
        vec![human("m1", "explain", "2026-09-01T08:00:00Z"), msg],
    )]);
    assert_eq!(
        sessions[0].messages[1].blocks,
        vec![
            Block::Thinking("plan it".to_string()),
            text("Lifetimes are..."),
            Block::ToolUse {
                id: "t1".to_string(),
                name: "web_search".to_string(),
                input: json!({"query": "x"}),
            },
            Block::ToolResult {
                tool_use_id: "t1".to_string(),
                content: "result".to_string(),
                is_error: false,
            },
        ]
    );
}

#[test]
fn test_AC_02_02_tool_result_array_content_joined_with_newline() {
    let msg = json!({
        "uuid": "m2", "sender": "assistant", "created_at": "2026-09-01T08:00:05Z",
        "content": [
            {"type": "tool_result", "tool_use_id": "t9", "is_error": true,
             "content": [
                {"type": "text", "text": "line one"},
                {"type": "image", "source": {}},
                {"type": "text", "text": "line two"}
             ]}
        ]
    });
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg])]);
    assert_eq!(
        sessions[0].messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "t9".to_string(),
            content: "line one\nline two".to_string(),
            is_error: true,
        }]
    );
}

#[test]
fn test_AC_02_02_tool_result_string_content_kept_as_is() {
    let msg = json!({
        "uuid": "m2", "sender": "assistant", "created_at": "2026-09-01T08:00:05Z",
        "content": [
            {"type": "tool_result", "tool_use_id": "t2", "content": "  plain  string "}
        ]
    });
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg])]);
    assert_eq!(
        sessions[0].messages[0].blocks,
        vec![Block::ToolResult {
            tool_use_id: "t2".to_string(),
            content: "  plain  string ".to_string(),
            is_error: false,
        }]
    );
}

#[test]
fn test_AC_02_02_defaults_for_missing_tool_fields() {
    let msg = json!({
        "uuid": "m2", "sender": "assistant", "created_at": "2026-09-01T08:00:05Z",
        "content": [
            {"type": "tool_use", "name": "calc"},
            {"type": "tool_result", "content": "ok"}
        ]
    });
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg])]);
    assert_eq!(
        sessions[0].messages[0].blocks,
        vec![
            Block::ToolUse {
                id: String::new(),
                name: "calc".to_string(),
                input: Value::Null,
            },
            Block::ToolResult {
                tool_use_id: String::new(),
                content: "ok".to_string(),
                is_error: false,
            },
        ]
    );
}

#[test]
fn test_AC_02_02_empty_thinking_empty_text_and_unknown_types_dropped() {
    let msg = json!({
        "uuid": "m2", "sender": "assistant", "created_at": "2026-09-01T08:00:05Z",
        "content": [
            {"type": "thinking", "thinking": ""},
            {"type": "text", "text": "   \n "},
            {"type": "voice_note", "text": "dropped"},
            {"type": "text", "text": "kept"}
        ]
    });
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg])]);
    assert_eq!(sessions[0].messages[0].blocks, vec![text("kept")]);
}

#[test]
fn test_AC_02_02_message_with_no_blocks_is_dropped() {
    let empty_msg = json!({
        "uuid": "m2", "sender": "assistant", "created_at": "2026-09-01T08:00:05Z",
        "content": [{"type": "thinking", "thinking": ""}, {"type": "mystery"}]
    });
    let sessions = parse(vec![conv(
        "c1",
        "T",
        "a",
        "b",
        vec![human("m1", "hi", "2026-09-01T08:00:00Z"), empty_msg],
    )]);
    assert_eq!(sessions[0].messages.len(), 1);
    assert_eq!(sessions[0].messages[0].role, Role::User);
}

// ---------------------------------------------------------------------------------------------
// AC-02-03: text field fallback
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_02_03_message_without_content_uses_text_field() {
    let msg = json!({"uuid": "m1", "sender": "human", "text": "plain question",
                     "created_at": "2026-09-01T08:00:00Z"});
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg])]);
    assert_eq!(sessions[0].messages.len(), 1);
    assert_eq!(sessions[0].messages[0].blocks, vec![text("plain question")]);
    assert_eq!(
        sessions[0].messages[0].timestamp.as_deref(),
        Some("2026-09-01T08:00:00Z")
    );
}

#[test]
fn test_AC_02_03_empty_content_array_uses_text_field() {
    let msg = json!({"uuid": "m1", "sender": "assistant", "text": "fallback answer",
                     "created_at": "2026-09-01T08:00:00Z", "content": []});
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg])]);
    assert_eq!(sessions[0].messages[0].role, Role::Assistant);
    assert_eq!(sessions[0].messages[0].blocks, vec![text("fallback answer")]);
}

#[test]
fn test_AC_02_03_empty_text_and_no_content_drops_message() {
    let msg = json!({"uuid": "m1", "sender": "human", "text": "",
                     "created_at": "2026-09-01T08:00:00Z"});
    let keep = assistant("m2", "kept", "2026-09-01T08:00:01Z");
    let sessions = parse(vec![conv("c1", "T", "a", "b", vec![msg, keep])]);
    assert_eq!(sessions[0].messages.len(), 1);
    assert_eq!(sessions[0].messages[0].blocks, vec![text("kept")]);
}

// ---------------------------------------------------------------------------------------------
// AC-02-04: titles and empty conversations
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_02_04_empty_name_uses_first_human_message() {
    let sessions = parse(vec![conv(
        "c1",
        "",
        "2026-09-01T08:00:00Z",
        "2026-09-01T09:00:00Z",
        vec![
            assistant("m0", "assistant speaks first", "2026-09-01T07:59:00Z"),
            human("m1", "what is   a\n monad?", "2026-09-01T08:00:00Z"),
            human("m2", "second question", "2026-09-01T08:01:00Z"),
        ],
    )]);
    assert_eq!(sessions[0].title, "what is a monad?");
}

#[test]
fn test_AC_02_04_derived_title_truncated_to_80_chars() {
    let long = "x".repeat(200);
    let sessions = parse(vec![conv(
        "c1",
        "",
        "a",
        "b",
        vec![human("m1", &long, "2026-09-01T08:00:00Z")],
    )]);
    assert_eq!(sessions[0].title, "x".repeat(80));
    assert_eq!(sessions[0].title.chars().count(), 80);
}

#[test]
fn test_AC_02_04_no_user_text_gives_untitled() {
    let sessions = parse(vec![conv(
        "c1",
        "",
        "a",
        "b",
        vec![assistant("m1", "only the assistant", "2026-09-01T08:00:00Z")],
    )]);
    assert_eq!(sessions[0].title, "Untitled");
}

#[test]
fn test_AC_02_04_conversation_without_messages_is_skipped() {
    let sessions = parse(vec![
        conv("empty", "", "a", "b", vec![]),
        conv("empty-named", "Has a name", "a", "b", vec![]),
        conv(
            "c2",
            "Real",
            "a",
            "b",
            vec![human("m1", "hi", "2026-09-01T08:00:00Z")],
        ),
    ]);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "c2");
}

#[test]
fn test_AC_02_04_conversation_whose_messages_all_drop_is_skipped() {
    let sessions = parse(vec![conv(
        "c1",
        "Name",
        "a",
        "b",
        vec![json!({"uuid": "m1", "sender": "tool", "text": "x",
                    "created_at": "2026-09-01T08:00:00Z"})],
    )]);
    assert!(sessions.is_empty());
}

#[test]
fn test_AC_02_04_timestamps_fall_back_to_message_timestamps() {
    let conversation = json!({
        "uuid": "c1", "name": "T",
        "chat_messages": [
            human("m1", "first", "2026-09-05T10:00:00Z"),
            assistant("m2", "last", "2026-09-05T10:00:30Z"),
        ]
    });
    let sessions =
        parse_conversations_json(&to_text(vec![conversation])).expect("should parse");
    assert_eq!(sessions[0].started_at.as_deref(), Some("2026-09-05T10:00:00Z"));
    assert_eq!(sessions[0].ended_at.as_deref(), Some("2026-09-05T10:00:30Z"));
}

// ---------------------------------------------------------------------------------------------
// AC-02-05: parse_export for folder / json / zip
// ---------------------------------------------------------------------------------------------

fn expected_sessions() -> Vec<Session> {
    parse(two_conversations())
}

#[test]
fn test_AC_02_05_folder_json_and_zip_give_same_result() {
    let dir = tempfile::tempdir().unwrap();
    let body = to_text(two_conversations());

    let folder = dir.path().join("export");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("conversations.json"), &body).unwrap();
    fs::write(folder.join("users.json"), "[]").unwrap();

    let json_file = dir.path().join("conversations.json");
    fs::write(&json_file, &body).unwrap();

    let zip_file = dir.path().join("export.zip");
    fs::write(
        &zip_file,
        build_zip(&[("conversations.json", body.as_bytes())]),
    )
    .unwrap();

    let expected = expected_sessions();
    assert_eq!(expected.len(), 2);
    assert_eq!(parse_export(&folder).unwrap(), expected);
    assert_eq!(parse_export(&json_file).unwrap(), expected);
    assert_eq!(parse_export(&zip_file).unwrap(), expected);
}

#[test]
fn test_AC_02_05_zip_with_file_in_subfolder() {
    let dir = tempfile::tempdir().unwrap();
    let body = to_text(two_conversations());
    let zip_file = dir.path().join("data-2026.zip");
    fs::write(
        &zip_file,
        build_zip(&[
            ("export/projects.json", b"[]"),
            ("export/deep/er/conversations.json", body.as_bytes()),
        ]),
    )
    .unwrap();
    assert_eq!(parse_export(&zip_file).unwrap(), expected_sessions());
}

#[test]
fn test_AC_02_05_zip_extension_is_case_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    let body = to_text(two_conversations());
    let zip_file = dir.path().join("EXPORT.ZIP");
    fs::write(
        &zip_file,
        build_zip(&[("conversations.json", body.as_bytes())]),
    )
    .unwrap();
    assert_eq!(parse_export(&zip_file).unwrap(), expected_sessions());
}

#[test]
fn test_AC_02_05_zip_uses_first_matching_entry() {
    let dir = tempfile::tempdir().unwrap();
    let first = to_text(two_conversations());
    let second = to_text(vec![conv(
        "other",
        "Other",
        "a",
        "b",
        vec![human("m1", "different", "2026-09-09T00:00:00Z")],
    )]);
    let zip_file = dir.path().join("e.zip");
    fs::write(
        &zip_file,
        build_zip(&[
            ("conversations.json.bak", b"not json at all"),
            ("a/conversations.json", first.as_bytes()),
            ("b/conversations.json", second.as_bytes()),
        ]),
    )
    .unwrap();
    assert_eq!(parse_export(&zip_file).unwrap(), expected_sessions());
}

#[test]
fn test_AC_02_05_any_other_file_is_read_as_conversations_json() {
    let dir = tempfile::tempdir().unwrap();
    let body = to_text(two_conversations());
    let odd = dir.path().join("my-chats.txt");
    fs::write(&odd, &body).unwrap();
    assert_eq!(parse_export(&odd).unwrap(), expected_sessions());
}

// ---------------------------------------------------------------------------------------------
// AC-02-06: errors
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_02_06_invalid_json_is_parse_error() {
    assert_parse_err(parse_conversations_json("{not json"));
    assert_parse_err(parse_conversations_json(""));
}

#[test]
fn test_AC_02_06_non_array_top_level_is_parse_error() {
    assert_parse_err(parse_conversations_json(r#"{"uuid":"c1"}"#));
    assert_parse_err(parse_conversations_json(r#""a string""#));
    assert_parse_err(parse_conversations_json("42"));
}

#[test]
fn test_AC_02_06_missing_path_is_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let missing: PathBuf = dir.path().join("nope.json");
    assert_io_err(parse_export(&missing));
    let missing_zip: PathBuf = dir.path().join("nope.zip");
    assert_io_err(parse_export(&missing_zip));
}

#[test]
fn test_AC_02_06_zip_without_conversations_json_is_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let zip_file = dir.path().join("e.zip");
    fs::write(
        &zip_file,
        build_zip(&[("users.json", b"[]"), ("projects.json", b"[]")]),
    )
    .unwrap();
    assert_parse_err(parse_export(&zip_file));
}

#[test]
fn test_AC_02_06_folder_without_conversations_json_is_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("users.json"), "[]").unwrap();
    assert_parse_err(parse_export(dir.path()));
}

#[test]
fn test_AC_02_06_corrupt_zip_is_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let zip_file = dir.path().join("broken.zip");
    fs::write(&zip_file, b"this is definitely not a zip archive").unwrap();
    assert_parse_err(parse_export(&zip_file));
}

#[test]
fn test_AC_02_06_json_file_with_invalid_content_is_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let file: &Path = &dir.path().join("conversations.json");
    fs::write(file, "{\"not\": \"an array\"}").unwrap();
    assert_parse_err(parse_export(file));
}
