use super::*;

pub(crate) fn run_price_check_analyze(command: &Value, state: &RuntimeState) -> Result<()> {
    let files = command_files(command)?;
    let config = load_config(&config_path(command))?;
    let header_templates = command_header_templates(command);
    let mut analyses = Vec::new();

    for (index, path) in files.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            emit(
                json!({"type": "price-done", "mode": "analysis", "stopped": true, "files": analyses}),
            );
            return Ok(());
        }
        emit(json!({
            "type": "price-progress",
            "phase": "analyze",
            "current": index + 1,
            "total": files.len(),
            "path": path,
        }));
        match analyze_path_with_templates(path, &config, &header_templates) {
            Ok(analysis) => {
                let requires_confirmation = analysis.requires_confirmation;
                emit(json!({"type": "price-analysis", "file": analysis.clone()}));
                if requires_confirmation {
                    emit(json!({"type": "price-mapping-required", "file": analysis.clone()}));
                }
                analyses.push(analysis);
            }
            Err(error) => {
                let analysis = PriceAnalysisFile {
                    input_path: path.display().to_string(),
                    file_name: path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string(),
                    issues: vec![format!("读取失败: {error:#}")],
                    requires_confirmation: true,
                    automation_decision: AutomationDecision {
                        status: "error".to_string(),
                        reasons: vec![format!("读取失败: {error:#}")],
                        ..AutomationDecision::default()
                    },
                    ..PriceAnalysisFile::default()
                };
                emit(json!({"type": "price-analysis", "file": analysis}));
                analyses.push(analysis);
            }
        }
    }
    emit(json!({"type": "price-done", "mode": "analysis", "stopped": false, "files": analyses}));
    Ok(())
}

pub(crate) fn run_price_check(command: &Value, state: &RuntimeState) -> Result<()> {
    let files = command_files(command)?;
    let config = load_config(&config_path(command))?;
    let output_dir = command
        .get("outputDir")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let overwrite_source_files = command
        .get("overwriteSourceFiles")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mappings = command_mappings(command)?;
    let header_templates = command_header_templates(command);
    let mut file_results = Vec::new();
    let mut failures = Vec::new();

    for (index, path) in files.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            emit(
                json!({"type": "price-done", "mode": "run", "stopped": true, "files": file_results, "failures": failures}),
            );
            return Ok(());
        }
        emit(json!({
            "type": "price-progress",
            "phase": "run",
            "current": index + 1,
            "total": files.len(),
            "path": path,
        }));
        let run_mapping = mappings
            .get(&path.display().to_string())
            .cloned()
            .or_else(|| {
                analyze_path_with_templates(path, &config, &header_templates)
                    .ok()
                    .and_then(|item| item.suggested_mapping)
                    .map(|mapping| PriceRunMapping {
                        mapping,
                        writeback_rows: Vec::new(),
                        cell_edits: Vec::new(),
                    })
            });
        let Some(run_mapping) = run_mapping else {
            let message = "没有可以执行的字段映射".to_string();
            failures.push(json!({"path": path, "message": message}));
            emit(
                json!({"type": "price-file-result", "path": path, "status": "failed", "message": message}),
            );
            continue;
        };

        let output_options = PriceOutputOptions {
            directory: &output_dir,
            overwrite_source_files,
        };
        match process_price_file(
            path,
            output_options,
            &run_mapping.mapping,
            &run_mapping.writeback_rows,
            &run_mapping.cell_edits,
            &config,
            state,
        ) {
            Ok(report) => {
                let output_path = report.output_path.clone();
                let status = if report.anomaly_summary.affected_rows > 0 {
                    "awaiting_confirmation"
                } else {
                    "completed"
                };
                emit(json!({
                    "type": "price-file-result",
                    "path": path,
                    "status": status,
                    "outputPath": output_path,
                    "totalRows": report.total_rows,
                    "matchedRows": report.matched_rows,
                    "exceptionRows": report.exception_rows,
                    "coverage": report.coverage,
                    "anomalySummary": report.anomaly_summary,
                }));
                file_results.push(json!({
                    "path": path,
                    "status": status,
                    "outputPath": report.output_path,
                    "totalRows": report.total_rows,
                    "matchedRows": report.matched_rows,
                    "exceptionRows": report.exception_rows,
                    "coverage": report.coverage,
                    "anomalySummary": report.anomaly_summary,
                }));
            }
            Err(error) => {
                let message = format!("{error:#}");
                failures.push(json!({"path": path, "message": message}));
                emit(
                    json!({"type": "price-file-result", "path": path, "status": "failed", "message": message}),
                );
            }
        }
    }
    emit(
        json!({"type": "price-done", "mode": "run", "stopped": false, "files": file_results, "failures": failures}),
    );
    Ok(())
}

pub(crate) fn run_price_check_validate(command: &Value, _state: &RuntimeState) -> Result<()> {
    let input_path = command
        .get("inputPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("缺少 inputPath 参数"))?;
    let request_version = command
        .get("requestVersion")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let mapping: PriceCheckMapping = serde_json::from_value(
        command
            .get("mapping")
            .cloned()
            .ok_or_else(|| anyhow!("缺少 mapping 参数"))?,
    )
    .map_err(|error| anyhow!("字段映射格式错误: {error}"))?;
    let cell_edits: Vec<PriceCellEdit> = command
        .get("cellEdits")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| anyhow!("单元格编辑格式错误: {error}"))?
        .unwrap_or_default();
    let writeback_rows: Vec<PricePreviewWritebackRow> = command
        .get("writebackRows")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| anyhow!("核价写回策略格式错误: {error}"))?
        .unwrap_or_default();
    let config = load_config(&config_path(command))?;
    if let Some(row_edit) = command.get("rowEdit") {
        let row_edit: PriceRowEdit = serde_json::from_value(row_edit.clone())
            .map_err(|error| anyhow!("单行核价参数格式错误: {error}"))?;
        let result = recalculate_price_row(
            Path::new(input_path),
            &mapping,
            &cell_edits,
            &config,
            &row_edit,
        );
        match result {
            Ok(recalculation) => emit(json!({
                "type": "price-row-validation",
                "inputPath": input_path,
                "requestVersion": request_version,
                "sourceRow": row_edit.source_row,
                "row": recalculation.row,
                "error": recalculation.error,
            })),
            Err(error) => emit(json!({
                "type": "price-row-validation",
                "inputPath": input_path,
                "requestVersion": request_version,
                "sourceRow": row_edit.source_row,
                "row": null,
                "error": format!("{error:#}"),
            })),
        }
        return Ok(());
    }
    let result = validate_price_mapping_with_overrides(
        Path::new(input_path),
        &mapping,
        &cell_edits,
        &writeback_rows,
        &config,
    );
    match result {
        Ok(validation) => emit(json!({
            "type": "price-validation",
            "inputPath": input_path,
            "requestVersion": request_version,
            "evaluatedRows": validation.evaluated_rows,
            "matchedRows": validation.matched_rows,
            "coverage": validation.coverage,
            "matchedOrderRows": validation.matched_order_rows,
            "writebackRows": validation.writeback_rows,
            "unmatchedRows": validation.unmatched_rows,
            "singleShipmentMatching": validation.single_shipment_matching,
            "fieldDiagnostics": validation.field_diagnostics,
            "errors": [],
            "warnings": validation.warnings,
        })),
        Err(failure) => emit(json!({
            "type": "price-validation",
            "inputPath": input_path,
            "requestVersion": request_version,
            "evaluatedRows": 0,
            "matchedRows": 0,
            "coverage": 0.0,
            "matchedOrderRows": [],
            "writebackRows": [],
            "unmatchedRows": [],
            "singleShipmentMatching": null,
            "fieldDiagnostics": failure.field_diagnostics,
            "errors": failure.errors,
            "warnings": [],
        })),
    }
    Ok(())
}

fn command_files(command: &Value) -> Result<Vec<PathBuf>> {
    let values = command
        .get("files")
        .or_else(|| command.get("inputFiles"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("缺少 files 参数"))?;
    let files = values
        .iter()
        .filter_map(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Err(anyhow!("至少需要一个 Excel 文件"));
    }
    Ok(files)
}

fn command_mappings(command: &Value) -> Result<HashMap<String, PriceRunMapping>> {
    let Some(values) = command.get("mappings") else {
        return Ok(HashMap::new());
    };
    let values = values
        .as_array()
        .ok_or_else(|| anyhow!("mappings 必须是数组"))?;
    let mut result = HashMap::new();
    for item in values {
        let path = item
            .get("inputPath")
            .or_else(|| item.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("映射缺少 inputPath"))?;
        let mapping_value = item.get("mapping").unwrap_or(item);
        let mapping: PriceCheckMapping = serde_json::from_value(mapping_value.clone())
            .map_err(|error| anyhow!("字段映射格式错误: {error}"))?;
        let writeback_rows = item
            .get("writebackRows")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| anyhow!("核价写回编辑格式错误: {error}"))?
            .unwrap_or_default();
        let cell_edits = item
            .get("cellEdits")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| anyhow!("单元格编辑格式错误: {error}"))?
            .unwrap_or_default();
        result.insert(
            path.to_string(),
            PriceRunMapping {
                mapping,
                writeback_rows,
                cell_edits,
            },
        );
    }
    Ok(result)
}

fn command_header_templates(command: &Value) -> Vec<HeaderTemplateRecord> {
    command
        .get("headerTemplates")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}
