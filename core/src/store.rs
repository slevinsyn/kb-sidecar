//! The on-disk knowledge base: source cache plus the generated nodes, dataset and graph.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use kb_core::dataset::{to_jsonl, to_record, DatasetOptions};
use kb_core::graph::build_graph;
use kb_core::node::{node_file_name, render_node};
use kb_core::topics::{extract_topics_clean, session_text};
use kb_core::Session;
use serde::{Deserialize, Serialize};

use crate::sha256::sha256_hex;

const CACHE_VERSION: u32 = 1;
const TOPIC_COUNT: usize = 8;

/// Sessions parsed from one source file, with the fingerprint of that file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub size: u64,
    pub sha256: String,
    pub sessions: Vec<Session>,
}

/// Cache of everything parsed so far, keyed by absolute source path.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Cache {
    pub version: u32,
    pub files: BTreeMap<String, Entry>,
}

/// Counters for the summary line.
#[derive(Debug, Default)]
pub struct Counts {
    pub new: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub skipped: usize,
}

impl Counts {
    pub fn line(&self) -> String {
        format!(
            "ingested: {} new, {} updated, {} unchanged, {} skipped",
            self.new, self.updated, self.unchanged, self.skipped
        )
    }
}

fn cache_path(out: &Path) -> PathBuf {
    out.join("cache").join("index.json")
}

/// Load the cache; a missing, unreadable or foreign-version cache counts as empty.
pub fn load_cache(out: &Path) -> Cache {
    let loaded = fs::read_to_string(cache_path(out))
        .ok()
        .and_then(|text| serde_json::from_str::<Cache>(&text).ok())
        .filter(|c| c.version == CACHE_VERSION);
    loaded.unwrap_or(Cache {
        version: CACHE_VERSION,
        files: BTreeMap::new(),
    })
}

/// Size and SHA-256 of a file.
pub fn fingerprint(path: &Path) -> std::io::Result<(u64, String)> {
    let bytes = fs::read(path)?;
    Ok((bytes.len() as u64, sha256_hex(&bytes)))
}

/// Path used as cache key: absolute and, when possible, canonical.
pub fn cache_key(path: &Path) -> String {
    let abs = fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|d| d.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    });
    abs.to_string_lossy().into_owned()
}

/// Write `content` to `path` unless the file already holds exactly that. Uses a temporary
/// file and a rename so a reader never sees a half-written file.
fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read(path).is_ok_and(|old| old == content.as_bytes()) {
        return Ok(());
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".tmp{}", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, content).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot write {}: {e}", path.display())
    })
}

fn make_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("cannot create {}: {e}", path.display()))
}

/// Delete `.md` files in `dir` that are not in `keep`; other files stay.
fn remove_stale_nodes(dir: &Path, keep: &BTreeSet<String>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".md") && !keep.contains(&name) && entry.path().is_file() {
            fs::remove_file(entry.path())
                .map_err(|e| format!("cannot remove {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// All cached sessions, one per id (later cache keys win), sorted by id.
fn all_sessions(cache: &Cache) -> Vec<Session> {
    let mut by_id: BTreeMap<&str, &Session> = BTreeMap::new();
    for entry in cache.files.values() {
        for s in &entry.sessions {
            by_id.insert(s.id.as_str(), s);
        }
    }
    by_id.into_values().cloned().collect()
}

/// Write nodes, dataset, graph and finally the cache for the sessions held in `cache`.
pub fn publish(out: &Path, cache: &Cache, redact: bool) -> Result<(), String> {
    let sessions = all_sessions(cache);
    let docs: Vec<String> = sessions.iter().map(session_text).collect();
    let topics = extract_topics_clean(&docs, TOPIC_COUNT);

    let nodes_dir = out.join("nodes");
    let dataset_dir = out.join("dataset");
    let graph_dir = out.join("graph");
    for d in [out, &nodes_dir, &dataset_dir, &graph_dir, &out.join("cache")] {
        make_dir(d)?;
    }

    let mut keep = BTreeSet::new();
    for (s, t) in sessions.iter().zip(&topics) {
        let name = node_file_name(s);
        write_if_changed(&nodes_dir.join(&name), &render_node(s, t))?;
        keep.insert(name);
    }
    remove_stale_nodes(&nodes_dir, &keep)?;

    let opts = DatasetOptions {
        redact,
        ..DatasetOptions::default()
    };
    let records: Vec<_> = sessions.iter().filter_map(|s| to_record(s, &opts)).collect();
    write_if_changed(&dataset_dir.join("conversations.jsonl"), &to_jsonl(&records))?;

    let with_topics: Vec<(Session, Vec<String>)> = sessions.into_iter().zip(topics).collect();
    write_if_changed(
        &graph_dir.join("graph.json"),
        &build_graph(&with_topics).to_json(),
    )?;

    let text = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    write_if_changed(&cache_path(out), &text)
}
