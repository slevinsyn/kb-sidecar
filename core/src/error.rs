//! Error type shared by the whole crate.

use std::fmt;

/// Errors produced by the knowledge base core.
#[derive(Debug)]
pub enum KbError {
    /// A file could not be read or written.
    Io(std::io::Error),
    /// The input held no usable messages (carries the session id).
    Empty(String),
    /// The input could not be parsed.
    Parse(String),
    /// The settings are broken.
    Settings(String),
}

impl fmt::Display for KbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KbError::Io(e) => write!(f, "I/O error: {e}"),
            KbError::Empty(id) => write!(f, "no messages in session {id}"),
            KbError::Parse(msg) => write!(f, "parse error: {msg}"),
            KbError::Settings(msg) => write!(f, "settings error: {msg}"),
        }
    }
}

impl std::error::Error for KbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            KbError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for KbError {
    fn from(e: std::io::Error) -> Self {
        KbError::Io(e)
    }
}
