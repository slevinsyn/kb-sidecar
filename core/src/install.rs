//! `kb install-hook`: add a SessionEnd hook to a Claude Code settings file.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde_json::{json, Value};

/// Result of an installation attempt.
#[derive(Debug, PartialEq, Eq)]
pub enum Installed {
    /// The hook was added and the file written.
    Added,
    /// An identical command was already registered; nothing was written.
    AlreadyThere,
}

/// True when some `SessionEnd[*].hooks[*].command` equals `command`.
fn has_command(session_end: &[Value], command: &str) -> bool {
    session_end
        .iter()
        .filter_map(|entry| entry.get("hooks").and_then(Value::as_array))
        .flatten()
        .any(|h| h.get("command").and_then(Value::as_str) == Some(command))
}

fn new_entry(command: &str) -> Value {
    json!({"hooks": [{"type": "command", "command": command}]})
}

/// Install `command` as a SessionEnd hook in the settings file at `path`.
pub fn install_hook(path: &Path, command: &str) -> Result<Installed, String> {
    let mut root = match fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes)
                .map_err(|e| format!("{} is not valid UTF-8: {e}", path.display()))?;
            serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Value::Object(serde_json::Map::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };

    let top = root
        .as_object_mut()
        .ok_or_else(|| format!("{}: top-level JSON value is not an object", path.display()))?;
    let hooks = top
        .entry("hooks")
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("{}: \"hooks\" is not an object", path.display()))?;
    let session_end = hooks
        .entry("SessionEnd")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| format!("{}: \"hooks.SessionEnd\" is not an array", path.display()))?;

    if has_command(session_end, command) {
        return Ok(Installed::AlreadyThere);
    }
    session_end.push(new_entry(command));

    let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
    }
    fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(Installed::Added)
}
