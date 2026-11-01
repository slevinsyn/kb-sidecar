//! Phase 04 tests: training dataset records (OpenAI chat `messages` format) and redaction.
//!
//! Pure functions only: every `Session` is built in memory, nothing touches the file system.

use kb_core::dataset::{redact, to_jsonl, to_record, DatasetOptions};
use kb_core::{Block, Message, Role, Session, Source};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------------

const SUFFIX: &str = "\n…[truncated]";

fn text(t: &str) -> Block {
    Block::Text(t.to_string())
}

fn thinking(t: &str) -> Block {
    Block::Thinking(t.to_string())
}

fn tool_use(id: &str, name: &str, input: Value) -> Block {
    Block::ToolUse {
        id: id.to_string(),
        name: name.to_string(),
        input,
    }
}

fn tool_result(id: &str, content: &str) -> Block {
    Block::ToolResult {
        tool_use_id: id.to_string(),
        content: content.to_string(),
        is_error: false,
    }
}

fn user(blocks: Vec<Block>) -> Message {
    Message {
        role: Role::User,
        timestamp: None,
        blocks,
    }
}

fn assistant(blocks: Vec<Block>) -> Message {
    Message {
        role: Role::Assistant,
        timestamp: None,
        blocks,
    }
}

fn session(messages: Vec<Message>) -> Session {
    Session {
        id: "s1".to_string(),
        source: Source::ClaudeCode,
        title: "Title".to_string(),
        project: Some("proj".to_string()),
        cwd: None,
        git_branch: None,
        started_at: None,
        ended_at: None,
        models: vec![],
        messages,
        prs: vec![],
    }
}

fn opts(redact: bool, max_tool_chars: usize, include_thinking: bool) -> DatasetOptions {
    DatasetOptions {
        redact,
        max_tool_chars,
        include_thinking,
    }
}

fn record(s: &Session, o: &DatasetOptions) -> Value {
    to_record(s, o).expect("expected a record")
}

fn messages_of(rec: &Value) -> Vec<Value> {
    rec["messages"]
        .as_array()
        .expect("messages must be an array")
        .clone()
}

fn roles(rec: &Value) -> Vec<String> {
    messages_of(rec)
        .iter()
        .map(|m| m["role"].as_str().unwrap().to_string())
        .collect()
}

/// user / assistant(thinking, text, tool_use) / tool result / assistant
fn full_session() -> Session {
    session(vec![
        user(vec![text("read main.rs")]),
        assistant(vec![
            thinking("plan"),
            text("Reading it."),
            tool_use("tu_1", "Read", json!({"file_path": "/p/main.rs"})),
        ]),
        user(vec![tool_result("tu_1", "fn main(){}")]),
        assistant(vec![text("It prints nothing.")]),
    ])
}

/// A session with one tool call "tu_1" whose result has the given content.
fn session_with_tool_output(content: &str) -> Session {
    session(vec![
        user(vec![text("go")]),
        assistant(vec![tool_use("tu_1", "Bash", json!({"command": "ls"}))]),
        user(vec![tool_result("tu_1", content)]),
        assistant(vec![text("ok")]),
    ])
}

fn tool_content(rec: &Value) -> String {
    messages_of(rec)
        .iter()
        .find(|m| m["role"] == "tool")
        .expect("expected a tool message")["content"]
        .as_str()
        .unwrap()
        .to_string()
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

#[test]
fn default_options_match_the_contract() {
    let d = DatasetOptions::default();
    assert!(d.redact);
    assert_eq!(d.max_tool_chars, 2000);
    assert!(d.include_thinking);
    let copy = d.clone();
    assert_eq!(copy.max_tool_chars, 2000);
    assert!(format!("{:?}", copy).contains("DatasetOptions"));
}

// ---------------------------------------------------------------------------------------------
// AC-04-01 conversion shape
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_01_full_exchange_converts_to_exact_record() {
    let rec = record(&full_session(), &DatasetOptions::default());
    let expected = json!({
        "id": "s1",
        "source": "claude-code",
        "title": "Title",
        "project": "proj",
        "messages": [
            {"role": "user", "content": "read main.rs"},
            {
                "role": "assistant",
                "content": "Reading it.",
                "reasoning_content": "plan",
                "tool_calls": [{
                    "id": "tu_1",
                    "type": "function",
                    "function": {"name": "Read", "arguments": "{\"file_path\":\"/p/main.rs\"}"}
                }]
            },
            {"role": "tool", "tool_call_id": "tu_1", "content": "fn main(){}"},
            {"role": "assistant", "content": "It prints nothing."}
        ]
    });
    assert_eq!(rec, expected);
}

#[test]
fn test_AC_04_01_role_order_is_user_assistant_tool_assistant() {
    let rec = record(&full_session(), &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant", "tool", "assistant"]);
    let msgs = messages_of(&rec);
    assert!(msgs[1].get("tool_calls").is_some());
    assert!(msgs[1].get("reasoning_content").is_some());
    // The plain final assistant message has neither key.
    assert!(msgs[3].get("tool_calls").is_none());
    assert!(msgs[3].get("reasoning_content").is_none());
}

#[test]
fn test_AC_04_01_top_level_keys_and_null_project() {
    let mut s = full_session();
    s.source = Source::ClaudeAi;
    s.project = None;
    s.title = "Chat title".to_string();
    let rec = record(&s, &DatasetOptions::default());
    let obj = rec.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(keys, vec!["id", "messages", "project", "source", "title"]);
    assert_eq!(rec["source"], "claude-ai");
    assert_eq!(rec["project"], Value::Null);
    assert_eq!(rec["title"], "Chat title");
    assert_eq!(rec["id"], "s1");
}

#[test]
fn test_AC_04_01_multiple_texts_joined_with_blank_line() {
    let s = session(vec![
        user(vec![text("one"), text("two")]),
        assistant(vec![text("a"), thinking("t1"), text("b"), thinking("t2")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    let msgs = messages_of(&rec);
    assert_eq!(msgs[0]["content"], "one\n\ntwo");
    assert_eq!(msgs[1]["content"], "a\n\nb");
    assert_eq!(msgs[1]["reasoning_content"], "t1\n\nt2");
}

#[test]
fn test_AC_04_01_tool_results_come_first_in_block_order_then_user_text() {
    let s = session(vec![
        user(vec![text("start")]),
        assistant(vec![
            tool_use("a", "Read", json!({"file_path": "/x"})),
            tool_use("b", "Read", json!({"file_path": "/y"})),
        ]),
        user(vec![
            text("before"),
            tool_result("a", "result a"),
            tool_result("b", "result b"),
            text("after"),
        ]),
        assistant(vec![text("done")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant", "tool", "tool", "user", "assistant"]);
    let msgs = messages_of(&rec);
    assert_eq!(msgs[1]["content"], "");
    assert_eq!(msgs[1]["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(msgs[1]["tool_calls"][0]["id"], "a");
    assert_eq!(msgs[1]["tool_calls"][1]["id"], "b");
    assert_eq!(msgs[2], json!({"role": "tool", "tool_call_id": "a", "content": "result a"}));
    assert_eq!(msgs[3], json!({"role": "tool", "tool_call_id": "b", "content": "result b"}));
    assert_eq!(msgs[4], json!({"role": "user", "content": "before\n\nafter"}));
}

#[test]
fn test_AC_04_01_user_message_with_only_tool_results_emits_no_user_message() {
    let rec = record(&full_session(), &DatasetOptions::default());
    // Exactly one user message: the opening prompt.
    assert_eq!(roles(&rec).iter().filter(|r| *r == "user").count(), 1);
}

#[test]
fn test_AC_04_01_empty_thinking_gives_no_reasoning_content_key() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![thinking(""), text("answer")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    let msgs = messages_of(&rec);
    assert_eq!(msgs[1], json!({"role": "assistant", "content": "answer"}));
}

// ---------------------------------------------------------------------------------------------
// AC-04-02 tool call arguments
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_02_arguments_is_compact_json_string_and_type_function() {
    let input = json!({"command": "ls -la"});
    let s = session(vec![
        user(vec![text("list")]),
        assistant(vec![tool_use("tu_9", "Bash", input.clone())]),
        user(vec![tool_result("tu_9", "total 0")]),
        assistant(vec![text("empty")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    let call = &messages_of(&rec)[1]["tool_calls"][0];
    assert_eq!(call["type"], "function");
    assert_eq!(call["id"], "tu_9");
    assert_eq!(call["function"]["name"], "Bash");
    assert!(call["function"]["arguments"].is_string());
    assert_eq!(call["function"]["arguments"], "{\"command\":\"ls -la\"}");
}

#[test]
fn test_AC_04_02_nested_input_is_serialized_without_whitespace() {
    let input = json!({"a": [1, 2], "b": {"c": true}});
    let s = session(vec![
        user(vec![text("go")]),
        assistant(vec![tool_use("t", "Tool", input.clone())]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    let args = messages_of(&rec)[1]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!args.contains(' '), "arguments must be compact: {args}");
    assert!(!args.contains('\n'), "arguments must be compact: {args}");
    let parsed: Value = serde_json::from_str(&args).unwrap();
    assert_eq!(parsed, input);
}

// ---------------------------------------------------------------------------------------------
// AC-04-03 include_thinking
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_03_include_thinking_false_removes_reasoning_content() {
    let rec = record(&full_session(), &opts(true, 2000, false));
    for m in messages_of(&rec) {
        assert!(m.get("reasoning_content").is_none(), "unexpected key in {m}");
    }
    let msgs = messages_of(&rec);
    assert_eq!(msgs[1]["content"], "Reading it.");
    assert!(msgs[1].get("tool_calls").is_some());
}

#[test]
fn test_AC_04_03_include_thinking_true_keeps_reasoning_content() {
    let rec = record(&full_session(), &opts(true, 2000, true));
    assert_eq!(messages_of(&rec)[1]["reasoning_content"], "plan");
}

#[test]
fn test_AC_04_03_thinking_only_assistant_dropped_without_thinking_kept_with_it() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![thinking("just pondering")]),
        assistant(vec![text("answer")]),
    ]);
    let without = record(&s, &opts(true, 2000, false));
    assert_eq!(roles(&without), vec!["user", "assistant"]);
    assert_eq!(messages_of(&without)[1]["content"], "answer");

    let with = record(&s, &opts(true, 2000, true));
    assert_eq!(roles(&with), vec!["user", "assistant", "assistant"]);
    let msgs = messages_of(&with);
    assert_eq!(msgs[1]["content"], "");
    assert_eq!(msgs[1]["reasoning_content"], "just pondering");
}

// ---------------------------------------------------------------------------------------------
// AC-04-04 truncation
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_04_long_tool_output_is_truncated_with_marker() {
    let rec = record(
        &session_with_tool_output("abcdefghijklmnopqrstuvwxy"),
        &opts(true, 10, true),
    );
    assert_eq!(tool_content(&rec), format!("abcdefghij{SUFFIX}"));
}

#[test]
fn test_AC_04_04_output_at_or_below_limit_is_unchanged() {
    let rec = record(&session_with_tool_output("0123456789"), &opts(true, 10, true));
    assert_eq!(tool_content(&rec), "0123456789");
    let rec = record(&session_with_tool_output("short"), &opts(true, 10, true));
    assert_eq!(tool_content(&rec), "short");
}

#[test]
fn test_AC_04_04_one_char_over_limit_is_truncated() {
    let rec = record(&session_with_tool_output("0123456789X"), &opts(true, 10, true));
    assert_eq!(tool_content(&rec), format!("0123456789{SUFFIX}"));
}

#[test]
fn test_AC_04_04_limit_counts_characters_not_bytes() {
    let long = "é".repeat(15);
    let rec = record(&session_with_tool_output(&long), &opts(true, 10, true));
    assert_eq!(tool_content(&rec), format!("{}{SUFFIX}", "é".repeat(10)));

    let fits = "é".repeat(10);
    let rec = record(&session_with_tool_output(&fits), &opts(true, 10, true));
    assert_eq!(tool_content(&rec), fits);
}

#[test]
fn test_AC_04_04_default_limit_is_2000_characters() {
    let long = "x".repeat(2500);
    let rec = record(&session_with_tool_output(&long), &DatasetOptions::default());
    assert_eq!(tool_content(&rec), format!("{}{SUFFIX}", "x".repeat(2000)));

    let exact = "y".repeat(2000);
    let rec = record(&session_with_tool_output(&exact), &DatasetOptions::default());
    assert_eq!(tool_content(&rec), exact);
}

#[test]
fn test_AC_04_04_only_tool_messages_are_truncated() {
    let long_user = "u".repeat(50);
    let s = session(vec![
        user(vec![text(&long_user)]),
        assistant(vec![text(&"a".repeat(50))]),
    ]);
    let rec = record(&s, &opts(true, 10, true));
    let msgs = messages_of(&rec);
    assert_eq!(msgs[0]["content"], long_user);
    assert_eq!(msgs[1]["content"], "a".repeat(50));
}

// ---------------------------------------------------------------------------------------------
// AC-04-05 orphan / leading / trailing removal, empty assistant removal
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_05_orphan_tool_result_is_dropped() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![text("a1")]),
        user(vec![tool_result("never_issued", "stray output")]),
        assistant(vec![text("a2")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant", "assistant"]);
    assert!(messages_of(&rec).iter().all(|m| m["role"] != "tool"));
}

#[test]
fn test_AC_04_05_orphan_result_dropped_but_user_text_in_same_message_kept() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![text("a1")]),
        user(vec![tool_result("ghost", "stray"), text("follow up")]),
        assistant(vec![text("a2")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant", "user", "assistant"]);
    assert_eq!(messages_of(&rec)[2]["content"], "follow up");
}

#[test]
fn test_AC_04_05_valid_result_kept_and_orphan_result_dropped_together() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![tool_use("good", "Read", json!({"file_path": "/f"}))]),
        user(vec![tool_result("bad", "orphan"), tool_result("good", "kept")]),
        assistant(vec![text("end")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant", "tool", "assistant"]);
    assert_eq!(
        messages_of(&rec)[2],
        json!({"role": "tool", "tool_call_id": "good", "content": "kept"})
    );
}

#[test]
fn test_AC_04_05_result_before_its_tool_call_is_dropped() {
    let s = session(vec![
        user(vec![text("q")]),
        user(vec![tool_result("t9", "too early")]),
        assistant(vec![text("calling"), tool_use("t9", "Bash", json!({"command": "x"}))]),
        user(vec![tool_result("t9", "on time")]),
        assistant(vec![text("done")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant", "tool", "assistant"]);
    assert_eq!(tool_content(&rec), "on time");
}

#[test]
fn test_AC_04_05_leading_assistant_messages_are_removed() {
    let s = session(vec![
        assistant(vec![text("hello, I started")]),
        user(vec![text("question")]),
        assistant(vec![text("answer")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant"]);
    assert_eq!(messages_of(&rec)[0]["content"], "question");
}

#[test]
fn test_AC_04_05_leading_tool_result_is_removed() {
    let s = session(vec![
        user(vec![tool_result("x", "orphan at start")]),
        user(vec![text("question")]),
        assistant(vec![text("answer")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant"]);
}

#[test]
fn test_AC_04_05_trailing_user_messages_are_removed() {
    let s = session(vec![
        user(vec![text("question")]),
        assistant(vec![text("answer")]),
        user(vec![text("unanswered follow-up")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant"]);
    assert_eq!(messages_of(&rec)[1]["content"], "answer");
}

#[test]
fn test_AC_04_05_trailing_tool_result_after_last_assistant_is_removed() {
    let s = session(vec![
        user(vec![text("go")]),
        assistant(vec![tool_use("t1", "Bash", json!({"command": "ls"}))]),
        user(vec![tool_result("t1", "file.txt")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant"]);
    assert!(messages_of(&rec)[1].get("tool_calls").is_some());
}

#[test]
fn test_AC_04_05_assistant_with_no_content_no_calls_no_reasoning_is_dropped() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![]),
        assistant(vec![text("")]),
        assistant(vec![text("real")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    assert_eq!(roles(&rec), vec!["user", "assistant"]);
    assert_eq!(messages_of(&rec)[1]["content"], "real");
}

#[test]
fn test_AC_04_05_assistant_with_only_tool_calls_is_kept() {
    let s = session(vec![
        user(vec![text("q")]),
        assistant(vec![tool_use("t1", "Bash", json!({"command": "pwd"}))]),
        user(vec![tool_result("t1", "/tmp")]),
        assistant(vec![text("done")]),
    ]);
    let rec = record(&s, &DatasetOptions::default());
    let msgs = messages_of(&rec);
    assert_eq!(msgs[1]["content"], "");
    assert_eq!(msgs[1]["tool_calls"][0]["id"], "t1");
}

// ---------------------------------------------------------------------------------------------
// AC-04-06 None cases
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_06_only_user_messages_returns_none() {
    let s = session(vec![user(vec![text("one")]), user(vec![text("two")])]);
    assert!(to_record(&s, &DatasetOptions::default()).is_none());
}

#[test]
fn test_AC_04_06_only_assistant_messages_returns_none() {
    let s = session(vec![assistant(vec![text("one")]), assistant(vec![text("two")])]);
    assert!(to_record(&s, &DatasetOptions::default()).is_none());
}

#[test]
fn test_AC_04_06_empty_session_returns_none() {
    let s = session(vec![]);
    assert!(to_record(&s, &DatasetOptions::default()).is_none());
}

#[test]
fn test_AC_04_06_assistant_before_user_only_returns_none() {
    let s = session(vec![assistant(vec![text("a")]), user(vec![text("q")])]);
    assert!(to_record(&s, &DatasetOptions::default()).is_none());
}

#[test]
fn test_AC_04_06_user_followed_only_by_empty_assistant_returns_none() {
    let s = session(vec![user(vec![text("q")]), assistant(vec![])]);
    assert!(to_record(&s, &DatasetOptions::default()).is_none());
}

#[test]
fn test_AC_04_06_only_orphan_tool_results_and_assistant_returns_none() {
    let s = session(vec![
        user(vec![tool_result("x", "orphan")]),
        assistant(vec![text("a")]),
    ]);
    assert!(to_record(&s, &DatasetOptions::default()).is_none());
}

// ---------------------------------------------------------------------------------------------
// AC-04-07 redact()
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_07_redacts_email() {
    assert_eq!(redact("mail bob.smith+tag@example.co.uk now"), "mail [EMAIL] now");
    assert_eq!(redact("a_b%c@sub.domain.org"), "[EMAIL]");
    assert_eq!(redact("x@y.io and z@w.com"), "[EMAIL] and [EMAIL]");
}

#[test]
fn test_AC_04_07_not_an_email_is_unchanged() {
    assert_eq!(redact("user@localhost is fine"), "user@localhost is fine");
    assert_eq!(redact("an @ sign"), "an @ sign");
}

#[test]
fn test_AC_04_07_redacts_anthropic_key() {
    assert_eq!(
        redact("key sk-ant-api03-abcdefghij1234 end"),
        "key [SECRET] end"
    );
}

#[test]
fn test_AC_04_07_redacts_sk_key_and_respects_minimum_length() {
    assert_eq!(
        redact("use sk-abcdefghijklmnopqrstuv1234 please"),
        "use [SECRET] please"
    );
    let short = format!("sk-{}", "a".repeat(19));
    assert_eq!(redact(&short), short);
}

#[test]
fn test_AC_04_07_redacts_aws_access_key() {
    assert_eq!(redact("id AKIAIOSFODNN7EXAMPLE ok"), "id [SECRET] ok");
}

#[test]
fn test_AC_04_07_redacts_github_tokens() {
    assert_eq!(
        redact("gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 done"),
        "gh [SECRET] done"
    );
    assert_eq!(redact("s ghs_ABCDEFGHIJ0123456789 e"), "s [SECRET] e");
}

#[test]
fn test_AC_04_07_redacts_slack_tokens() {
    assert_eq!(redact("slack xoxb-1234567890-abcdefghij end"), "slack [SECRET] end");
    assert_eq!(redact("slack xoxp-1234567890-abcdefghij end"), "slack [SECRET] end");
}

#[test]
fn test_AC_04_07_redacts_jwt() {
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijKLMN_-1234";
    assert_eq!(redact(&format!("auth {jwt} done")), "auth [SECRET] done");
}

#[test]
fn test_AC_04_07_redacts_multiline_pem_private_key() {
    let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nQUJDREVGR0g=\n-----END RSA PRIVATE KEY-----";
    assert_eq!(redact(&format!("before\n{pem}\nafter")), "before\n[SECRET]\nafter");

    let ec = "-----BEGIN EC PRIVATE KEY-----\nAAAA\nBBBB\n-----END EC PRIVATE KEY-----";
    assert_eq!(redact(&format!("k: {ec}.")), "k: [SECRET].");
}

#[test]
fn test_AC_04_07_redacts_password_assignments_keeping_key_and_separator() {
    assert_eq!(redact("password=hunter2"), "password=[SECRET]");
    assert_eq!(redact("login with password=hunter2 now"), "login with password=[SECRET] now");
    assert_eq!(redact("API_KEY: abc"), "API_KEY: [SECRET]");
    assert_eq!(redact("token: xyz"), "token: [SECRET]");
    assert_eq!(redact("api-key=zzz"), "api-key=[SECRET]");
    assert_eq!(redact("apikey=q1"), "apikey=[SECRET]");
    assert_eq!(redact("PASSWD=abc"), "PASSWD=[SECRET]");
    assert_eq!(redact("secret=top"), "secret=[SECRET]");
    assert_eq!(redact("pwd = foo"), "pwd = [SECRET]");
}

#[test]
fn test_AC_04_07_keyword_match_is_case_insensitive() {
    assert_eq!(redact("Password: Hunter2"), "Password: [SECRET]");
    assert_eq!(redact("TOKEN=abc"), "TOKEN=[SECRET]");
}

#[test]
fn test_AC_04_07_keyword_without_separator_is_unchanged() {
    assert_eq!(redact("the token is valid"), "the token is valid");
    assert_eq!(redact("reset your password"), "reset your password");
}

#[test]
fn test_AC_04_07_text_without_matches_is_unchanged() {
    assert_eq!(redact(""), "");
    let plain = "fn main() {\n    println!(\"héllo wörld\");\n}\n";
    assert_eq!(redact(plain), plain);
}

#[test]
fn test_AC_04_07_redaction_order_keyword_before_email() {
    // The keyword rule runs before the email rule, so the whole value becomes [SECRET].
    assert_eq!(redact("password=a@b.com"), "password=[SECRET]");
    assert_eq!(
        redact("email me at x@y.com password=pw"),
        "email me at [EMAIL] password=[SECRET]"
    );
}

#[test]
fn test_AC_04_07_secret_inside_keyword_value_still_single_secret() {
    assert_eq!(redact("token=sk-ant-api03-abcdefghij"), "token=[SECRET]");
}

#[test]
fn test_AC_04_07_redact_is_idempotent_on_its_output() {
    let once = redact("password=hunter2 and bob@example.com and AKIAIOSFODNN7EXAMPLE");
    assert_eq!(once, "password=[SECRET] and [EMAIL] and [SECRET]");
    assert_eq!(redact(&once), once);
}

// ---------------------------------------------------------------------------------------------
// AC-04-08 redaction applied by to_record
// ---------------------------------------------------------------------------------------------

fn leaky_session() -> Session {
    let mut s = session(vec![
        user(vec![text("my key sk-ant-api03-abcdefghij1234 and mail a.b@corp.io")]),
        assistant(vec![
            thinking("password=hunter2 is it"),
            text("use token: abc123"),
            tool_use("tu_1", "Bash", json!({"command": "echo sk-ant-api03-abcdefghij1234"})),
        ]),
        user(vec![tool_result("tu_1", "AKIAIOSFODNN7EXAMPLE leaked")]),
        assistant(vec![text("done ghp_abcdefghijklmnopqrstuvwxyz0123456789")]),
    ]);
    s.title = "Leak bob@example.com".to_string();
    s
}

#[test]
fn test_AC_04_08_default_options_redact_everything() {
    let rec = record(&leaky_session(), &DatasetOptions::default());
    assert_eq!(rec["title"], "Leak [EMAIL]");
    let msgs = messages_of(&rec);
    assert_eq!(msgs[0]["content"], "my key [SECRET] and mail [EMAIL]");
    assert_eq!(msgs[1]["reasoning_content"], "password=[SECRET] is it");
    assert_eq!(msgs[1]["content"], "use token: [SECRET]");
    assert_eq!(
        msgs[1]["tool_calls"][0]["function"]["arguments"],
        "{\"command\":\"echo [SECRET]\"}"
    );
    assert_eq!(msgs[2]["content"], "[SECRET] leaked");
    assert_eq!(msgs[3]["content"], "done [SECRET]");
}

#[test]
fn test_AC_04_08_default_output_contains_no_original_secret() {
    let rec = record(&leaky_session(), &DatasetOptions::default());
    let dump = rec.to_string();
    for needle in [
        "sk-ant-api03-abcdefghij1234",
        "a.b@corp.io",
        "hunter2",
        "abc123",
        "AKIAIOSFODNN7EXAMPLE",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "bob@example.com",
    ] {
        assert!(!dump.contains(needle), "{needle} leaked into {dump}");
    }
}

#[test]
fn test_AC_04_08_redact_false_keeps_everything_verbatim() {
    let rec = record(&leaky_session(), &opts(false, 2000, true));
    assert_eq!(rec["title"], "Leak bob@example.com");
    let msgs = messages_of(&rec);
    assert_eq!(
        msgs[0]["content"],
        "my key sk-ant-api03-abcdefghij1234 and mail a.b@corp.io"
    );
    assert_eq!(msgs[1]["reasoning_content"], "password=hunter2 is it");
    assert_eq!(msgs[1]["content"], "use token: abc123");
    assert_eq!(
        msgs[1]["tool_calls"][0]["function"]["arguments"],
        "{\"command\":\"echo sk-ant-api03-abcdefghij1234\"}"
    );
    assert_eq!(msgs[2]["content"], "AKIAIOSFODNN7EXAMPLE leaked");
    assert_eq!(msgs[3]["content"], "done ghp_abcdefghijklmnopqrstuvwxyz0123456789");
}

// ---------------------------------------------------------------------------------------------
// AC-04-09 to_jsonl
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_04_09_empty_slice_gives_empty_string() {
    assert_eq!(to_jsonl(&[]), "");
}

#[test]
fn test_AC_04_09_one_json_object_per_line_newline_terminated() {
    let a = json!({"id": "a", "messages": [{"role": "user", "content": "hi"}]});
    let b = json!({"id": "b", "n": 2});
    let out = to_jsonl(&[a.clone(), b.clone()]);
    assert!(out.ends_with('\n'));
    assert!(!out.ends_with("\n\n"));
    let lines: Vec<&str> = out.split_terminator('\n').collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(serde_json::from_str::<Value>(lines[0]).unwrap(), a);
    assert_eq!(serde_json::from_str::<Value>(lines[1]).unwrap(), b);
}

#[test]
fn test_AC_04_09_single_record_is_compact_json_plus_newline() {
    let r = json!({"id": "x", "list": [1, 2, 3], "nested": {"k": "v"}});
    assert_eq!(to_jsonl(&[r.clone()]), format!("{}\n", serde_json::to_string(&r).unwrap()));
}

#[test]
fn test_AC_04_09_newlines_inside_strings_stay_escaped_on_one_line() {
    let r = json!({"content": "line1\nline2\n\nline4"});
    let out = to_jsonl(&[r.clone(), r.clone(), r.clone()]);
    assert_eq!(out.matches('\n').count(), 3);
    for line in out.split_terminator('\n') {
        assert_eq!(serde_json::from_str::<Value>(line).unwrap(), r);
    }
}

#[test]
fn test_AC_04_09_real_records_round_trip_through_jsonl() {
    let rec = record(&full_session(), &DatasetOptions::default());
    let out = to_jsonl(&[rec.clone()]);
    assert_eq!(out.lines().count(), 1);
    assert_eq!(serde_json::from_str::<Value>(out.trim_end()).unwrap(), rec);
}
