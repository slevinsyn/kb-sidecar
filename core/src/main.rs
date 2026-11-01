//! `kb`: build the conversation knowledge base (ingest), keep it current from a Claude Code
//! SessionEnd hook (hook) and register that hook (install-hook).

mod install;
mod sha256;
mod store;

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use kb_core::{claude_ai, claude_code, KbError, Session};

use crate::install::{install_hook, Installed};
use crate::store::{cache_key, fingerprint, load_cache, publish, Cache, Counts, Entry};

const USAGE: &str = "usage:
  kb ingest [--claude-dir <dir>] [--claude-ai <path>]... [--out <dir>] [--no-redact]
  kb hook [--out <dir>] [--no-redact]
  kb install-hook --settings <file> [--command <cmd>]";

/// Exit code for bad command line arguments.
const EXIT_USAGE: u8 = 2;
/// Exit code for runtime failures.
const EXIT_FAILURE: u8 = 1;

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Opts {
    claude_dir: Option<PathBuf>,
    claude_ai: Vec<PathBuf>,
    out: Option<PathBuf>,
    no_redact: bool,
    settings: Option<PathBuf>,
    command: Option<String>,
}

/// Parse `args` accepting only the flags in `allowed`.
fn parse_opts(args: &[String], allowed: &[&str]) -> Result<Opts, String> {
    let mut opts = Opts::default();
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        if !allowed.contains(&flag.as_str()) {
            return Err(format!("unknown argument: {flag}"));
        }
        if flag == "--no-redact" {
            opts.no_redact = true;
            continue;
        }
        let value = it
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--claude-dir" => opts.claude_dir = Some(PathBuf::from(value)),
            "--claude-ai" => opts.claude_ai.push(PathBuf::from(value)),
            "--out" => opts.out = Some(PathBuf::from(value)),
            "--settings" => opts.settings = Some(PathBuf::from(value)),
            "--command" => opts.command = Some(value.clone()),
            _ => return Err(format!("unknown argument: {flag}")),
        }
    }
    Ok(opts)
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn home() -> Result<PathBuf, String> {
    env_path("HOME").ok_or_else(|| "HOME is not set".to_string())
}

/// `--out`, else `$KB_HOME`, else `$HOME/claude-kb`.
fn out_dir(opts: &Opts) -> Result<PathBuf, String> {
    if let Some(p) = &opts.out {
        return Ok(p.clone());
    }
    if let Some(p) = env_path("KB_HOME") {
        return Ok(p);
    }
    Ok(home()?.join("claude-kb"))
}

// ---------------------------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Kind {
    ClaudeCode,
    ClaudeAi,
}

/// The file whose bytes identify a source (an export folder is identified by its JSON file).
fn fingerprint_target(path: &Path, kind: Kind) -> PathBuf {
    match kind {
        Kind::ClaudeAi if path.is_dir() => path.join("conversations.json"),
        _ => path.to_path_buf(),
    }
}

fn parse_source(path: &Path, kind: Kind) -> Result<Vec<Session>, KbError> {
    match kind {
        Kind::ClaudeCode => claude_code::parse_transcript(path).map(|s| vec![s]),
        Kind::ClaudeAi => claude_ai::parse_export(path),
    }
}

fn run_ingest(args: &[String]) -> Result<(), (u8, String)> {
    let opts = parse_opts(
        args,
        &["--claude-dir", "--claude-ai", "--out", "--no-redact"],
    )
    .map_err(|e| (EXIT_USAGE, e))?;
    let out = out_dir(&opts).map_err(|e| (EXIT_FAILURE, e))?;
    let claude_dir = match &opts.claude_dir {
        Some(d) => d.clone(),
        None => home()
            .map_err(|e| (EXIT_FAILURE, e))?
            .join(".claude")
            .join("projects"),
    };

    let mut sources: Vec<(PathBuf, Kind)> = claude_code::discover(&claude_dir)
        .into_iter()
        .map(|p| (p, Kind::ClaudeCode))
        .collect();
    sources.extend(opts.claude_ai.iter().map(|p| (p.clone(), Kind::ClaudeAi)));

    let old = load_cache(&out);
    let old_ids: BTreeSet<&str> = old
        .files
        .values()
        .flat_map(|e| e.sessions.iter().map(|s| s.id.as_str()))
        .collect();

    let mut next = Cache {
        version: old.version,
        files: Default::default(),
    };
    let mut counts = Counts::default();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for (path, kind) in &sources {
        let key = cache_key(path);
        if !seen.insert(key.clone()) {
            continue;
        }
        let (size, sha) = match fingerprint(&fingerprint_target(path, *kind)) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("skipped {}: {}", path.display(), KbError::Io(e));
                counts.skipped += 1;
                continue;
            }
        };
        if let Some(entry) = old.files.get(&key) {
            if entry.size == size && entry.sha256 == sha {
                counts.unchanged += entry.sessions.len();
                next.files.insert(key, entry.clone());
                continue;
            }
        }
        match parse_source(path, *kind) {
            Ok(sessions) if !sessions.is_empty() => {
                for s in &sessions {
                    if old_ids.contains(s.id.as_str()) {
                        counts.updated += 1;
                    } else {
                        counts.new += 1;
                    }
                }
                next.files.insert(
                    key,
                    Entry {
                        size,
                        sha256: sha,
                        sessions,
                    },
                );
            }
            Ok(_) => {
                eprintln!("skipped {}: no conversations", path.display());
                counts.skipped += 1;
            }
            Err(e) => {
                eprintln!("skipped {}: {e}", path.display());
                counts.skipped += 1;
            }
        }
    }

    // Cached sources outside this run (for example hooked sessions) stay while their file exists.
    for (key, entry) in &old.files {
        if !seen.contains(key) && Path::new(key).exists() {
            counts.unchanged += entry.sessions.len();
            next.files.insert(key.clone(), entry.clone());
        }
    }

    publish(&out, &next, !opts.no_redact).map_err(|e| (EXIT_FAILURE, e))?;
    println!("{}", counts.line());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// hook
// ---------------------------------------------------------------------------------------------

fn run_hook(args: &[String]) -> Result<(), String> {
    let opts = parse_opts(args, &["--out", "--no-redact"])?;
    let out = out_dir(&opts)?;

    let mut input = Vec::new();
    std::io::stdin()
        .read_to_end(&mut input)
        .map_err(|e| format!("cannot read stdin: {e}"))?;
    let payload: serde_json::Value =
        serde_json::from_slice(&input).map_err(|e| format!("invalid JSON on stdin: {e}"))?;
    let transcript = payload
        .get("transcript_path")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .ok_or("no transcript_path in input")?;
    let path = Path::new(transcript);

    let (size, sha) = fingerprint(path).map_err(|e| format!("cannot read {transcript}: {e}"))?;
    let session = claude_code::parse_transcript(path).map_err(|e| format!("{transcript}: {e}"))?;

    let mut cache = load_cache(&out);
    let key = cache_key(path);
    let existed = cache
        .files
        .values()
        .any(|e| e.sessions.iter().any(|s| s.id == session.id));

    // The session replaces any earlier copy, whichever file it came from.
    cache.files.remove(&key);
    for entry in cache.files.values_mut() {
        entry.sessions.retain(|s| s.id != session.id);
    }
    cache.files.retain(|_, e| !e.sessions.is_empty());
    let unchanged: usize = cache.files.values().map(|e| e.sessions.len()).sum();
    cache.files.insert(
        key,
        Entry {
            size,
            sha256: sha,
            sessions: vec![session],
        },
    );

    publish(&out, &cache, !opts.no_redact)?;
    let counts = Counts {
        new: usize::from(!existed),
        updated: usize::from(existed),
        unchanged,
        skipped: 0,
    };
    // A closed stdout must not fail the hook, so the write result is ignored.
    let _ = writeln!(std::io::stdout(), "{}", counts.line());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// install-hook
// ---------------------------------------------------------------------------------------------

fn default_hook_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate kb executable: {e}"))?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    Ok(format!("{} hook", exe.display()))
}

fn run_install(args: &[String]) -> Result<(), (u8, String)> {
    let opts = parse_opts(args, &["--settings", "--command"]).map_err(|e| (EXIT_USAGE, e))?;
    let settings = opts
        .settings
        .ok_or((EXIT_USAGE, "missing required --settings <file>".to_string()))?;
    let command = match opts.command {
        Some(c) => c,
        None => default_hook_command().map_err(|e| (EXIT_FAILURE, e))?,
    };
    match install_hook(&settings, &command).map_err(|e| (EXIT_FAILURE, e))? {
        Installed::Added => println!("installed"),
        Installed::AlreadyThere => println!("already installed"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------

fn fail(code: u8, msg: &str) -> ExitCode {
    eprintln!("kb: {msg}");
    if code == EXIT_USAGE {
        eprintln!("{USAGE}");
    }
    ExitCode::from(code)
}

/// Run the SessionEnd hook. It never fails and never panics out: errors and panics are reported
/// on stderr (best effort) and the caller exits 0 so the Claude Code session is undisturbed.
fn hook_main(rest: &[String]) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_hook(rest)));
    let msg = match result {
        Ok(Ok(())) => return,
        Ok(Err(msg)) => msg,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            format!("internal error: {detail}")
        }
    };
    let _ = writeln!(std::io::stderr(), "kb hook: {msg}");
}

fn main() -> ExitCode {
    // Lossy conversion so non-UTF-8 arguments never panic (the hook must always exit 0).
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let Some((command, rest)) = args.split_first() else {
        return fail(EXIT_USAGE, "missing command");
    };
    match command.as_str() {
        "ingest" => match run_ingest(rest) {
            Ok(()) => ExitCode::SUCCESS,
            Err((code, msg)) => fail(code, &msg),
        },
        "install-hook" => match run_install(rest) {
            Ok(()) => ExitCode::SUCCESS,
            Err((code, msg)) => fail(code, &msg),
        },
        "hook" => {
            // A failing hook must never disturb the Claude Code session.
            hook_main(rest);
            ExitCode::SUCCESS
        }
        "-h" | "--help" | "help" => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        other => fail(EXIT_USAGE, &format!("unknown command: {other}")),
    }
}
