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

/// Extra noise words dropped by the clean pipeline (lowercase).
pub const EXTRA_STOP_WORDS: &[&str] = &[
    "number", "say", "said", "evening", "morning", "afternoon", "night", "today", "tomorrow",
    "yesterday", "week", "month", "year", "time", "goal", "focus", "active", "primary", "pending",
    "recap", "home", "date", "index", "ins", "candidate", "thing", "something", "think", "know",
    "look", "sure", "right", "good", "great", "well", "really", "still", "going", "work", "using",
    "used", "new", "first", "last", "next", "back", "start", "give", "take", "keep", "try", "show",
    "tell", "ask", "help", "run", "set", "check", "add", "change", "update",
];

/// Technology terms (lowercase, normalised singular form) that get a score boost.
pub const TECH_TERMS: &[&str] = &[
    "rust", "cargo", "typescript", "javascript", "python", "react", "vite", "node", "npm",
    "docker", "kubernetes", "aws", "lambda", "sap", "abap", "hana", "fiori", "sql", "postgres",
    "sqlite", "redis", "graphql", "api", "json", "yaml", "git", "github", "mcp", "claude", "llm",
    "pdf", "html", "css", "vitest", "terraform", "cdk",
];

/// Reduce a lowercase token to its singular form (plurals only).
pub fn normalize_term(t: &str) -> String {
    if t.len() <= 4 {
        return t.to_string();
    }
    if ["ss", "us", "is", "os"].iter().any(|e| t.ends_with(e)) {
        return t.to_string();
    }
    if let Some(stem) = t.strip_suffix("ies") {
        return format!("{stem}y");
    }
    if t.ends_with("sses") || ["ches", "shes", "xes"].iter().any(|e| t.ends_with(e)) {
        return t[..t.len() - 2].to_string();
    }
    if let Some(stem) = t.strip_suffix('s') {
        return stem.to_string();
    }
    t.to_string()
}

fn is_noise(t: &str) -> bool {
    STOP_WORDS.contains(&t) || EXTRA_STOP_WORDS.contains(&t)
}

/// Clean tokenizer: `tokenize`, plurals merged, stop words (also in plural form) dropped.
pub fn tokenize_clean(text: &str) -> Vec<String> {
    tokenize(text)
        .into_iter()
        .filter_map(|tok| {
            if is_noise(&tok) {
                return None;
            }
            // Technology terms are kept verbatim (normalising would misspell e.g. "kubernetes").
            if TECH_TERMS.contains(&tok.as_str()) {
                return Some(tok);
            }
            let norm = normalize_term(&tok);
            if is_noise(&norm) || norm.len() < 3 {
                None
            } else {
                Some(norm)
            }
        })
        .collect()
}

/// Clean TF-IDF topics per document: merged plurals, extra stop words, generic terms dropped,
/// technology terms boosted.
pub fn extract_topics_clean(docs: &[String], k: usize) -> Vec<Vec<String>> {
    let tokenized: Vec<Vec<String>> = docs.iter().map(|d| tokenize_clean(d)).collect();
    let n_docs = docs.len();
    let n = n_docs as f64;

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
                .filter_map(|(term, count)| {
                    let d = df.get(term).copied().unwrap_or(0);
                    if n_docs >= 10 && d as f64 / n > 0.4 {
                        return None;
                    }
                    let tf = count as f64 / total;
                    let idf = ((1.0 + n) / (1.0 + d as f64)).ln() + 1.0;
                    let boost = if TECH_TERMS.contains(&term) { 1.5 } else { 1.0 };
                    Some((term, tf * idf * boost))
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
