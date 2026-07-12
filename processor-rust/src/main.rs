mod config;
mod error_mapper;
mod excel_engine;
mod extractor;
mod filename_rules;
mod ipc;
mod pricing;
mod pricing_writer;
mod reader;
mod scanner;
mod state;
mod writer;

use anyhow::Result;
use excel_engine::{run_merge_summaries, run_processing, run_scan};
use ipc::{emit, emit_error};
use serde_json::{Value, json};
use state::RuntimeState;
use std::io::{self, BufRead};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

fn main() -> Result<()> {
    let state = RuntimeState::new();
    let task_running = Arc::new(AtomicBool::new(false));
    emit(json!({"type": "ready"}));

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let command: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                emit(json!({"type": "error", "message": format!("命令 JSON 解析失败: {error}")}));
                continue;
            }
        };
        let action = command_action(&command);
        match action {
            "shutdown" => break,
            "pause" => {
                state.set_paused(true);
                emit(json!({"type": "state", "state": "paused"}));
            }
            "resume" => {
                state.set_paused(false);
                emit(json!({"type": "state", "state": "running"}));
            }
            "stop" => {
                state.request_stop();
                emit(json!({"type": "state", "state": "stopping"}));
            }
            "scan" => {
                spawn_task(&task_running, &state, command, "扫描失败", false, run_scan);
            }
            "start" => {
                spawn_task(
                    &task_running,
                    &state,
                    command,
                    "处理失败",
                    true,
                    run_processing,
                );
            }
            "merge-summaries" => {
                spawn_task(
                    &task_running,
                    &state,
                    command,
                    "合并汇总失败",
                    true,
                    run_merge_summaries,
                );
            }
            "price-check-analyze" => {
                spawn_task(
                    &task_running,
                    &state,
                    command,
                    "核价分析失败",
                    true,
                    pricing::run_price_check_analyze,
                );
            }
            "price-check-run" => {
                spawn_task(
                    &task_running,
                    &state,
                    command,
                    "核价执行失败",
                    true,
                    pricing::run_price_check,
                );
            }
            other => emit(json!({"type": "error", "message": format!("未知命令: {other}")})),
        }
    }

    Ok(())
}

fn command_action(command: &Value) -> &str {
    command
        .get("action")
        .or_else(|| command.get("command"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn spawn_task(
    task_running: &Arc<AtomicBool>,
    state: &RuntimeState,
    command: Value,
    error_context: &'static str,
    emit_idle_on_finish: bool,
    task: fn(&Value, &RuntimeState) -> Result<()>,
) {
    if task_running.swap(true, Ordering::SeqCst) {
        emit(json!({"type": "error", "message": "当前已有任务在运行"}));
        return;
    }

    state.reset();
    let task_state = state.clone();
    let task_running = Arc::clone(task_running);
    thread::spawn(move || {
        if let Err(error) = task(&command, &task_state) {
            emit_error(error_context, error);
        }
        if emit_idle_on_finish {
            emit(json!({"type": "state", "state": "idle"}));
        }
        task_running.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_action_or_legacy_command_field() {
        assert_eq!(command_action(&json!({"action": "scan"})), "scan");
        assert_eq!(command_action(&json!({"command": "start"})), "start");
        assert_eq!(
            command_action(&json!({"action": "pause", "command": "scan"})),
            "pause"
        );
        assert_eq!(command_action(&json!({})), "");
    }
}
