//! Conversation knowledge base core.

pub mod claude_ai;
pub mod claude_code;
pub mod error;
pub mod model;
pub mod node;
pub mod topics;

pub use error::KbError;
pub use model::{Block, Message, Role, Session, Source};
