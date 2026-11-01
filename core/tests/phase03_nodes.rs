//! Phase 03 tests: TF-IDF topic keywords + Markdown session nodes.
//!
//! Pure functions only: every `Session` is built in memory, nothing touches the file system.


use kb_core::node::{node_file_name, render_node, slug};
use kb_core::topics::{extract_topics, session_text, tokenize, STOP_WORDS};
use kb_core::{Block, Message, Role, Session, Source};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------------

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn text(t: &str) -> Block {
    Block::Text(t.to_string())
}

fn msg(role: Role, ts: Option<&str>, blocks: Vec<Block>) -> Message {
    Message {
        role,
        timestamp: ts.map(|t| t.to_string()),
        blocks,
    }
}

fn tool_use(id: &str, name: &str, input: Value) -> Block {
    Block::ToolUse {
        id: id.to_string(),
        name: name.to_string(),
        input,
    }
}

fn tool_result(id: &str, content: &str, is_error: bool) -> Block {
    Block::ToolResult {
        tool_use_id: id.to_string(),
        content: content.to_string(),
        is_error,
    }
}

/// A bare code session: no project, no timestamps, no messages.
fn base(id: &str, title: &str) -> Session {
    Session {
        id: id.to_string(),
        source: Source::ClaudeCode,
        title: title.to_string(),
        project: None,
        cwd: None,
        git_branch: None,
        started_at: None,
        ended_at: None,
        models: vec![],
        messages: vec![],
        prs: vec![],
    }
}

/// A session with exactly the given messages (everything else empty).
fn with_messages(messages: Vec<Message>) -> Session {
    let mut sess = base("sess-x", "T");
    sess.messages = messages;
    sess
}

/// A session whose only message is a single tool result with the given content.
fn with_result(content: &str, is_error: bool) -> Session {
    with_messages(vec![msg(
        Role::User,
        None,
        vec![tool_result("t1", content, is_error)],
    )])
}

fn full_session() -> Session {
    Session {
        id: "sess-1".to_string(),
        source: Source::ClaudeCode,
        title: "Fix ingress".to_string(),
        project: Some("my-proj".to_string()),
        cwd: Some("/home/a/my-proj".to_string()),
        git_branch: Some("main".to_string()),
        started_at: Some("2026-10-01T10:00:00.000Z".to_string()),
        ended_at: Some("2026-10-01T10:05:00.000Z".to_string()),
        models: vec!["claude-opus-5-5".to_string(), "claude-sonnet-5".to_string()],
        messages: vec![
            msg(
                Role::User,
                Some("2026-10-01T10:00:00.000Z"),
                vec![text("please fix the ingress")],
            ),
            msg(
                Role::Assistant,
                Some("2026-10-01T10:00:05.000Z"),
                vec![
                    Block::Thinking("consider rules".to_string()),
                    text("Looking at it."),
                    tool_use("t1", "Read", json!({"file_path": "/home/a/my-proj/ing.yaml"})),
                ],
            ),
            msg(
                Role::User,
                None,
                vec![tool_result("t1", "kind: Ingress", false)],
            ),
            msg(
                Role::Assistant,
                None,
                vec![tool_use("t2", "Bash", json!({"command": "kubectl apply"}))],
            ),
            msg(Role::User, None, vec![tool_result("t2", "boom", true)]),
            msg(
                Role::User,
                Some("2026-10-01T10:05:00.000Z"),
                vec![text("thanks, that works")],
            ),
        ],
        prs: vec!["https://github.com/o/r/pull/7".to_string()],
    }
}

/// Parse the frontmatter block into ordered `(key, raw value)` pairs.
fn frontmatter(out: &str) -> Vec<(String, String)> {
    let mut lines = out.lines();
    assert_eq!(lines.next(), Some("---"), "output must start with ---");
    let mut fm = Vec::new();
    loop {
        let line = lines.next().expect("frontmatter must be closed by ---");
        if line == "---" {
            break;
        }
        let (k, v) = line
            .split_once(": ")
            .unwrap_or_else(|| panic!("frontmatter line is not `key: value`: {line:?}"));
        fm.push((k.to_string(), v.to_string()));
    }
    fm
}

fn fm_get<'a>(fm: &'a [(String, String)], key: &str) -> &'a str {
    fm.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .unwrap_or_else(|| panic!("missing frontmatter key {key}"))
}

fn conversation_part(out: &str) -> &str {
    out.split_once("## Conversation\n")
        .expect("output must contain the `## Conversation` heading")
        .1
}

const FM_KEYS: [&str; 14] = [
    "id",
    "source",
    "title",
    "project",
    "branch",
    "cwd",
    "started_at",
    "ended_at",
    "models",
    "turns",
    "tools",
    "files",
    "prs",
    "topics",
];

// ---------------------------------------------------------------------------------------------
// AC-03-01: tokenize
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_01_lowercases_and_splits_on_punctuation_and_underscores() {
    assert_eq!(
        tokenize("Redis_Cache-Latency.p99/Throughput"),
        s(&["redis", "cache", "latency", "p99", "throughput"])
    );
}

#[test]
fn test_AC_03_01_splits_on_whitespace_and_symbols() {
    assert_eq!(
        tokenize("Quasar,nebula;pulsar!\n(galaxy)\t[orbit]{comet}"),
        s(&["quasar", "nebula", "pulsar", "galaxy", "orbit", "comet"])
    );
}

#[test]
fn test_AC_03_01_stop_words_list_is_lowercase_and_has_required_words() {
    let required = [
        "the", "and", "for", "that", "this", "with", "you", "are", "was", "but", "not", "have",
        "can", "will", "just", "what", "from", "use", "file", "code", "make", "need", "want",
        "like", "yes", "okay", "please", "thanks", "let", "now", "here", "there", "also", "would",
        "should", "could",
    ];
    for w in required {
        assert!(STOP_WORDS.contains(&w), "STOP_WORDS is missing {w:?}");
    }
    for w in STOP_WORDS {
        assert_eq!(*w, w.to_lowercase(), "stop word {w:?} must be lowercase");
    }
}

#[test]
fn test_AC_03_01_drops_every_required_stop_word() {
    let required = [
        "the", "and", "for", "that", "this", "with", "you", "are", "was", "but", "not", "have",
        "can", "will", "just", "what", "from", "use", "file", "code", "make", "need", "want",
        "like", "yes", "okay", "please", "thanks", "let", "now", "here", "there", "also", "would",
        "should", "could",
    ];
    for w in required {
        assert!(tokenize(w).is_empty(), "{w:?} should be dropped");
        assert!(
            tokenize(&w.to_uppercase()).is_empty(),
            "{w:?} in capitals should be dropped after lowercasing"
        );
    }
}

#[test]
fn test_AC_03_01_stop_words_dropped_between_real_words_keeping_order() {
    assert_eq!(
        tokenize("The redis AND the cache, please; THANKS for the latency"),
        s(&["redis", "cache", "latency"])
    );
}

#[test]
fn test_AC_03_01_short_tokens_dropped_three_chars_kept() {
    assert_eq!(tokenize("ab xyz q z9 pqr"), s(&["xyz", "pqr"]));
}

#[test]
fn test_AC_03_01_token_length_upper_bound_is_30() {
    let thirty = "k".repeat(30);
    let thirty_one = "k".repeat(31);
    assert_eq!(tokenize(&thirty), vec![thirty.clone()]);
    assert!(tokenize(&thirty_one).is_empty());
    assert_eq!(
        tokenize(&format!("{thirty_one} redis {thirty}")),
        vec!["redis".to_string(), thirty]
    );
}

#[test]
fn test_AC_03_01_pure_numbers_dropped_mixed_alphanumerics_kept() {
    assert_eq!(tokenize("12345 2026-10-01 007"), Vec::<String>::new());
    assert_eq!(
        tokenize("abc123 123abc 4x4x4 99"),
        s(&["abc123", "123abc", "4x4x4"])
    );
}

#[test]
fn test_AC_03_01_non_ascii_characters_split_words() {
    // "é" is not ASCII alphanumeric: it acts as a separator.
    assert_eq!(tokenize("café"), s(&["caf"]));
    assert_eq!(tokenize("naïve"), Vec::<String>::new()); // "na" and "ve" are too short
    assert!(tokenize("日本語 テスト").is_empty());
    assert_eq!(tokenize("münchen"), s(&["nchen"]));
}

#[test]
fn test_AC_03_01_order_preserved_and_duplicates_kept() {
    assert_eq!(
        tokenize("redis cache redis latency cache redis"),
        s(&["redis", "cache", "redis", "latency", "cache", "redis"])
    );
}

#[test]
fn test_AC_03_01_empty_blank_and_punctuation_only_input_gives_nothing() {
    assert!(tokenize("").is_empty());
    assert!(tokenize("   \n\t ").is_empty());
    assert!(tokenize("!!! --- ___ ... ///").is_empty());
}

// ---------------------------------------------------------------------------------------------
// AC-03-02: TF-IDF ranking
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_02_repeated_terms_are_the_docs_top_topics() {
    let docs = s(&[
        "kubernetes ingress kubernetes ingress rollout",
        "pasta recipe boil rollout",
        "guitar chords strum",
    ]);
    let topics = extract_topics(&docs, 2);
    assert_eq!(topics.len(), 3);
    // kubernetes and ingress: tf 0.4, df 1 beat rollout: tf 0.2, df 2. Equal scores -> alphabetical.
    assert_eq!(topics[0], s(&["ingress", "kubernetes"]));
}

#[test]
fn test_AC_03_02_third_term_is_the_lower_scoring_shared_term() {
    let docs = s(&[
        "kubernetes ingress kubernetes ingress rollout",
        "pasta recipe boil rollout",
        "guitar chords strum",
    ]);
    let topics = extract_topics(&docs, 3);
    assert_eq!(topics[0], s(&["ingress", "kubernetes", "rollout"]));
}

#[test]
fn test_AC_03_02_term_in_every_doc_ranks_below_unique_term_at_equal_frequency() {
    // "abacus" sorts before "zephyr", so only the idf can put "zephyr" first.
    let docs = s(&["abacus zephyr", "abacus yodel", "abacus quartz"]);
    let topics = extract_topics(&docs, 2);
    assert_eq!(topics[0], s(&["zephyr", "abacus"]));
    assert_eq!(extract_topics(&docs, 1)[0], s(&["zephyr"]));
}

#[test]
fn test_AC_03_02_idf_beats_raw_count_when_term_is_ubiquitous() {
    // N = 10. ubiq: tf 2/3, idf 1 -> 0.667. quasar: tf 1/3, idf ln(11/2)+1 = 2.705 -> 0.902.
    let mut docs = s(&["ubiq ubiq quasar"]);
    for _ in 0..9 {
        docs.push("ubiq filler".to_string());
    }
    let topics = extract_topics(&docs, 2);
    assert_eq!(topics.len(), 10);
    assert_eq!(topics[0], s(&["quasar", "ubiq"]));
}

#[test]
fn test_AC_03_02_idf_is_smoothed_with_plus_one_numerator_and_denominator() {
    // N = 2. gizmo: tf 0.4, df 1 -> 0.4 * (ln(3/2)+1) = 0.562.
    //        widget: tf 0.6, df 2 -> 0.6 * (ln(3/3)+1) = 0.600.  widget must win.
    let docs = s(&["gizmo gizmo widget widget widget", "widget"]);
    let topics = extract_topics(&docs, 2);
    assert_eq!(topics[0], s(&["widget", "gizmo"]));
    assert_eq!(topics[1], s(&["widget"]));
}

#[test]
fn test_AC_03_02_single_doc_ranks_by_term_frequency() {
    let docs = s(&["redis cache redis latency"]);
    let topics = extract_topics(&docs, 3);
    // redis tf 0.5; cache and latency tie at 0.25 -> alphabetical.
    assert_eq!(topics, vec![s(&["redis", "cache", "latency"])]);
}

#[test]
fn test_AC_03_02_session_text_prefixes_title_and_joins_text_blocks_with_newline() {
    let mut sess = base("sid", "Plan");
    sess.messages = vec![
        msg(Role::User, None, vec![text("q1")]),
        msg(
            Role::Assistant,
            None,
            vec![
                Block::Thinking("hidden thought".to_string()),
                text("a1"),
                tool_use("t1", "Read", json!({"file_path": "/SECRETPATH"})),
                text("a2"),
            ],
        ),
        msg(
            Role::User,
            None,
            vec![tool_result("t1", "TOOLOUTPUT", false)],
        ),
        msg(Role::User, None, vec![text("q2")]),
    ];
    let t = session_text(&sess);
    assert_eq!(t, "Plan\nq1\na1\na2\nq2");
    assert!(!t.contains("hidden thought"));
    assert!(!t.contains("SECRETPATH"));
    assert!(!t.contains("TOOLOUTPUT"));
}

#[test]
fn test_AC_03_02_session_text_of_session_without_messages_is_title_and_newline() {
    assert_eq!(session_text(&base("sid", "Only title")), "Only title\n");
}

#[test]
fn test_AC_03_02_session_text_feeds_extract_topics_end_to_end() {
    let mut a = base("a", "Ingress debugging");
    a.messages = vec![
        msg(Role::User, None, vec![text("kubernetes ingress is failing")]),
        msg(
            Role::Assistant,
            None,
            vec![text("check the kubernetes ingress annotations")],
        ),
    ];
    let mut b = base("b", "Pasta night");
    b.messages = vec![msg(Role::User, None, vec![text("boil penne penne penne")])];
    let docs = vec![session_text(&a), session_text(&b)];
    let topics = extract_topics(&docs, 2);
    assert_eq!(topics[0], s(&["ingress", "kubernetes"]));
    assert_eq!(topics[1][0], "penne");
    assert!(!topics[1].contains(&"kubernetes".to_string()));
}

// ---------------------------------------------------------------------------------------------
// AC-03-03: k limit, empty docs, ties, determinism
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_03_returns_at_most_k_terms_per_doc() {
    let docs = s(&[
        "alpha1 bravo2 charlie3 delta4 echo5 foxtrot6",
        "golf7 hotel8",
    ]);
    let top3 = extract_topics(&docs, 3);
    assert_eq!(top3.len(), 2);
    assert_eq!(top3[0].len(), 3);
    assert_eq!(top3[1].len(), 2);

    let top1 = extract_topics(&docs, 1);
    assert_eq!(top1[0].len(), 1);
    assert_eq!(top1[1].len(), 1);

    let top100 = extract_topics(&docs, 100);
    assert_eq!(top100[0].len(), 6);
    assert_eq!(top100[1].len(), 2);
}

#[test]
fn test_AC_03_03_k_zero_gives_empty_vectors() {
    let docs = s(&["kubernetes ingress", "pasta recipe"]);
    assert_eq!(extract_topics(&docs, 0), vec![Vec::<String>::new(); 2]);
}

#[test]
fn test_AC_03_03_empty_docs_get_empty_vectors_in_place() {
    let docs = s(&["", "the and for", "kubernetes ingress", "   ", "12 34 5"]);
    let topics = extract_topics(&docs, 5);
    assert_eq!(topics.len(), 5);
    assert!(topics[0].is_empty());
    assert!(topics[1].is_empty(), "a doc of only stop words has no tokens");
    assert_eq!(topics[2], s(&["ingress", "kubernetes"]));
    assert!(topics[3].is_empty());
    assert!(topics[4].is_empty(), "a doc of only numbers has no tokens");
}

#[test]
fn test_AC_03_03_no_docs_gives_no_vectors() {
    assert!(extract_topics(&[], 5).is_empty());
}

#[test]
fn test_AC_03_03_ties_ordered_alphabetically() {
    let docs = s(&["zulu yankee xray whiskey victor"]);
    assert_eq!(
        extract_topics(&docs, 3),
        vec![s(&["victor", "whiskey", "xray"])]
    );
    assert_eq!(
        extract_topics(&docs, 5),
        vec![s(&["victor", "whiskey", "xray", "yankee", "zulu"])]
    );
}

#[test]
fn test_AC_03_03_ties_alphabetical_in_a_multi_doc_corpus() {
    // Every term appears once in its own doc and nowhere else: all scores are equal.
    let docs = s(&["mango apple cherry", "peach banana"]);
    let topics = extract_topics(&docs, 2);
    assert_eq!(topics[0], s(&["apple", "cherry"]));
    assert_eq!(topics[1], s(&["banana", "peach"]));
}

#[test]
fn test_AC_03_03_is_deterministic() {
    let docs = s(&[
        "kubernetes ingress kubernetes rollout service mesh",
        "pasta recipe boil rollout sauce tomato basil",
        "guitar chords strum rollout capo tuning",
        "",
    ]);
    let first = extract_topics(&docs, 4);
    for _ in 0..20 {
        assert_eq!(extract_topics(&docs, 4), first);
    }
}

// ---------------------------------------------------------------------------------------------
// AC-03-04: stop words never appear in topics
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_04_frequent_stop_words_do_not_become_topics() {
    let docs = s(&[
        "the the the the file code make please thanks THE kubernetes",
        "you are not here, there is also this and that with would should could",
    ]);
    let topics = extract_topics(&docs, 10);
    assert_eq!(topics[0], s(&["kubernetes"]));
    assert!(topics[1].is_empty());
}

#[test]
fn test_AC_03_04_no_topic_is_ever_a_stop_word() {
    let everything = format!("{} zebra", STOP_WORDS.join(" "));
    let docs = vec![everything.clone(), format!("{everything} {everything} giraffe")];
    let topics = extract_topics(&docs, 1000);
    assert!(topics[0].contains(&"zebra".to_string()));
    assert!(topics[1].contains(&"giraffe".to_string()));
    for per_doc in &topics {
        for t in per_doc {
            assert!(!STOP_WORDS.contains(&t.as_str()), "{t:?} is a stop word");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// AC-03-05: slug and node_file_name
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_05_slug_spec_example() {
    assert_eq!(
        slug("Fix: Totals are rounded wrongly!"),
        "fix-totals-are-rounded-wrongly"
    );
}

#[test]
fn test_AC_03_05_slug_runs_collapse_and_ends_are_trimmed() {
    assert_eq!(slug("  Hello   World  "), "hello-world");
    assert_eq!(slug("--a---b--"), "a-b");
    assert_eq!(slug("a_b.c/d\\e"), "a-b-c-d-e");
    assert_eq!(slug("Version 2.0 (beta)"), "version-2-0-beta");
    assert_eq!(slug("ALLCAPS123"), "allcaps123");
}

#[test]
fn test_AC_03_05_slug_non_ascii_is_a_separator() {
    assert_eq!(slug("Ünïcode café"), "n-code-caf");
    assert_eq!(slug("日本語"), "untitled");
}

#[test]
fn test_AC_03_05_slug_empty_or_symbol_only_is_untitled() {
    assert_eq!(slug(""), "untitled");
    assert_eq!(slug("!!!"), "untitled");
    assert_eq!(slug("  ---  "), "untitled");
    assert_eq!(slug("\n\t"), "untitled");
}

#[test]
fn test_AC_03_05_slug_cut_to_60_characters() {
    assert_eq!(slug(&"x".repeat(70)), "x".repeat(60));
    assert_eq!(slug(&"x".repeat(60)), "x".repeat(60));
    assert_eq!(slug(&"x".repeat(59)), "x".repeat(59));
    // The cut keeps the first 60 characters, which here include one inner dash.
    let input = format!("{} {}", "a".repeat(30), "b".repeat(40));
    assert_eq!(
        slug(&input),
        format!("{}-{}", "a".repeat(30), "b".repeat(29))
    );
}

#[test]
fn test_AC_03_05_slug_trailing_dash_removed_again_after_the_cut() {
    // Before the cut: 59 a's, "-", "bbbb". The first 60 characters end in "-", which is removed.
    let input = format!("{} bbbb", "a".repeat(59));
    assert_eq!(slug(&input), "a".repeat(59));
    // A longer run of separators starting on the cut boundary collapses to one dash, then goes.
    let input = format!("{}!!!!!!!!zzz", "q".repeat(59));
    assert_eq!(slug(&input), "q".repeat(59));
}

#[test]
fn test_AC_03_05_node_file_name_has_date_slug_and_id8() {
    let mut sess = base("ABCDEF12-3456-7890-abcd-ef0123456789", "Fix: Totals are rounded wrongly!");
    sess.started_at = Some("2026-10-01T10:00:00.000Z".to_string());
    assert_eq!(
        node_file_name(&sess),
        "2026-10-01-fix-totals-are-rounded-wrongly-abcdef12.md"
    );
}

#[test]
fn test_AC_03_05_node_file_name_undated_when_no_start() {
    let sess = base("0f3c9a1b-77de", "Some chat");
    assert_eq!(node_file_name(&sess), "undated-some-chat-0f3c9a1b.md");
}

#[test]
fn test_AC_03_05_node_file_name_untitled_when_title_has_no_alphanumerics() {
    let mut sess = base("12345678-aaaa", "???");
    sess.started_at = Some("2025-01-31T23:59:59Z".to_string());
    assert_eq!(node_file_name(&sess), "2025-01-31-untitled-12345678.md");
}

#[test]
fn test_AC_03_05_node_file_name_short_id_is_used_whole() {
    let mut sess = base("ab", "Hello");
    sess.started_at = Some("2026-02-03T00:00:00Z".to_string());
    assert_eq!(node_file_name(&sess), "2026-02-03-hello-ab.md");
}

#[test]
fn test_AC_03_05_node_file_name_id_is_slugged_before_the_first_8_chars() {
    let mut sess = base("AB_cd.EF/gh-ij", "Hello");
    sess.started_at = Some("2026-02-03T00:00:00Z".to_string());
    // slug(id) = "ab-cd-ef-gh-ij"; first 8 chars = "ab-cd-ef".
    assert_eq!(node_file_name(&sess), "2026-02-03-hello-ab-cd-ef.md");
}

#[test]
fn test_AC_03_05_node_file_name_uses_the_60_char_title_slug() {
    let mut sess = base("deadbeef-0000", &"w".repeat(100));
    sess.started_at = Some("2026-10-01T10:00:00.000Z".to_string());
    assert_eq!(
        node_file_name(&sess),
        format!("2026-10-01-{}-deadbeef.md", "w".repeat(60))
    );
}

// ---------------------------------------------------------------------------------------------
// AC-03-06: frontmatter
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_06_frontmatter_has_14_keys_in_order() {
    let out = render_node(&full_session(), &s(&["kubernetes", "ingress"]));
    assert!(out.starts_with("---\n"));
    let fm = frontmatter(&out);
    let keys: Vec<&str> = fm.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, FM_KEYS.to_vec());
}

#[test]
fn test_AC_03_06_frontmatter_values_for_a_code_session() {
    let out = render_node(&full_session(), &s(&["kubernetes", "ingress"]));
    let fm = frontmatter(&out);
    assert_eq!(fm_get(&fm, "id"), "\"sess-1\"");
    assert_eq!(fm_get(&fm, "source"), "\"claude-code\"");
    assert_eq!(fm_get(&fm, "title"), "\"Fix ingress\"");
    assert_eq!(fm_get(&fm, "project"), "\"my-proj\"");
    assert_eq!(fm_get(&fm, "branch"), "\"main\"");
    assert_eq!(fm_get(&fm, "cwd"), "\"/home/a/my-proj\"");
    assert_eq!(fm_get(&fm, "started_at"), "\"2026-10-01T10:00:00.000Z\"");
    assert_eq!(fm_get(&fm, "ended_at"), "\"2026-10-01T10:05:00.000Z\"");
    assert_eq!(fm_get(&fm, "models"), r#"["claude-opus-5-5","claude-sonnet-5"]"#);
    assert_eq!(fm_get(&fm, "turns"), "2");
    assert_eq!(fm_get(&fm, "tools"), r#"["Bash","Read"]"#);
    assert_eq!(fm_get(&fm, "files"), r#"["/home/a/my-proj/ing.yaml"]"#);
    assert_eq!(fm_get(&fm, "prs"), r#"["https://github.com/o/r/pull/7"]"#);
    assert_eq!(fm_get(&fm, "topics"), r#"["kubernetes","ingress"]"#);
}

#[test]
fn test_AC_03_06_every_value_is_compact_valid_json() {
    let out = render_node(&full_session(), &s(&["kubernetes", "ingress"]));
    for (k, v) in frontmatter(&out) {
        let parsed: Value = serde_json::from_str(&v)
            .unwrap_or_else(|e| panic!("value of {k} is not valid JSON ({v:?}): {e}"));
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            v,
            "value of {k} must be compact serde_json output"
        );
    }
}

#[test]
fn test_AC_03_06_claude_ai_session_has_null_project_and_null_optionals() {
    let mut sess = base("c1", "Rust lifetimes");
    sess.source = Source::ClaudeAi;
    sess.started_at = Some("2026-09-01T08:00:00Z".to_string());
    sess.ended_at = Some("2026-09-01T09:00:00Z".to_string());
    sess.messages = vec![
        msg(Role::User, Some("2026-09-01T08:00:00Z"), vec![text("explain lifetimes")]),
        msg(Role::Assistant, Some("2026-09-01T08:00:05Z"), vec![text("They are...")]),
    ];
    let out = render_node(&sess, &[]);
    let fm = frontmatter(&out);
    let keys: Vec<&str> = fm.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, FM_KEYS.to_vec());
    assert_eq!(fm_get(&fm, "source"), "\"claude-ai\"");
    assert_eq!(fm_get(&fm, "project"), "null");
    assert_eq!(fm_get(&fm, "branch"), "null");
    assert_eq!(fm_get(&fm, "cwd"), "null");
    assert_eq!(fm_get(&fm, "models"), "[]");
    assert_eq!(fm_get(&fm, "turns"), "1");
    assert_eq!(fm_get(&fm, "tools"), "[]");
    assert_eq!(fm_get(&fm, "files"), "[]");
    assert_eq!(fm_get(&fm, "prs"), "[]");
    assert_eq!(fm_get(&fm, "topics"), "[]");
}

#[test]
fn test_AC_03_06_missing_timestamps_render_as_null() {
    let out = render_node(&base("only-id", "No clock"), &[]);
    let fm = frontmatter(&out);
    assert_eq!(fm_get(&fm, "started_at"), "null");
    assert_eq!(fm_get(&fm, "ended_at"), "null");
    assert_eq!(fm_get(&fm, "turns"), "0");
}

#[test]
fn test_AC_03_06_special_characters_are_json_escaped_on_one_line() {
    let mut sess = base("id\"quote", "Say \"hi\" \u{2014} \u{fc}n\u{ef}\tTab\nNext");
    sess.cwd = Some("C:\\work\\proj".to_string());
    sess.git_branch = Some("feat/x y".to_string());
    let out = render_node(&sess, &s(&["alpha"]));
    let fm = frontmatter(&out);
    assert_eq!(keys_of(&fm), FM_KEYS.to_vec());
    assert_eq!(
        fm_get(&fm, "title"),
        serde_json::to_string(&sess.title).unwrap()
    );
    assert_eq!(fm_get(&fm, "id"), serde_json::to_string(&sess.id).unwrap());
    assert_eq!(fm_get(&fm, "cwd"), r#""C:\\work\\proj""#);
    assert_eq!(fm_get(&fm, "branch"), r#""feat/x y""#);
    let title: String = serde_json::from_str(fm_get(&fm, "title")).unwrap();
    assert_eq!(title, sess.title);
}

fn keys_of(fm: &[(String, String)]) -> Vec<&str> {
    fm.iter().map(|(k, _)| k.as_str()).collect()
}

#[test]
fn test_AC_03_06_topics_keep_the_order_given() {
    let out = render_node(&base("t", "T"), &s(&["zeta", "alpha", "mid"]));
    let fm = frontmatter(&out);
    assert_eq!(fm_get(&fm, "topics"), r#"["zeta","alpha","mid"]"#);
}

#[test]
fn test_AC_03_06_frontmatter_is_followed_by_blank_line_and_title_heading() {
    let out = render_node(&full_session(), &s(&["kubernetes", "ingress"]));
    assert!(
        out.contains("\n---\n\n# Fix ingress\n\n"),
        "frontmatter must close with --- and a blank line before the title:\n{out}"
    );
}

// ---------------------------------------------------------------------------------------------
// AC-03-07: body header and conversation text
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_07_header_block_exact() {
    let out = render_node(&full_session(), &s(&["kubernetes", "ingress"]));
    let expected = "\n---\n\n# Fix ingress\n\n\
                    Project: [[project/my-proj]]\n\
                    Topics: [[topic/kubernetes]] \u{b7} [[topic/ingress]]\n\
                    Tools: Bash, Read\n\n\
                    ## Conversation\n";
    assert!(out.contains(expected), "unexpected header:\n{out}");
}

#[test]
fn test_AC_03_07_project_link_uses_the_slug_of_the_project() {
    let mut sess = base("p", "T");
    sess.project = Some("My Proj_v2".to_string());
    let out = render_node(&sess, &[]);
    assert!(out.contains("\nProject: [[project/my-proj-v2]]\n"));
    // The frontmatter keeps the raw project name.
    assert_eq!(fm_get(&frontmatter(&out), "project"), "\"My Proj_v2\"");
}

#[test]
fn test_AC_03_07_one_topic_link_per_topic_in_order() {
    let out = render_node(&base("p", "T"), &s(&["zeta", "alpha", "mid"]));
    assert!(out.contains("\nTopics: [[topic/zeta]] \u{b7} [[topic/alpha]] \u{b7} [[topic/mid]]\n"));
    assert_eq!(out.matches("[[topic/").count(), 3);
}

#[test]
fn test_AC_03_07_single_topic_has_no_separator() {
    let out = render_node(&base("p", "T"), &s(&["solo"]));
    let line = out
        .lines()
        .find(|l| l.starts_with("Topics:"))
        .expect("Topics line");
    assert_eq!(line, "Topics: [[topic/solo]]");
}

#[test]
fn test_AC_03_07_project_line_omitted_without_project() {
    let mut sess = base("p", "T");
    sess.messages = vec![msg(Role::User, None, vec![text("Project: not a header")])];
    let out = render_node(&sess, &s(&["alpha"]));
    assert!(!out.contains("[[project/"));
    // Only the header region may not contain a Project line.
    let header = out.split("## Conversation").next().unwrap();
    assert!(!header.lines().any(|l| l.starts_with("Project:")));
    assert!(out.contains("\nTopics: [[topic/alpha]]\n"));
}

#[test]
fn test_AC_03_07_topics_line_omitted_without_topics() {
    let mut sess = base("p", "T");
    sess.project = Some("proj".to_string());
    let out = render_node(&sess, &[]);
    assert!(!out.contains("[[topic/"));
    assert!(!out.lines().any(|l| l.starts_with("Topics:")));
    assert!(out.contains("\nProject: [[project/proj]]\n"));
}

#[test]
fn test_AC_03_07_tools_line_omitted_without_tools() {
    let mut sess = base("p", "T");
    sess.messages = vec![msg(Role::User, None, vec![text("hello")])];
    let out = render_node(&sess, &s(&["alpha"]));
    assert!(!out.lines().any(|l| l.starts_with("Tools:")));
}

#[test]
fn test_AC_03_07_tools_line_lists_tools_used_comma_separated() {
    let sess = with_messages(vec![msg(
        Role::Assistant,
        None,
        vec![
            tool_use("1", "Write", json!({})),
            tool_use("2", "Bash", json!({})),
            tool_use("3", "Write", json!({})),
        ],
    )]);
    let out = render_node(&sess, &[]);
    assert!(
        out.lines().any(|l| l == "Tools: Bash, Write"),
        "expected `Tools: Bash, Write` in:\n{out}"
    );
}

#[test]
fn test_AC_03_07_title_heading_is_raw_title() {
    let out = render_node(&base("p", "Ünï \"quoted\" title: x"), &[]);
    assert!(out.contains("\n# Ünï \"quoted\" title: x\n"));
}

#[test]
fn test_AC_03_07_every_user_and_assistant_text_appears_in_order() {
    let sess = with_messages(vec![
        msg(Role::User, None, vec![text("first question")]),
        msg(Role::Assistant, None, vec![text("second answer"), text("third addendum")]),
        msg(Role::User, None, vec![text("fourth follow-up")]),
        msg(Role::Assistant, None, vec![text("fifth reply")]),
    ]);
    let out = render_node(&sess, &[]);
    let body = conversation_part(&out);
    let mut last = 0;
    for needle in [
        "first question",
        "second answer",
        "third addendum",
        "fourth follow-up",
        "fifth reply",
    ] {
        let pos = body[last..]
            .find(needle)
            .unwrap_or_else(|| panic!("{needle:?} missing or out of order in:\n{body}"));
        last += pos + needle.len();
    }
}

#[test]
fn test_AC_03_07_conversation_section_exact_layout() {
    let sess = with_messages(vec![
        msg(Role::User, Some("2026-10-01T10:00:00.000Z"), vec![text("hello")]),
        msg(Role::Assistant, None, vec![text("hi there"), text("second paragraph")]),
    ]);
    let out = render_node(&sess, &[]);
    assert_eq!(
        conversation_part(&out),
        "\n### User \u{b7} 2026-10-01T10:00:00.000Z\n\nhello\n\n### Assistant\n\nhi there\n\nsecond paragraph\n"
    );
}

#[test]
fn test_AC_03_07_headings_carry_timestamp_only_when_present() {
    let out = render_node(&full_session(), &[]);
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines.contains(&"### User \u{b7} 2026-10-01T10:00:00.000Z"));
    assert!(lines.contains(&"### Assistant \u{b7} 2026-10-01T10:00:05.000Z"));
    assert!(lines.contains(&"### User \u{b7} 2026-10-01T10:05:00.000Z"));
    // Messages without a timestamp: two user messages (tool results) and one assistant message.
    assert_eq!(lines.iter().filter(|l| **l == "### User").count(), 2);
    assert_eq!(lines.iter().filter(|l| **l == "### Assistant").count(), 1);
}

#[test]
fn test_AC_03_07_text_with_markdown_is_emitted_raw() {
    let raw = "# not a title\n- item\n```rust\nfn main() {}\n```\n<b>bold</b>";
    let sess = with_messages(vec![msg(Role::User, None, vec![text(raw)])]);
    let out = render_node(&sess, &[]);
    assert!(out.contains(&format!("### User\n\n{raw}\n")));
}

// ---------------------------------------------------------------------------------------------
// AC-03-08: thinking, tool calls, error results, truncation
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_08_thinking_renders_inside_details() {
    let out = render_node(&full_session(), &[]);
    assert!(out.contains(
        "<details><summary>Thinking</summary>\n\nconsider rules\n\n</details>"
    ));
    assert_eq!(out.matches("consider rules").count(), 1);
}

#[test]
fn test_AC_03_08_multiline_thinking_kept_verbatim_in_details() {
    let sess = with_messages(vec![msg(
        Role::Assistant,
        None,
        vec![
            Block::Thinking("step 1\nstep 2\n\nstep 4".to_string()),
            text("done"),
        ],
    )]);
    let out = render_node(&sess, &[]);
    let expected = "<details><summary>Thinking</summary>\n\nstep 1\nstep 2\n\nstep 4\n\n</details>";
    assert!(out.contains(expected));
    let details_pos = out.find(expected).unwrap();
    let done_pos = out.rfind("done").unwrap();
    assert!(details_pos < done_pos, "blocks must keep their order");
}

#[test]
fn test_AC_03_08_tool_call_shows_name_and_pretty_json_input() {
    let out = render_node(&full_session(), &[]);
    assert!(out.contains("**Tool call** `Read`"));
    assert!(out.contains("```json\n{\n  \"file_path\": \"/home/a/my-proj/ing.yaml\"\n}\n```"));
    assert!(out.contains("**Tool call** `Bash`"));
    assert!(out.contains("```json\n{\n  \"command\": \"kubectl apply\"\n}\n```"));
}

#[test]
fn test_AC_03_08_tool_call_input_is_pretty_printed_with_nesting() {
    let input = json!({"query": "x", "opts": {"limit": 5, "tags": ["a", "b"]}});
    let sess = with_messages(vec![msg(
        Role::Assistant,
        None,
        vec![tool_use("t", "web_search", input.clone())],
    )]);
    let out = render_node(&sess, &[]);
    let pretty = serde_json::to_string_pretty(&input).unwrap();
    assert!(pretty.contains('\n'));
    assert!(out.contains("**Tool call** `web_search`"));
    assert!(out.contains(&format!("```json\n{pretty}\n```")));
}

#[test]
fn test_AC_03_08_tool_call_label_comes_before_its_fence() {
    let out = render_node(&full_session(), &[]);
    let label = out.find("**Tool call** `Read`").unwrap();
    let fence = out.find("```json\n{\n  \"file_path\"").unwrap();
    assert!(label < fence);
}

#[test]
fn test_AC_03_08_successful_tool_result_has_plain_label_and_fenced_content() {
    let sess = with_result("kind: Ingress", false);
    let out = render_node(&sess, &[]);
    assert!(out.contains("**Tool result**"));
    assert!(!out.contains("(error)"));
    assert!(out.contains("```\nkind: Ingress\n```"));
}

#[test]
fn test_AC_03_08_error_tool_result_is_marked() {
    let out = render_node(&with_result("boom", true), &[]);
    assert!(out.contains("**Tool result** (error)"));
    assert!(out.contains("```\nboom\n```"));
}

#[test]
fn test_AC_03_08_only_error_results_carry_the_marker_in_a_mixed_session() {
    let out = render_node(&full_session(), &[]);
    assert_eq!(out.matches("**Tool result** (error)").count(), 1);
    assert_eq!(out.matches("**Tool result**").count(), 2);
    let err_pos = out.find("**Tool result** (error)").unwrap();
    let ok_pos = out.find("```\nkind: Ingress\n```").unwrap();
    assert!(ok_pos < err_pos);
}

#[test]
fn test_AC_03_08_result_of_exactly_2000_chars_is_not_truncated() {
    let content = "x".repeat(2000);
    let out = render_node(&with_result(&content, false), &[]);
    assert!(out.contains(&format!("```\n{content}\n```")));
    assert!(!out.contains("truncated"));
}

#[test]
fn test_AC_03_08_result_over_2000_chars_is_cut_with_marker_and_exact_count() {
    let content = "x".repeat(2005);
    let out = render_node(&with_result(&content, false), &[]);
    let expected = format!("```\n{}\n\u{2026} [truncated 5 chars]\n```", "x".repeat(2000));
    assert!(out.contains(&expected), "truncated block not found");
    assert!(!out.contains(&"x".repeat(2001)));
}

#[test]
fn test_AC_03_08_one_char_over_the_limit_reports_one() {
    let content = "y".repeat(2001);
    let out = render_node(&with_result(&content, false), &[]);
    assert!(out.contains(&format!("{}\n\u{2026} [truncated 1 chars]", "y".repeat(2000))));
}

#[test]
fn test_AC_03_08_truncation_counts_characters_not_bytes() {
    let content = "\u{e9}".repeat(2003); // 'é' is two bytes in UTF-8
    let out = render_node(&with_result(&content, false), &[]);
    assert!(out.contains(&format!(
        "```\n{}\n\u{2026} [truncated 3 chars]\n```",
        "\u{e9}".repeat(2000)
    )));
    assert!(!out.contains(&"\u{e9}".repeat(2001)));
}

#[test]
fn test_AC_03_08_large_result_reports_the_removed_count() {
    let content = "z".repeat(10_000);
    let out = render_node(&with_result(&content, false), &[]);
    assert!(out.contains("\n\u{2026} [truncated 8000 chars]\n```"));
    assert!(out.len() < 4_000, "the full result must not be embedded");
}

#[test]
fn test_AC_03_08_truncated_error_result_keeps_both_markers() {
    let content = "e".repeat(2100);
    let out = render_node(&with_result(&content, true), &[]);
    assert!(out.contains("**Tool result** (error)"));
    assert!(out.contains("\n\u{2026} [truncated 100 chars]\n"));
}

#[test]
fn test_AC_03_08_tool_input_is_not_truncated() {
    let long = "q".repeat(3000);
    let sess = with_messages(vec![msg(
        Role::Assistant,
        None,
        vec![tool_use("t", "Write", json!({"content": long}))],
    )]);
    let out = render_node(&sess, &[]);
    assert!(out.contains(&"q".repeat(3000)));
    assert!(!out.contains("truncated"));
}

// ---------------------------------------------------------------------------------------------
// AC-03-09: longer fences around backticks
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_09_result_with_triple_backticks_gets_four_backtick_fence() {
    let content = "before\n```\ncode\n```\nafter";
    let out = render_node(&with_result(content, false), &[]);
    assert!(out.contains(&format!("````\n{content}\n````")));
    // It must not be wrapped in a plain three-backtick fence.
    assert!(!out.contains(&format!("\n```\n{content}\n```\n")));
}

#[test]
fn test_AC_03_09_fence_is_one_longer_than_the_longest_run() {
    let content = "a ````` b `` c ```";
    let out = render_node(&with_result(content, false), &[]);
    assert!(out.contains(&format!("``````\n{content}\n``````")));
}

#[test]
fn test_AC_03_09_longest_run_counts_even_when_it_is_not_first() {
    let content = "``` first\nthen ```` longer";
    let out = render_node(&with_result(content, false), &[]);
    assert!(out.contains(&format!("`````\n{content}\n`````")));
}

#[test]
fn test_AC_03_09_short_backtick_runs_keep_the_minimum_three_backtick_fence() {
    let content = "use `x` and ``y`` here";
    let out = render_node(&with_result(content, false), &[]);
    assert!(out.contains(&format!("```\n{content}\n```")));
    assert!(!out.contains("````"));
}

#[test]
fn test_AC_03_09_tool_input_with_backticks_gets_longer_json_fence() {
    let input = json!({"cmd": "echo ```"});
    let sess = with_messages(vec![msg(
        Role::Assistant,
        None,
        vec![tool_use("t", "Bash", input.clone())],
    )]);
    let out = render_node(&sess, &[]);
    let pretty = serde_json::to_string_pretty(&input).unwrap();
    assert!(out.contains(&format!("````json\n{pretty}\n````")));
}

#[test]
fn test_AC_03_09_tool_input_without_backticks_uses_three_backticks() {
    let sess = with_messages(vec![msg(
        Role::Assistant,
        None,
        vec![tool_use("t", "Bash", json!({"cmd": "ls"}))],
    )]);
    let out = render_node(&sess, &[]);
    assert!(out.contains("```json\n{\n  \"cmd\": \"ls\"\n}\n```"));
    assert!(!out.contains("````"));
}

#[test]
fn test_AC_03_09_each_block_gets_its_own_fence_length() {
    let sess = with_messages(vec![
        msg(Role::User, None, vec![tool_result("a", "plain output", false)]),
        msg(Role::User, None, vec![tool_result("b", "has ```` four", false)]),
        msg(Role::User, None, vec![tool_result("c", "has ``` three", false)]),
    ]);
    let out = render_node(&sess, &[]);
    assert!(out.contains("```\nplain output\n```"));
    assert!(out.contains("`````\nhas ```` four\n`````"));
    assert!(out.contains("````\nhas ``` three\n````"));
}

// ---------------------------------------------------------------------------------------------
// AC-03-10: determinism and trailing newline
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_03_10_render_is_byte_identical_across_calls() {
    let topics = s(&["kubernetes", "ingress"]);
    let first = render_node(&full_session(), &topics);
    for _ in 0..10 {
        assert_eq!(render_node(&full_session(), &topics).as_bytes(), first.as_bytes());
    }
    let sess = full_session();
    assert_eq!(render_node(&sess, &topics), render_node(&sess, &topics));
}

#[test]
fn test_AC_03_10_output_ends_with_exactly_one_newline() {
    for out in [
        render_node(&full_session(), &s(&["kubernetes"])),
        render_node(&base("e", "No messages"), &[]),
        render_node(&with_result("boom", true), &[]),
        render_node(&with_result(&"x".repeat(5000), false), &[]),
        render_node(
            &with_messages(vec![msg(Role::User, None, vec![text("last words")])]),
            &[],
        ),
    ] {
        assert!(out.ends_with('\n'), "must end with a newline");
        assert!(!out.ends_with("\n\n"), "must end with exactly one newline");
    }
}

#[test]
fn test_AC_03_10_session_without_messages_ends_after_the_conversation_heading() {
    let out = render_node(&base("e", "No messages"), &[]);
    assert!(out.ends_with("## Conversation\n"));
}

#[test]
fn test_AC_03_10_output_does_not_depend_on_other_calls() {
    let a = render_node(&base("a", "Alpha"), &s(&["one"]));
    let _ = render_node(&full_session(), &s(&["two", "three"]));
    let a_again = render_node(&base("a", "Alpha"), &s(&["one"]));
    assert_eq!(a, a_again);
}
