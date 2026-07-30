use crate::config::{Config, load_config};
use crate::extractor::{extract_records, header_confirmation, resolve_columns};
use crate::filename_rules::{
    duplicate_group_key, duplicate_groups, normalize_source_filename, requires_manual_confirmation,
};
use crate::ipc::{command_path, config_path, emit};
use crate::reader::{
    configured_quick_scan_bytes, configured_shared_strings_bytes, is_resource_limit_error,
    read_workbook_limited, read_xlsx_preview_fast, workbook_sheet_count_limited,
};
use crate::scanner::{
    canonical_path_key, discover_excel_files, file_id_for_path, file_name, format_file_size,
    is_supported_excel_file,
};
use crate::state::RuntimeState;
use crate::writer::{
    SummaryIndexRow, SummaryWriter, copy_standard_file, ensure_output_structure,
    group_name_from_standard_name, merge_summary_workbooks, write_processing_manifests,
    write_scan_manifests, write_summary_index,
};
use anyhow::{Result, anyhow};
use rayon::ThreadPoolBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Instant;

const SCAN_PREVIEW_ROW_LIMIT: usize = 50;
const SCAN_PREVIEW_COLUMN_LIMIT: usize = 130;
const SUMMARY_DIR: &str = "汇总";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ProcessorFile {
    pub(crate) id: u64,
    pub(crate) path: String,
    #[serde(rename = "originalName")]
    pub(crate) original_name: String,
    #[serde(rename = "standardName")]
    pub(crate) standard_name: String,
    pub(crate) status: String,
    pub(crate) category: String,
    #[serde(default)]
    pub(crate) reason: String,
    #[serde(rename = "sheetCount")]
    pub(crate) sheet_count: Option<usize>,
    pub(crate) size: String,
    #[serde(rename = "sheetName")]
    pub(crate) sheet_name: Option<String>,
    #[serde(rename = "headerRow")]
    pub(crate) header_row: Option<usize>,
    #[serde(rename = "columnHints")]
    pub(crate) column_hints: Option<BTreeMap<String, Option<usize>>>,
}

#[derive(Debug, Clone)]
pub(crate) struct SheetData {
    pub(crate) name: String,
    pub(crate) rows: Vec<Vec<CellValue>>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkbookData {
    pub(crate) sheets: Vec<SheetData>,
}

#[derive(Clone)]
struct ProcessingTask {
    index: usize,
    path: PathBuf,
    path_key: String,
}

struct ProcessingSuccess {
    result: crate::extractor::ExtractResult,
    standard_name: String,
    record_count: usize,
    copied_path: Option<PathBuf>,
    copy_ms: Option<u128>,
    elapsed_ms: u128,
}

enum ProcessingOutcome {
    Success(Box<ProcessingSuccess>),
    Failure { message: String, elapsed_ms: u128 },
}

struct ProcessingResult {
    index: usize,
    path: PathBuf,
    path_key: String,
    outcome: ProcessingOutcome,
}

#[derive(Debug, Clone, Default)]
pub(crate) enum CellValue {
    #[default]
    Empty,
    String(Arc<str>),
    Float(f64),
    Int(i64),
    Bool(bool),
}

impl CellValue {
    pub(crate) fn string(value: impl Into<Arc<str>>) -> Self {
        CellValue::String(value.into())
    }

    pub(crate) fn text_cow(&self) -> Cow<'_, str> {
        match self {
            CellValue::Empty => Cow::Borrowed(""),
            CellValue::String(value) => Cow::Borrowed(value.trim()),
            CellValue::Float(value) => {
                if value.fract() == 0.0 {
                    Cow::Owned(format!("{}", *value as i64))
                } else {
                    Cow::Owned(value.to_string())
                }
            }
            CellValue::Int(value) => Cow::Owned(value.to_string()),
            CellValue::Bool(value) => Cow::Owned(value.to_string()),
        }
    }

    pub(crate) fn text(&self) -> String {
        self.text_cow().into_owned()
    }

    pub(crate) fn is_empty(&self) -> bool {
        match self {
            CellValue::Empty => true,
            CellValue::String(value) => value.trim().is_empty(),
            CellValue::Float(_) | CellValue::Int(_) | CellValue::Bool(_) => false,
        }
    }
}

pub(crate) fn run_scan(command: &Value, state: &RuntimeState) -> Result<()> {
    let input_dir = command_path(command, "inputDir")?;
    let output_dir = command
        .get("outputDir")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let config = load_config(&config_path(command))?;
    let files = discover_excel_files(&input_dir, output_dir.as_deref())?;

    emit(json!({"type": "scan-start", "total": 0}));
    for (index, path) in files.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            emit(json!({"type": "log", "level": "warning", "message": "扫描已停止"}));
            emit(json!({"type": "state", "state": "idle"}));
            return Ok(());
        }
        emit_scan_progress("scan", index + 1, index + 1, path);
    }

    let duplicate_groups = duplicate_groups(&files);
    let worker_count = processing_worker_count(files.len(), &config);
    emit(json!({
        "type": "log",
        "level": "info",
        "message": format!("并行扫描线程：{worker_count}")
    }));
    let (scan_sender, scan_receiver) = sync_channel(worker_count.saturating_mul(2).max(1));
    let scan_state = state.clone();
    let scan_config = config.clone();
    let scan_duplicate_groups = duplicate_groups.clone();
    let scan_files = files.clone();
    let scan_total = scan_files.len();
    let scanner = thread::spawn(move || -> Result<()> {
        let pool = ThreadPoolBuilder::new().num_threads(worker_count).build()?;
        pool.install(|| {
            scan_files.into_par_iter().enumerate().try_for_each_with(
                scan_sender,
                |sender, (index, path)| -> Result<()> {
                    scan_state.wait_if_paused();
                    if scan_state.should_stop() {
                        return Ok(());
                    }
                    let mut file =
                        scan_file_row(&path, index + 1, &scan_config, &scan_duplicate_groups);
                    file.id = file_id_for_path(&path, index + 1);
                    sender
                        .send((index, path, file))
                        .map_err(|_| anyhow!("扫描结果接收端已关闭"))?;
                    Ok(())
                },
            )
        })
    });

    let mut rows = Vec::new();
    for (index, path, file) in scan_receiver {
        emit_scan_progress("rename", rows.len() + 1, scan_total, &path);
        emit(
            json!({"type": "scan-row", "index": index + 1, "total": scan_total, "file": file.clone()}),
        );
        rows.push(file);
    }
    let scanner_result = scanner
        .join()
        .map_err(|_| anyhow!("并行扫描线程异常退出"))?;
    scanner_result?;
    if state.should_stop() {
        emit(json!({"type": "log", "level": "warning", "message": "重命名检查已停止"}));
        emit(json!({"type": "state", "state": "idle"}));
        return Ok(());
    }

    rows.sort_by_key(|row| {
        (
            row.standard_name.to_lowercase(),
            row.original_name.to_lowercase(),
        )
    });
    for (index, row) in rows.iter_mut().enumerate() {
        row.id = file_id_for_path(Path::new(&row.path), index + 1);
    }

    if let Some(output_dir) = output_dir {
        write_scan_manifests(&output_dir, &rows)?;
        emit(
            json!({"type": "log", "level": "success", "message": format!("已生成输出结构和初版清单：{}", output_dir.display())}),
        );
    }
    emit(json!({"type": "scan-result", "files": rows}));
    Ok(())
}

fn emit_scan_progress(phase: &str, current: usize, total: usize, path: &Path) {
    emit(json!({
        "type": "scan-progress",
        "phase": phase,
        "current": current,
        "total": total,
        "path": path.to_string_lossy(),
        "fileName": file_name(path),
    }));
}

fn scan_file_row(
    path: &Path,
    index: usize,
    config: &Config,
    duplicate_groups: &HashSet<String>,
) -> ProcessorFile {
    let size = fs::metadata(path)
        .map(|m| format_file_size(m.len()))
        .unwrap_or_default();
    let standard_name = normalize_source_filename(path, config);
    let mut row = ProcessorFile {
        id: file_id_for_path(path, index),
        path: path.to_string_lossy().to_string(),
        original_name: file_name(path),
        standard_name,
        status: "已确认".to_string(),
        category: "confirmed".to_string(),
        reason: String::new(),
        sheet_count: None,
        size,
        sheet_name: None,
        header_row: None,
        column_hints: None,
    };

    match scan_workbook_preview(path, config) {
        Ok(preview) => {
            row.sheet_count = Some(preview.sheet_count);
            row.sheet_name = preview.sheet_name;
            row.header_row = preview.header_row;
            row.column_hints = preview.column_hints;
            if let Some(reason) = preview.reason {
                row.status = "待确认".to_string();
                row.category = "pending".to_string();
                row.reason = reason;
            }
        }
        Err(error) => {
            row.status = "失败".to_string();
            row.category = "error".to_string();
            row.reason = error.to_string();
        }
    }

    if duplicate_groups.contains(&duplicate_group_key(path)) {
        row.status = "待确认".to_string();
        row.category = "pending".to_string();
        row.reason = "同名文件存在括号数字版本，需人工确认".to_string();
    } else if requires_manual_confirmation(path, config) {
        row.status = "待确认".to_string();
        row.category = "pending".to_string();
        row.reason = "特殊支付汇总表，需人工确认是否处理".to_string();
    }
    row
}

struct Preview {
    sheet_count: usize,
    reason: Option<String>,
    sheet_name: Option<String>,
    header_row: Option<usize>,
    column_hints: Option<BTreeMap<String, Option<usize>>>,
}

fn scan_workbook_preview(path: &Path, config: &Config) -> Result<Preview> {
    let quick_scan_limit = configured_quick_scan_bytes(config);
    let file_size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let max_scan_rows = (config.sheet_rules.header_scan_rows + config.sheet_rules.data_sample_rows)
        .min(SCAN_PREVIEW_ROW_LIMIT);
    let max_scan_columns = config
        .sheet_rules
        .sample_column_scan_limit
        .min(SCAN_PREVIEW_COLUMN_LIMIT);
    let profile_scan = env::var("TABLE_HANDLE_LINE_PROFILE_SCAN").is_ok();
    let preview_started = Instant::now();
    if file_size > quick_scan_limit {
        let sheet_count = workbook_sheet_count_limited(path, quick_scan_limit).unwrap_or(0);
        return Ok(Preview {
            sheet_count,
            reason: None,
            sheet_name: None,
            header_row: None,
            column_hints: None,
        });
    }
    let preview_result = read_xlsx_preview_fast(
        path,
        None,
        Some(max_scan_rows),
        Some(max_scan_columns),
        quick_scan_limit,
        configured_shared_strings_bytes(config),
        false,
        None,
    );
    let (sheet_count, workbook) = match preview_result {
        Ok(value) => {
            if profile_scan {
                eprintln!(
                    "scan-preview\tfast-xlsx\t{:.3}\t{}",
                    preview_started.elapsed().as_secs_f64(),
                    path.display()
                );
            }
            value
        }
        Err(error) => {
            if is_resource_limit_error(&error) {
                let sheet_count = workbook_sheet_count_limited(path, quick_scan_limit).unwrap_or(0);
                return Ok(Preview {
                    sheet_count,
                    reason: Some(error.to_string()),
                    sheet_name: None,
                    header_row: None,
                    column_hints: None,
                });
            }
            if profile_scan {
                eprintln!(
                    "scan-preview\tfast-xlsx-fallback\t{:.3}\t{}\t{}",
                    preview_started.elapsed().as_secs_f64(),
                    path.display(),
                    error
                );
            }
            read_workbook_limited(path, None, Some(max_scan_rows), Some(max_scan_columns))?
        }
    };
    let (reason, sheet_name, header_row) = header_confirmation(&workbook, config);
    let column_hints = if let (Some(sheet_name), Some(header_row)) = (&sheet_name, header_row) {
        workbook
            .sheets
            .iter()
            .find(|sheet| &sheet.name == sheet_name)
            .map(|sheet| resolve_columns(sheet, header_row, config))
    } else {
        None
    };
    Ok(Preview {
        sheet_count,
        reason,
        sheet_name,
        header_row,
        column_hints,
    })
}

pub(crate) fn run_processing(command: &Value, state: &RuntimeState) -> Result<()> {
    let output_dir = command_path(command, "outputDir")?;
    let config = load_config(&config_path(command))?;
    let confirmed_files = parse_processor_files(command.get("confirmedFiles")).unwrap_or_default();
    let pending_files = parse_processor_files(command.get("pendingFiles")).unwrap_or_default();
    let error_files = parse_processor_files(command.get("errorFiles")).unwrap_or_default();
    let archive_standard_files = command
        .get("archiveStandardFiles")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let paths = if let Some(values) = command.get("files").and_then(Value::as_array) {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .filter(|path| is_supported_excel_file(path))
            .collect::<Vec<_>>()
    } else {
        discover_excel_files(&command_path(command, "inputDir")?, Some(&output_dir))?
    };

    if paths.is_empty() {
        return Err(anyhow!("没有可处理的 Excel 文件"));
    }

    ensure_output_structure(&output_dir)?;
    let total_files = paths.len();
    emit(json!({"type": "state", "state": "running", "total": total_files}));

    let mut output_files = Vec::new();
    let mut failures = Vec::new();
    let mut processing_error_rows = Vec::new();
    let mut copied_paths = HashMap::new();
    let mut summary_writers: BTreeMap<String, SummaryWriter> = BTreeMap::new();
    let mut summary_index_rows: BTreeMap<String, SummaryIndexRow> = BTreeMap::new();
    let confirmed_by_key = confirmed_files
        .iter()
        .map(|file| (canonical_path_key(Path::new(&file.path)), file.clone()))
        .collect::<HashMap<_, _>>();
    let processing_tasks = paths
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, path)| ProcessingTask {
            index,
            path_key: canonical_path_key(&path),
            path,
        })
        .collect::<Vec<_>>();
    let formal_rows = if confirmed_files.is_empty() {
        paths
            .iter()
            .enumerate()
            .map(|(index, path)| scan_file_row(path, index + 1, &config, &HashSet::new()))
            .collect::<Vec<_>>()
    } else {
        confirmed_files
    };
    let mut status_by_key = HashMap::new();
    let mut remark_by_key = HashMap::new();

    let worker_count = processing_worker_count(total_files, &config);
    emit(json!({
        "type": "log",
        "level": "info",
        "message": format!("并行处理线程：{worker_count}")
    }));
    let (result_sender, result_receiver) =
        sync_channel(processing_result_channel_capacity(worker_count));
    let producer_state = state.clone();
    let producer_config = config.clone();
    let producer_output_dir = output_dir.clone();
    let producer_confirmed_by_key = confirmed_by_key.clone();
    let producer_tasks = processing_tasks.clone();
    let producer = thread::spawn(move || -> Result<()> {
        let pool = ThreadPoolBuilder::new().num_threads(worker_count).build()?;
        pool.install(|| {
            producer_tasks.into_par_iter().try_for_each_with(
                result_sender,
                |sender, task| -> Result<()> {
                    producer_state.wait_if_paused();
                    if producer_state.should_stop() {
                        return Ok(());
                    }
                    let result = process_file_task(
                        task,
                        total_files,
                        &producer_config,
                        &producer_output_dir,
                        &producer_confirmed_by_key,
                        archive_standard_files,
                    );
                    sender
                        .send(result)
                        .map_err(|_| anyhow!("处理结果接收端已关闭"))?;
                    Ok(())
                },
            )
        })
    });
    let mut consumer_error = None;
    for result in result_receiver {
        if let Err(error) = apply_processing_result(
            result,
            total_files,
            &config,
            &output_dir,
            &mut output_files,
            &mut failures,
            &mut processing_error_rows,
            &mut copied_paths,
            &mut summary_writers,
            &mut summary_index_rows,
            &mut status_by_key,
            &mut remark_by_key,
        ) {
            state.request_stop();
            consumer_error = Some(error);
            break;
        }
    }
    let producer_result = producer
        .join()
        .map_err(|_| anyhow!("并行处理线程异常退出"))?;
    if let Some(error) = consumer_error {
        return Err(error);
    }
    producer_result?;

    if state.should_stop() {
        for task in &processing_tasks {
            status_by_key
                .entry(task.path_key.clone())
                .or_insert_with(|| "已停止".to_string());
        }
    }

    let summary_started = Instant::now();
    emit(json!({"type": "log", "level": "info", "message": "开始写入汇总文件"}));
    for writer in summary_writers.values_mut() {
        writer.flush(true)?;
    }
    let index_rows = summary_index_rows.into_values().collect::<Vec<_>>();
    write_summary_index(&output_dir, &index_rows)?;
    emit(json!({
        "type": "log",
        "level": "success",
        "message": format!(
            "汇总写入完成：{} 个分组，耗时 {:.2}s",
            summary_writers.len(),
            summary_started.elapsed().as_secs_f64()
        )
    }));
    let manifest_started = Instant::now();
    emit(json!({"type": "log", "level": "info", "message": "开始写入处理清单"}));
    write_processing_manifests(
        &output_dir,
        &formal_rows,
        &pending_files,
        &combined_error_files(&error_files, &processing_error_rows),
        &copied_paths,
        &status_by_key,
        &remark_by_key,
    )?;
    emit(json!({
        "type": "log",
        "level": "success",
        "message": format!("处理清单写入完成：耗时 {:.2}s", manifest_started.elapsed().as_secs_f64())
    }));
    let summary_path = output_dir.join(SUMMARY_DIR);
    emit(json!({
        "type": "done",
        "stopped": state.should_stop(),
        "summaryPath": summary_path.to_string_lossy(),
        "outputFiles": output_files,
        "failures": failures,
    }));
    Ok(())
}

pub(crate) fn run_merge_summaries(command: &Value, _state: &RuntimeState) -> Result<()> {
    let output_dir = command_path(command, "outputDir")?;
    let started = Instant::now();
    emit(json!({"type": "log", "level": "info", "message": "开始合并汇总文件"}));
    let merged = merge_summary_workbooks(&output_dir)?;
    emit(json!({
        "type": "merge-done",
        "outputPath": merged.path.to_string_lossy(),
        "mergedFiles": merged.file_count,
        "mergedRows": merged.row_count,
    }));
    emit(json!({
        "type": "log",
        "level": "success",
        "message": format!(
            "汇总合并完成：{} 个文件，{} 行，耗时 {:.2}s，{}",
            merged.file_count,
            merged.row_count,
            started.elapsed().as_secs_f64(),
            merged.path.to_string_lossy()
        )
    }));
    Ok(())
}

fn processing_worker_count(total_files: usize, config: &Config) -> usize {
    let available = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4);
    processing_worker_count_for_available(
        total_files,
        available,
        config.performance.processing_workers,
    )
}

fn processing_worker_count_for_available(
    total_files: usize,
    available_workers: usize,
    configured_workers: usize,
) -> usize {
    let available_workers = available_workers.max(1);
    let automatic_workers = available_workers
        .saturating_sub((available_workers / 4).max(1))
        .max(1);
    let requested_workers = if configured_workers == 0 {
        automatic_workers
    } else {
        configured_workers
    };
    total_files
        .max(1)
        .min(requested_workers)
        .min(available_workers)
}

fn processing_result_channel_capacity(worker_count: usize) -> usize {
    worker_count.min(8).saturating_mul(2).max(1)
}

fn process_file_task(
    task: ProcessingTask,
    total: usize,
    config: &Config,
    output_dir: &Path,
    confirmed_by_key: &HashMap<String, ProcessorFile>,
    archive_standard_files: bool,
) -> ProcessingResult {
    let file_started = Instant::now();
    emit_file_stage("extracting", task.index + 1, total, &task.path, json!({}));
    let outcome = match extract_records(&task.path, config, confirmed_by_key.get(&task.path_key)) {
        Ok(mut result) => {
            let standard_name = confirmed_by_key
                .get(&task.path_key)
                .map(|file| file.standard_name.clone())
                .unwrap_or_else(|| normalize_source_filename(&task.path, config));
            let file_date = file_date_from_standard_name(&standard_name);
            let file_customer = group_name_from_standard_name(&standard_name);
            for record in &mut result.records {
                record.values.insert(
                    "file_date".to_string(),
                    CellValue::string(file_date.clone()),
                );
                record.values.insert(
                    "file_customer".to_string(),
                    CellValue::string(file_customer.clone()),
                );
            }
            let record_count = result.records.len();
            let mut copy_ms = None;
            let mut copied_path = None;
            if archive_standard_files {
                let copy_started = Instant::now();
                match copy_standard_file(&task.path, output_dir, &standard_name) {
                    Ok(path) => {
                        copy_ms = Some(copy_started.elapsed().as_millis());
                        copied_path = Some(path);
                    }
                    Err(error) => {
                        return ProcessingResult {
                            index: task.index,
                            path_key: task.path_key,
                            path: task.path,
                            outcome: ProcessingOutcome::Failure {
                                message: error.to_string(),
                                elapsed_ms: file_started.elapsed().as_millis(),
                            },
                        };
                    }
                }
            }
            ProcessingOutcome::Success(Box::new(ProcessingSuccess {
                result,
                standard_name,
                record_count,
                copied_path,
                copy_ms,
                elapsed_ms: file_started.elapsed().as_millis(),
            }))
        }
        Err(error) => ProcessingOutcome::Failure {
            message: error.to_string(),
            elapsed_ms: file_started.elapsed().as_millis(),
        },
    };
    ProcessingResult {
        index: task.index,
        path_key: task.path_key,
        path: task.path,
        outcome,
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_processing_result(
    processing_result: ProcessingResult,
    total: usize,
    config: &Config,
    output_dir: &Path,
    output_files: &mut Vec<String>,
    failures: &mut Vec<String>,
    processing_error_rows: &mut Vec<ProcessorFile>,
    copied_paths: &mut HashMap<String, PathBuf>,
    summary_writers: &mut BTreeMap<String, SummaryWriter>,
    summary_index_rows: &mut BTreeMap<String, SummaryIndexRow>,
    status_by_key: &mut HashMap<String, String>,
    remark_by_key: &mut HashMap<String, String>,
) -> Result<()> {
    let current = processing_result.index + 1;
    let path_key = processing_result.path_key;
    let path = processing_result.path;
    match processing_result.outcome {
        ProcessingOutcome::Success(success) => {
            emit_file_stage(
                "extracted",
                current,
                total,
                &path,
                json!({
                    "records": success.record_count,
                    "sheet": success.result.sheet_name,
                    "rows": success.result.row_count,
                    "open_ms": success.result.timings.open_ms,
                    "identify_ms": success.result.timings.identify_ms,
                    "columns_ms": success.result.timings.columns_ms,
                    "extract_ms": success.result.timings.extract_ms,
                    "elapsed_ms": success.result.timings.total_ms,
                }),
            );
            if let Some(copied_path) = success.copied_path.as_ref() {
                emit_file_stage(
                    "copied",
                    current,
                    total,
                    &path,
                    json!({
                        "copied_path": copied_path.to_string_lossy(),
                        "copy_ms": success.copy_ms,
                        "elapsed_ms": success.copy_ms,
                    }),
                );
                copied_paths.insert(path_key.clone(), copied_path.clone());
                output_files.push(copied_path.to_string_lossy().to_string());
            }
            status_by_key.insert(path_key, "完成".to_string());
            let group = group_name_from_standard_name(&success.standard_name);
            if !summary_writers.contains_key(&group) {
                let writer = SummaryWriter::new(output_dir, &group, config)?;
                summary_index_rows.insert(
                    group.clone(),
                    SummaryIndexRow {
                        group: group.clone(),
                        path: writer.path().to_path_buf(),
                        file_count: 0,
                        row_count: 0,
                        status: "完成".to_string(),
                    },
                );
                summary_writers.insert(group.clone(), writer);
            }
            let writer = summary_writers
                .get_mut(&group)
                .expect("summary writer must exist after insertion");
            let buffered_rows = writer.buffer_records(&success.result.records, config);
            let flushed_rows = writer.flush(false)?;
            if let Some(index_row) = summary_index_rows.get_mut(&group) {
                index_row.file_count += 1;
                index_row.row_count += buffered_rows;
            }
            emit_file_stage(
                "writing",
                current,
                total,
                &path,
                json!({
                    "group": group,
                    "sheet": success.result.sheet_name,
                    "buffered_rows": buffered_rows,
                    "flushed_rows": flushed_rows,
                }),
            );
            emit_file_stage(
                "completed",
                current,
                total,
                &path,
                json!({
                    "records": success.record_count,
                    "open_ms": success.result.timings.open_ms,
                    "identify_ms": success.result.timings.identify_ms,
                    "columns_ms": success.result.timings.columns_ms,
                    "extract_ms": success.result.timings.extract_ms,
                    "copy_ms": success.copy_ms,
                    "elapsed_ms": success.elapsed_ms,
                }),
            );
        }
        ProcessingOutcome::Failure {
            message,
            elapsed_ms,
        } => {
            failures.push(format!("{}: {message}", path.display()));
            status_by_key.insert(path_key.clone(), "失败".to_string());
            remark_by_key.insert(path_key, message.clone());
            processing_error_rows.push(processing_error_file(&path, &message));
            emit_file_stage(
                "failed",
                current,
                total,
                &path,
                json!({
                    "error": message,
                    "elapsed_ms": elapsed_ms,
                }),
            );
        }
    }
    Ok(())
}

fn combined_error_files(
    error_files: &[ProcessorFile],
    processing_error_rows: &[ProcessorFile],
) -> Vec<ProcessorFile> {
    error_files
        .iter()
        .chain(processing_error_rows.iter())
        .cloned()
        .collect()
}

fn processing_error_file(path: &Path, message: &str) -> ProcessorFile {
    ProcessorFile {
        id: file_id_for_path(path, 1),
        path: path.to_string_lossy().to_string(),
        original_name: file_name(path),
        standard_name: normalize_source_filename(path, &Config::default()),
        status: "失败".to_string(),
        category: "error".to_string(),
        reason: message.to_string(),
        sheet_count: None,
        size: fs::metadata(path)
            .map(|metadata| format_file_size(metadata.len()))
            .unwrap_or_default(),
        sheet_name: None,
        header_row: None,
        column_hints: None,
    }
}

fn parse_processor_files(value: Option<&Value>) -> Result<Vec<ProcessorFile>> {
    match value {
        Some(value) => Ok(serde_json::from_value(value.clone())?),
        None => Ok(Vec::new()),
    }
}

fn emit_file_stage(stage: &str, current: usize, total: usize, path: &Path, payload: Value) {
    let mut event = json!({
        "type": "file-stage",
        "stage": stage,
        "current": current,
        "total": total,
        "path": path.to_string_lossy(),
        "fileName": file_name(path),
    });
    if let (Some(event_map), Some(payload_map)) = (event.as_object_mut(), payload.as_object()) {
        for (key, value) in payload_map {
            event_map.insert(key.clone(), value.clone());
        }
    }
    emit(event);
}

fn file_date_from_standard_name(standard_name: &str) -> String {
    standard_name
        .split("__")
        .nth(1)
        .unwrap_or("无日期")
        .trim()
        .to_string()
}

#[cfg(test)]
include!("../../../test/backend/processor/excel_engine.test.rs");
