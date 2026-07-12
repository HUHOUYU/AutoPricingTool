use crate::error_mapper::map_error;
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::PathBuf;

pub(crate) fn emit(value: Value) {
    println!("{value}");
    let _ = io::stdout().flush();
}

pub(crate) fn emit_error(context: &str, error: anyhow::Error) {
    let details = format!("{error:#}");
    let user_error = map_error(context, &details);
    emit(json!({
        "type": "error",
        "message": format!("{context}: {error}"),
        "userMessage": user_error.title,
        "suggestion": user_error.suggestion,
        "details": details
    }));
}

pub(crate) fn command_path(command: &Value, key: &str) -> Result<PathBuf> {
    command
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("缺少参数: {key}"))
}

pub(crate) fn config_path(command: &Value) -> PathBuf {
    command
        .get("configPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config").join("extract_rules.json"))
}
