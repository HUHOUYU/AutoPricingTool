use crate::config::{
    Config, CountryIdentity, FieldRule, PricingRules, SingleShipmentMatchField, load_config,
};
use crate::country_catalog::COUNTRY_ALIASES;
use crate::excel_engine::{CellValue, SheetData, WorkbookData};
use crate::ipc::{config_path, emit};
use crate::reader::read_workbook_for_processing;
use crate::state::RuntimeState;
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

mod sku;

use sku::{calculate_related_quantity, normalize_sku, parse_sku_expression};

const ORDER_HEADER_SCAN_ROWS: usize = 30;
const PRICE_HEADER_SCAN_ROWS: usize = 24;
const PRICE_TIER_LOOKAHEAD_ROWS: usize = 2;
const QUANTITY_ONE_PRICE_QUANTITY: i64 = 1;
const HEADER_EXACT_SCORE: i32 = 300;
const HEADER_CONTAINS_SCORE: i32 = 160;
const HEADER_ALIAS_ORDER_STEP: i32 = 1;
const VALUE_PATTERN_MAX_SCORE: i32 = 500;
const NEGATIVE_PATTERN_MAX_PENALTY: i32 = 500;
const NEGATIVE_HEADER_PENALTY: i32 = 450;
const LOW_PRIORITY_HEADER_PENALTY: i32 = 220;

const ORDER_ID_ALIASES: &[&str] = &[
    "订单号",
    "订单编号",
    "业务订单号",
    "订单id",
    "orderid",
    "orderno",
    "order",
    "name",
    "订单",
    "平台订单号",
    "平台单号",
    "子订单号",
    "子订单",
    "subordernumber",
    "platformorder",
];
const COUNTRY_CODE_ALIASES: &[&str] = &[
    "国家二字码",
    "国家代码",
    "国家简码",
    "countrycode",
    "country code",
    "iso",
];
const COUNTRY_EN_ALIASES: &[&str] = &[
    "英文国家名",
    "英文国家",
    "国家英文",
    "收货人国家",
    "countryname",
    "country name",
    "country",
    "countryregion",
    "shippingcountry",
    "配送国家",
];
const COUNTRY_CN_ALIASES: &[&str] = &["中文国家名", "中文国家", "国家中文", "目的国家", "收货国家"];
const PRICING_COUNTRY_ALIASES: &[&str] = &[
    "国家",
    "country",
    "countrycode",
    "country code",
    "国家代码",
    "国家二字码",
    "国家简码",
    "配送国家",
];
const SKU_ALIASES: &[&str] = &[
    "sku",
    "itemno",
    "itemnumber",
    "productsku",
    "商品sku",
    "货号",
    "产品sku",
    "产品编码",
    "商品编码",
];
const PRODUCT_NAME_ALIASES: &[&str] = &["productname", "产品名称", "商品名称", "产品名", "商品名"];
const QTY_ALIASES: &[&str] = &[
    "数量",
    "qty",
    "quantity",
    "商品数量",
    "产品总数",
    "商品总数",
    "总数",
    "件数",
    "购买数量",
    "数量合计",
];
const PRICE_ALIASES: &[&str] = &[
    "价格",
    "price",
    "售价",
    "原价",
    "核价",
    "cost",
    "单价",
    "销售价",
];
const QUANTITY_ONE_PRICE_ALIASES: &[&str] = &["productshippingvattax", "shippingvattax"];
const ORDER_TAX_ALIASES: &[&str] = &["EU TAX"];
const PRICE_DIFFERENCE_ZERO_EPSILON: f64 = 1e-9;
const SINGLE_SHIPMENT_FIELD_ALIASES: &[&str] =
    &["name", "收件人", "收货人", "收件人姓名", "收货人姓名"];
const SINGLE_SHIPMENT_PHONE_ALIASES: &[&str] = &[
    "phone",
    "phone number",
    "telephone",
    "mobile",
    "电话",
    "联系电话",
    "手机",
    "手机号码",
    "收件人电话",
];
const SINGLE_SHIPMENT_POSTAL_CODE_ALIASES: &[&str] = &[
    "zip code",
    "zipcode",
    "postal code",
    "postcode",
    "code",
    "邮编",
    "邮政编码",
];
const SINGLE_SHIPMENT_ADDRESS_ALIASES: &[&str] = &[
    "address",
    "address1",
    "address2",
    "street",
    "street address",
    "地址",
    "地址1",
    "地址2",
    "详细地址",
];
const SINGLE_SHIPMENT_EMAIL_ALIASES: &[&str] = &["email", "buyeremail", "收件人邮箱", "邮箱"];

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkuQtyPair {
    pub(crate) sku_column: usize,
    pub(crate) qty_column: usize,
    pub(crate) merged_qty_column: usize,
    #[serde(default)]
    pub(crate) direct_quantity: bool,
    pub(crate) sku_header: String,
    pub(crate) qty_header: String,
    pub(crate) merged_qty_header: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrderSheetCandidate {
    pub(crate) sheet_name: String,
    pub(crate) header_row: usize,
    pub(crate) score: f64,
    pub(crate) business_order_number_column: Option<usize>,
    pub(crate) country_code_column: Option<usize>,
    pub(crate) country_english_column: Option<usize>,
    pub(crate) country_chinese_column: Option<usize>,
    pub(crate) sku_qty_pairs: Vec<SkuQtyPair>,
    pub(crate) single_shipment_column: Option<usize>,
    pub(crate) single_shipment_fields: Vec<SingleShipmentMatchFieldStatus>,
    pub(crate) price_column: Option<usize>,
    pub(crate) valid_order_rows: usize,
    pub(crate) country_coverage: f64,
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceTierColumn {
    pub(crate) quantity: i64,
    pub(crate) column: usize,
    pub(crate) header: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricingSheetCandidate {
    pub(crate) sheet_name: String,
    pub(crate) header_row: usize,
    pub(crate) quantity_header_row: Option<usize>,
    pub(crate) sku_column: Option<usize>,
    pub(crate) country_column: Option<usize>,
    pub(crate) tier_columns: Vec<PriceTierColumn>,
    pub(crate) valid_price_rows: usize,
    pub(crate) usable_price_cells: usize,
    pub(crate) score: f64,
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCheckMapping {
    pub(crate) order_sheet: String,
    pub(crate) order_header_row: usize,
    pub(crate) business_order_number_column: Option<usize>,
    pub(crate) country_code_column: Option<usize>,
    pub(crate) country_english_column: Option<usize>,
    pub(crate) country_chinese_column: Option<usize>,
    pub(crate) sku_qty_pairs: Vec<SkuQtyPair>,
    pub(crate) single_shipment_column: Option<usize>,
    #[serde(default)]
    pub(crate) single_shipment_fields: Vec<SingleShipmentMatchFieldStatus>,
    pub(crate) order_price_column: Option<usize>,
    pub(crate) pricing_sheet: String,
    pub(crate) pricing_header_row: usize,
    pub(crate) pricing_quantity_header_row: Option<usize>,
    pub(crate) pricing_sku_column: usize,
    pub(crate) pricing_country_column: usize,
    pub(crate) quantity_tier_columns: Vec<PriceTierColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SingleShipmentMatchingStatus {
    pub(crate) enabled: bool,
    pub(crate) ready: bool,
    pub(crate) fields: Vec<SingleShipmentMatchFieldStatus>,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SingleShipmentMatchFieldStatus {
    pub(crate) field: SingleShipmentMatchField,
    pub(crate) columns: Vec<usize>,
    pub(crate) headers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HeaderTemplateFieldMapping {
    field_key: String,
    sheet_name: String,
    column: usize,
    header: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HeaderTemplateRecord {
    file_name: String,
    mappings: Vec<HeaderTemplateFieldMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceAnalysisFile {
    pub(crate) input_path: String,
    pub(crate) file_name: String,
    pub(crate) order_sheet_candidates: Vec<OrderSheetCandidate>,
    pub(crate) pricing_sheet_candidates: Vec<PricingSheetCandidate>,
    pub(crate) suggested_mapping: Option<PriceCheckMapping>,
    pub(crate) coverage: f64,
    pub(crate) matched_order_rows: Vec<usize>,
    pub(crate) writeback_rows: Vec<PricePreviewWritebackRow>,
    pub(crate) unmatched_rows: Vec<UnmatchedPriceIssue>,
    pub(crate) single_shipment_matching: SingleShipmentMatchingStatus,
    pub(crate) requires_confirmation: bool,
    pub(crate) automation_decision: AutomationDecision,
    pub(crate) issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationDecision {
    pub(crate) status: String,
    pub(crate) reasons: Vec<String>,
    pub(crate) evaluated_rows: usize,
    pub(crate) matched_rows: usize,
    pub(crate) coverage: f64,
    pub(crate) runner_up_coverage: Option<f64>,
    pub(crate) candidate_score: Option<f64>,
    pub(crate) runner_up_score: Option<f64>,
    pub(crate) score_kind: Option<String>,
    pub(crate) score_gap: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCheckException {
    pub(crate) file_path: String,
    pub(crate) sheet_name: String,
    pub(crate) source_row: Option<usize>,
    pub(crate) kind: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCheckRow {
    pub(crate) business_order_number: String,
    pub(crate) country_code: String,
    pub(crate) country_english_name: String,
    pub(crate) country_chinese_name: String,
    pub(crate) original_sku: String,
    pub(crate) matched_sku: String,
    pub(crate) total_quantity: f64,
    pub(crate) original_price: Option<f64>,
    pub(crate) pricing_price: Option<f64>,
    pub(crate) price_difference: Option<f64>,
    pub(crate) status: String,
    pub(crate) exception_reason: String,
    pub(crate) order_source_sheet: String,
    pub(crate) pricing_source_sheet: String,
    pub(crate) source_rows: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCheckReport {
    pub(crate) input_path: String,
    pub(crate) output_path: String,
    pub(crate) mapping: PriceCheckMapping,
    pub(crate) rows: Vec<PriceCheckRow>,
    pub(crate) exceptions: Vec<PriceCheckException>,
    pub(crate) total_rows: usize,
    pub(crate) matched_rows: usize,
    pub(crate) exception_rows: usize,
    pub(crate) coverage: f64,
}

#[derive(Debug, Clone)]
struct CountryInfo {
    code: String,
    english: String,
    chinese: String,
    routes: Vec<String>,
    conflict: bool,
    reason: String,
}

#[derive(Debug, Clone)]
struct OrderLine {
    business_order_number: String,
    country: CountryInfo,
    single_shipment: bool,
    original_sku: String,
    matched_sku: String,
    quantity: f64,
    original_price: Option<f64>,
    source_sheet: String,
    source_row: usize,
    sku_pair_priority: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourceAssignment {
    pub(crate) source_row: usize,
    pub(crate) sku_pair_priority: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AggregatedOrderSku {
    pub(crate) business_order_number: String,
    pub(crate) country_code: String,
    pub(crate) country_english_name: String,
    pub(crate) country_chinese_name: String,
    pub(crate) country_routes: Vec<String>,
    pub(crate) single_shipment: bool,
    pub(crate) original_sku: String,
    pub(crate) matched_sku: String,
    pub(crate) total_quantity: f64,
    pub(crate) original_price: Option<f64>,
    pub(crate) source_sheet: String,
    pub(crate) source_rows: Vec<usize>,
    pub(crate) source_assignments: Vec<SourceAssignment>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PriceWritebackRow {
    pub(crate) source_row: usize,
    pub(crate) sku_pair_priority: Option<usize>,
    pub(crate) matched: bool,
    pub(crate) pricing_price: Option<f64>,
    pub(crate) price_difference: Option<f64>,
    pub(crate) quantity: Option<usize>,
    pub(crate) quantity_error: Option<String>,
    pub(crate) quantity_mismatch: bool,
}

#[derive(Debug, Clone)]
struct PriceEntry {
    price: Option<f64>,
    raw_price: String,
    sheet_name: String,
}

#[derive(Debug, Clone, Default)]
struct PriceIndex {
    entries: HashMap<String, Vec<PriceEntry>>,
    quantity_keys: HashSet<String>,
    country_routes: HashSet<String>,
    source_sheet: String,
    single_shipment: Option<Box<PriceIndex>>,
}

#[derive(Debug, Clone)]
struct Lookup {
    status: &'static str,
    price: Option<f64>,
    matched_sku: String,
    source_sheet: String,
    reason: String,
}

#[derive(Debug)]
struct MappingValidationResult {
    evaluated_rows: usize,
    matched_rows: usize,
    coverage: f64,
    matched_order_rows: Vec<usize>,
    writeback_rows: Vec<PricePreviewWritebackRow>,
    unmatched_rows: Vec<UnmatchedPriceIssue>,
    single_shipment_matching: SingleShipmentMatchingStatus,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnmatchedPriceIssue {
    source_row: usize,
    sku_column: usize,
    sku: String,
    country: String,
    quantity: f64,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricePreviewWritebackRow {
    source_row: usize,
    pricing_price: Option<f64>,
    price_difference: Option<f64>,
    quantity: Option<usize>,
    quantity_error: Option<String>,
    quantity_issue_context: Option<SkuQuantityIssueContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkuQuantityIssueContext {
    previous_sku_column: usize,
    previous_sku: String,
    main_sku_column: usize,
    main_sku: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PriceRowEdit {
    source_row: usize,
    quantity: Option<usize>,
}

#[derive(Debug)]
struct PriceRowRecalculation {
    row: PricePreviewWritebackRow,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCellEdit {
    pub(crate) sheet_name: String,
    pub(crate) row: usize,
    pub(crate) column: usize,
    pub(crate) value: String,
    pub(crate) numeric: bool,
}

#[derive(Debug, Clone)]
struct PriceRunMapping {
    mapping: PriceCheckMapping,
    writeback_rows: Vec<PricePreviewWritebackRow>,
    cell_edits: Vec<PriceCellEdit>,
}

#[derive(Debug, Clone)]
struct MappingCandidateEvaluation {
    coverage: f64,
    sheet_score: f64,
    field_score: f64,
    total: usize,
    matched: usize,
    mapping: PriceCheckMapping,
    matched_rows: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateAmbiguity {
    Sheet,
    Column,
}

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
                emit(json!({
                    "type": "price-file-result",
                    "path": path,
                    "status": "completed",
                    "outputPath": output_path,
                    "totalRows": report.total_rows,
                    "matchedRows": report.matched_rows,
                    "exceptionRows": report.exception_rows,
                    "coverage": report.coverage,
                }));
                file_results.push(json!({
                    "path": path,
                    "outputPath": report.output_path,
                    "totalRows": report.total_rows,
                    "matchedRows": report.matched_rows,
                    "exceptionRows": report.exception_rows,
                    "coverage": report.coverage,
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
    let result = validate_price_mapping(Path::new(input_path), &mapping, &cell_edits, &config);
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
            "errors": [],
            "warnings": validation.warnings,
        })),
        Err(errors) => emit(json!({
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
            "errors": errors,
            "warnings": [],
        })),
    }
    Ok(())
}

fn recalculate_price_row(
    path: &Path,
    mapping: &PriceCheckMapping,
    cell_edits: &[PriceCellEdit],
    config: &Config,
    row_edit: &PriceRowEdit,
) -> Result<PriceRowRecalculation> {
    if row_edit.source_row == 0 {
        return Err(anyhow!("源数据行必须大于 0"));
    }
    if mapping.order_sheet == mapping.pricing_sheet {
        return Err(anyhow!("订单 Sheet 与核价 Sheet 不能相同"));
    }
    if !mapping_is_complete(mapping) {
        return Err(anyhow!(
            "订单号、国家、数量/SKU/合并数量或核价档位等必需字段不完整"
        ));
    }
    let mut workbook = read_workbook_for_processing(path, config)?;
    apply_cell_edits(&mut workbook, cell_edits)?;
    let order_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.order_sheet)
        .ok_or_else(|| anyhow!("找不到订单 Sheet: {}", mapping.order_sheet))?;
    let pricing_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.pricing_sheet)
        .ok_or_else(|| anyhow!("找不到核价 Sheet: {}", mapping.pricing_sheet))?;
    let row = order_sheet
        .rows
        .get(row_edit.source_row.saturating_sub(1))
        .ok_or_else(|| anyhow!("第 {} 行超出订单 Sheet 范围", row_edit.source_row))?;
    let mut resolved_quantities = resolve_order_quantities(order_sheet, mapping, config);
    let target_index = resolved_quantities
        .iter()
        .position(|resolved| resolved.source_row == row_edit.source_row)
        .ok_or_else(|| {
            anyhow!(
                "第 {} 行没有有效订单号或不属于订单数据行",
                row_edit.source_row
            )
        })?;
    {
        let target = &mut resolved_quantities[target_index];
        target.quantity = row_edit.quantity;
        target.quantity_error = None;
        target.quantity_issue_context = None;
        target.absorbed = false;
    }
    let target = &resolved_quantities[target_index];
    let base_row = PricePreviewWritebackRow {
        source_row: row_edit.source_row,
        pricing_price: None,
        price_difference: None,
        quantity: row_edit.quantity,
        quantity_error: None,
        quantity_issue_context: None,
    };
    let Some(quantity) = row_edit.quantity else {
        return Ok(PriceRowRecalculation {
            row: PricePreviewWritebackRow {
                quantity_error: Some("数量为空，无法重新核价".to_string()),
                ..base_row
            },
            error: Some("数量为空，无法重新核价".to_string()),
        });
    };
    if target.matched_sku.is_empty() {
        return Ok(PriceRowRecalculation {
            row: base_row,
            error: Some("主要 SKU 为空，无法重新核价".to_string()),
        });
    }

    let country = normalize_order_country_fields(
        &cell_text(row, mapping.country_code_column),
        &cell_text(row, mapping.country_english_column),
        &cell_text(row, mapping.country_chinese_column),
        &config.pricing,
    );
    if country.conflict {
        return Ok(PriceRowRecalculation {
            row: base_row,
            error: Some(country.reason),
        });
    }
    let single_shipment =
        single_shipment_orders(order_sheet, mapping, config, &resolved_quantities)
            .contains(&target.business_order_number);
    let lookup = build_price_index(pricing_sheet, mapping, &config.pricing)
        .lookup_routes_with_single_shipment_preference(
            &country.routes,
            &target.matched_sku,
            quantity as i64,
            single_shipment,
        );
    let Some(base_price) = lookup.price.filter(|_| lookup.status == "matched") else {
        return Ok(PriceRowRecalculation {
            row: base_row,
            error: Some(lookup.reason),
        });
    };
    let pricing_price =
        base_price + order_tax_amount(row, order_tax_column_index(order_sheet, mapping));
    let original_price = mapping
        .order_price_column
        .and_then(|column| row.get(column.saturating_sub(1)))
        .and_then(parse_price);
    Ok(PriceRowRecalculation {
        row: PricePreviewWritebackRow {
            pricing_price: Some(pricing_price),
            price_difference: original_price
                .map(|original| normalize_price_difference(pricing_price - original)),
            ..base_row
        },
        error: None,
    })
}

fn validate_price_mapping(
    path: &Path,
    mapping: &PriceCheckMapping,
    cell_edits: &[PriceCellEdit],
    config: &Config,
) -> std::result::Result<MappingValidationResult, Vec<String>> {
    let mut workbook = read_workbook_for_processing(path, config)
        .map_err(|error| vec![format!("读取文件失败: {error:#}")])?;
    let data_edits = cell_edits
        .iter()
        .filter(|edit| {
            !((edit.sheet_name == mapping.order_sheet && edit.row == mapping.order_header_row)
                || (edit.sheet_name == mapping.pricing_sheet
                    && (edit.row == mapping.pricing_header_row
                        || Some(edit.row) == mapping.pricing_quantity_header_row)))
        })
        .cloned()
        .collect::<Vec<_>>();
    apply_cell_edits(&mut workbook, &data_edits)
        .map_err(|error| vec![format!("应用单元格编辑失败: {error:#}")])?;
    let mut errors = Vec::new();
    if mapping.order_sheet == mapping.pricing_sheet {
        errors.push("订单 Sheet 与核价 Sheet 不能相同".to_string());
    }
    let order_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.order_sheet);
    let pricing_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.pricing_sheet);
    if order_sheet.is_none() {
        errors.push("订单 Sheet 不存在".to_string());
    }
    if pricing_sheet.is_none() {
        errors.push("核价 Sheet 不存在".to_string());
    }
    let (Some(order_sheet), Some(pricing_sheet)) = (order_sheet, pricing_sheet) else {
        return Err(errors);
    };
    let single_shipment_matching = single_shipment_matching_status(order_sheet, mapping, config);
    if !mapping_is_complete(mapping) {
        errors.push("订单号、国家、数量/SKU/合并数量或核价档位等必需字段不完整".to_string());
    }
    if mapping.order_header_row == 0 || mapping.order_header_row > order_sheet.rows.len() {
        errors.push("订单表头行超出有效范围".to_string());
    }
    if mapping.pricing_header_row == 0 || mapping.pricing_header_row > pricing_sheet.rows.len() {
        errors.push("核价表头行超出有效范围".to_string());
    }
    if mapping
        .pricing_quantity_header_row
        .is_some_and(|row| row == 0 || row > pricing_sheet.rows.len())
    {
        errors.push("数量档位表头行超出有效范围".to_string());
    }
    let order_columns = order_sheet
        .rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default();
    let pricing_columns = pricing_sheet
        .rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default();
    let mut order_mapped_columns = [
        mapping.business_order_number_column,
        mapping.order_price_column,
    ]
    .into_iter()
    .flatten()
    .chain(mapping.sku_qty_pairs.iter().flat_map(|pair| {
        if pair.direct_quantity {
            vec![pair.qty_column, pair.sku_column]
        } else {
            vec![pair.qty_column, pair.sku_column, pair.merged_qty_column]
        }
    }))
    .collect::<Vec<_>>();
    if mapping.single_shipment_fields.is_empty() {
        order_mapped_columns.extend(mapping.single_shipment_column);
    } else {
        order_mapped_columns.extend(
            mapping
                .single_shipment_fields
                .iter()
                .flat_map(|field| field.columns.iter().copied()),
        );
    }
    for (identity, column) in [
        (CountryIdentity::Iso2, mapping.country_code_column),
        (CountryIdentity::English, mapping.country_english_column),
        (CountryIdentity::Chinese, mapping.country_chinese_column),
    ] {
        if config.pricing.uses_country_identity(identity)
            && let Some(column) = column
        {
            order_mapped_columns.push(column);
        }
    }
    if order_mapped_columns
        .iter()
        .any(|column| *column == 0 || *column > order_columns)
    {
        errors.push("订单字段列超出有效范围".to_string());
    }
    if mapping.pricing_sku_column == 0
        || mapping.pricing_country_column == 0
        || mapping.pricing_sku_column > pricing_columns
        || mapping.pricing_country_column > pricing_columns
        || mapping
            .quantity_tier_columns
            .iter()
            .any(|tier| tier.column == 0 || tier.column > pricing_columns || tier.quantity < 0)
    {
        errors.push("核价字段列或数量档位超出有效范围".to_string());
    }
    if mapping.sku_qty_pairs.iter().any(|pair| {
        pair.sku_column == pair.qty_column
            || (!pair.direct_quantity
                && (pair.sku_column == pair.merged_qty_column
                    || pair.qty_column == pair.merged_qty_column))
    }) {
        errors.push("原始数量、SKU 与合并数量列不能相同".to_string());
    }
    // 单组模式只要求 SKU 与数量列有效；多组模式继续要求原始数量 → SKU → 合并数量。
    if mapping.sku_qty_pairs.iter().any(|pair| {
        pair.qty_column == 0
            || pair.sku_column == 0
            || pair.merged_qty_column == 0
            || !(pair.direct_quantity
                || pair.qty_column < pair.sku_column && pair.sku_column < pair.merged_qty_column)
    }) {
        errors.push(
            "单 SKU 组必须映射 SKU 与数量列；多 SKU 组必须按“原始数量、SKU、合并数量”从左到右排列（可不连续）"
                .to_string(),
        );
    }
    let recognized_quantity_columns = configured_matching_columns(
        order_sheet,
        mapping.order_header_row.saturating_sub(1),
        order_field_rule(config, "quantity"),
        QTY_ALIASES,
    );
    // 识别到的数量别名列，或空表头列（允许人工把空表头列当数量列）均可
    let is_acceptable_quantity_column = |column_1based: usize| -> bool {
        let index = column_1based.saturating_sub(1);
        if recognized_quantity_columns.contains(&index) {
            return true;
        }
        // sheet_cell_text 参数为 1-based 行列
        sheet_cell_text(order_sheet, mapping.order_header_row, column_1based)
            .trim()
            .is_empty()
    };
    if mapping.sku_qty_pairs.iter().any(|pair| {
        !is_acceptable_quantity_column(pair.qty_column)
            || (!pair.direct_quantity && !is_acceptable_quantity_column(pair.merged_qty_column))
    }) {
        errors.push("原始数量列与合并数量列必须为有效数量列或空表头列".to_string());
    }
    let mut order_unique_columns = HashSet::new();
    if order_mapped_columns
        .iter()
        .any(|column| !order_unique_columns.insert(*column))
    {
        errors.push("订单字段映射中存在重复列".to_string());
    }
    let mut pricing_unique_columns =
        HashSet::from([mapping.pricing_sku_column, mapping.pricing_country_column]);
    let mut tier_quantities = HashSet::new();
    if mapping.quantity_tier_columns.iter().any(|tier| {
        !pricing_unique_columns.insert(tier.column) || !tier_quantities.insert(tier.quantity)
    }) {
        errors.push("数量档位中存在重复列或重复数量".to_string());
    }
    if !errors.is_empty() {
        errors.sort();
        errors.dedup();
        return Err(errors);
    }

    let index = build_price_index(pricing_sheet, mapping, &config.pricing);
    let (lines, quantity_exceptions, resolved_quantities) =
        read_order_lines(order_sheet, mapping, config);
    let evaluated_rows = lines.len();
    let (matched_rows, matched_order_rows) = evaluate_matches(&index, &lines);
    let unmatched_rows = unmatched_price_issues(&index, mapping, &lines);
    let writeback_rows = calculate_preview_writeback_rows(
        order_sheet,
        mapping,
        &index,
        &lines,
        &resolved_quantities,
    );
    let coverage = ratio(matched_rows, evaluated_rows);
    let mut warnings = Vec::new();
    let quantity_exception_count = quantity_exceptions
        .iter()
        .filter(|exception| matches!(exception.kind.as_str(), "数量无效" | "SKU关系无法计算"))
        .count();
    if quantity_exception_count > 0 {
        warnings.push(format!(
            "{} 行数量无法计算，需要确认",
            quantity_exception_count
        ));
    }
    if evaluated_rows == 0 {
        warnings.push("没有可用于试算的订单行".to_string());
    } else if evaluated_rows < config.automation.min_trial_rows && coverage < 1.0 {
        warnings.push(format!(
            "试算少于 {} 行时覆盖率必须达到 100%",
            config.automation.min_trial_rows
        ));
    } else if coverage < config.automation.coverage_threshold {
        warnings.push(format!(
            "试算覆盖率低于 {:.1}%",
            config.automation.coverage_threshold * 100.0
        ));
    }
    Ok(MappingValidationResult {
        evaluated_rows,
        matched_rows,
        coverage,
        matched_order_rows,
        writeback_rows,
        unmatched_rows,
        single_shipment_matching,
        warnings,
    })
}

fn unmatched_price_issues(
    index: &PriceIndex,
    mapping: &PriceCheckMapping,
    lines: &[OrderLine],
) -> Vec<UnmatchedPriceIssue> {
    lines
        .iter()
        .filter_map(|line| {
            let lookup = index.lookup_routes_with_single_shipment_preference(
                &line.country.routes,
                &line.matched_sku,
                line.quantity.round() as i64,
                line.single_shipment,
            );
            (lookup.status != "matched").then(|| UnmatchedPriceIssue {
                source_row: line.source_row,
                sku_column: mapping
                    .sku_qty_pairs
                    .get(line.sku_pair_priority)
                    .map(|pair| pair.sku_column)
                    .unwrap_or_default(),
                sku: line.matched_sku.clone(),
                country: line.country.routes.join(" / "),
                quantity: line.quantity,
                reason: format!("{}：{}", lookup.status, lookup.reason),
            })
        })
        .collect()
}

fn evaluate_matches(index: &PriceIndex, lines: &[OrderLine]) -> (usize, Vec<usize>) {
    let mut matched_rows = 0;
    let mut order_row_matches = HashMap::new();
    for line in lines {
        let lookup = index.lookup_routes_with_single_shipment_preference(
            &line.country.routes,
            &line.matched_sku,
            line.quantity.round() as i64,
            line.single_shipment,
        );
        let matched = lookup.status == "matched";
        order_row_matches
            .entry(line.source_row)
            .and_modify(|all_matched| *all_matched &= matched)
            .or_insert(matched);
        if matched {
            matched_rows += 1;
        }
    }
    let mut matched_order_rows = order_row_matches
        .into_iter()
        .filter_map(|(source_row, all_matched)| all_matched.then_some(source_row))
        .collect::<Vec<_>>();
    matched_order_rows.sort_unstable();
    (matched_rows, matched_order_rows)
}

fn calculate_preview_writeback_rows(
    order_sheet: &SheetData,
    mapping: &PriceCheckMapping,
    index: &PriceIndex,
    lines: &[OrderLine],
    resolved_quantities: &[ResolvedOrderQuantity],
) -> Vec<PricePreviewWritebackRow> {
    let quantity_issue_contexts = resolved_quantities
        .iter()
        .filter_map(|resolved| {
            resolved
                .quantity_issue_context
                .clone()
                .map(|context| (resolved.source_row, context))
        })
        .collect::<HashMap<_, _>>();
    let mut matched_candidates = HashMap::new();
    for item in aggregate_lines(lines) {
        let lookup = index.lookup_routes_with_single_shipment_preference(
            &item.country_routes,
            &item.matched_sku,
            item.total_quantity.round() as i64,
            item.single_shipment,
        );
        if lookup.status == "matched"
            && let Some(pricing_price) = lookup.price
        {
            record_matched_candidates(&mut matched_candidates, &item, pricing_price);
        }
    }
    build_writeback_rows(
        order_sheet,
        mapping,
        &matched_candidates,
        resolved_quantities,
    )
    .into_iter()
    .map(|row| PricePreviewWritebackRow {
        source_row: row.source_row,
        pricing_price: row.pricing_price,
        price_difference: row.price_difference,
        quantity: row.quantity,
        quantity_error: row.quantity_error,
        quantity_issue_context: quantity_issue_contexts.get(&row.source_row).cloned(),
    })
    .collect()
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

fn analyze_path_with_templates(
    path: &Path,
    config: &Config,
    header_templates: &[HeaderTemplateRecord],
) -> Result<PriceAnalysisFile> {
    let workbook = read_workbook_for_processing(path, config)?;
    let mut order_candidates = Vec::new();
    let mut pricing_candidates = Vec::new();
    for sheet in &workbook.sheets {
        if let Some(candidate) = infer_order_candidate_with_config(sheet, config) {
            order_candidates.push(candidate);
        }
        if let Some(candidate) = infer_pricing_candidate_with_config(sheet, config) {
            pricing_candidates.push(candidate);
        }
    }
    order_candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
    pricing_candidates.sort_by(|left, right| right.score.total_cmp(&left.score));

    let mut issues = Vec::new();
    if order_candidates.is_empty() {
        issues.push("未识别到包含订单号、SKU和数量的订单 Sheet".to_string());
    }
    if pricing_candidates.is_empty() {
        issues.push("未识别到包含 SKU、国家和数量档位的核价 Sheet".to_string());
    }

    let mut suggested_mapping = None;
    let mut coverage = 0.0;
    let mut evaluated_rows = 0;
    let mut matched_rows = 0;
    let mut matched_order_rows = Vec::new();
    let mut runner_up_coverage = None;
    let mut candidate_score = None;
    let mut runner_up_score = None;
    let mut automation_score_kind = None;
    let mut score_gap = None;
    let mut ambiguity_reason = None;
    let template_match = config
        .automation
        .template_match_priority
        .then(|| {
            match_header_template(
                &workbook.sheets,
                &order_candidates,
                &pricing_candidates,
                header_templates,
            )
        })
        .flatten();
    if let Some((template_name, mapping)) = template_match {
        if let (Some(order_sheet), Some(pricing_sheet)) = (
            workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.order_sheet),
            workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.pricing_sheet),
        ) {
            let index = build_price_index(pricing_sheet, &mapping, &config.pricing);
            let lines = read_order_lines(order_sheet, &mapping, config).0;
            evaluated_rows = lines.len();
            let evaluated = evaluate_matches(&index, &lines);
            matched_rows = evaluated.0;
            matched_order_rows = evaluated.1;
            coverage = ratio(matched_rows, evaluated_rows);
            suggested_mapping = Some(mapping);
            emit(json!({
                "type": "log",
                "level": "success",
                "message": format!("模板优先匹配成功：{template_name}"),
            }));
        }
    } else if !order_candidates.is_empty() && !pricing_candidates.is_empty() {
        let mut combinations = Vec::new();
        for order in order_candidates.iter().take(6) {
            for pricing in pricing_candidates.iter().take(6) {
                for mapping in mapping_variants(order, pricing) {
                    let order_sheet = workbook
                        .sheets
                        .iter()
                        .find(|sheet| sheet.name == mapping.order_sheet);
                    let pricing_sheet = workbook
                        .sheets
                        .iter()
                        .find(|sheet| sheet.name == mapping.pricing_sheet);
                    if let (Some(order_sheet), Some(pricing_sheet)) = (order_sheet, pricing_sheet) {
                        let index = build_price_index(pricing_sheet, &mapping, &config.pricing);
                        let lines = read_order_lines(order_sheet, &mapping, config).0;
                        let total = lines.len();
                        let (matched, matched_rows) = evaluate_matches(&index, &lines);
                        let pair_coverage = ratio(matched, total);
                        combinations.push(MappingCandidateEvaluation {
                            coverage: pair_coverage,
                            sheet_score: order.score + pricing.score,
                            field_score: sku_qty_field_score(order_sheet, &mapping, config),
                            total,
                            matched,
                            mapping,
                            matched_rows,
                        });
                    }
                }
            }
        }
        combinations.sort_by(|left, right| {
            right
                .coverage
                .total_cmp(&left.coverage)
                .then_with(|| right.sheet_score.total_cmp(&left.sheet_score))
                .then_with(|| right.field_score.total_cmp(&left.field_score))
                .then_with(|| right.total.cmp(&left.total))
                .then_with(|| {
                    left.mapping
                        .sku_qty_pairs
                        .len()
                        .cmp(&right.mapping.sku_qty_pairs.len())
                })
        });
        if combinations
            .iter()
            .any(|item| item.mapping.order_sheet != item.mapping.pricing_sheet)
        {
            combinations.retain(|item| item.mapping.order_sheet != item.mapping.pricing_sheet);
        }
        if let Some(best) = combinations.first().cloned() {
            coverage = best.coverage;
            evaluated_rows = best.total;
            matched_rows = best.matched;
            matched_order_rows = best.matched_rows.clone();
            if let Some(runner_up) = combinations
                .iter()
                .skip(1)
                .find(|candidate| !mapping_is_nested_variant(&best.mapping, &candidate.mapping))
            {
                runner_up_coverage = Some(runner_up.coverage);
                let same_sheet_pair = best.mapping.order_sheet == runner_up.mapping.order_sheet
                    && best.mapping.pricing_sheet == runner_up.mapping.pricing_sheet;
                let best_comparison_score = if same_sheet_pair {
                    best.field_score
                } else {
                    best.sheet_score
                };
                let runner_up_comparison_score = if same_sheet_pair {
                    runner_up.field_score
                } else {
                    runner_up.sheet_score
                };
                let comparison_score_kind = if same_sheet_pair { "field" } else { "sheet" };
                score_gap = Some((best_comparison_score - runner_up_comparison_score).max(0.0));
                if let Some(kind) = classify_candidate_ambiguity(
                    &best.mapping,
                    &runner_up.mapping,
                    best.coverage - runner_up.coverage,
                    best_comparison_score - runner_up_comparison_score,
                    config,
                ) {
                    candidate_score = Some(best_comparison_score);
                    runner_up_score = Some(runner_up_comparison_score);
                    automation_score_kind = Some(comparison_score_kind.to_string());
                    ambiguity_reason = Some(candidate_ambiguity_reason(
                        kind,
                        &best.mapping,
                        &runner_up.mapping,
                    ));
                }
            }
            suggested_mapping = Some(best.mapping);
            if let Some(reason) = ambiguity_reason.as_ref() {
                issues.push(format!("{reason}，需要确认"));
            }
        }
    }

    let mut automation_decision = decide_automation(
        config,
        suggested_mapping.as_ref(),
        !order_candidates.is_empty(),
        !pricing_candidates.is_empty(),
        evaluated_rows,
        matched_rows,
        coverage,
        runner_up_coverage,
        score_gap,
        ambiguity_reason.as_deref(),
    );
    automation_decision.candidate_score = candidate_score;
    automation_decision.runner_up_score = runner_up_score;
    automation_decision.score_kind = automation_score_kind;
    if let Some(mapping) = suggested_mapping.as_ref()
        && let Some(order_sheet) = workbook
            .sheets
            .iter()
            .find(|sheet| sheet.name == mapping.order_sheet)
    {
        let quantity_exception_count = read_order_lines(order_sheet, mapping, config)
            .1
            .iter()
            .filter(|exception| matches!(exception.kind.as_str(), "数量无效" | "SKU关系无法计算"))
            .count();
        if quantity_exception_count > 0 {
            let reason = format!("{quantity_exception_count} 行数量无法计算，需要确认");
            if !automation_decision.reasons.contains(&reason) {
                automation_decision.reasons.push(reason.clone());
            }
            if automation_decision.status == "eligible" {
                automation_decision.status = "confirm".to_string();
            }
            issues.push(reason);
        }
    }
    let requires_confirmation = automation_decision.status != "eligible";
    if suggested_mapping
        .as_ref()
        .is_some_and(|mapping| mapping.order_sheet == mapping.pricing_sheet)
    {
        issues.push("订单 Sheet 与核价 Sheet 被识别为同一页，需要确认".to_string());
    }
    if coverage < config.automation.coverage_threshold && suggested_mapping.is_some() {
        issues.push(format!(
            "当前建议映射的试算覆盖率为 {:.1}%",
            coverage * 100.0
        ));
    }
    let single_shipment_matching = suggested_mapping
        .as_ref()
        .and_then(|mapping| {
            workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.order_sheet)
                .map(|sheet| single_shipment_matching_status(sheet, mapping, config))
        })
        .unwrap_or_else(|| single_shipment_matching_unavailable(config, "尚未确定订单字段映射"));
    let (writeback_rows, unmatched_rows) = suggested_mapping
        .as_ref()
        .and_then(|mapping| {
            let order_sheet = workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.order_sheet)?;
            let pricing_sheet = workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.pricing_sheet)?;
            let index = build_price_index(pricing_sheet, mapping, &config.pricing);
            let (lines, _, resolved_quantities) = read_order_lines(order_sheet, mapping, config);
            Some((
                calculate_preview_writeback_rows(
                    order_sheet,
                    mapping,
                    &index,
                    &lines,
                    &resolved_quantities,
                ),
                unmatched_price_issues(&index, mapping, &lines),
            ))
        })
        .unwrap_or_default();
    Ok(PriceAnalysisFile {
        input_path: path.display().to_string(),
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        order_sheet_candidates: order_candidates,
        pricing_sheet_candidates: pricing_candidates,
        suggested_mapping,
        coverage,
        matched_order_rows,
        writeback_rows,
        unmatched_rows,
        single_shipment_matching,
        requires_confirmation,
        automation_decision,
        issues,
    })
}

fn mapping_is_nested_variant(
    left_mapping: &PriceCheckMapping,
    right_mapping: &PriceCheckMapping,
) -> bool {
    let mut left_base = left_mapping.clone();
    let mut right_base = right_mapping.clone();
    left_base.sku_qty_pairs.clear();
    right_base.sku_qty_pairs.clear();
    if left_base != right_base {
        return false;
    }
    let left_pairs = left_mapping.sku_qty_pairs.iter().collect::<HashSet<_>>();
    let right_pairs = right_mapping.sku_qty_pairs.iter().collect::<HashSet<_>>();
    left_pairs.is_subset(&right_pairs) || right_pairs.is_subset(&left_pairs)
}

#[allow(clippy::too_many_arguments)]
fn decide_automation(
    config: &Config,
    mapping: Option<&PriceCheckMapping>,
    has_order_candidate: bool,
    has_pricing_candidate: bool,
    evaluated_rows: usize,
    matched_rows: usize,
    coverage: f64,
    runner_up_coverage: Option<f64>,
    score_gap: Option<f64>,
    ambiguity_reason: Option<&str>,
) -> AutomationDecision {
    let mut reasons = Vec::new();
    if mapping.is_none() {
        reasons.push("没有生成可用字段映射".to_string());
    } else if !mapping.is_some_and(mapping_is_complete) {
        reasons.push("订单号、国家、数量/SKU/合并数量或核价档位等必需字段不完整".to_string());
    }
    if mapping.is_some_and(|value| value.order_sheet == value.pricing_sheet) {
        reasons.push("订单 Sheet 与核价 Sheet 不能相同".to_string());
    }
    if evaluated_rows == 0 {
        reasons.push("没有可用于试算的订单行".to_string());
    } else if evaluated_rows < config.automation.min_trial_rows && coverage < 1.0 {
        reasons.push(format!(
            "试算少于 {} 行时覆盖率必须达到 100%",
            config.automation.min_trial_rows
        ));
    } else if evaluated_rows >= config.automation.min_trial_rows
        && coverage < config.automation.coverage_threshold
    {
        reasons.push(format!(
            "试算覆盖率低于 {:.1}%",
            config.automation.coverage_threshold * 100.0
        ));
    }
    if let Some(reason) = ambiguity_reason {
        reasons.push(reason.to_string());
    }
    if !config.automation.auto_run {
        reasons.push("配置已关闭自动核价".to_string());
    }
    let status = if mapping.is_none() || !has_order_candidate || !has_pricing_candidate {
        "error"
    } else if reasons.is_empty() {
        "eligible"
    } else {
        "confirm"
    };
    AutomationDecision {
        status: status.to_string(),
        reasons,
        evaluated_rows,
        matched_rows,
        coverage,
        runner_up_coverage,
        candidate_score: None,
        runner_up_score: None,
        score_kind: None,
        score_gap,
    }
}

fn classify_candidate_ambiguity(
    best: &PriceCheckMapping,
    runner_up: &PriceCheckMapping,
    coverage_gap: f64,
    score_gap: f64,
    config: &Config,
) -> Option<CandidateAmbiguity> {
    if coverage_gap >= config.automation.candidate_coverage_gap
        || score_gap >= config.automation.candidate_score_gap
    {
        return None;
    }
    let same_sheet_pair =
        best.order_sheet == runner_up.order_sheet && best.pricing_sheet == runner_up.pricing_sheet;
    Some(if same_sheet_pair {
        CandidateAmbiguity::Column
    } else {
        CandidateAmbiguity::Sheet
    })
}

fn candidate_ambiguity_reason(
    kind: CandidateAmbiguity,
    best: &PriceCheckMapping,
    runner_up: &PriceCheckMapping,
) -> String {
    match kind {
        CandidateAmbiguity::Sheet => format!(
            "订单/核价 Sheet 候选差距不足：最优 [订单 {} / 核价 {}]；次优 [订单 {} / 核价 {}]",
            best.order_sheet, best.pricing_sheet, runner_up.order_sheet, runner_up.pricing_sheet
        ),
        CandidateAmbiguity::Column => format!(
            "同一 Sheet 组合下，字段列候选差距不足：最优 [{}]；次优 [{}]",
            sku_qty_columns_summary(best),
            sku_qty_columns_summary(runner_up)
        ),
    }
}

fn sku_qty_columns_summary(mapping: &PriceCheckMapping) -> String {
    mapping
        .sku_qty_pairs
        .iter()
        .map(|pair| {
            format!(
                "原始数量 {}{} / SKU {}{} / 合并数量 {}{}",
                excel_column_label(pair.qty_column),
                header_suffix(&pair.qty_header),
                excel_column_label(pair.sku_column),
                header_suffix(&pair.sku_header),
                excel_column_label(pair.merged_qty_column),
                header_suffix(&pair.merged_qty_header)
            )
        })
        .collect::<Vec<_>>()
        .join("、")
}

fn header_suffix(header: &str) -> String {
    let header = header.trim();
    if header.is_empty() {
        String::new()
    } else {
        format!("（{header}）")
    }
}

fn excel_column_label(mut column: usize) -> String {
    if column == 0 {
        return "未设置".to_string();
    }
    let mut label = String::new();
    while column > 0 {
        let remainder = (column - 1) % 26;
        label.insert(0, char::from(b'A' + remainder as u8));
        column = (column - 1) / 26;
    }
    label
}

fn mapping_is_complete(mapping: &PriceCheckMapping) -> bool {
    mapping.business_order_number_column.is_some()
        && (mapping.country_code_column.is_some()
            || mapping.country_english_column.is_some()
            || mapping.country_chinese_column.is_some())
        && !mapping.sku_qty_pairs.is_empty()
        && mapping.pricing_sku_column > 0
        && mapping.pricing_country_column > 0
        && !mapping.quantity_tier_columns.is_empty()
}

fn mapping_from_candidates(
    order: &OrderSheetCandidate,
    pricing: &PricingSheetCandidate,
) -> PriceCheckMapping {
    PriceCheckMapping {
        order_sheet: order.sheet_name.clone(),
        order_header_row: order.header_row,
        business_order_number_column: order.business_order_number_column,
        country_code_column: order.country_code_column,
        country_english_column: order.country_english_column,
        country_chinese_column: order.country_chinese_column,
        sku_qty_pairs: order.sku_qty_pairs.clone(),
        single_shipment_column: order.single_shipment_column,
        single_shipment_fields: order.single_shipment_fields.clone(),
        order_price_column: order.price_column,
        pricing_sheet: pricing.sheet_name.clone(),
        pricing_header_row: pricing.header_row,
        pricing_quantity_header_row: pricing.quantity_header_row,
        pricing_sku_column: pricing.sku_column.unwrap_or(1),
        pricing_country_column: pricing.country_column.unwrap_or(1),
        quantity_tier_columns: pricing.tier_columns.clone(),
    }
}

fn mapping_variants(
    order: &OrderSheetCandidate,
    pricing: &PricingSheetCandidate,
) -> Vec<PriceCheckMapping> {
    vec![mapping_from_candidates(order, pricing)]
}

fn sku_qty_pair_score(
    order_sheet: &SheetData,
    data_start: usize,
    pair: &SkuQtyPair,
    config: &Config,
) -> f64 {
    let Some(header) = order_sheet.rows.get(data_start.saturating_sub(1)) else {
        return 0.0;
    };
    let sku_column = pair.sku_column.saturating_sub(1);
    let qty_column = pair.qty_column.saturating_sub(1);
    let sku_header = header
        .get(sku_column)
        .map(CellValue::text)
        .unwrap_or_default();
    let qty_header = header
        .get(qty_column)
        .map(CellValue::text)
        .unwrap_or_default();
    let sku_rule = order_field_rule(config, "sku");
    let product_rule = order_field_rule(config, "product_name");
    let sku_rule_confidence = field_header_confidence(&sku_header, sku_rule, SKU_ALIASES);
    let product_rule_confidence =
        field_header_confidence(&sku_header, product_rule, PRODUCT_NAME_ALIASES);
    let sku_header_confidence = sku_rule_confidence.max(product_rule_confidence);
    let sku_sample_confidence = field_sample_confidence(
        order_sheet,
        data_start,
        sku_column,
        if sku_rule_confidence >= product_rule_confidence {
            sku_rule
        } else {
            product_rule
        },
    );
    let qty_header_confidence = field_header_confidence(
        &qty_header,
        order_field_rule(config, "quantity"),
        QTY_ALIASES,
    );
    let qty_sample_confidence = numeric_column_confidence(order_sheet, data_start, qty_column);
    let distance = pair.sku_column.abs_diff(pair.qty_column);
    let proximity_confidence = (1.0 - distance.saturating_sub(1) as f64 * 0.12).clamp(0.4, 1.0);
    let completeness = pair_completeness(order_sheet, data_start, sku_column, qty_column);
    100.0
        * (sku_header_confidence * 0.40
            + sku_sample_confidence * 0.15
            + qty_header_confidence * 0.20
            + qty_sample_confidence * 0.10
            + proximity_confidence * 0.10
            + completeness * 0.05)
}

fn sku_qty_field_score(
    order_sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> f64 {
    let scores = mapping
        .sku_qty_pairs
        .iter()
        .map(|pair| sku_qty_pair_score(order_sheet, mapping.order_header_row, pair, config))
        .collect::<Vec<_>>();
    if scores.is_empty() {
        0.0
    } else {
        scores.iter().sum::<f64>() / scores.len() as f64
    }
}

fn field_header_confidence(
    header: &str,
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> f64 {
    (configured_header_score(header, rule, fallback_aliases) as f64 / HEADER_EXACT_SCORE as f64)
        .clamp(0.0, 1.0)
}

fn field_sample_confidence(
    sheet: &SheetData,
    data_start: usize,
    column: usize,
    rule: Option<&FieldRule>,
) -> f64 {
    let values = sheet
        .rows
        .iter()
        .skip(data_start)
        .take(ORDER_HEADER_SCAN_ROWS)
        .filter_map(|row| row.get(column).map(CellValue::text))
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return 0.0;
    }
    let Some(rule) = rule else {
        return 1.0;
    };
    let positive = if rule.compiled_value_patterns.is_empty() {
        1.0
    } else {
        ratio(
            values
                .iter()
                .filter(|value| {
                    rule.compiled_value_patterns
                        .iter()
                        .any(|pattern| pattern.is_match(value))
                })
                .count(),
            values.len(),
        )
    };
    let negative = ratio(
        values
            .iter()
            .filter(|value| {
                rule.compiled_negative_patterns
                    .iter()
                    .any(|pattern| pattern.is_match(value))
            })
            .count(),
        values.len(),
    );
    (positive - negative).clamp(0.0, 1.0)
}

fn numeric_column_confidence(sheet: &SheetData, data_start: usize, column: usize) -> f64 {
    let values = sheet
        .rows
        .iter()
        .skip(data_start)
        .take(ORDER_HEADER_SCAN_ROWS)
        .filter_map(|row| row.get(column).map(CellValue::text))
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    ratio(
        values
            .iter()
            .filter(|value| {
                value
                    .trim()
                    .parse::<f64>()
                    .is_ok_and(|number| number >= 0.0)
            })
            .count(),
        values.len(),
    )
}

fn pair_completeness(
    sheet: &SheetData,
    data_start: usize,
    sku_column: usize,
    qty_column: usize,
) -> f64 {
    let rows = sheet
        .rows
        .iter()
        .skip(data_start)
        .take(ORDER_HEADER_SCAN_ROWS)
        .collect::<Vec<_>>();
    ratio(
        rows.iter()
            .filter(|row| {
                !cell_text(row, Some(sku_column + 1)).is_empty()
                    && !cell_text(row, Some(qty_column + 1)).is_empty()
            })
            .count(),
        rows.len(),
    )
}

fn match_header_template(
    sheets: &[SheetData],
    order_candidates: &[OrderSheetCandidate],
    pricing_candidates: &[PricingSheetCandidate],
    templates: &[HeaderTemplateRecord],
) -> Option<(String, PriceCheckMapping)> {
    const ORDER_FIELDS: [&str; 4] = ["order_number", "country_code", "sku_detail", "qty_detail"];
    const PRICING_FIELDS: [&str; 2] = ["pricing_sku", "pricing_country"];

    for template in templates {
        let field = |key: &str| {
            template
                .mappings
                .iter()
                .find(|mapping| mapping.field_key == key)
        };
        let order_fields = ORDER_FIELDS.map(field);
        let pricing_fields = PRICING_FIELDS.map(field);
        let price_fields = template
            .mappings
            .iter()
            .filter(|mapping| mapping.field_key == "price")
            .collect::<Vec<_>>();
        if order_fields.iter().any(Option::is_none)
            || pricing_fields.iter().any(Option::is_none)
            || price_fields.is_empty()
        {
            continue;
        }
        let order_fields = order_fields.map(Option::unwrap);
        let pricing_fields = pricing_fields.map(Option::unwrap);
        if !order_fields
            .iter()
            .all(|mapping| mapping.sheet_name == order_fields[0].sheet_name)
            || !pricing_fields
                .iter()
                .all(|mapping| mapping.sheet_name == pricing_fields[0].sheet_name)
            || !price_fields
                .iter()
                .all(|mapping| mapping.sheet_name == pricing_fields[0].sheet_name)
            || order_fields[0].sheet_name == pricing_fields[0].sheet_name
        {
            continue;
        }

        for order in order_candidates {
            let Some(order_sheet) = sheets.iter().find(|sheet| sheet.name == order.sheet_name)
            else {
                continue;
            };
            if !order_fields
                .iter()
                .all(|mapping| template_header_matches(order_sheet, order.header_row, mapping))
            {
                continue;
            }
            for pricing in pricing_candidates {
                if order.sheet_name == pricing.sheet_name {
                    continue;
                }
                let Some(pricing_sheet) =
                    sheets.iter().find(|sheet| sheet.name == pricing.sheet_name)
                else {
                    continue;
                };
                let pricing_headers_match = pricing_fields.iter().all(|mapping| {
                    template_header_matches(pricing_sheet, pricing.header_row, mapping)
                }) && price_fields.iter().all(|mapping| {
                    template_header_matches(
                        pricing_sheet,
                        pricing.quantity_header_row.unwrap_or(pricing.header_row),
                        mapping,
                    )
                });
                if !pricing_headers_match {
                    continue;
                }

                let mut mapping = mapping_from_candidates(order, pricing);
                mapping.business_order_number_column = Some(order_fields[0].column);
                mapping.country_code_column = Some(order_fields[1].column);
                mapping.country_english_column = None;
                mapping.country_chinese_column = None;
                mapping.sku_qty_pairs = vec![SkuQtyPair {
                    sku_column: order_fields[2].column,
                    qty_column: order_fields[3].column,
                    merged_qty_column: order_fields[3].column,
                    direct_quantity: true,
                    sku_header: order_fields[2].header.clone(),
                    qty_header: order_fields[3].header.clone(),
                    merged_qty_header: order_fields[3].header.clone(),
                }];
                mapping.pricing_sku_column = pricing_fields[0].column;
                mapping.pricing_country_column = pricing_fields[1].column;
                let quantity_row = pricing.quantity_header_row.unwrap_or(pricing.header_row);
                let selected_tiers = price_fields
                    .iter()
                    .map(|price| {
                        let header = sheet_cell_text(pricing_sheet, quantity_row, price.column);
                        parse_tier(&header).map(|quantity| PriceTierColumn {
                            quantity,
                            column: price.column,
                            header,
                        })
                    })
                    .collect::<Option<Vec<_>>>();
                let Some(mut selected_tiers) = selected_tiers else {
                    continue;
                };
                selected_tiers.sort_by_key(|tier| (tier.quantity, tier.column));
                mapping.quantity_tier_columns = selected_tiers;
                return Some((template.file_name.clone(), mapping));
            }
        }
    }
    None
}

fn template_header_matches(
    sheet: &SheetData,
    header_row: usize,
    mapping: &HeaderTemplateFieldMapping,
) -> bool {
    normalize_header(&sheet_cell_text(sheet, header_row, mapping.column))
        == normalize_header(&mapping.header)
}

fn sheet_cell_text(sheet: &SheetData, row: usize, column: usize) -> String {
    if row == 0 || column == 0 {
        return String::new();
    }
    sheet
        .rows
        .get(row - 1)
        .and_then(|cells| cells.get(column - 1))
        .map(CellValue::text)
        .unwrap_or_default()
}

#[cfg(test)]
fn infer_order_candidate(sheet: &SheetData) -> Option<OrderSheetCandidate> {
    infer_order_candidate_with_config(sheet, &Config::default())
}

fn infer_order_candidate_with_config(
    sheet: &SheetData,
    config: &Config,
) -> Option<OrderSheetCandidate> {
    let mut best = None;
    let scan_limit = sheet.rows.len().min(ORDER_HEADER_SCAN_ROWS);
    for header_idx in 0..scan_limit {
        let header = &sheet.rows[header_idx];
        let sku_columns = configured_matching_columns(
            sheet,
            header_idx,
            order_field_rule(config, "sku"),
            SKU_ALIASES,
        );
        let qty_columns = configured_matching_columns(
            sheet,
            header_idx,
            order_field_rule(config, "quantity"),
            QTY_ALIASES,
        );
        let order_col = configured_best_column(
            sheet,
            header_idx,
            order_field_rule(config, "order_number"),
            ORDER_ID_ALIASES,
        );
        let mut raw_pairs = pair_sku_qty_columns(header, &sku_columns, &qty_columns);
        let using_product_name = raw_pairs.is_empty();
        if using_product_name {
            let product_name_columns = configured_matching_columns(
                sheet,
                header_idx,
                order_field_rule(config, "product_name"),
                PRODUCT_NAME_ALIASES,
            );
            raw_pairs = pair_sku_qty_columns(header, &product_name_columns, &qty_columns);
        }
        let mut detected_pairs =
            deduplicate_equivalent_sku_qty_pairs(sheet, header_idx + 1, &raw_pairs, order_col);
        detected_pairs.sort_by_key(|pair| {
            (
                std::cmp::Reverse(pair.sku_column.max(pair.qty_column)),
                std::cmp::Reverse(pair.sku_column),
            )
        });
        let exact_sku_columns =
            configured_exact_header_columns(header, order_field_rule(config, "sku"), SKU_ALIASES);
        let exact_qty_columns = configured_exact_header_columns(
            header,
            order_field_rule(config, "quantity"),
            QTY_ALIASES,
        );
        let direct_single_group = !using_product_name
            && exact_sku_columns.len() == 1
            && exact_qty_columns.len() == 1
            && exact_sku_columns[0] != exact_qty_columns[0];
        let pairs = if direct_single_group {
            let sku_column = exact_sku_columns[0];
            let qty_column = exact_qty_columns[0];
            vec![SkuQtyPair {
                sku_column: sku_column + 1,
                qty_column: qty_column + 1,
                merged_qty_column: qty_column + 1,
                direct_quantity: true,
                sku_header: header[sku_column].text(),
                qty_header: header[qty_column].text(),
                merged_qty_header: header[qty_column].text(),
            }]
        } else {
            highest_sku_quantity_group(header, &detected_pairs, &qty_columns)
        };
        if order_col.is_none() && detected_pairs.is_empty() {
            continue;
        }
        let (country_code, country_en, country_cn) =
            infer_order_country_columns(sheet, header_idx, config);
        let country_en = country_en.filter(|column| Some(*column) != country_code);
        let country_cn = country_cn
            .filter(|column| Some(*column) != country_code && Some(*column) != country_en);
        let single_shipment_fields =
            resolve_single_shipment_fields(sheet, header_idx, config, &[], None);
        let single_shipment = single_shipment_fields
            .iter()
            .find(|matched| matched.field == SingleShipmentMatchField::RecipientName)
            .and_then(|matched| matched.columns.first().copied());
        let price = configured_best_column(
            sheet,
            header_idx,
            order_field_rule(config, "price"),
            PRICE_ALIASES,
        );
        let (valid_rows, country_rows) = score_order_rows(
            sheet,
            header_idx + 1,
            &detected_pairs,
            order_col,
            [country_code, country_en, country_cn],
        );
        if valid_rows == 0
            || order_col.is_none()
            || detected_pairs.is_empty()
            || country_code.is_none() && country_en.is_none() && country_cn.is_none()
        {
            continue;
        }
        let mut notes = Vec::new();
        if raw_pairs.len() > detected_pairs.len() {
            notes.push(format!(
                "忽略 {} 组数据完全重复的数量/SKU/合并数量字段",
                raw_pairs.len() - detected_pairs.len()
            ));
        }
        if detected_pairs.len() > 1 && !direct_single_group {
            notes.push(format!(
                "识别到 {} 组数量/SKU/合并数量字段，仅使用最高优先级 SKU 组",
                detected_pairs.len()
            ));
        }
        if direct_single_group {
            notes.push("识别到单 SKU/数量组，直接使用 SKU 与数量列".to_string());
        }
        if pairs.is_empty() {
            notes.push(
                "最高优先级 SKU 未形成“数量 / SKU / 合并数量”三列组，需要人工确认".to_string(),
            );
        }
        if country_code.is_none() || country_en.is_none() || country_cn.is_none() {
            notes.push("国家三要素未全部识别，运行时会尝试补全并记录冲突".to_string());
        }
        if using_product_name && !pairs.is_empty() {
            notes.push("未识别到 SKU，使用产品名称作为临时匹配键".to_string());
        }
        let field_score = (detected_pairs.len() as f64 * 24.0)
            + if order_col.is_some() { 24.0 } else { 0.0 }
            + if country_code.is_some() { 8.0 } else { 0.0 }
            + if country_en.is_some() { 6.0 } else { 0.0 }
            + if country_cn.is_some() { 6.0 } else { 0.0 }
            + if price.is_some() { 3.0 } else { 0.0 }
            + sheet_name_hint(&sheet.name, &["订单", "order", "orders"]);
        let price_matrix_penalty =
            numeric_header_ladder_level(header, &HashSet::new()) as f64 * 18.0;
        let candidate = OrderSheetCandidate {
            sheet_name: sheet.name.clone(),
            header_row: header_idx + 1,
            score: field_score + valid_rows as f64 * 0.02 + ratio(country_rows, valid_rows) * 20.0
                - price_matrix_penalty,
            business_order_number_column: order_col.map(|column| column + 1),
            country_code_column: country_code.map(|column| column + 1),
            country_english_column: country_en.map(|column| column + 1),
            country_chinese_column: country_cn.map(|column| column + 1),
            sku_qty_pairs: pairs,
            single_shipment_column: single_shipment,
            single_shipment_fields,
            price_column: price.map(|column| column + 1),
            valid_order_rows: valid_rows,
            country_coverage: ratio(country_rows, valid_rows),
            notes,
        };
        if best
            .as_ref()
            .is_none_or(|current: &OrderSheetCandidate| candidate.score > current.score)
        {
            best = Some(candidate);
        }
    }
    best
}

#[cfg(test)]
fn infer_pricing_candidate(sheet: &SheetData) -> Option<PricingSheetCandidate> {
    infer_pricing_candidate_with_config(sheet, &Config::default())
}

fn infer_pricing_candidate_with_config(
    sheet: &SheetData,
    config: &Config,
) -> Option<PricingSheetCandidate> {
    let mut best = None;
    let scan_limit = sheet.rows.len().min(PRICE_HEADER_SCAN_ROWS);
    for header_idx in 0..scan_limit {
        let header = &sheet.rows[header_idx];
        let sku_columns = configured_matching_columns(
            sheet,
            header_idx,
            order_field_rule(config, "sku"),
            SKU_ALIASES,
        );
        let qty_columns = configured_matching_columns(
            sheet,
            header_idx,
            order_field_rule(config, "quantity"),
            QTY_ALIASES,
        );
        let order_like = configured_best_column(
            sheet,
            header_idx,
            order_field_rule(config, "order_number"),
            ORDER_ID_ALIASES,
        )
        .is_some()
            && !pair_sku_qty_columns(header, &sku_columns, &qty_columns).is_empty();
        if order_like {
            continue;
        }
        let sku_column =
            best_pricing_sku_column(sheet, header_idx, pricing_field_rule(config, "sku"));
        let country_column =
            best_pricing_country_column(sheet, header_idx, pricing_field_rule(config, "country"));
        let tier_row = (header_idx..=header_idx.saturating_add(PRICE_TIER_LOOKAHEAD_ROWS))
            .filter(|row_idx| {
                *row_idx < sheet.rows.len()
                    && (*row_idx == header_idx || row_idx.saturating_add(1) < sheet.rows.len())
            })
            .filter_map(|row_idx| {
                let tiers = tier_columns(&sheet.rows[row_idx], sku_column, country_column);
                (!tiers.is_empty()).then_some((row_idx, tiers))
            })
            .max_by_key(|(row_idx, tiers)| (tiers.len(), std::cmp::Reverse(*row_idx)));
        let quantity_one_price_column = best_quantity_one_price_column(
            sheet,
            header_idx,
            quantity_one_price_rule(config),
            [sku_column, country_column]
                .into_iter()
                .flatten()
                .collect::<HashSet<_>>(),
        );
        let (quantity_header_row, tiers, quantity_one_price) =
            if let Some((row_idx, tiers)) = tier_row {
                ((row_idx != header_idx).then_some(row_idx + 1), tiers, false)
            } else if let Some(column) = quantity_one_price_column {
                (
                    None,
                    vec![PriceTierColumn {
                        quantity: QUANTITY_ONE_PRICE_QUANTITY,
                        column: column + 1,
                        header: header[column].text(),
                    }],
                    true,
                )
            } else {
                (None, Vec::new(), false)
            };
        if sku_column.is_none() || country_column.is_none() || tiers.is_empty() {
            continue;
        }
        let sku_column = sku_column.unwrap();
        let country_column = country_column.unwrap();
        let start_row = (header_idx + 1).max(quantity_header_row.unwrap_or(0));
        let (valid_rows, usable_cells) =
            score_price_rows(sheet, start_row, sku_column, country_column, &tiers);
        if valid_rows == 0 {
            continue;
        }
        let excluded = [Some(sku_column), Some(country_column)]
            .into_iter()
            .flatten()
            .collect::<HashSet<_>>();
        let ladder_level = numeric_header_ladder_level(header, &excluded);
        let mut notes = Vec::new();
        if quantity_header_row.is_some() {
            notes.push(if quantity_header_row == Some(header_idx + 2) {
                "使用双行表头识别数量档位".to_string()
            } else {
                "跳过空白行识别数量档位".to_string()
            });
        }
        if quantity_one_price {
            notes.push("使用单列价格作为数量 1 档位".to_string());
        }
        if tiers.iter().any(|tier| tier.quantity == 0) {
            notes.push("数量档位包含 0，按有效档位处理".to_string());
        }
        if ladder_level > 0 {
            notes.push(format!("识别到连续数量档位，连续级别 {}", ladder_level));
        } else if tiers.len() == 1 {
            notes.push("仅识别到一个数量档位，建议确认核价表头".to_string());
        }
        let tier_count = tiers.len();
        let candidate = PricingSheetCandidate {
            sheet_name: sheet.name.clone(),
            header_row: header_idx + 1,
            quantity_header_row,
            sku_column: Some(sku_column + 1),
            country_column: Some(country_column + 1),
            tier_columns: tiers,
            valid_price_rows: valid_rows,
            usable_price_cells: usable_cells,
            score: 35.0
                + sheet_name_hint(&sheet.name, &["核价", "price", "pricing", "cost"])
                + tier_count as f64 * 3.0
                + ladder_level as f64 * 8.0
                + valid_rows as f64 * 0.03
                + usable_cells as f64 * 0.01,
            notes,
        };
        if best
            .as_ref()
            .is_none_or(|current: &PricingSheetCandidate| candidate.score > current.score)
        {
            best = Some(candidate);
        }
    }
    best
}

fn infer_order_country_columns(
    sheet: &SheetData,
    header_idx: usize,
    config: &Config,
) -> (Option<usize>, Option<usize>, Option<usize>) {
    let code_rule = order_field_rule(config, "country_code");
    let english_rule = order_field_rule(config, "country_english");
    let chinese_rule = order_field_rule(config, "country_chinese");
    let mut candidates =
        configured_matching_columns(sheet, header_idx, code_rule, COUNTRY_CODE_ALIASES);
    candidates.extend(configured_matching_columns(
        sheet,
        header_idx,
        english_rule,
        COUNTRY_EN_ALIASES,
    ));
    candidates.extend(configured_matching_columns(
        sheet,
        header_idx,
        chinese_rule,
        COUNTRY_CN_ALIASES,
    ));
    candidates.sort_unstable();
    candidates.dedup();
    let mut code_column =
        configured_best_column(sheet, header_idx, code_rule, COUNTRY_CODE_ALIASES);
    let mut english_column =
        configured_best_column(sheet, header_idx, english_rule, COUNTRY_EN_ALIASES);
    let mut chinese_column =
        configured_best_column(sheet, header_idx, chinese_rule, COUNTRY_CN_ALIASES);

    let mut classified = Vec::new();
    for column in candidates {
        let samples = sheet
            .rows
            .iter()
            .skip(header_idx + 1)
            .take(120)
            .filter_map(|row| row.get(column).map(CellValue::text))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let is_code = samples.iter().any(|value| {
            let token = value.trim();
            token.len() == 2
                && token
                    .chars()
                    .all(|character| character.is_ascii_alphabetic())
                && country_lookup(token).is_some()
        });
        let is_chinese = samples.iter().any(|value| has_chinese(value));
        let is_english = samples
            .iter()
            .any(|value| !has_chinese(value) && value.len() > 2 && country_lookup(value).is_some());
        classified.push((column, is_code, is_english, is_chinese));
    }
    if code_column.is_none_or(|current| {
        !classified
            .iter()
            .any(|(column, is_code, _, _)| *column == current && *is_code)
    }) {
        code_column = classified
            .iter()
            .find_map(|(column, is_code, _, _)| is_code.then_some(*column));
    }
    if english_column.is_none_or(|current| {
        !classified
            .iter()
            .any(|(column, _, is_english, _)| *column == current && *is_english)
    }) {
        english_column = classified
            .iter()
            .find_map(|(column, _, is_english, _)| is_english.then_some(*column));
    }
    if chinese_column.is_none_or(|current| {
        !classified
            .iter()
            .any(|(column, _, _, is_chinese)| *column == current && *is_chinese)
    }) {
        chinese_column = classified
            .iter()
            .find_map(|(column, _, _, is_chinese)| is_chinese.then_some(*column));
    }
    (code_column, english_column, chinese_column)
}

fn best_pricing_country_column(
    sheet: &SheetData,
    header_idx: usize,
    rule: Option<&FieldRule>,
) -> Option<usize> {
    let header = &sheet.rows[header_idx];
    header
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            let header_score = configured_header_score(&cell.text(), rule, PRICING_COUNTRY_ALIASES);
            if header_score == 0 {
                return None;
            }
            let mut non_empty = 0usize;
            let mut recognized = 0usize;
            let mut code_values = 0usize;
            let mut english_values = 0usize;
            let mut chinese_values = 0usize;
            for row in sheet.rows.iter().skip(header_idx + 1).take(500) {
                let Some(value) = row.get(column).map(CellValue::text) else {
                    continue;
                };
                if value.is_empty() {
                    continue;
                }
                non_empty += 1;
                // 国家列整格识别，不做「国名-后缀」拆分
                if country_lookup(&value).is_some() {
                    recognized += 1;
                    let trimmed = value.trim();
                    if trimmed.len() == 2
                        && trimmed
                            .chars()
                            .all(|character| character.is_ascii_alphabetic())
                    {
                        code_values += 1;
                    } else if has_chinese(trimmed) {
                        chinese_values += 1;
                    } else {
                        english_values += 1;
                    }
                }
            }
            let country_type_priority = [
                (code_values, 3usize),
                (english_values, 2usize),
                (chinese_values, 1usize),
            ]
            .into_iter()
            .max_by_key(|(count, priority)| (*count, *priority))
            .filter(|(count, _)| *count > 0)
            .map(|(_, priority)| priority)
            .unwrap_or_default();
            let configured_score = field_sample_adjustment(sheet, header_idx, column, rule, 500);
            (non_empty > 0).then_some((
                country_type_priority,
                recognized as i64 * 10_000
                    + configured_score as i64 * 100
                    + header_score as i64 * 10
                    + non_empty as i64,
                column,
            ))
        })
        .max_by_key(|(priority, score, column)| (*priority, *score, std::cmp::Reverse(*column)))
        .map(|(_, _, column)| column)
}

fn best_quantity_one_price_column(
    sheet: &SheetData,
    header_idx: usize,
    rule: Option<&FieldRule>,
    excluded: HashSet<usize>,
) -> Option<usize> {
    let header = &sheet.rows[header_idx];
    header
        .iter()
        .enumerate()
        .filter(|(column, _)| !excluded.contains(column))
        .filter_map(|(column, cell)| {
            let value = cell.text();
            let header_score = configured_header_score(&value, rule, QUANTITY_ONE_PRICE_ALIASES)
                .max(configured_header_score(&value, rule, PRICE_ALIASES));
            if header_score <= 0 {
                return None;
            }
            let score =
                header_score + field_sample_adjustment(sheet, header_idx, column, rule, 500);
            (score > 0).then_some((score, column))
        })
        .max_by_key(|(score, column)| (*score, std::cmp::Reverse(*column)))
        .map(|(_, column)| column)
}

fn best_pricing_sku_column(
    sheet: &SheetData,
    header_idx: usize,
    rule: Option<&FieldRule>,
) -> Option<usize> {
    let header = &sheet.rows[header_idx];
    header
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            let header_score = configured_header_score(&cell.text(), rule, SKU_ALIASES);
            if header_score == 0 {
                return None;
            }
            let mut non_empty = 0usize;
            let mut sku_like = 0usize;
            for row in sheet.rows.iter().skip(header_idx + 1).take(500) {
                let Some(value) = row.get(column).map(CellValue::text) else {
                    continue;
                };
                if value.is_empty() {
                    continue;
                }
                non_empty += 1;
                if normalize_sku(&value).len() >= 4 {
                    sku_like += 1;
                }
            }
            let configured_score = field_sample_adjustment(sheet, header_idx, column, rule, 500);
            (non_empty > 0).then_some((
                sku_like as i64 * 10_000
                    + configured_score as i64 * 100
                    + header_score as i64 * 10
                    + non_empty as i64,
                column,
            ))
        })
        .max_by_key(|(score, column)| (*score, std::cmp::Reverse(*column)))
        .map(|(_, column)| column)
}

fn has_chinese(value: &str) -> bool {
    value
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

fn score_order_rows(
    sheet: &SheetData,
    data_start: usize,
    pairs: &[SkuQtyPair],
    order_column: Option<usize>,
    country_columns: [Option<usize>; 3],
) -> (usize, usize) {
    let mut valid = 0;
    let mut country_rows = 0;
    for row in sheet.rows.iter().skip(data_start).take(120) {
        let has_order = order_column
            .and_then(|column| row.get(column))
            .is_some_and(|cell| !cell.is_empty());
        let has_pair = pairs.iter().any(|pair| {
            row.get(pair.sku_column.saturating_sub(1))
                .is_some_and(|cell| !cell.is_empty())
                && row
                    .get(pair.qty_column.saturating_sub(1))
                    .and_then(parse_number)
                    .is_some()
        });
        if has_order && has_pair {
            valid += 1;
            if country_columns
                .into_iter()
                .flatten()
                .any(|column| row.get(column).is_some_and(|cell| !cell.is_empty()))
            {
                country_rows += 1;
            }
        }
    }
    (valid, country_rows)
}

fn score_price_rows(
    sheet: &SheetData,
    data_start: usize,
    sku_column: usize,
    country_column: usize,
    tiers: &[PriceTierColumn],
) -> (usize, usize) {
    let mut valid = 0;
    let mut usable = 0;
    for row in sheet.rows.iter().skip(data_start).take(500) {
        if row.get(sku_column).is_some_and(|cell| !cell.is_empty())
            && row.get(country_column).is_some_and(|cell| !cell.is_empty())
        {
            valid += 1;
            usable += tiers
                .iter()
                .filter(|tier| {
                    row.get(tier.column.saturating_sub(1))
                        .and_then(parse_price)
                        .is_some()
                })
                .count();
        }
    }
    (valid, usable)
}

fn order_field_rule<'a>(config: &'a Config, name: &str) -> Option<&'a FieldRule> {
    config.pricing_fields.order.get(name)
}

fn pricing_field_rule<'a>(config: &'a Config, name: &str) -> Option<&'a FieldRule> {
    config.pricing_fields.pricing.get(name)
}

fn quantity_one_price_rule(config: &Config) -> Option<&FieldRule> {
    pricing_field_rule(config, "quantity_one_price")
        .or_else(|| pricing_field_rule(config, "fixed_price"))
}

fn configured_matching_columns(
    sheet: &SheetData,
    header_idx: usize,
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> Vec<usize> {
    let mut candidates = sheet.rows[header_idx]
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            let header = cell.text();
            let header_score = configured_header_score(&header, rule, fallback_aliases);
            if header_score <= 0 {
                return None;
            }
            let score = header_score
                + field_sample_adjustment(sheet, header_idx, column, rule, ORDER_HEADER_SCAN_ROWS);
            (score > 0).then_some((
                configured_header_is_exact(&header, rule, fallback_aliases),
                score,
                column,
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(is_exact, score, column)| {
        (
            std::cmp::Reverse(*is_exact),
            std::cmp::Reverse(*score),
            *column,
        )
    });
    candidates
        .into_iter()
        .map(|(_, _, column)| column)
        .collect()
}

fn configured_exact_header_columns(
    header: &[CellValue],
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> Vec<usize> {
    header
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            configured_header_is_exact(&cell.text(), rule, fallback_aliases).then_some(column)
        })
        .collect()
}

fn configured_header_is_exact(
    value: &str,
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> bool {
    let normalized = normalize_header(value);
    if normalized.is_empty() {
        return false;
    }
    if let Some(rule) = rule.filter(|rule| !rule.header_aliases.is_empty()) {
        rule.header_aliases
            .iter()
            .any(|alias| normalize_header(alias) == normalized)
    } else {
        fallback_aliases
            .iter()
            .any(|alias| normalize_header(alias) == normalized)
    }
}

fn configured_best_column(
    sheet: &SheetData,
    header_idx: usize,
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> Option<usize> {
    configured_matching_columns(sheet, header_idx, rule, fallback_aliases)
        .into_iter()
        .next()
}

fn header_score(value: &str, aliases: &[&str]) -> i32 {
    let normalized = normalize_header(value);
    if normalized.is_empty() {
        return 0;
    }
    aliases
        .iter()
        .enumerate()
        .map(|(index, alias)| alias_match_score(&normalized, alias, index, aliases.len()))
        .max()
        .unwrap_or(0)
}

fn configured_header_score(
    value: &str,
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> i32 {
    let normalized = normalize_header(value);
    if normalized.is_empty() {
        return 0;
    }
    let mut score = if let Some(rule) = rule.filter(|rule| !rule.header_aliases.is_empty()) {
        rule.header_aliases
            .iter()
            .enumerate()
            .map(|(index, alias)| {
                alias_match_score(&normalized, alias, index, rule.header_aliases.len())
            })
            .max()
            .unwrap_or(0)
    } else {
        header_score(value, fallback_aliases)
    };
    if let Some(rule) = rule {
        if rule
            .negative_headers
            .iter()
            .any(|header| normalize_header(header) == normalized)
        {
            score -= NEGATIVE_HEADER_PENALTY;
        }
        if rule
            .low_priority_headers
            .iter()
            .any(|header| normalize_header(header) == normalized)
        {
            score -= LOW_PRIORITY_HEADER_PENALTY;
        }
    }
    score.max(0)
}

fn alias_match_score(normalized: &str, alias: &str, index: usize, alias_count: usize) -> i32 {
    let candidate = normalize_header(alias);
    if candidate.is_empty() {
        return 0;
    }
    let order_bonus = alias_count.saturating_sub(index + 1) as i32 * HEADER_ALIAS_ORDER_STEP;
    if normalized == candidate {
        HEADER_EXACT_SCORE + order_bonus
    } else if normalized.contains(&candidate) || candidate.contains(normalized) {
        HEADER_CONTAINS_SCORE + order_bonus
    } else {
        0
    }
}

fn field_sample_adjustment(
    sheet: &SheetData,
    header_idx: usize,
    column: usize,
    rule: Option<&FieldRule>,
    sample_limit: usize,
) -> i32 {
    let Some(rule) = rule else {
        return 0;
    };
    if rule.compiled_value_patterns.is_empty() && rule.compiled_negative_patterns.is_empty() {
        return 0;
    }
    let values = sheet
        .rows
        .iter()
        .skip(header_idx + 1)
        .take(sample_limit)
        .filter_map(|row| row.get(column).map(CellValue::text))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return 0;
    }
    let positive_hits = values
        .iter()
        .filter(|value| {
            rule.compiled_value_patterns
                .iter()
                .any(|pattern| pattern.is_match(value))
        })
        .count();
    let negative_hits = values
        .iter()
        .filter(|value| {
            rule.compiled_negative_patterns
                .iter()
                .any(|pattern| pattern.is_match(value))
        })
        .count();
    VALUE_PATTERN_MAX_SCORE * positive_hits as i32 / values.len() as i32
        - NEGATIVE_PATTERN_MAX_PENALTY * negative_hits as i32 / values.len() as i32
}

fn normalize_header(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(
                    character,
                    ':' | '：' | '/' | '\\' | '(' | ')' | '（' | '）' | '-' | '_'
                )
        })
        .flat_map(char::to_uppercase)
        .collect()
}

fn pair_sku_qty_columns(
    header: &[CellValue],
    sku_columns: &[usize],
    qty_columns: &[usize],
) -> Vec<SkuQtyPair> {
    let mut candidates = Vec::new();
    for &sku_column in sku_columns {
        for &qty_column in qty_columns {
            if sku_column == qty_column {
                continue;
            }
            let crosses_sku = sku_columns.iter().any(|other_sku| {
                *other_sku != sku_column
                    && *other_sku > sku_column.min(qty_column)
                    && *other_sku < sku_column.max(qty_column)
            });
            let priority = if !crosses_sku {
                0
            } else if qty_column < sku_column {
                1
            } else {
                // 跨越 SKU 的兜底只允许向左查找。
                continue;
            };
            candidates.push((
                priority,
                sku_column.abs_diff(qty_column),
                std::cmp::Reverse(sku_column.max(qty_column)),
                std::cmp::Reverse(sku_column),
                sku_column,
                qty_column,
            ));
        }
    }
    candidates.sort_by_key(|candidate| (candidate.0, candidate.1, candidate.2, candidate.3));

    let mut pairs = Vec::new();
    let mut used_columns = HashSet::new();
    for (_, _, _, _, sku_column, qty_column) in candidates {
        if used_columns.contains(&sku_column) || used_columns.contains(&qty_column) {
            continue;
        }
        used_columns.insert(sku_column);
        used_columns.insert(qty_column);
        pairs.push(SkuQtyPair {
            sku_column: sku_column + 1,
            qty_column: qty_column + 1,
            merged_qty_column: sku_column + 2,
            direct_quantity: false,
            sku_header: header[sku_column].text(),
            qty_header: header[qty_column].text(),
            merged_qty_header: header
                .get(sku_column + 1)
                .map(CellValue::text)
                .unwrap_or_default(),
        });
    }
    pairs.sort_by_key(|pair| {
        (
            std::cmp::Reverse(pair.sku_column.max(pair.qty_column)),
            std::cmp::Reverse(pair.sku_column),
        )
    });
    pairs
}

fn highest_sku_quantity_group(
    header: &[CellValue],
    detected_pairs: &[SkuQtyPair],
    qty_columns: &[usize],
) -> Vec<SkuQtyPair> {
    let Some(highest_sku_column) = detected_pairs
        .iter()
        .map(|pair| pair.sku_column.saturating_sub(1))
        .max()
    else {
        return Vec::new();
    };
    let Some(qty_column) = qty_columns
        .iter()
        .copied()
        .filter(|column| *column < highest_sku_column)
        .max()
    else {
        return Vec::new();
    };
    if !qty_columns.contains(&(highest_sku_column + 1)) {
        return Vec::new();
    }
    vec![SkuQtyPair {
        sku_column: highest_sku_column + 1,
        qty_column: qty_column + 1,
        merged_qty_column: highest_sku_column + 2,
        direct_quantity: false,
        sku_header: header[highest_sku_column].text(),
        qty_header: header[qty_column].text(),
        merged_qty_header: header[highest_sku_column + 1].text(),
    }]
}

fn deduplicate_equivalent_sku_qty_pairs(
    sheet: &SheetData,
    data_start: usize,
    pairs: &[SkuQtyPair],
    order_column: Option<usize>,
) -> Vec<SkuQtyPair> {
    let mut unique = Vec::new();
    for pair in pairs {
        if unique.iter().any(|existing| {
            sku_qty_pair_data_equivalent(sheet, data_start, existing, pair, order_column)
        }) {
            continue;
        }
        unique.push(pair.clone());
    }
    unique
}

fn sku_qty_pair_data_equivalent(
    sheet: &SheetData,
    data_start: usize,
    left: &SkuQtyPair,
    right: &SkuQtyPair,
    order_column: Option<usize>,
) -> bool {
    let mut compared = false;
    for row in sheet.rows.iter().skip(data_start) {
        let has_order = order_column
            .and_then(|column| row.get(column))
            .is_some_and(|cell| !cell.text().trim().is_empty());
        if !has_order {
            continue;
        }
        let left_sku = normalize_sku(&cell_text(row, Some(left.sku_column)));
        let right_sku = normalize_sku(&cell_text(row, Some(right.sku_column)));
        let left_qty = row
            .get(left.qty_column.saturating_sub(1))
            .and_then(parse_number);
        let right_qty = row
            .get(right.qty_column.saturating_sub(1))
            .and_then(parse_number);
        if left_sku != right_sku || left_qty != right_qty {
            return false;
        }
        compared |= !left_sku.is_empty() && left_qty.is_some();
    }
    compared
}

fn tier_columns(
    row: &[CellValue],
    sku_column: Option<usize>,
    country_column: Option<usize>,
) -> Vec<PriceTierColumn> {
    let excluded = [sku_column, country_column]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    let mut tiers = row
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            if excluded.contains(&column) {
                return None;
            }
            parse_tier(&cell.text()).map(|quantity| PriceTierColumn {
                quantity,
                column: column + 1,
                header: cell.text(),
            })
        })
        .collect::<Vec<_>>();
    tiers.sort_by_key(|tier| (tier.quantity, tier.column));
    tiers.dedup_by_key(|tier| tier.quantity);
    tiers
}

fn numeric_header_ladder_level(row: &[CellValue], excluded: &HashSet<usize>) -> usize {
    let values = row
        .iter()
        .enumerate()
        .filter(|(column, _)| !excluded.contains(column))
        .map(|(_, cell)| parse_tier(&cell.text()))
        .collect::<Vec<_>>();
    let numeric_count = values.iter().filter(|value| value.is_some()).count();
    let mut level = numeric_count.saturating_sub(1);
    let mut run = 0usize;
    let mut expected = None;
    for value in values {
        match (expected, value) {
            (Some(next), Some(current)) if current == next => {
                run += 1;
                expected = Some(current + 1);
            }
            (_, Some(current)) => {
                run = 1;
                expected = Some(current + 1);
            }
            _ => {
                run = 0;
                expected = None;
            }
        }
        level = level.max(run.saturating_sub(1));
    }
    level
}

fn parse_tier(value: &str) -> Option<i64> {
    let mut token = value.trim().to_ascii_lowercase();
    if token.is_empty() {
        return None;
    }
    for prefix in ["quantity", "qty"] {
        if let Some(rest) = token.strip_prefix(prefix) {
            token = rest.trim().to_string();
            break;
        }
    }
    let compact = token
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let token = ["pieces", "piece", "pcs", "pc", "件", "个"]
        .iter()
        .find_map(|suffix| compact.strip_suffix(suffix))
        .unwrap_or(&compact)
        .trim();
    if token.contains('-') || token.contains('~') || token.contains('至') {
        return None;
    }
    let number = token.parse::<f64>().ok()?;
    (number.is_finite() && number.fract() == 0.0 && number >= 0.0 && number <= (i64::MAX as f64))
        .then_some(number as i64)
}

fn sheet_name_hint(name: &str, keywords: &[&str]) -> f64 {
    let normalized = normalize_header(name);
    if keywords
        .iter()
        .map(|keyword| normalize_header(keyword))
        .any(|keyword| !keyword.is_empty() && normalized.contains(&keyword))
    {
        8.0
    } else {
        0.0
    }
}

fn parse_number(cell: &CellValue) -> Option<f64> {
    let value = match cell {
        CellValue::Float(value) => *value,
        CellValue::Int(value) => *value as f64,
        CellValue::String(value) => value.trim().replace(',', "").parse::<f64>().ok()?,
        CellValue::Bool(value) => u8::from(*value) as f64,
        CellValue::Empty => return None,
    };
    value.is_finite().then_some(value)
}

fn parse_price(cell: &CellValue) -> Option<f64> {
    let text = cell.text();
    if matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "" | "/" | "未核价" | "#value!" | "#n/a" | "n/a"
    ) {
        return None;
    }
    parse_number(cell)
}

fn normalize_order_number(value: &str) -> String {
    value.trim().to_ascii_uppercase()
}

fn country_token(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(character, '-' | '_' | '/' | '—' | '（' | '）' | '(' | ')')
        })
        .flat_map(char::to_uppercase)
        .collect()
}

fn country_lookup(value: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let token = country_token(value);
    COUNTRY_ALIASES
        .iter()
        .find_map(|(code, english, chinese, alias)| {
            (token == *code
                || token == country_token(english)
                || token == country_token(chinese)
                || alias.iter().any(|item| token == country_token(item)))
            .then_some((*code, *english, *chinese))
        })
}

fn country_route_token(value: &str) -> String {
    value.trim().to_uppercase()
}

fn normalize_country_fields(code: &str, english: &str, chinese: &str) -> CountryInfo {
    // 国家字段按整格识别，不再从「UNITED STATES-hold」一类字符串拆物流后缀
    let inputs = [code, english, chinese];
    let mut resolved = Vec::new();
    for input in inputs {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(item) = country_lookup(trimmed) {
            resolved.push((item.0.to_string(), item.1.to_string(), item.2.to_string()));
        } else if trimmed.len() == 2
            && trimmed
                .chars()
                .all(|character| character.is_ascii_alphabetic())
        {
            resolved.push((trimmed.to_ascii_uppercase(), String::new(), String::new()));
        }
    }
    let codes = resolved
        .iter()
        .map(|item| item.0.as_str())
        .collect::<HashSet<_>>();
    if codes.len() > 1 {
        return CountryInfo {
            code: resolved
                .first()
                .map(|item| item.0.clone())
                .unwrap_or_default(),
            english: english.trim().to_string(),
            chinese: chinese.trim().to_string(),
            routes: inputs
                .iter()
                .map(|value| country_route_token(value))
                .filter(|value| !value.is_empty())
                .collect(),
            conflict: true,
            reason: format!("国家三要素冲突: code={code}, en={english}, cn={chinese}"),
        };
    }
    let (resolved_code, resolved_en, resolved_cn) = resolved.first().cloned().unwrap_or_default();
    let resolved_code_empty = resolved_code.is_empty();
    CountryInfo {
        code: resolved_code,
        english: if resolved_en.is_empty() {
            english.trim().to_string()
        } else {
            resolved_en
        },
        chinese: if resolved_cn.is_empty() {
            chinese.trim().to_string()
        } else {
            resolved_cn
        },
        routes: inputs
            .iter()
            .map(|value| country_route_token(value))
            .filter(|value| !value.is_empty())
            .collect(),
        conflict: false,
        reason: if resolved_code_empty {
            "无法识别国家".to_string()
        } else {
            String::new()
        },
    }
}

fn normalize_order_country_fields(
    code: &str,
    english: &str,
    chinese: &str,
    rules: &PricingRules,
) -> CountryInfo {
    let enabled_values = [
        (rules.uses_country_identity(CountryIdentity::Iso2), code),
        (
            rules.uses_country_identity(CountryIdentity::English),
            english,
        ),
        (
            rules.uses_country_identity(CountryIdentity::Chinese),
            chinese,
        ),
    ];
    let mut country = normalize_country_fields(
        if enabled_values[0].0 {
            enabled_values[0].1
        } else {
            ""
        },
        if enabled_values[1].0 {
            enabled_values[1].1
        } else {
            ""
        },
        if enabled_values[2].0 {
            enabled_values[2].1
        } else {
            ""
        },
    );
    country.routes = enabled_values
        .into_iter()
        .filter(|(enabled, _)| *enabled)
        .map(|(_, value)| country_route_token(value))
        .filter(|value| !value.is_empty())
        .fold(Vec::new(), |mut routes, route| {
            if !routes.contains(&route) {
                routes.push(route);
            }
            routes
        });
    country
}

fn highest_priority_sku_qty_pair(mapping: &PriceCheckMapping) -> Option<(usize, &SkuQtyPair)> {
    mapping
        .sku_qty_pairs
        .iter()
        .enumerate()
        .max_by_key(|(_, pair)| (pair.merged_qty_column, pair.sku_column))
}

#[derive(Debug, Clone)]
struct SingleShipmentMatchColumns {
    field: SingleShipmentMatchField,
    columns: Vec<usize>,
}

fn exact_header_columns(sheet: &SheetData, header_idx: usize, aliases: &[&str]) -> Vec<usize> {
    let normalized_aliases = aliases
        .iter()
        .map(|alias| normalize_header(alias))
        .collect::<HashSet<_>>();
    sheet
        .rows
        .get(header_idx)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(column, cell)| {
            normalized_aliases
                .contains(&normalize_header(&cell.text()))
                .then_some(column)
        })
        .collect()
}

fn single_shipment_match_columns(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> Option<Vec<SingleShipmentMatchColumns>> {
    let status = single_shipment_matching_status(sheet, mapping, config);
    status.ready.then(|| {
        status
            .fields
            .into_iter()
            .map(|matched| SingleShipmentMatchColumns {
                field: matched.field,
                columns: matched
                    .columns
                    .into_iter()
                    .map(|column| column.saturating_sub(1))
                    .collect(),
            })
            .collect()
    })
}

fn single_shipment_field_label(field: SingleShipmentMatchField) -> &'static str {
    match field {
        SingleShipmentMatchField::RecipientName => "收件人姓名",
        SingleShipmentMatchField::Phone => "电话",
        SingleShipmentMatchField::PostalCode => "邮编",
        SingleShipmentMatchField::Address => "完整地址",
        SingleShipmentMatchField::Email => "邮箱",
    }
}

fn single_shipment_field_rule_key(field: SingleShipmentMatchField) -> &'static str {
    match field {
        SingleShipmentMatchField::RecipientName => "recipient_name",
        SingleShipmentMatchField::Phone => "phone",
        SingleShipmentMatchField::PostalCode => "postal_code",
        SingleShipmentMatchField::Address => "address",
        SingleShipmentMatchField::Email => "email",
    }
}

fn single_shipment_field_aliases(field: SingleShipmentMatchField) -> &'static [&'static str] {
    match field {
        SingleShipmentMatchField::RecipientName => SINGLE_SHIPMENT_FIELD_ALIASES,
        SingleShipmentMatchField::Phone => SINGLE_SHIPMENT_PHONE_ALIASES,
        SingleShipmentMatchField::PostalCode => SINGLE_SHIPMENT_POSTAL_CODE_ALIASES,
        SingleShipmentMatchField::Address => SINGLE_SHIPMENT_ADDRESS_ALIASES,
        SingleShipmentMatchField::Email => SINGLE_SHIPMENT_EMAIL_ALIASES,
    }
}

fn resolve_single_shipment_fields(
    sheet: &SheetData,
    header_idx: usize,
    config: &Config,
    explicit_fields: &[SingleShipmentMatchFieldStatus],
    legacy_recipient_name_column: Option<usize>,
) -> Vec<SingleShipmentMatchFieldStatus> {
    config
        .pricing
        .single_shipment_match_fields
        .iter()
        .map(|field| {
            let explicit = explicit_fields
                .iter()
                .find(|matched| matched.field == *field);
            let mut zero_based_columns = if let Some(explicit) = explicit {
                explicit
                    .columns
                    .iter()
                    .filter_map(|column| column.checked_sub(1))
                    .collect()
            } else if *field == SingleShipmentMatchField::RecipientName {
                legacy_recipient_name_column
                    .and_then(|column| column.checked_sub(1))
                    .map(|column| vec![column])
                    .unwrap_or_else(|| {
                        configured_matching_columns(
                            sheet,
                            header_idx,
                            order_field_rule(config, single_shipment_field_rule_key(*field)),
                            single_shipment_field_aliases(*field),
                        )
                    })
            } else {
                configured_matching_columns(
                    sheet,
                    header_idx,
                    order_field_rule(config, single_shipment_field_rule_key(*field)),
                    single_shipment_field_aliases(*field),
                )
            };
            if *field != SingleShipmentMatchField::Address {
                zero_based_columns.truncate(1);
            }
            let columns = zero_based_columns
                .iter()
                .map(|column| column + 1)
                .collect::<Vec<_>>();
            let headers = columns
                .iter()
                .map(|column| {
                    sheet_cell_text(sheet, header_idx + 1, *column)
                        .trim()
                        .to_string()
                })
                .collect();
            SingleShipmentMatchFieldStatus {
                field: *field,
                columns,
                headers,
            }
        })
        .collect()
}

fn single_shipment_matching_unavailable(
    config: &Config,
    unavailable_reason: &str,
) -> SingleShipmentMatchingStatus {
    let enabled = config.pricing.single_shipment_matching_enabled;
    SingleShipmentMatchingStatus {
        enabled,
        ready: false,
        fields: config
            .pricing
            .single_shipment_match_fields
            .iter()
            .map(|field| SingleShipmentMatchFieldStatus {
                field: *field,
                columns: Vec::new(),
                headers: Vec::new(),
            })
            .collect(),
        reason: if enabled {
            unavailable_reason.to_string()
        } else {
            "配置中心未启用，当前使用通用价格".to_string()
        },
    }
}

fn single_shipment_matching_status(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> SingleShipmentMatchingStatus {
    let Some(header_idx) = mapping.order_header_row.checked_sub(1) else {
        return single_shipment_matching_unavailable(config, "订单表头行无效");
    };
    if header_idx >= sheet.rows.len() {
        return single_shipment_matching_unavailable(config, "订单表头行超出有效范围");
    }

    let fields = resolve_single_shipment_fields(
        sheet,
        header_idx,
        config,
        &mapping.single_shipment_fields,
        mapping.single_shipment_column,
    );
    let missing_fields = fields
        .iter()
        .filter(|matched| matched.columns.is_empty())
        .map(|matched| single_shipment_field_label(matched.field))
        .collect::<Vec<_>>();

    let enabled = config.pricing.single_shipment_matching_enabled;
    let ready = enabled && fields.len() >= 2 && missing_fields.is_empty();
    let reason = if !enabled {
        "配置中心未启用，当前使用通用价格".to_string()
    } else if fields.len() < 2 {
        "联合判断至少需要两个字段，当前使用通用价格".to_string()
    } else if !missing_fields.is_empty() {
        format!(
            "缺少联合字段表头：{}，当前使用通用价格",
            missing_fields.join("、")
        )
    } else {
        "联合字段完整；仅证据充分的单主 SKU 订单使用单独发货价格".to_string()
    };
    SingleShipmentMatchingStatus {
        enabled,
        ready,
        fields,
        reason,
    }
}

fn normalize_single_shipment_match_value(field: SingleShipmentMatchField, value: &str) -> String {
    match field {
        SingleShipmentMatchField::Phone | SingleShipmentMatchField::PostalCode => value
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_uppercase)
            .collect(),
        SingleShipmentMatchField::Email => value.trim().to_lowercase(),
        SingleShipmentMatchField::RecipientName | SingleShipmentMatchField::Address => value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_uppercase(),
    }
}

fn single_shipment_match_key(
    row: &[CellValue],
    columns: &[SingleShipmentMatchColumns],
) -> Option<String> {
    let mut values = Vec::with_capacity(columns.len());
    for matched in columns {
        let combined = matched
            .columns
            .iter()
            .filter_map(|column| row.get(*column).map(CellValue::text))
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let normalized = normalize_single_shipment_match_value(matched.field, &combined);
        if normalized.is_empty() {
            return None;
        }
        values.push(normalized);
    }
    Some(values.join("\u{1f}"))
}

fn single_shipment_orders(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
    resolved_quantities: &[ResolvedOrderQuantity],
) -> HashSet<String> {
    let Some(match_columns) = single_shipment_match_columns(sheet, mapping, config) else {
        return HashSet::new();
    };
    let mut invalid_orders = HashSet::new();
    let mut keys_by_order: HashMap<String, HashSet<String>> = HashMap::new();
    let mut main_skus_by_order: HashMap<String, HashSet<String>> = HashMap::new();
    for resolved in resolved_quantities {
        if resolved.business_order_number.is_empty() {
            continue;
        }
        let Some(row) = sheet.rows.get(resolved.source_row.saturating_sub(1)) else {
            invalid_orders.insert(resolved.business_order_number.clone());
            continue;
        };
        if resolved.quantity_error.is_some() {
            invalid_orders.insert(resolved.business_order_number.clone());
        }
        if let Some(key) = single_shipment_match_key(row, &match_columns) {
            keys_by_order
                .entry(resolved.business_order_number.clone())
                .or_default()
                .insert(key);
        } else {
            invalid_orders.insert(resolved.business_order_number.clone());
        }
        if !resolved.absorbed
            && resolved.quantity.is_some_and(|quantity| quantity > 0)
            && !resolved.matched_sku.is_empty()
        {
            main_skus_by_order
                .entry(resolved.business_order_number.clone())
                .or_default()
                .insert(resolved.matched_sku.clone());
        }
    }

    let valid_keys = keys_by_order
        .into_iter()
        .filter_map(|(order, keys)| {
            (!invalid_orders.contains(&order) && keys.len() == 1)
                .then(|| (order, keys.into_iter().next().expect("one key")))
        })
        .collect::<HashMap<_, _>>();
    let mut orders_by_key: HashMap<String, HashSet<String>> = HashMap::new();
    for (order, key) in &valid_keys {
        orders_by_key
            .entry(key.clone())
            .or_default()
            .insert(order.clone());
    }

    valid_keys
        .into_iter()
        .filter_map(|(order, key)| {
            let one_order_per_key = orders_by_key
                .get(&key)
                .is_some_and(|orders| orders.len() == 1);
            let one_main_sku = main_skus_by_order
                .get(&order)
                .is_some_and(|skus| skus.len() == 1);
            (one_order_per_key && one_main_sku).then_some(order)
        })
        .collect()
}

#[derive(Debug, Clone)]
struct ResolvedOrderQuantity {
    source_row: usize,
    business_order_number: String,
    raw_sku: String,
    matched_sku: String,
    component_source: Option<CompoundQuantitySource>,
    quantity: Option<usize>,
    quantity_error: Option<String>,
    quantity_issue_context: Option<SkuQuantityIssueContext>,
    absorbed: bool,
    sku_pair_priority: usize,
}

#[derive(Debug, Clone)]
struct CompoundQuantitySource {
    previous_sku: String,
    source_quantity: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct QuantitySourceColumns {
    main_sku: usize,
    previous_sku: Option<usize>,
    quantity: usize,
    direct_quantity: bool,
}

fn quantity_source_columns(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> Result<QuantitySourceColumns, String> {
    let Some((_, main_pair)) = highest_priority_sku_qty_pair(mapping) else {
        return Err("没有主要 SKU 映射".to_string());
    };
    let header_idx = mapping.order_header_row.saturating_sub(1);
    if header_idx >= sheet.rows.len() {
        return Err("订单表头行超出范围".to_string());
    }
    let main_sku = main_pair.sku_column.saturating_sub(1);
    if main_pair.direct_quantity {
        return Ok(QuantitySourceColumns {
            main_sku,
            previous_sku: None,
            quantity: main_pair.qty_column.saturating_sub(1),
            direct_quantity: true,
        });
    }
    let mut sku_columns = configured_matching_columns(
        sheet,
        header_idx,
        order_field_rule(config, "sku"),
        SKU_ALIASES,
    );
    sku_columns.extend(
        mapping
            .sku_qty_pairs
            .iter()
            .map(|pair| pair.sku_column.saturating_sub(1)),
    );
    sku_columns.push(main_sku);
    sku_columns.sort_unstable();
    sku_columns.dedup();
    let previous_sku = sku_columns
        .iter()
        .copied()
        .filter(|column| *column < main_sku)
        .max()
        .ok_or_else(|| "主要 SKU 左侧找不到前一个 SKU 列".to_string())?;

    let mut quantity_columns = configured_matching_columns(
        sheet,
        header_idx,
        order_field_rule(config, "quantity"),
        QTY_ALIASES,
    );
    quantity_columns.extend(
        mapping
            .sku_qty_pairs
            .iter()
            .map(|pair| pair.qty_column.saturating_sub(1)),
    );
    quantity_columns.sort_unstable();
    quantity_columns.dedup();

    let left_sku_boundary = sku_columns
        .iter()
        .copied()
        .filter(|column| *column < previous_sku)
        .max();
    let local_quantity = quantity_columns
        .iter()
        .copied()
        .filter(|column| {
            (*column > previous_sku && *column < main_sku)
                || (*column < previous_sku
                    && left_sku_boundary.is_none_or(|boundary| *column > boundary))
        })
        .min_by_key(|column| (previous_sku.abs_diff(*column), std::cmp::Reverse(*column)));
    let left_fallback = quantity_columns
        .iter()
        .copied()
        .filter(|column| *column < previous_sku)
        .max();
    let quantity = local_quantity
        .or(left_fallback)
        .ok_or_else(|| "前一个 SKU 左侧找不到对应数量列".to_string())?;
    Ok(QuantitySourceColumns {
        main_sku,
        previous_sku: Some(previous_sku),
        quantity,
        direct_quantity: false,
    })
}

fn resolve_direct_sku_quantity(
    raw_sku: &str,
    source_quantity: usize,
) -> Result<(String, usize), String> {
    let normalized = normalize_sku(raw_sku);
    if normalized.is_empty() {
        return Err("主要 SKU 为空".to_string());
    }
    if normalized.contains('+') || !normalized.contains('*') {
        return Ok((normalized, source_quantity));
    }
    let Some((sku, multiplier)) = normalized.rsplit_once('*') else {
        return Ok((normalized, source_quantity));
    };
    if sku.is_empty() || sku.contains('*') {
        return Err(format!("SKU 倍数格式无效: {normalized}"));
    }
    let multiplier = multiplier
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("SKU 倍数必须为正整数: {normalized}"))?;
    let quantity = source_quantity
        .checked_mul(multiplier)
        .ok_or_else(|| format!("数量计算溢出: {source_quantity} × {multiplier}"))?;
    Ok((sku.to_string(), quantity))
}

fn resolve_order_quantities(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> Vec<ResolvedOrderQuantity> {
    let source_columns = quantity_source_columns(sheet, mapping, config);
    let sku_pair_priority = highest_priority_sku_qty_pair(mapping)
        .map(|(priority, _)| priority)
        .unwrap_or_default();
    let mut resolved = Vec::new();
    for (row_index, row) in sheet.rows.iter().enumerate().skip(mapping.order_header_row) {
        let source_row = row_index + 1;
        let business_order_number =
            normalize_order_number(&cell_text(row, mapping.business_order_number_column));
        let raw_sku = source_columns
            .as_ref()
            .ok()
            .and_then(|columns| row.get(columns.main_sku))
            .map(CellValue::text)
            .unwrap_or_else(|| {
                highest_priority_sku_qty_pair(mapping)
                    .map(|(_, pair)| cell_text(row, Some(pair.sku_column)))
                    .unwrap_or_default()
            });
        // 没有订单号的合计、说明或空白行不属于订单，不能进入数量计算与核价聚合。
        if business_order_number.is_empty() {
            continue;
        }
        let quantity_issue_context = source_columns.as_ref().ok().and_then(|columns| {
            columns
                .previous_sku
                .map(|previous_sku| SkuQuantityIssueContext {
                    previous_sku_column: previous_sku + 1,
                    previous_sku: row
                        .get(previous_sku)
                        .map(CellValue::text)
                        .unwrap_or_default(),
                    main_sku_column: columns.main_sku + 1,
                    main_sku: raw_sku.clone(),
                })
        });
        let mut component_source = None;
        let sku_quantity_result = if raw_sku.is_empty() {
            Err("主要 SKU 为空".to_string())
        } else {
            source_columns
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|columns| {
                    let quantity = row
                        .get(columns.quantity)
                        .and_then(parse_number)
                        .filter(|value| *value >= 0.0 && value.fract() == 0.0)
                        .ok_or_else(|| {
                            format!(
                                "数量无效: {} 列没有可用非负整数",
                                excel_column_label(columns.quantity + 1)
                            )
                        })?;
                    if columns.direct_quantity {
                        return resolve_direct_sku_quantity(&raw_sku, quantity as usize);
                    }
                    let previous_sku_column = columns
                        .previous_sku
                        .ok_or_else(|| "主要 SKU 左侧找不到前一个 SKU 列".to_string())?;
                    let previous_sku = row
                        .get(previous_sku_column)
                        .map(CellValue::text)
                        .unwrap_or_default();
                    if previous_sku.is_empty() {
                        return Err("前一个 SKU 为空，SKU关系无法计算".to_string());
                    }
                    component_source = Some(CompoundQuantitySource {
                        previous_sku: previous_sku.clone(),
                        source_quantity: quantity as usize,
                    });
                    calculate_related_quantity(&raw_sku, &previous_sku, quantity as usize)
                        .map(|resolved_quantity| (normalize_sku(&raw_sku), resolved_quantity))
                })
        };
        let quantity_error = sku_quantity_result.as_ref().err().cloned();
        let matched_sku = sku_quantity_result
            .as_ref()
            .map(|(sku, _)| sku.clone())
            .unwrap_or_else(|_| normalize_sku(&raw_sku));
        resolved.push(ResolvedOrderQuantity {
            source_row,
            business_order_number,
            raw_sku,
            matched_sku,
            component_source,
            quantity: sku_quantity_result
                .as_ref()
                .ok()
                .map(|(_, quantity)| *quantity),
            quantity_issue_context: quantity_error
                .as_ref()
                .is_some_and(|error| error.contains("SKU关系无法计算"))
                .then_some(quantity_issue_context)
                .flatten(),
            quantity_error,
            absorbed: false,
            sku_pair_priority,
        });
    }

    // 吸收严格按订单隔离，且仅处理原金额明确为 0 的独立 SKU 行。
    let mut order_rows: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, item) in resolved.iter().enumerate() {
        if !item.business_order_number.is_empty() {
            order_rows
                .entry(item.business_order_number.clone())
                .or_default()
                .push(index);
        }
    }
    for indexes in order_rows.values() {
        for source_index in indexes {
            let source = &resolved[*source_index];
            if source.quantity.is_none() {
                continue;
            }
            let original_price = mapping
                .order_price_column
                .and_then(|column| {
                    sheet
                        .rows
                        .get(source.source_row.saturating_sub(1))?
                        .get(column.saturating_sub(1))
                })
                .and_then(parse_price);
            if original_price != Some(0.0) {
                continue;
            }
            let Ok(source_expression) = parse_sku_expression(&source.matched_sku) else {
                continue;
            };
            let targets = indexes
                .iter()
                .filter_map(|target_index| {
                    if target_index == source_index {
                        return None;
                    }
                    let target = &resolved[*target_index];
                    target.quantity?;
                    let expression = parse_sku_expression(&target.matched_sku).ok()?;
                    (expression.components.len() > 1
                        && expression.normalized != source_expression.normalized
                        && source_expression.components.iter().all(|(sku, quantity)| {
                            expression
                                .components
                                .get(sku)
                                .is_some_and(|target_quantity| target_quantity >= quantity)
                        }))
                    .then_some(target.matched_sku.clone())
                })
                .collect::<HashSet<_>>();
            if targets.len() == 1 {
                let source = &mut resolved[*source_index];
                source.quantity = Some(0);
                source.absorbed = true;
            } else if targets.len() > 1 {
                let source = &mut resolved[*source_index];
                source.quantity = None;
                source.quantity_error =
                    Some("SKU关系无法计算: 同订单内存在多个可吸收的复合主要 SKU".to_string());
            }
        }
    }

    // 同订单、同主要 SKU 全局合并；首行保留合计，后续行写 0。
    let mut groups: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (index, item) in resolved.iter().enumerate() {
        if !item.absorbed
            && item.quantity.is_some()
            && !item.business_order_number.is_empty()
            && !item.matched_sku.is_empty()
        {
            groups
                .entry((item.business_order_number.clone(), item.matched_sku.clone()))
                .or_default()
                .push(index);
        }
    }
    for indexes in groups.values() {
        let main_sku = &resolved[indexes[0]].matched_sku;
        let is_compound_component_group = parse_sku_expression(main_sku)
            .is_ok_and(|expression| expression.components.len() > 1)
            && indexes
                .iter()
                .all(|index| resolved[*index].component_source.is_some());
        let total = if is_compound_component_group {
            calculate_grouped_compound_quantity(main_sku, indexes, &resolved)
        } else {
            indexes
                .iter()
                .try_fold(0usize, |total, index| {
                    total.checked_add(resolved[*index].quantity.unwrap_or_default())
                })
                .ok_or_else(|| "数量合并溢出".to_string())
        };
        match total {
            Ok(total) => {
                for (position, index) in indexes.iter().enumerate() {
                    resolved[*index].quantity = Some(if position == 0 { total } else { 0 });
                }
            }
            Err(error) => {
                for index in indexes {
                    resolved[*index].quantity = None;
                    resolved[*index].quantity_error = Some(error.clone());
                }
            }
        }
    }
    resolved
}

fn calculate_grouped_compound_quantity(
    main_sku: &str,
    indexes: &[usize],
    resolved: &[ResolvedOrderQuantity],
) -> Result<usize, String> {
    let main = parse_sku_expression(main_sku)?;
    let mut component_quantities = HashMap::<String, usize>::new();
    for index in indexes {
        let source = resolved[*index]
            .component_source
            .as_ref()
            .ok_or_else(|| "复合 SKU 缺少组件数量来源".to_string())?;
        let previous = parse_sku_expression(&source.previous_sku)?;
        for (sku, multiplier) in previous.components {
            if !main.components.contains_key(&sku) {
                continue;
            }
            let contribution = source
                .source_quantity
                .checked_mul(multiplier)
                .ok_or_else(|| "数量计算溢出".to_string())?;
            let total = component_quantities.entry(sku).or_default();
            *total = total
                .checked_add(contribution)
                .ok_or_else(|| "数量合并溢出".to_string())?;
        }
    }

    let mut grouped_quantity = None;
    for (sku, component_quantity) in component_quantities {
        let required_quantity = main.components[&sku];
        let candidate = component_quantity.div_ceil(required_quantity);
        if grouped_quantity.is_some_and(|quantity| quantity != candidate) {
            return Err(format!(
                "SKU关系无法计算: 同订单内主要SKU {main_sku} 的组件数量比例冲突"
            ));
        }
        grouped_quantity = Some(candidate);
    }
    grouped_quantity
        .ok_or_else(|| format!("SKU关系无法计算: 同订单内主要SKU {main_sku} 没有可用组件数量"))
}

fn read_order_lines(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> (
    Vec<OrderLine>,
    Vec<PriceCheckException>,
    Vec<ResolvedOrderQuantity>,
) {
    let mut lines = Vec::new();
    let mut exceptions = Vec::new();
    let resolved_quantities = resolve_order_quantities(sheet, mapping, config);
    let single_shipment_orders =
        single_shipment_orders(sheet, mapping, config, &resolved_quantities);
    for resolved in &resolved_quantities {
        let row_index = resolved.source_row.saturating_sub(1);
        let Some(row) = sheet.rows.get(row_index) else {
            continue;
        };
        let business = resolved.business_order_number.clone();
        let code = cell_text(row, mapping.country_code_column);
        let english = cell_text(row, mapping.country_english_column);
        let chinese = cell_text(row, mapping.country_chinese_column);
        let country = normalize_order_country_fields(&code, &english, &chinese, &config.pricing);
        let single_shipment = single_shipment_orders.contains(&business);
        if let Some(error) = &resolved.quantity_error {
            exceptions.push(PriceCheckException {
                file_path: String::new(),
                sheet_name: sheet.name.clone(),
                source_row: Some(resolved.source_row),
                kind: if error.starts_with("数量") {
                    "数量无效".to_string()
                } else {
                    "SKU关系无法计算".to_string()
                },
                message: error.clone(),
            });
            continue;
        }
        if resolved.absorbed {
            continue;
        }
        if country.conflict {
            exceptions.push(PriceCheckException {
                file_path: String::new(),
                sheet_name: sheet.name.clone(),
                source_row: Some(resolved.source_row),
                kind: "国家三要素冲突".to_string(),
                message: country.reason.clone(),
            });
            continue;
        }
        if let Some(quantity) = resolved.quantity {
            lines.push(OrderLine {
                business_order_number: business,
                country,
                single_shipment,
                original_sku: resolved.raw_sku.clone(),
                matched_sku: resolved.matched_sku.clone(),
                quantity: quantity as f64,
                original_price: mapping
                    .order_price_column
                    .and_then(|column| row.get(column.saturating_sub(1)))
                    .and_then(parse_price),
                source_sheet: sheet.name.clone(),
                source_row: resolved.source_row,
                sku_pair_priority: resolved.sku_pair_priority,
            });
        }
    }
    (lines, exceptions, resolved_quantities)
}

fn build_price_index(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    pricing_rules: &PricingRules,
) -> PriceIndex {
    let mut index = PriceIndex::default();
    let mut single_shipment_index = PriceIndex::default();
    let data_start = mapping
        .pricing_header_row
        .max(mapping.pricing_quantity_header_row.unwrap_or(0));
    let single_shipment_start =
        sheet
            .rows
            .iter()
            .enumerate()
            .skip(data_start)
            .find_map(|(row_index, row)| {
                row.iter()
                    .any(|cell| {
                        let normalized = normalize_header(&cell.text());
                        pricing_rules
                            .single_shipment_price_marker_aliases
                            .iter()
                            .any(|alias| normalized == normalize_header(alias))
                    })
                    .then_some(row_index)
            });
    for (row_index, row) in sheet.rows.iter().enumerate().skip(data_start) {
        let target = if single_shipment_start.is_some_and(|start| row_index > start) {
            &mut single_shipment_index
        } else {
            &mut index
        };
        insert_price_row(target, row, sheet, mapping);
    }
    if !single_shipment_index.entries.is_empty() {
        index.single_shipment = Some(Box::new(single_shipment_index));
    }
    index
}

fn insert_price_row(
    index: &mut PriceIndex,
    row: &[CellValue],
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
) {
    let raw_sku = cell_text(row, Some(mapping.pricing_sku_column));
    let raw_country = cell_text(row, Some(mapping.pricing_country_column));
    let country_route = country_route_token(&raw_country);
    if country_route.is_empty() {
        return;
    }
    index.source_sheet = sheet.name.clone();
    index.country_routes.insert(country_route.clone());
    if raw_sku.is_empty() {
        return;
    }
    let sku = normalize_sku(&raw_sku);
    for tier in &mapping.quantity_tier_columns {
        let entry = PriceEntry {
            price: row.get(tier.column.saturating_sub(1)).and_then(parse_price),
            raw_price: row
                .get(tier.column.saturating_sub(1))
                .map(CellValue::text)
                .unwrap_or_default(),
            sheet_name: sheet.name.clone(),
        };
        let key = full_key(&country_route, &sku, tier.quantity);
        index.quantity_keys.insert(prefix_key(&country_route, &sku));
        index.entries.entry(key).or_default().push(entry);
    }
}

fn aggregate_lines(lines: &[OrderLine]) -> Vec<AggregatedOrderSku> {
    let mut result: Vec<AggregatedOrderSku> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for line in lines {
        let key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            line.business_order_number,
            line.country.routes.join("\u{1e}"),
            line.matched_sku,
            line.single_shipment
        );
        if let Some(position) = positions.get(&key).copied() {
            let row = &mut result[position];
            row.total_quantity += line.quantity;
            if !row
                .original_sku
                .split(" | ")
                .any(|value| value == line.original_sku)
            {
                row.original_sku.push_str(" | ");
                row.original_sku.push_str(&line.original_sku);
            }
            if row.original_price.is_none() {
                row.original_price = line.original_price;
            }
            if !row.source_rows.contains(&line.source_row) {
                row.source_rows.push(line.source_row);
            }
            if !row.source_assignments.contains(&SourceAssignment {
                source_row: line.source_row,
                sku_pair_priority: line.sku_pair_priority,
            }) {
                row.source_assignments.push(SourceAssignment {
                    source_row: line.source_row,
                    sku_pair_priority: line.sku_pair_priority,
                });
            }
        } else {
            positions.insert(key, result.len());
            result.push(AggregatedOrderSku {
                business_order_number: line.business_order_number.clone(),
                country_code: line.country.code.clone(),
                country_english_name: line.country.english.clone(),
                country_chinese_name: line.country.chinese.clone(),
                country_routes: line.country.routes.clone(),
                single_shipment: line.single_shipment,
                original_sku: line.original_sku.clone(),
                matched_sku: line.matched_sku.clone(),
                total_quantity: line.quantity,
                original_price: line.original_price,
                source_sheet: line.source_sheet.clone(),
                source_rows: vec![line.source_row],
                source_assignments: vec![SourceAssignment {
                    source_row: line.source_row,
                    sku_pair_priority: line.sku_pair_priority,
                }],
            });
        }
    }
    result
}

#[derive(Debug, Clone, Copy)]
struct MatchedRowCandidate {
    sku_pair_priority: usize,
    pricing_price: f64,
}

fn record_matched_candidates(
    candidates: &mut HashMap<usize, MatchedRowCandidate>,
    item: &AggregatedOrderSku,
    pricing_price: f64,
) {
    let first_source_row = item
        .source_assignments
        .iter()
        .map(|assignment| assignment.source_row)
        .min();
    for assignment in &item.source_assignments {
        let candidate = MatchedRowCandidate {
            sku_pair_priority: assignment.sku_pair_priority,
            pricing_price: if Some(assignment.source_row) == first_source_row {
                pricing_price
            } else {
                0.0
            },
        };
        candidates
            .entry(assignment.source_row)
            .and_modify(|current| {
                if candidate.sku_pair_priority < current.sku_pair_priority {
                    *current = candidate;
                }
            })
            .or_insert(candidate);
    }
}

fn order_tax_column_index(sheet: &SheetData, mapping: &PriceCheckMapping) -> Option<usize> {
    let header_index = mapping.order_header_row.checked_sub(1)?;
    exact_header_columns(sheet, header_index, ORDER_TAX_ALIASES)
        .into_iter()
        .next()
}

fn order_tax_amount(row: &[CellValue], tax_column_index: Option<usize>) -> f64 {
    tax_column_index
        .and_then(|column| row.get(column))
        .and_then(parse_price)
        .unwrap_or_default()
}

fn normalize_price_difference(value: f64) -> f64 {
    if value.abs() < PRICE_DIFFERENCE_ZERO_EPSILON {
        0.0
    } else {
        value
    }
}

fn build_writeback_rows(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    candidates: &HashMap<usize, MatchedRowCandidate>,
    resolved_quantities: &[ResolvedOrderQuantity],
) -> Vec<PriceWritebackRow> {
    let Some((_, pair)) = highest_priority_sku_qty_pair(mapping) else {
        return Vec::new();
    };
    let tax_column_index = order_tax_column_index(sheet, mapping);
    let mut rows = Vec::new();
    for resolved in resolved_quantities {
        let Some(row) = sheet.rows.get(resolved.source_row.saturating_sub(1)) else {
            continue;
        };
        let source_row = resolved.source_row;
        let candidate = candidates.get(&source_row);
        let quantity = resolved.quantity;
        let merged_quantity = (!pair.direct_quantity)
            .then(|| {
                row.get(pair.merged_qty_column.saturating_sub(1))
                    .and_then(parse_number)
                    .filter(|value| *value >= 0.0 && value.fract() == 0.0)
                    .map(|value| value as usize)
            })
            .flatten();
        let original_price = mapping
            .order_price_column
            .and_then(|column| row.get(column.saturating_sub(1)))
            .and_then(parse_price);
        let pricing_price =
            candidate.map(|value| value.pricing_price + order_tax_amount(row, tax_column_index));
        rows.push(PriceWritebackRow {
            source_row,
            sku_pair_priority: candidate.map(|value| value.sku_pair_priority),
            matched: candidate.is_some(),
            pricing_price,
            price_difference: pricing_price.and_then(|pricing| {
                original_price.map(|original| normalize_price_difference(pricing - original))
            }),
            quantity,
            quantity_error: resolved.quantity_error.clone(),
            quantity_mismatch: !pair.direct_quantity
                && quantity.is_some_and(|quantity| merged_quantity != Some(quantity)),
        });
    }
    rows
}

fn process_price_file(
    input_path: &Path,
    output_options: PriceOutputOptions<'_>,
    mapping: &PriceCheckMapping,
    writeback_overrides: &[PricePreviewWritebackRow],
    cell_edits: &[PriceCellEdit],
    config: &Config,
    state: &RuntimeState,
) -> Result<PriceCheckReport> {
    crate::pricing_writer::validate_source_format(input_path)?;
    let order_price_column = mapping
        .order_price_column
        .ok_or_else(|| anyhow!("订单 Sheet 找不到 TOTAL Price/原始价格列，未生成结果文件"))?;
    let mut workbook = read_workbook_for_processing(input_path, config)?;
    apply_cell_edits(&mut workbook, cell_edits)?;
    let order_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.order_sheet)
        .ok_or_else(|| anyhow!("找不到订单 Sheet: {}", mapping.order_sheet))?;
    let pricing_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.pricing_sheet)
        .ok_or_else(|| anyhow!("找不到核价 Sheet: {}", mapping.pricing_sheet))?;
    let (lines, mut exceptions, resolved_quantities) =
        read_order_lines(order_sheet, mapping, config);
    for exception in &mut exceptions {
        exception.file_path = input_path.display().to_string();
    }
    let aggregated = aggregate_lines(&lines);
    let index = build_price_index(pricing_sheet, mapping, &config.pricing);
    let tax_column_index = order_tax_column_index(order_sheet, mapping);
    let mut rows = Vec::new();
    let mut matched_rows = 0;
    let mut matched_candidates = HashMap::new();
    for (position, item) in aggregated.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            break;
        }
        let lookup = index.lookup_routes_with_single_shipment_preference(
            &item.country_routes,
            &item.matched_sku,
            item.total_quantity.round() as i64,
            item.single_shipment,
        );
        if lookup.status == "matched" {
            matched_rows += 1;
            if let Some(pricing_price) = lookup.price {
                record_matched_candidates(&mut matched_candidates, item, pricing_price);
            }
        } else {
            exceptions.push(PriceCheckException {
                file_path: input_path.display().to_string(),
                sheet_name: item.source_sheet.clone(),
                source_row: item.source_rows.first().copied(),
                kind: lookup.status.to_string(),
                message: lookup.reason.clone(),
            });
        }
        let tax_amount = item
            .source_rows
            .iter()
            .filter_map(|source_row| order_sheet.rows.get(source_row.saturating_sub(1)))
            .map(|row| order_tax_amount(row, tax_column_index))
            .sum::<f64>();
        let financial_price = lookup.price.map(|price| price + tax_amount);
        let difference = match (item.original_price, financial_price) {
            (Some(original), Some(pricing)) => Some(normalize_price_difference(pricing - original)),
            _ => None,
        };
        rows.push(PriceCheckRow {
            business_order_number: item.business_order_number.clone(),
            country_code: item.country_code.clone(),
            country_english_name: item.country_english_name.clone(),
            country_chinese_name: item.country_chinese_name.clone(),
            original_sku: item.original_sku.clone(),
            matched_sku: lookup.matched_sku.clone(),
            total_quantity: item.total_quantity,
            original_price: item.original_price,
            pricing_price: financial_price,
            price_difference: difference,
            status: if lookup.status == "matched" {
                "已核价".to_string()
            } else {
                "异常".to_string()
            },
            exception_reason: lookup.reason,
            order_source_sheet: item.source_sheet.clone(),
            pricing_source_sheet: lookup.source_sheet,
            source_rows: item
                .source_rows
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(","),
        });
        if position % 100 == 0 {
            emit(json!({
                "type": "price-progress",
                "phase": "rows",
                "current": position + 1,
                "total": aggregated.len(),
                "path": input_path,
            }));
        }
    }
    let total_rows = rows.len();
    let output_path = output_path_for(input_path, output_options.directory);
    let mut writeback_rows = build_writeback_rows(
        order_sheet,
        mapping,
        &matched_candidates,
        &resolved_quantities,
    );
    apply_writeback_overrides(&mut writeback_rows, writeback_overrides);
    let mut report = PriceCheckReport {
        input_path: input_path.display().to_string(),
        output_path: output_path.display().to_string(),
        mapping: mapping.clone(),
        rows,
        exceptions,
        total_rows,
        matched_rows,
        exception_rows: total_rows.saturating_sub(matched_rows),
        coverage: ratio(matched_rows, total_rows),
    };
    crate::pricing_writer::write_price_result(
        input_path,
        &output_path,
        &mapping.order_sheet,
        crate::pricing_writer::PriceWritebackLayout {
            header_row: mapping.order_header_row,
            order_number_column: mapping.business_order_number_column,
            total_price_column: order_price_column,
        },
        &writeback_rows,
        cell_edits,
    )?;
    if output_options.overwrite_source_files {
        crate::pricing_writer::overwrite_source_with_result(&output_path, input_path)?;
    }
    report.output_path = output_path.display().to_string();
    Ok(report)
}

#[derive(Debug, Clone, Copy)]
struct PriceOutputOptions<'a> {
    directory: &'a Path,
    overwrite_source_files: bool,
}

fn apply_cell_edits(workbook: &mut WorkbookData, edits: &[PriceCellEdit]) -> Result<()> {
    for edit in edits {
        if edit.row == 0 || edit.column == 0 {
            return Err(anyhow!("单元格行列必须从 1 开始"));
        }
        let sheet = workbook
            .sheets
            .iter_mut()
            .find(|sheet| sheet.name == edit.sheet_name)
            .ok_or_else(|| anyhow!("找不到编辑目标 Sheet: {}", edit.sheet_name))?;
        let row = sheet
            .rows
            .get_mut(edit.row - 1)
            .ok_or_else(|| anyhow!("编辑目标行超出范围: {}!{}", edit.sheet_name, edit.row))?;
        if row.len() < edit.column {
            row.resize(edit.column, CellValue::Empty);
        }
        row[edit.column - 1] = if edit.numeric {
            if edit.value.trim().is_empty() {
                CellValue::Empty
            } else {
                CellValue::Float(
                    edit.value
                        .replace(',', "")
                        .parse()
                        .map_err(|_| anyhow!("数字单元格编辑值无效: {}", edit.value))?,
                )
            }
        } else {
            CellValue::string(edit.value.trim())
        };
    }
    Ok(())
}

fn apply_writeback_overrides(
    rows: &mut [PriceWritebackRow],
    overrides: &[PricePreviewWritebackRow],
) {
    let overrides = overrides
        .iter()
        .map(|row| (row.source_row, row))
        .collect::<HashMap<_, _>>();
    for row in rows {
        let Some(edited) = overrides.get(&row.source_row) else {
            continue;
        };
        row.pricing_price = edited.pricing_price;
        row.price_difference = edited.price_difference;
        row.quantity = edited.quantity;
        row.quantity_error = edited.quantity_error.clone();
        if row.quantity.is_some() {
            row.quantity_error = None;
        }
    }
}

impl PriceIndex {
    #[cfg(test)]
    fn lookup_with_single_shipment_preference(
        &self,
        country: &str,
        sku: &str,
        quantity: i64,
        prefer_single_shipment: bool,
    ) -> Lookup {
        self.lookup_routes_with_single_shipment_preference(
            &[country_route_token(country)],
            sku,
            quantity,
            prefer_single_shipment,
        )
    }

    fn lookup_routes_with_single_shipment_preference(
        &self,
        country_routes: &[String],
        sku: &str,
        quantity: i64,
        prefer_single_shipment: bool,
    ) -> Lookup {
        if prefer_single_shipment
            && let Some(single_shipment) = &self.single_shipment
            && single_shipment.has_route_sku(country_routes, sku)
        {
            return single_shipment.lookup_routes(country_routes, sku, quantity);
        }
        self.lookup_routes(country_routes, sku, quantity)
    }

    #[cfg(test)]
    fn lookup(&self, country: &str, sku: &str, quantity: i64) -> Lookup {
        self.lookup_routes(&[country_route_token(country)], sku, quantity)
    }

    fn has_route_sku(&self, country_routes: &[String], sku: &str) -> bool {
        country_routes
            .iter()
            .any(|route| self.quantity_keys.contains(&prefix_key(route, sku)))
    }

    fn lookup_routes(&self, country_routes: &[String], sku: &str, quantity: i64) -> Lookup {
        let country_routes = country_routes
            .iter()
            .map(|route| country_route_token(route))
            .filter(|route| !route.is_empty())
            .collect::<Vec<_>>();
        if country_routes.is_empty() || sku.is_empty() {
            return Lookup {
                status: "SKU或国家缺失",
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: self.source_sheet.clone(),
                reason: "订单国家原值或 SKU 缺失".to_string(),
            };
        }
        let route = country_routes
            .iter()
            .find(|route| self.quantity_keys.contains(&prefix_key(route, sku)));
        let Some(route) = route else {
            let existing_routes = country_routes
                .iter()
                .filter(|route| self.country_routes.contains(*route))
                .cloned()
                .collect::<Vec<_>>();
            let (status, reason) = if existing_routes.is_empty() {
                (
                    "国家路由不存在",
                    format!(
                        "核价 Sheet {} 没有国家路由 [{}]",
                        self.source_sheet,
                        country_routes.join(" / ")
                    ),
                )
            } else {
                (
                    "SKU不存在",
                    format!(
                        "核价 Sheet {} 的国家路由 [{}] 没有 SKU {}",
                        self.source_sheet,
                        existing_routes.join(" / "),
                        sku
                    ),
                )
            };
            return Lookup {
                status,
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: self.source_sheet.clone(),
                reason,
            };
        };
        let key = full_key(route, sku, quantity);
        if let Some(entries) = self.entries.get(&key) {
            if entries.len() != 1 {
                let entry = &entries[0];
                return Lookup {
                    status: "核价键重复",
                    price: None,
                    matched_sku: sku.to_string(),
                    source_sheet: entry.sheet_name.clone(),
                    reason: format!(
                        "核价 Sheet {} 中国家路由 {}、SKU {}、数量 {} 对应多个价格",
                        entry.sheet_name, route, sku, quantity
                    ),
                };
            }
            let entry = &entries[0];
            if let Some(price) = entry.price {
                return Lookup {
                    status: "matched",
                    price: Some(price),
                    matched_sku: sku.to_string(),
                    source_sheet: entry.sheet_name.clone(),
                    reason: String::new(),
                };
            }
            return Lookup {
                status: "价格不可用",
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: entry.sheet_name.clone(),
                reason: format!(
                    "核价 Sheet {} 中国家路由 {}、SKU {}、数量 {} 的价格不可用: {}",
                    entry.sheet_name, route, sku, quantity, entry.raw_price
                ),
            };
        }
        Lookup {
            status: "数量档位不存在",
            price: None,
            matched_sku: sku.to_string(),
            source_sheet: self.source_sheet.clone(),
            reason: format!(
                "核价 Sheet {} 的国家路由 {}、SKU {} 没有数量 {} 对应的档位",
                self.source_sheet, route, sku, quantity
            ),
        }
    }
}

fn cell_text(row: &[CellValue], column: Option<usize>) -> String {
    column
        .and_then(|value| value.checked_sub(1))
        .and_then(|index| row.get(index))
        .map(CellValue::text)
        .unwrap_or_default()
}

fn prefix_key(country: &str, sku: &str) -> String {
    format!("{}\u{1f}{}", country, sku)
}

fn full_key(country: &str, sku: &str, quantity: i64) -> String {
    format!("{}\u{1f}{}\u{1f}{}", country, sku, quantity)
}

fn output_path_for(input_path: &Path, output_dir: &Path) -> PathBuf {
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名");
    let extension = match input_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("xlsm") => "xlsm",
        _ => "xlsx",
    };
    let file_name = format!("{}_核价结果.{extension}", safe_file_name(stem));
    output_dir.join(file_name)
}

fn safe_file_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches(['.', ' '])
        .to_string();
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

#[cfg(test)]
include!("../../../test/backend/processor/pricing.test.rs");
