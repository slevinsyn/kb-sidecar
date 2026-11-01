//! Phase 08 tests: clean topic pipeline (`normalize_term`, `tokenize_clean`,
//! `extract_topics_clean`, `EXTRA_STOP_WORDS`, `TECH_TERMS`) and its wiring into `kb ingest`.
//!
//! The unit tests are pure functions. The ingest tests run the `kb` binary on a temporary
//! `--claude-dir` fixture with HOME pointing at a temp dir, KB_HOME removed and `--out <tmp>`,
//! so the real ~/.claude and ~/claude-kb are never touched.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use kb_core::topics::*;
use serde_json::{json, Value};
use tempfile::TempDir;

const KB: &str = env!("CARGO_BIN_EXE_kb");

// ---------------------------------------------------------------------------------------------
// Unit-test helpers
// ---------------------------------------------------------------------------------------------

fn v(items: &[&str]) -> Vec<String> {
    items.iter().map(|x| x.to_string()).collect()
}

fn docs_of(items: &[&str]) -> Vec<String> {
    v(items)
}

fn assert_normalizes(cases: &[(&str, &str)]) {
    for (input, expected) in cases {
        assert_eq!(
            normalize_term(input),
            *expected,
            "normalize_term({input:?})"
        );
    }
}

/// Words whose plural `<word>s` is reduced back to `<word>` by the normalisation rules:
/// at least 4 letters (so the plural is longer than 4), and the plural must not end in
/// ss/us/is/os, ies, sses, ches, shes or xes.
fn plural_round_trips_by_rules(w: &str) -> bool {
    w.len() >= 4
        && w.chars().all(|c| c.is_ascii_alphabetic())
        && !w.ends_with(['s', 'u', 'i', 'o'])
        && !w.ends_with("ie")
        && !w.ends_with("xe")
        && !w.ends_with("she")
        && !w.ends_with("che")
        && !w.ends_with("sse")
}

// ---------------------------------------------------------------------------------------------
// AC-08-01: normalize_term
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_01_words_of_four_chars_or_fewer_are_unchanged() {
    assert_normalizes(&[
        ("aws", "aws"),
        ("data", "data"),
        ("bus", "bus"),
        ("ios", "ios"),
        ("tips", "tips"),
        ("ties", "ties"),
        ("uses", "uses"),
        ("news", "news"),
        ("axes", "axes"),
        ("ab", "ab"),
        ("a", "a"),
        ("", ""),
    ]);
}

#[test]
fn test_AC_08_01_words_ending_ss_us_is_os_are_unchanged() {
    assert_normalizes(&[
        ("class", "class"),
        ("status", "status"),
        ("analysis", "analysis"),
        ("macos", "macos"),
        ("address", "address"),
        ("bonus", "bonus"),
        ("basis", "basis"),
        ("photos", "photos"),
        ("chassis", "chassis"),
        ("walrus", "walrus"),
        ("chaos", "chaos"),
    ]);
}

#[test]
fn test_AC_08_01_ies_becomes_y() {
    assert_normalizes(&[
        ("queries", "query"),
        ("entries", "entry"),
        ("libraries", "library"),
        ("policies", "policy"),
        ("tries", "try"),
        ("cries", "cry"),
    ]);
}

#[test]
fn test_AC_08_01_sses_drops_the_final_es() {
    assert_normalizes(&[
        ("classes", "class"),
        ("addresses", "address"),
        ("processes", "process"),
        ("bosses", "boss"),
        ("glasses", "glass"),
    ]);
}

#[test]
fn test_AC_08_01_ches_shes_xes_drop_es() {
    assert_normalizes(&[
        ("patches", "patch"),
        ("boxes", "box"),
        ("branches", "branch"),
        ("hashes", "hash"),
        ("indexes", "index"),
        ("matches", "match"),
        ("fixes", "fix"),
        ("wishes", "wish"),
        ("taxes", "tax"),
    ]);
}

#[test]
fn test_AC_08_01_plain_trailing_s_is_dropped() {
    assert_normalizes(&[
        ("proposals", "proposal"),
        ("notes", "note"),
        ("files", "file"),
        ("servers", "server"),
        ("databases", "database"),
        ("images", "image"),
        ("reviewers", "reviewer"),
        ("releases", "release"),
        ("cases", "case"),
    ]);
}

#[test]
fn test_AC_08_01_other_words_are_unchanged() {
    assert_normalizes(&[
        ("proposal", "proposal"),
        ("deployment", "deployment"),
        ("parser", "parser"),
        ("typescript", "typescript"),
        ("lambda", "lambda"),
        ("python", "python"),
        ("abc123", "abc123"),
    ]);
}

#[test]
fn test_AC_08_01_first_matching_rule_wins() {
    // Length rule beats the plural rules.
    assert_eq!(normalize_term("dies"), "dies");
    // ss/us/is/os beats the plain-s rule.
    assert_eq!(normalize_term("canvass"), "canvass");
    // sses beats ches/s: "classes" -> "class", not "classe".
    assert_eq!(normalize_term("classes"), "class");
    // ches beats the plain-s rule: "patches" -> "patch", not "patche".
    assert_eq!(normalize_term("patches"), "patch");
}

// ---------------------------------------------------------------------------------------------
// AC-08-02: tokenize_clean example
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_02_spec_example() {
    assert_eq!(
        tokenize_clean("Proposals and PROPOSAL notes this evening"),
        v(&["proposal", "proposal", "note"])
    );
}

#[test]
fn test_AC_08_02_order_preserved_duplicates_kept_and_lowercased() {
    assert_eq!(
        tokenize_clean("Rust Docker docker RUST"),
        v(&["rust", "docker", "docker", "rust"])
    );
}

#[test]
fn test_AC_08_02_plural_forms_are_normalised_in_place() {
    assert_eq!(
        tokenize_clean("Queries, entries; patches & boxes"),
        v(&["query", "entry", "patch", "box"])
    );
}

#[test]
fn test_AC_08_02_phase_03_tokenisation_rules_still_apply() {
    // Underscores and punctuation split, pure numbers and over-long tokens are dropped.
    assert_eq!(
        tokenize_clean("redis_cache-latency 2026 12345"),
        v(&["redis", "cache", "latency"])
    );
    let long = "k".repeat(31);
    assert_eq!(tokenize_clean(&format!("{long} redis")), v(&["redis"]));
    assert!(tokenize_clean("").is_empty());
    assert!(tokenize_clean("   \n\t ").is_empty());
    assert!(tokenize_clean("!!! --- ___").is_empty());
}

#[test]
fn test_AC_08_02_extra_stop_words_and_their_plurals_are_dropped_in_a_sentence() {
    assert_eq!(
        tokenize_clean("Yesterday the reviewers said that tomorrow deployments focus"),
        v(&["reviewer", "deployment"])
    );
    assert!(tokenize_clean("number numbers evening evenings goal goals").is_empty());
}

#[test]
fn test_AC_08_02_original_token_in_stop_words_is_dropped() {
    assert_eq!(tokenize_clean("this redis the cache"), v(&["redis", "cache"]));
}

// ---------------------------------------------------------------------------------------------
// AC-08-03: stop word lists
// ---------------------------------------------------------------------------------------------

const REQUIRED_EXTRA: &[&str] = &[
    "number", "say", "said", "evening", "morning", "afternoon", "night", "today", "tomorrow",
    "yesterday", "week", "month", "year", "time", "goal", "focus", "active", "primary", "pending",
    "recap", "home", "date", "index", "ins", "candidate", "thing", "something", "think", "know",
    "look", "sure", "right", "good", "great", "well", "really", "still", "going", "work", "using",
    "used", "new", "first", "last", "next", "back", "start", "give", "take", "keep", "try", "show",
    "tell", "ask", "help", "run", "set", "check", "add", "change", "update",
];

const REQUIRED_TECH: &[&str] = &[
    "rust", "cargo", "typescript", "javascript", "python", "react", "vite", "node", "npm", "docker",
    "kubernetes", "aws", "lambda", "sap", "abap", "hana", "fiori", "sql", "postgres", "sqlite",
    "redis", "graphql", "api", "json", "yaml", "git", "github", "mcp", "claude", "llm", "pdf",
    "html", "css", "vitest", "terraform", "cdk",
];

#[test]
fn test_AC_08_03_extra_stop_words_contains_every_required_word_and_is_lowercase() {
    for w in REQUIRED_EXTRA {
        assert!(EXTRA_STOP_WORDS.contains(w), "EXTRA_STOP_WORDS is missing {w:?}");
    }
    for w in EXTRA_STOP_WORDS {
        assert_eq!(*w, w.to_lowercase(), "extra stop word {w:?} must be lowercase");
    }
    for w in STOP_WORDS {
        assert_eq!(*w, w.to_lowercase(), "stop word {w:?} must be lowercase");
    }
}

#[test]
fn test_AC_08_03_tech_terms_contains_every_required_term_and_is_lowercase() {
    for w in REQUIRED_TECH {
        assert!(TECH_TERMS.contains(w), "TECH_TERMS is missing {w:?}");
    }
    for w in TECH_TERMS {
        assert_eq!(*w, w.to_lowercase(), "tech term {w:?} must be lowercase");
    }
}

#[test]
fn test_AC_08_03_every_listed_stop_word_is_dropped() {
    for w in EXTRA_STOP_WORDS.iter().chain(STOP_WORDS.iter()) {
        if !w.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue; // not a possible token
        }
        assert!(tokenize_clean(w).is_empty(), "{w:?} should be dropped");
        assert!(
            tokenize_clean(&w.to_uppercase()).is_empty(),
            "{w:?} in capitals should be dropped"
        );
    }
}

#[test]
fn test_AC_08_03_plural_of_every_listed_stop_word_is_dropped() {
    let mut checked = 0;
    for w in EXTRA_STOP_WORDS.iter().chain(STOP_WORDS.iter()) {
        if !plural_round_trips_by_rules(w) {
            continue;
        }
        let plural = format!("{w}s");
        assert!(
            tokenize_clean(&plural).is_empty(),
            "plural {plural:?} of stop word {w:?} should be dropped"
        );
        checked += 1;
    }
    assert!(checked >= 20, "expected many testable plurals, got {checked}");
}

#[test]
fn test_AC_08_03_named_plurals_of_extra_stop_words_are_dropped() {
    let plurals = [
        "numbers", "evenings", "mornings", "afternoons", "nights", "weeks", "months", "years",
        "times", "goals", "things", "candidates", "dates", "recaps", "homes", "starts", "gives",
        "takes", "tries", "checks", "changes", "updates", "helps", "shows", "looks", "thinks",
        "knows", "keeps", "tells", "indexes",
    ];
    for p in plurals {
        assert!(tokenize_clean(p).is_empty(), "{p:?} should be dropped");
    }
}

#[test]
fn test_AC_08_03_all_stop_words_in_one_text_leave_only_the_real_word() {
    let words: Vec<&str> = EXTRA_STOP_WORDS
        .iter()
        .chain(STOP_WORDS.iter())
        .copied()
        .filter(|w| w.chars().all(|c| c.is_ascii_alphanumeric()))
        .collect();
    let text = format!("{} zebra {}", words.join(" "), words.join(" "));
    assert_eq!(tokenize_clean(&text), v(&["zebra"]));
}

// ---------------------------------------------------------------------------------------------
// AC-08-04: plural and singular counts merge
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_04_proposal_is_first_topic_when_plural_and_singular_merge() {
    let docs = docs_of(&["proposal proposals proposals invoice"]);
    let topics = extract_topics_clean(&docs, 5);
    assert_eq!(topics.len(), 1);
    assert_eq!(topics[0][0], "proposal");
    assert_eq!(topics[0], v(&["proposal", "invoice"]));
    assert!(!topics[0].contains(&"proposals".to_string()));
}

#[test]
fn test_AC_08_04_merged_counts_tie_with_other_terms_alphabetically() {
    // sprocket (1 + 1) merges to 2 and ties with gadget (2): alphabetical order decides.
    // Unmerged, gadget (2) would lead and sprocket / sprockets would each have 1.
    let docs = docs_of(&["sprocket sprockets gadget gadget"]);
    assert_eq!(extract_topics_clean(&docs, 5), vec![v(&["gadget", "sprocket"])]);
}

#[test]
fn test_AC_08_04_merging_happens_across_documents_for_document_frequency() {
    // "ledger" and "ledgers" are in different docs; after merging df(ledger) = 2.
    // N = 3: ledger tf 1/2, idf ln(4/3)+1 = 1.288 -> 0.644; the unique terms: tf 1/2, idf ln(4/2)+1 = 1.693 -> 0.847.
    let docs = docs_of(&["ledger audit", "ledgers invoice", "pasta"]);
    let topics = extract_topics_clean(&docs, 5);
    assert_eq!(topics[0], v(&["audit", "ledger"]));
    assert_eq!(topics[1], v(&["invoice", "ledger"]));
    assert_eq!(topics[2], v(&["pasta"]));
}

#[test]
fn test_AC_08_04_exact_ranking_with_idf_over_three_documents() {
    // N = 3.
    // doc0: proposal 2/3 * (ln(4/2)+1) = 1.129, invoice 1/3 * (ln(4/3)+1) = 0.429.
    // doc1: invoice and ledger both tf 1/2, df 2 -> tie -> alphabetical.
    // doc2: ledger 2/3 * 1.288 = 0.858, audit 1/3 * 1.693 = 0.564.
    let docs = docs_of(&[
        "proposal proposals invoice",
        "invoice ledger",
        "ledger ledgers audit",
    ]);
    let topics = extract_topics_clean(&docs, 5);
    assert_eq!(topics.len(), 3);
    assert_eq!(topics[0], v(&["proposal", "invoice"]));
    assert_eq!(topics[1], v(&["invoice", "ledger"]));
    assert_eq!(topics[2], v(&["ledger", "audit"]));
}

#[test]
fn test_AC_08_04_idf_is_smoothed_with_plus_one() {
    // N = 2. gizmo: tf 0.4 * (ln(3/2)+1) = 0.562; widget: tf 0.6 * (ln(3/3)+1) = 0.600.
    let docs = docs_of(&["gizmo gizmo widget widget widget", "widget"]);
    let topics = extract_topics_clean(&docs, 2);
    assert_eq!(topics[0], v(&["widget", "gizmo"]));
    assert_eq!(topics[1], v(&["widget"]));
}

#[test]
fn test_AC_08_04_stop_words_never_become_topics() {
    let docs = docs_of(&["number evening goal say proposals proposals", "evenings goals numbers"]);
    let topics = extract_topics_clean(&docs, 10);
    assert_eq!(topics[0], v(&["proposal"]));
    assert!(topics[1].is_empty());
    for per_doc in &topics {
        for t in per_doc {
            assert!(!EXTRA_STOP_WORDS.contains(&t.as_str()), "{t:?} is an extra stop word");
            assert!(!STOP_WORDS.contains(&t.as_str()), "{t:?} is a stop word");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// AC-08-05: generic terms (document frequency above 40 percent with 10 or more docs)
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_05_term_in_half_of_ten_docs_is_never_a_topic() {
    // N = 10, "gizmo" in docs 0..=4 (50% > 40%). Without the rule it would lead doc 0
    // (tf 0.75, idf ln(11/6)+1 = 1.606 -> 1.2 vs zork0 0.25 * 2.705 = 0.68).
    let mut docs = vec!["gizmo gizmo gizmo zork0".to_string()];
    for i in 1..5 {
        docs.push(format!("gizmo zork{i}"));
    }
    for i in 5..10 {
        docs.push(format!("zork{i}"));
    }
    let topics = extract_topics_clean(&docs, 1);
    assert_eq!(topics.len(), 10);
    for (i, t) in topics.iter().enumerate() {
        assert_eq!(t, &vec![format!("zork{i}")], "doc {i}");
    }
    // With a large k the generic term is still absent.
    for t in extract_topics_clean(&docs, 50) {
        assert!(!t.contains(&"gizmo".to_string()), "gizmo leaked into {t:?}");
    }
}

#[test]
fn test_AC_08_05_term_at_exactly_forty_percent_is_still_allowed() {
    // N = 10, "gadget" in 4 docs = 40%, not more than 40%.
    let mut docs = vec!["gadget gadget gadget zork0".to_string()];
    for i in 1..4 {
        docs.push(format!("gadget zork{i}"));
    }
    for i in 4..10 {
        docs.push(format!("zork{i}"));
    }
    let topics = extract_topics_clean(&docs, 1);
    // gadget: 0.75 * (ln(11/5)+1) = 1.34 beats zork0: 0.25 * (ln(11/2)+1) = 0.68.
    assert_eq!(topics[0], v(&["gadget"]));
    // Docs 1..=3: gadget 0.5 * 1.788 = 0.894 vs zork 0.5 * 2.705 = 1.35.
    assert_eq!(topics[1], v(&["zork1"]));
    let top_all = extract_topics_clean(&docs, 5);
    assert_eq!(top_all[1], v(&["zork1", "gadget"]));
}

#[test]
fn test_AC_08_05_threshold_uses_the_plural_merged_document_frequency() {
    // 10 docs; "sprocket" appears in 3 docs and "sprockets" in 3 other docs: merged df = 6 (60%).
    let mut docs = Vec::new();
    for i in 0..3 {
        docs.push(format!("sprocket zork{i}"));
    }
    for i in 3..6 {
        docs.push(format!("sprockets zork{i}"));
    }
    for i in 6..10 {
        docs.push(format!("zork{i}"));
    }
    for (i, t) in extract_topics_clean(&docs, 5).iter().enumerate() {
        assert_eq!(t, &vec![format!("zork{i}")], "doc {i}");
    }
}

#[test]
fn test_AC_08_05_with_nine_docs_nothing_is_excluded_for_frequency() {
    // N = 9, "gizmo" in all 9 docs (100%): allowed because N < 10.
    // gizmo: tf 0.5 * (ln(10/10)+1) = 0.5; zork: 0.5 * (ln(10/2)+1) = 1.30.
    let docs: Vec<String> = (0..9).map(|i| format!("gizmo zork{i}")).collect();
    let topics = extract_topics_clean(&docs, 2);
    assert_eq!(topics.len(), 9);
    for (i, t) in topics.iter().enumerate() {
        assert_eq!(t, &vec![format!("zork{i}"), "gizmo".to_string()], "doc {i}");
    }
}

#[test]
fn test_AC_08_05_a_doc_of_only_generic_terms_has_no_topics() {
    let mut docs = vec!["gizmo gizmo".to_string()];
    for i in 1..10 {
        docs.push(format!("gizmo zork{i}"));
    }
    let topics = extract_topics_clean(&docs, 5);
    assert_eq!(topics.len(), 10);
    assert!(topics[0].is_empty());
    assert_eq!(topics[1], v(&["zork1"]));
}

#[test]
fn test_AC_08_05_eleven_docs_forty_percent_is_4_4_docs() {
    // N = 11: df 4 (36%) allowed, df 5 (45%) excluded.
    let mut docs = Vec::new();
    for i in 0..11 {
        let mut d = format!("zork{i}");
        if i < 5 {
            d.push_str(" gizmo");
        }
        if i < 4 {
            d.push_str(" gadget gadget");
        }
        docs.push(d);
    }
    let topics = extract_topics_clean(&docs, 10);
    for (i, t) in topics.iter().enumerate() {
        assert!(!t.contains(&"gizmo".to_string()), "doc {i} has gizmo: {t:?}");
        assert_eq!(
            t.contains(&"gadget".to_string()),
            i < 4,
            "doc {i}: gadget presence in {t:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// AC-08-06: technology boost
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_06_tech_term_outranks_non_tech_term_at_equal_frequency() {
    // "abacus" sorts before "rust", so only the boost can put "rust" first.
    assert_eq!(
        extract_topics_clean(&docs_of(&["abacus rust"]), 2),
        vec![v(&["rust", "abacus"])]
    );
}

#[test]
fn test_AC_08_06_boost_works_with_equal_document_frequency_across_docs() {
    let docs = docs_of(&["abacus python", "abacus python"]);
    let topics = extract_topics_clean(&docs, 2);
    assert_eq!(topics[0], v(&["python", "abacus"]));
    assert_eq!(topics[1], v(&["python", "abacus"]));
}

#[test]
fn test_AC_08_06_boost_applies_to_the_normalised_form() {
    // "dockers" -> "docker" (tech); upper case input is lowercased first.
    assert_eq!(
        extract_topics_clean(&docs_of(&["abacus Dockers"]), 2),
        vec![v(&["docker", "abacus"])]
    );
}

#[test]
fn test_AC_08_06_boost_is_only_one_and_a_half_not_unbounded() {
    // abacus tf 2/3 = 0.667 beats rust tf 1/3 * 1.5 = 0.5.
    assert_eq!(
        extract_topics_clean(&docs_of(&["abacus abacus rust"]), 2),
        vec![v(&["abacus", "rust"])]
    );
    // docker 3/5 * 1.5 = 0.9 beats abacus 2/5 = 0.4.
    assert_eq!(
        extract_topics_clean(&docs_of(&["abacus abacus docker docker docker"]), 2),
        vec![v(&["docker", "abacus"])]
    );
}

#[test]
fn test_AC_08_06_boost_multiplies_the_tf_idf_score() {
    // N = 2. rust: tf 0.5, df 2, idf 1 -> 0.5 * 1 * 1.5 = 0.75.
    //        abacus: tf 0.5, df 1, idf ln(3/2)+1 = 1.405 -> 0.703.
    // Unboosted, abacus would win; the boost lets rust win.
    let docs = docs_of(&["abacus rust", "rust"]);
    let topics = extract_topics_clean(&docs, 2);
    assert_eq!(topics[0], v(&["rust", "abacus"]));
    assert_eq!(topics[1], v(&["rust"]));
}

#[test]
fn test_AC_08_06_non_tech_pair_without_boost_is_ordered_alphabetically() {
    // Control: the boost, not the spelling, decides in the tech tests above.
    assert_eq!(
        extract_topics_clean(&docs_of(&["zebra abacus"]), 2),
        vec![v(&["abacus", "zebra"])]
    );
}

// ---------------------------------------------------------------------------------------------
// AC-08-07: k, empty docs, ties, determinism
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_07_returns_at_most_k_terms_per_doc() {
    let docs = docs_of(&[
        "alpha1 bravo2 charlie3 delta4 echo5 foxtrot6",
        "golf7 hotel8",
    ]);
    let top3 = extract_topics_clean(&docs, 3);
    assert_eq!(top3.len(), 2);
    assert_eq!(top3[0], v(&["alpha1", "bravo2", "charlie3"]));
    assert_eq!(top3[1].len(), 2);
    let top1 = extract_topics_clean(&docs, 1);
    assert_eq!(top1[0].len(), 1);
    assert_eq!(top1[1].len(), 1);
    let top100 = extract_topics_clean(&docs, 100);
    assert_eq!(top100[0].len(), 6);
    assert_eq!(top100[1].len(), 2);
}

#[test]
fn test_AC_08_07_k_zero_gives_empty_vectors() {
    let docs = docs_of(&["ingress rollout", "pasta recipe"]);
    assert_eq!(extract_topics_clean(&docs, 0), vec![Vec::<String>::new(); 2]);
}

#[test]
fn test_AC_08_07_empty_docs_get_empty_vectors_in_place() {
    let docs = docs_of(&[
        "",
        "the and for",
        "ingress rollout",
        "   ",
        "12 34 5",
        "number evening goal",
    ]);
    let topics = extract_topics_clean(&docs, 5);
    assert_eq!(topics.len(), 6);
    assert!(topics[0].is_empty());
    assert!(topics[1].is_empty());
    assert_eq!(topics[2], v(&["ingress", "rollout"]));
    assert!(topics[3].is_empty());
    assert!(topics[4].is_empty());
    assert!(topics[5].is_empty());
}

#[test]
fn test_AC_08_07_no_docs_gives_no_vectors() {
    assert!(extract_topics_clean(&[], 5).is_empty());
}

#[test]
fn test_AC_08_07_ties_are_ordered_alphabetically() {
    let docs = docs_of(&["zulu yankee xray whiskey victor"]);
    assert_eq!(
        extract_topics_clean(&docs, 3),
        vec![v(&["victor", "whiskey", "xray"])]
    );
    let docs = docs_of(&["mango apple cherry", "peach banana"]);
    let topics = extract_topics_clean(&docs, 2);
    assert_eq!(topics[0], v(&["apple", "cherry"]));
    assert_eq!(topics[1], v(&["banana", "peach"]));
}

#[test]
fn test_AC_08_07_many_tied_terms_come_out_in_sorted_order_every_time() {
    // 30 terms, one occurrence each, listed in reverse order: all scores are equal.
    let words: Vec<String> = (0..30).rev().map(|i| format!("tkn{i:02}")).collect();
    let docs = vec![words.join(" ")];
    let expected: Vec<String> = (0..10).map(|i| format!("tkn{i:02}")).collect();
    for _ in 0..20 {
        assert_eq!(extract_topics_clean(&docs, 10), vec![expected.clone()]);
    }
}

#[test]
fn test_AC_08_07_is_deterministic() {
    let docs = docs_of(&[
        "ingress rollout service mesh ingress",
        "pasta recipe boil rollout sauce tomato basil",
        "guitar chords strum rollout capo tuning",
        "",
        "docker rust proposals proposal",
    ]);
    let first = extract_topics_clean(&docs, 4);
    assert_eq!(first.len(), 5);
    for _ in 0..20 {
        assert_eq!(extract_topics_clean(&docs, 4), first);
    }
}

#[test]
fn test_AC_08_07_one_result_per_doc_in_the_same_order() {
    let docs = docs_of(&["pasta pasta", "ingress ingress", "guitar guitar"]);
    let topics = extract_topics_clean(&docs, 1);
    assert_eq!(topics, vec![v(&["pasta"]), v(&["ingress"]), v(&["guitar"])]);
}

// ---------------------------------------------------------------------------------------------
// AC-08-09: phase 03 functions keep their behaviour
// ---------------------------------------------------------------------------------------------

#[test]
fn test_AC_08_09_tokenize_still_keeps_plurals_and_the_new_noise_words() {
    assert_eq!(
        tokenize("Proposals evening number goal"),
        v(&["proposals", "evening", "number", "goal"])
    );
    assert_eq!(
        tokenize("Redis_Cache-Latency.p99/Throughput"),
        v(&["redis", "cache", "latency", "p99", "throughput"])
    );
    assert_eq!(tokenize("The redis AND the cache, please"), v(&["redis", "cache"]));
    assert_eq!(tokenize("ab xyz q z9 pqr"), v(&["xyz", "pqr"]));
}

#[test]
fn test_AC_08_09_extract_topics_still_splits_plural_and_singular() {
    // Old behaviour: proposals 2/4, invoice 1/4 and proposal 1/4 (tie -> alphabetical).
    let docs = docs_of(&["proposal proposals proposals invoice"]);
    assert_eq!(extract_topics(&docs, 5), vec![v(&["proposals", "invoice", "proposal"])]);
}

#[test]
fn test_AC_08_09_extract_topics_still_has_phase_03_ranking_and_ties() {
    let docs = docs_of(&[
        "kubernetes ingress kubernetes ingress rollout",
        "pasta recipe boil rollout",
        "guitar chords strum",
    ]);
    assert_eq!(extract_topics(&docs, 3)[0], v(&["ingress", "kubernetes", "rollout"]));
    let docs = docs_of(&["abacus zephyr", "abacus yodel", "abacus quartz"]);
    assert_eq!(extract_topics(&docs, 2)[0], v(&["zephyr", "abacus"]));
    // The old pipeline does not drop the generic term at 10+ docs.
    let mut many = vec!["gizmo gizmo gizmo zork0".to_string()];
    for i in 1..5 {
        many.push(format!("gizmo zork{i}"));
    }
    for i in 5..10 {
        many.push(format!("zork{i}"));
    }
    assert_eq!(extract_topics(&many, 1)[0], v(&["gizmo"]));
}

#[test]
fn test_AC_08_09_stop_words_list_is_unchanged_for_required_words() {
    for w in [
        "the", "and", "for", "that", "this", "with", "you", "are", "was", "but", "not", "have",
        "can", "will", "just", "what", "from", "use", "file", "code", "make", "need", "want",
        "like", "yes", "okay", "please", "thanks", "let", "now", "here", "there", "also", "would",
        "should", "could",
    ] {
        assert!(STOP_WORDS.contains(&w), "STOP_WORDS lost {w:?}");
        assert!(tokenize(w).is_empty());
    }
}

// ---------------------------------------------------------------------------------------------
// AC-08-08: kb ingest / kb hook publish clean topics
// ---------------------------------------------------------------------------------------------

const A_ID: &str = "aaaaaaaa-1111";
const B_ID: &str = "bbbbbbbb-2222";
const C_ID: &str = "cccccccc-3333";
const H_ID: &str = "dddddddd-4444";

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

    fn claude(&self) -> PathBuf {
        self.p("projects")
    }

    fn run(&self, args: &[String], stdin: Option<&str>) -> Output {
        let mut cmd = Command::new(KB);
        cmd.args(args)
            .env("HOME", self.p("home"))
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

    fn ingest(&self, out: &Path) -> Output {
        let args = vec![
            "ingest".to_string(),
            "--claude-dir".to_string(),
            path_str(&self.claude()),
            "--out".to_string(),
            path_str(out),
        ];
        self.run(&args, None)
    }

    fn hook(&self, out: &Path, stdin: &str) -> Output {
        let args = vec!["hook".to_string(), "--out".to_string(), path_str(out)];
        self.run(&args, Some(stdin))
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn stderr_of(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

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

fn write_session(dir: &Path, sid: &str, cwd: &str, prompt: &str, reply: &str, day: &str) -> PathBuf {
    let path = dir.join(format!("{sid}.jsonl"));
    fs::create_dir_all(dir).expect("create dir");
    let lines = [
        user_line(sid, cwd, &format!("{day}T10:00:00.000Z"), prompt),
        assistant_line(sid, &format!("{day}T10:00:05.000Z"), &format!("msg_{sid}"), reply),
    ];
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(&path, body).expect("write transcript");
    path
}

fn seed_fixture(sb: &Sandbox) {
    write_session(
        &sb.claude().join("proj-a"),
        A_ID,
        "/home/a/alpha",
        "Proposals proposals proposals ready this evening",
        "Proposals reviewed in the evening",
        "2026-10-01",
    );
    write_session(
        &sb.claude().join("proj-b"),
        B_ID,
        "/home/a/beta",
        "Draft the proposal for the invoice",
        "Proposal drafted, invoice attached",
        "2026-10-02",
    );
    write_session(
        &sb.claude().join("proj-c"),
        C_ID,
        "/home/a/gamma",
        "Tune the kafka partitions",
        "Partitions rebalanced overnight",
        "2026-10-03",
    );
}

fn read_graph(out: &Path) -> Value {
    let text = fs::read_to_string(out.join("graph").join("graph.json")).expect("graph file");
    serde_json::from_str(&text).expect("graph.json is JSON")
}

fn graph_ids(graph: &Value) -> Vec<String> {
    graph["nodes"]
        .as_array()
        .expect("nodes array")
        .iter()
        .map(|n| n["id"].as_str().expect("node id").to_string())
        .collect()
}

fn graph_node<'a>(graph: &'a Value, id: &str) -> &'a Value {
    graph["nodes"]
        .as_array()
        .expect("nodes array")
        .iter()
        .find(|n| n["id"] == id)
        .unwrap_or_else(|| panic!("graph lacks node {id}"))
}

fn meta_topics(graph: &Value, session_id: &str) -> Vec<String> {
    graph_node(graph, &format!("session:{session_id}"))["meta"]["topics"]
        .as_array()
        .expect("meta.topics array")
        .iter()
        .map(|t| t.as_str().expect("topic string").to_string())
        .collect()
}

fn note_text(out: &Path, graph: &Value, session_id: &str) -> String {
    let node_file = graph_node(graph, &format!("session:{session_id}"))["meta"]["node_file"]
        .as_str()
        .expect("meta.node_file")
        .to_string();
    fs::read_to_string(out.join("nodes").join(node_file)).expect("session note")
}

fn note_topics_line(note: &str) -> Vec<String> {
    let line = note
        .lines()
        .find(|l| l.starts_with("topics: "))
        .expect("note has a `topics:` line");
    serde_json::from_str(line.trim_start_matches("topics: ")).expect("topics line is a JSON array")
}

#[test]
fn test_AC_08_08_ingest_graph_has_clean_topic_nodes() {
    let sb = Sandbox::new();
    seed_fixture(&sb);
    let out = sb.p("out");

    let o = sb.ingest(&out);
    assert_eq!(o.status.code(), Some(0), "stderr: {}", stderr_of(&o));

    let graph = read_graph(&out);
    let ids = graph_ids(&graph);
    assert!(ids.contains(&"topic:proposal".to_string()), "ids: {ids:?}");
    assert!(!ids.contains(&"topic:proposals".to_string()), "ids: {ids:?}");
    assert!(!ids.contains(&"topic:evening".to_string()), "ids: {ids:?}");
    assert!(ids.contains(&"topic:partition".to_string()), "ids: {ids:?}");
    assert!(!ids.contains(&"topic:partitions".to_string()), "ids: {ids:?}");

    // Plural and singular merged into one topic shared by sessions A and B.
    let proposal = graph_node(&graph, "topic:proposal");
    assert_eq!(proposal["label"], "proposal");
    assert_eq!(proposal["size"], 2);

    // No topic node is a (plural of a) stop word.
    for id in &ids {
        if let Some(term) = id.strip_prefix("topic:") {
            assert!(!STOP_WORDS.contains(&term), "{id} is a stop word");
            assert!(!EXTRA_STOP_WORDS.contains(&term), "{id} is an extra stop word");
        }
    }
}

#[test]
fn test_AC_08_08_session_meta_and_note_carry_the_same_clean_topics() {
    let sb = Sandbox::new();
    seed_fixture(&sb);
    let out = sb.p("out");
    let o = sb.ingest(&out);
    assert_eq!(o.status.code(), Some(0), "stderr: {}", stderr_of(&o));

    let graph = read_graph(&out);
    let topics_a = meta_topics(&graph, A_ID);
    assert!(topics_a.contains(&"proposal".to_string()), "{topics_a:?}");
    assert!(!topics_a.contains(&"proposals".to_string()), "{topics_a:?}");
    assert!(!topics_a.contains(&"evening".to_string()), "{topics_a:?}");
    assert!(topics_a.len() <= 8);

    let note = note_text(&out, &graph, A_ID);
    assert_eq!(note_topics_line(&note), topics_a);
    assert!(note.contains("[[topic/proposal]]"), "note:\n{note}");
    assert!(!note.contains("[[topic/proposals]]"));
    assert!(!note.contains("[[topic/evening]]"));

    let topics_b = meta_topics(&graph, B_ID);
    assert!(topics_b.contains(&"proposal".to_string()), "{topics_b:?}");
    assert!(topics_b.contains(&"invoice".to_string()), "{topics_b:?}");
    assert_eq!(note_topics_line(&note_text(&out, &graph, B_ID)), topics_b);

    let topics_c = meta_topics(&graph, C_ID);
    assert!(topics_c.contains(&"partition".to_string()), "{topics_c:?}");
    assert!(!topics_c.contains(&"partitions".to_string()), "{topics_c:?}");
    assert!(!topics_c.contains(&"proposal".to_string()));
}

#[test]
fn test_AC_08_08_rerunning_ingest_keeps_the_clean_topics() {
    let sb = Sandbox::new();
    seed_fixture(&sb);
    let out = sb.p("out");
    assert_eq!(sb.ingest(&out).status.code(), Some(0));
    let first = fs::read(out.join("graph").join("graph.json")).unwrap();

    assert_eq!(sb.ingest(&out).status.code(), Some(0));
    let second = fs::read(out.join("graph").join("graph.json")).unwrap();
    assert_eq!(first, second);

    let ids = graph_ids(&read_graph(&out));
    assert!(ids.contains(&"topic:proposal".to_string()));
    assert!(!ids.contains(&"topic:proposals".to_string()));
    assert!(!ids.contains(&"topic:evening".to_string()));
}

#[test]
fn test_AC_08_08_hook_publishes_clean_topics_too() {
    let sb = Sandbox::new();
    let transcript = write_session(
        &sb.p("elsewhere"),
        H_ID,
        "/home/a/delta",
        "Proposals proposals needed this evening",
        "Proposals drafted for the evening review",
        "2026-10-04",
    );
    let stdin = json!({
        "session_id": H_ID,
        "transcript_path": path_str(&transcript),
        "cwd": "/home/a/delta",
        "hook_event_name": "SessionEnd",
        "reason": "exit"
    })
    .to_string();
    let out = sb.p("out");

    let o = sb.hook(&out, &stdin);
    assert_eq!(o.status.code(), Some(0), "stderr: {}", stderr_of(&o));

    let graph = read_graph(&out);
    let ids = graph_ids(&graph);
    assert!(ids.contains(&"topic:proposal".to_string()), "ids: {ids:?}");
    assert!(!ids.contains(&"topic:proposals".to_string()), "ids: {ids:?}");
    assert!(!ids.contains(&"topic:evening".to_string()), "ids: {ids:?}");
    let topics = meta_topics(&graph, H_ID);
    assert!(topics.contains(&"proposal".to_string()), "{topics:?}");
    assert_eq!(note_topics_line(&note_text(&out, &graph, H_ID)), topics);
}
