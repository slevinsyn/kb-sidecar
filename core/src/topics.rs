//! Offline topic keywords (TF-IDF).

use std::collections::{BTreeMap, BTreeSet};

use crate::{Block, Session};

/// Words that never become topics (lowercase).
pub const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "that", "this", "with", "you", "are", "was", "but", "not", "have", "can",
    "will", "just", "what", "from", "use", "file", "code", "make", "need", "want", "like", "yes",
    "okay", "please", "thanks", "let", "now", "here", "there", "also", "would", "should", "could",
    "has", "had", "its", "his", "her", "our", "your", "they", "them", "then", "than", "when",
    "which", "who", "how", "why", "all", "any", "one", "get", "got", "does", "did", "done",
    "out", "about", "into", "some", "more", "very", "see", "way", "may", "too", "yet", "were",
    "been", "being", "their", "these", "those", "where", "while", "only", "each", "other",
];

/// Lowercase, split on non-ASCII-alphanumerics, drop stop words, short tokens and numbers.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| {
            (3..=30).contains(&t.len())
                && !t.bytes().all(|b| b.is_ascii_digit())
                && !STOP_WORDS.contains(t)
        })
        .map(str::to_string)
        .collect()
}

/// Top `k` TF-IDF terms for each document.
pub fn extract_topics(docs: &[String], k: usize) -> Vec<Vec<String>> {
    let tokenized: Vec<Vec<String>> = docs.iter().map(|d| tokenize(d)).collect();
    let n = docs.len() as f64;

    let mut df: BTreeMap<&str, usize> = BTreeMap::new();
    for tokens in &tokenized {
        let unique: BTreeSet<&str> = tokens.iter().map(String::as_str).collect();
        for t in unique {
            *df.entry(t).or_insert(0) += 1;
        }
    }

    tokenized
        .iter()
        .map(|tokens| {
            if tokens.is_empty() || k == 0 {
                return Vec::new();
            }
            let total = tokens.len() as f64;
            let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
            for t in tokens {
                *counts.entry(t.as_str()).or_insert(0) += 1;
            }
            let mut scored: Vec<(&str, f64)> = counts
                .into_iter()
                .map(|(term, count)| {
                    let tf = count as f64 / total;
                    let d = df.get(term).copied().unwrap_or(0) as f64;
                    let idf = ((1.0 + n) / (1.0 + d)).ln() + 1.0;
                    (term, tf * idf)
                })
                .collect();
            scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            scored
                .into_iter()
                .take(k)
                .map(|(t, _)| t.to_string())
                .collect()
        })
        .collect()
}

/// Title plus all text blocks of a session.
pub fn session_text(s: &Session) -> String {
    let parts: Vec<&str> = s
        .messages
        .iter()
        .flat_map(|m| m.blocks.iter())
        .filter_map(|b| match b {
            Block::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    format!("{}\n{}", s.title, parts.join("\n"))
}
