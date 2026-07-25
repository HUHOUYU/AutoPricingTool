use crate::config::{Config, CountryIdentity, FieldRule, PricingRules, load_config};
use crate::country_catalog::COUNTRY_ALIASES;
use crate::excel_engine::{CellValue, SheetData};
use crate::ipc::{config_path, emit};
use crate::reader::read_workbook_for_processing;
use crate::state::RuntimeState;
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const ORDER_HEADER_SCAN_ROWS: usize = 30;
const PRICE_HEADER_SCAN_ROWS: usize = 24;
const PRICE_TIER_LOOKAHEAD_ROWS: usize = 2;
const FIXED_PRICE_QUANTITY: i64 = 1;
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
const SHIPPING_ALIASES: &[&str] = &[
    "物流方式",
    "运输方式",
    "配送方式",
    "物流",
    "shippingmethod",
    "shipping method",
    "shipping",
    "transportation",
    "transport",
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
const FIXED_PRICE_ALIASES: &[&str] = &["productshippingvattax", "shippingvattax"];
const SINGLE_SHIPMENT_FIELD_ALIASES: &[&str] =
    &["name", "收件人", "收货人", "收件人姓名", "收货人姓名"];
const SINGLE_SHIPMENT_PRICE_MARKER: &str = "单独发货价格";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkuQtyPair {
    pub(crate) sku_column: usize,
    pub(crate) qty_column: usize,
    pub(crate) merged_qty_column: usize,
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
    pub(crate) shipping_method_column: Option<usize>,
    pub(crate) single_shipment_column: Option<usize>,
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
    pub(crate) shipping_method_column: Option<usize>,
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
    pub(crate) shipping_method_column: Option<usize>,
    pub(crate) single_shipment_column: Option<usize>,
    pub(crate) order_price_column: Option<usize>,
    pub(crate) pricing_sheet: String,
    pub(crate) pricing_header_row: usize,
    pub(crate) pricing_quantity_header_row: Option<usize>,
    pub(crate) pricing_sku_column: usize,
    pub(crate) pricing_country_column: usize,
    pub(crate) pricing_shipping_method_column: Option<usize>,
    pub(crate) quantity_tier_columns: Vec<PriceTierColumn>,
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
    pub(crate) shipping_method: String,
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
    inferred_shipping: String,
    conflict: bool,
    reason: String,
}

#[derive(Debug, Clone)]
struct OrderLine {
    business_order_number: String,
    country: CountryInfo,
    shipping_method: String,
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
    pub(crate) shipping_method: String,
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
    pub(crate) quantity: usize,
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
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricePreviewWritebackRow {
    source_row: usize,
    pricing_price: Option<f64>,
    price_difference: Option<f64>,
    quantity: usize,
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
        let mapping = mappings
            .get(&path.display().to_string())
            .cloned()
            .or_else(|| {
                analyze_path_with_templates(path, &config, &header_templates)
                    .ok()
                    .and_then(|item| item.suggested_mapping)
            });
        let Some(mapping) = mapping else {
            let message = "没有可以执行的字段映射".to_string();
            failures.push(json!({"path": path, "message": message}));
            emit(
                json!({"type": "price-file-result", "path": path, "status": "failed", "message": message}),
            );
            continue;
        };

        match process_price_file(path, &output_dir, &mapping, &config, state) {
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
    let config = load_config(&config_path(command))?;
    let result = validate_price_mapping(Path::new(input_path), &mapping, &config);
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
            "errors": errors,
            "warnings": [],
        })),
    }
    Ok(())
}

fn validate_price_mapping(
    path: &Path,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> std::result::Result<MappingValidationResult, Vec<String>> {
    let workbook = read_workbook_for_processing(path, config)
        .map_err(|error| vec![format!("读取文件失败: {error:#}")])?;
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
        mapping.shipping_method_column,
        mapping.single_shipment_column,
        mapping.order_price_column,
    ]
    .into_iter()
    .flatten()
    .chain(
        mapping
            .sku_qty_pairs
            .iter()
            .flat_map(|pair| [pair.qty_column, pair.sku_column, pair.merged_qty_column]),
    )
    .collect::<Vec<_>>();
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
            .pricing_shipping_method_column
            .is_some_and(|column| column == 0 || column > pricing_columns)
        || mapping
            .quantity_tier_columns
            .iter()
            .any(|tier| tier.column == 0 || tier.column > pricing_columns || tier.quantity < 0)
    {
        errors.push("核价字段列或数量档位超出有效范围".to_string());
    }
    if mapping.sku_qty_pairs.iter().any(|pair| {
        pair.sku_column == pair.qty_column
            || pair.sku_column == pair.merged_qty_column
            || pair.qty_column == pair.merged_qty_column
    }) {
        errors.push("原始数量、SKU 与合并数量列不能相同".to_string());
    }
    if mapping.sku_qty_pairs.iter().any(|pair| {
        pair.qty_column + 1 != pair.sku_column || pair.sku_column + 1 != pair.merged_qty_column
    }) {
        errors.push("SKU 组必须按“原始数量、SKU、合并数量”三列连续排列".to_string());
    }
    let recognized_quantity_columns = configured_matching_columns(
        order_sheet,
        mapping.order_header_row.saturating_sub(1),
        order_field_rule(config, "quantity"),
        QTY_ALIASES,
    );
    if mapping.sku_qty_pairs.iter().any(|pair| {
        !recognized_quantity_columns.contains(&pair.qty_column.saturating_sub(1))
            || !recognized_quantity_columns.contains(&pair.merged_qty_column.saturating_sub(1))
    }) {
        errors.push("SKU 前后的原始数量列和合并数量列必须为有效数量列".to_string());
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
    if let Some(column) = mapping.pricing_shipping_method_column
        && !pricing_unique_columns.insert(column)
    {
        errors.push("核价字段映射中存在重复列".to_string());
    }
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

    let index = build_price_index(pricing_sheet, mapping);
    let lines = read_order_lines(order_sheet, mapping, config).0;
    let evaluated_rows = lines.len();
    let (matched_rows, matched_order_rows) = evaluate_matches(&index, &lines);
    let writeback_rows = calculate_preview_writeback_rows(order_sheet, mapping, &index, &lines);
    let coverage = ratio(matched_rows, evaluated_rows);
    let mut warnings = Vec::new();
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
        warnings,
    })
}

fn evaluate_matches(index: &PriceIndex, lines: &[OrderLine]) -> (usize, Vec<usize>) {
    let mut matched_rows = 0;
    let mut order_row_matches = HashMap::new();
    for line in lines {
        let lookup = index.lookup_with_single_shipment_preference(
            &line.country.code,
            &line.matched_sku,
            &line.shipping_method,
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
) -> Vec<PricePreviewWritebackRow> {
    let mut matched_candidates = HashMap::new();
    for item in aggregate_lines(lines) {
        let lookup = index.lookup_with_single_shipment_preference(
            &item.country_code,
            &item.matched_sku,
            &item.shipping_method,
            item.total_quantity.round() as i64,
            item.single_shipment,
        );
        if lookup.status == "matched"
            && let Some(pricing_price) = lookup.price
        {
            record_matched_candidates(&mut matched_candidates, &item, pricing_price);
        }
    }
    build_writeback_rows(order_sheet, mapping, &matched_candidates)
        .into_iter()
        .map(|row| PricePreviewWritebackRow {
            source_row: row.source_row,
            pricing_price: row.pricing_price,
            price_difference: row.price_difference,
            quantity: row.quantity,
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

fn command_mappings(command: &Value) -> Result<HashMap<String, PriceCheckMapping>> {
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
        result.insert(path.to_string(), mapping);
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
            let index = build_price_index(pricing_sheet, &mapping);
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
                        let index = build_price_index(pricing_sheet, &mapping);
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
    let writeback_rows = suggested_mapping
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
            let index = build_price_index(pricing_sheet, mapping);
            let lines = read_order_lines(order_sheet, mapping, config).0;
            Some(calculate_preview_writeback_rows(
                order_sheet,
                mapping,
                &index,
                &lines,
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
        shipping_method_column: order.shipping_method_column,
        single_shipment_column: order.single_shipment_column,
        order_price_column: order.price_column,
        pricing_sheet: pricing.sheet_name.clone(),
        pricing_header_row: pricing.header_row,
        pricing_quantity_header_row: pricing.quantity_header_row,
        pricing_sku_column: pricing.sku_column.unwrap_or(1),
        pricing_country_column: pricing.country_column.unwrap_or(1),
        pricing_shipping_method_column: pricing.shipping_method_column,
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
                    merged_qty_column: order_fields[2].column + 1,
                    sku_header: order_fields[2].header.clone(),
                    qty_header: order_fields[3].header.clone(),
                    merged_qty_header: sheet_cell_text(
                        order_sheet,
                        order.header_row,
                        order_fields[2].column + 1,
                    ),
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
        let pairs = highest_sku_quantity_group(header, &detected_pairs, &qty_columns);
        if order_col.is_none() && detected_pairs.is_empty() {
            continue;
        }
        let (country_code, country_en, country_cn) =
            infer_order_country_columns(sheet, header_idx, config);
        let country_en = country_en.filter(|column| Some(*column) != country_code);
        let country_cn = country_cn
            .filter(|column| Some(*column) != country_code && Some(*column) != country_en);
        let shipping = best_shipping_column(
            sheet,
            header_idx,
            order_field_rule(config, "shipping_method"),
            order_field_rule(config, "price"),
            None,
        );
        let single_shipment =
            configured_best_column(sheet, header_idx, None, SINGLE_SHIPMENT_FIELD_ALIASES);
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
        if detected_pairs.len() > 1 {
            notes.push(format!(
                "识别到 {} 组数量/SKU/合并数量字段，仅使用最高优先级 SKU 组",
                detected_pairs.len()
            ));
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
            shipping_method_column: shipping.map(|column| column + 1),
            single_shipment_column: single_shipment.map(|column| column + 1),
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
        let shipping_column = best_shipping_column(
            sheet,
            header_idx,
            pricing_field_rule(config, "shipping_method"),
            pricing_field_rule(config, "fixed_price"),
            pricing_field_rule(config, "fixed_price"),
        );
        let tier_row = (header_idx..=header_idx.saturating_add(PRICE_TIER_LOOKAHEAD_ROWS))
            .filter(|row_idx| {
                *row_idx < sheet.rows.len()
                    && (*row_idx == header_idx || row_idx.saturating_add(1) < sheet.rows.len())
            })
            .filter_map(|row_idx| {
                let tiers = tier_columns(
                    &sheet.rows[row_idx],
                    sku_column,
                    country_column,
                    shipping_column,
                );
                (!tiers.is_empty()).then_some((row_idx, tiers))
            })
            .max_by_key(|(row_idx, tiers)| (tiers.len(), std::cmp::Reverse(*row_idx)));
        let fixed_price_column = best_fixed_price_column(
            sheet,
            header_idx,
            pricing_field_rule(config, "fixed_price"),
            [sku_column, country_column, shipping_column]
                .into_iter()
                .flatten()
                .collect::<HashSet<_>>(),
        );
        let (quantity_header_row, tiers, fixed_price) = if let Some((row_idx, tiers)) = tier_row {
            ((row_idx != header_idx).then_some(row_idx + 1), tiers, false)
        } else if let Some(column) = fixed_price_column {
            (
                None,
                vec![PriceTierColumn {
                    quantity: FIXED_PRICE_QUANTITY,
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
        let excluded = [Some(sku_column), Some(country_column), shipping_column]
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
        if fixed_price {
            notes.push("使用固定单价列作为数量 1 档位".to_string());
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
            shipping_method_column: shipping_column.map(|column| column + 1),
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
        let is_english = samples.iter().any(|value| {
            !has_chinese(value)
                && value.len() > 2
                && country_lookup(&split_country_shipping(value).0).is_some()
        });
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
                let base = split_country_shipping(&value).0;
                if country_lookup(&base).is_some() {
                    recognized += 1;
                    let trimmed = base.trim();
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

fn best_fixed_price_column(
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
            let header_score = configured_header_score(&value, rule, FIXED_PRICE_ALIASES)
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
            let header_score = configured_header_score(&cell.text(), rule, fallback_aliases);
            if header_score <= 0 {
                return None;
            }
            let score = header_score
                + field_sample_adjustment(sheet, header_idx, column, rule, ORDER_HEADER_SCAN_ROWS);
            (score > 0).then_some((score, column))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(score, column)| (std::cmp::Reverse(*score), *column));
    candidates.into_iter().map(|(_, column)| column).collect()
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

fn best_shipping_column(
    sheet: &SheetData,
    header_idx: usize,
    shipping_rule: Option<&FieldRule>,
    price_rule: Option<&FieldRule>,
    fixed_price_rule: Option<&FieldRule>,
) -> Option<usize> {
    sheet.rows[header_idx]
        .iter()
        .enumerate()
        .filter_map(|(index, cell)| {
            let normalized = normalize_header(&cell.text());
            if normalized.contains("COUNTRY")
                || normalized.contains("国家")
                || configured_header_score(&normalized, price_rule, PRICE_ALIASES) > 0
                || configured_header_score(&normalized, fixed_price_rule, FIXED_PRICE_ALIASES) > 0
                || (normalized.starts_with("SHIPPING")
                    && normalized != "SHIPPING"
                    && !normalized.contains("METHOD"))
            {
                return None;
            }
            let score = configured_header_score(&normalized, shipping_rule, SHIPPING_ALIASES)
                + field_sample_adjustment(
                    sheet,
                    header_idx,
                    index,
                    shipping_rule,
                    ORDER_HEADER_SCAN_ROWS,
                );
            (score > 0).then_some((score, index))
        })
        .max_by_key(|(score, index)| (*score, std::cmp::Reverse(*index)))
        .map(|(_, index)| index)
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
            candidates.push((
                sku_column.abs_diff(qty_column),
                std::cmp::Reverse(sku_column.max(qty_column)),
                std::cmp::Reverse(sku_column),
                sku_column,
                qty_column,
            ));
        }
    }
    candidates.sort_by_key(|candidate| (candidate.0, candidate.1, candidate.2));

    let mut pairs = Vec::new();
    let mut used_columns = HashSet::new();
    for (_, _, _, sku_column, qty_column) in candidates {
        if used_columns.contains(&sku_column) || used_columns.contains(&qty_column) {
            continue;
        }
        used_columns.insert(sku_column);
        used_columns.insert(qty_column);
        pairs.push(SkuQtyPair {
            sku_column: sku_column + 1,
            qty_column: qty_column + 1,
            merged_qty_column: sku_column + 2,
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
    shipping_column: Option<usize>,
) -> Vec<PriceTierColumn> {
    let excluded = [sku_column, country_column, shipping_column]
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

fn normalize_sku(value: &str) -> String {
    normalize_sku_and_multiplier(value).0
}

fn normalize_sku_and_multiplier(value: &str) -> (String, usize) {
    let normalized = value
        .trim()
        .replace([' ', '\u{3000}', '\t', '\r', '\n'], "")
        .to_ascii_uppercase();
    let Some((sku, multiplier)) = normalized.rsplit_once('*') else {
        return (normalized, 1);
    };
    let multiplier = multiplier.parse::<usize>().ok().filter(|value| *value > 0);
    match multiplier {
        Some(multiplier) if !sku.is_empty() => (sku.to_string(), multiplier),
        _ => (normalized, 1),
    }
}

fn normalize_shipping(value: &str) -> String {
    value
        .trim()
        .replace([' ', '\u{3000}', '\t', '\r', '\n'], "")
        .to_ascii_lowercase()
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

fn split_country_shipping(value: &str) -> (String, String) {
    let trimmed = value.trim();
    if country_lookup(trimmed).is_some() {
        return (trimmed.to_string(), String::new());
    }
    for separator in ['-', '—', '_'] {
        if let Some((base, suffix)) = trimmed.rsplit_once(separator)
            && country_lookup(base).is_some()
        {
            return (base.trim().to_string(), suffix.trim().to_string());
        }
    }
    (trimmed.to_string(), String::new())
}

fn normalize_country_fields(code: &str, english: &str, chinese: &str) -> CountryInfo {
    let inputs = [code, english, chinese];
    let mut resolved = Vec::new();
    let mut inferred_shipping = String::new();
    for input in inputs {
        if input.trim().is_empty() {
            continue;
        }
        let (base, shipping) = split_country_shipping(input);
        if inferred_shipping.is_empty() && !shipping.is_empty() {
            inferred_shipping = normalize_shipping(&shipping);
        }
        if let Some(item) = country_lookup(&base) {
            resolved.push((item.0.to_string(), item.1.to_string(), item.2.to_string()));
        } else if base.len() == 2
            && base
                .chars()
                .all(|character| character.is_ascii_alphabetic())
        {
            resolved.push((base.to_ascii_uppercase(), String::new(), String::new()));
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
            inferred_shipping,
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
        inferred_shipping,
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
    normalize_country_fields(
        if rules.uses_country_identity(CountryIdentity::Iso2) {
            code
        } else {
            ""
        },
        if rules.uses_country_identity(CountryIdentity::English) {
            english
        } else {
            ""
        },
        if rules.uses_country_identity(CountryIdentity::Chinese) {
            chinese
        } else {
            ""
        },
    )
}

fn highest_priority_sku_qty_pair(mapping: &PriceCheckMapping) -> Option<(usize, &SkuQtyPair)> {
    mapping
        .sku_qty_pairs
        .iter()
        .enumerate()
        .max_by_key(|(_, pair)| (pair.merged_qty_column, pair.sku_column))
}

fn normalize_single_shipment_value(value: &str) -> String {
    value.trim().to_lowercase()
}

fn single_shipment_values_by_order(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
) -> HashMap<String, HashSet<String>> {
    let Some(column) = mapping.single_shipment_column else {
        return HashMap::new();
    };
    let mut orders_by_value: HashMap<String, HashSet<String>> = HashMap::new();
    for row in sheet.rows.iter().skip(mapping.order_header_row) {
        let business_order_number = cell_text(row, mapping.business_order_number_column);
        let value = normalize_single_shipment_value(&cell_text(row, Some(column)));
        if business_order_number.is_empty() || value.is_empty() {
            continue;
        }
        orders_by_value
            .entry(value)
            .or_default()
            .insert(business_order_number);
    }
    orders_by_value
}

fn read_order_lines(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> (Vec<OrderLine>, Vec<PriceCheckException>) {
    let mut lines = Vec::new();
    let mut exceptions = Vec::new();
    let single_shipment_values = single_shipment_values_by_order(sheet, mapping);
    let data_start = mapping.order_header_row;
    for (row_index, row) in sheet.rows.iter().enumerate().skip(data_start) {
        let business = cell_text(row, mapping.business_order_number_column);
        let code = cell_text(row, mapping.country_code_column);
        let english = cell_text(row, mapping.country_english_column);
        let chinese = cell_text(row, mapping.country_chinese_column);
        let mut country =
            normalize_order_country_fields(&code, &english, &chinese, &config.pricing);
        let shipping_from_column = cell_text(row, mapping.shipping_method_column);
        let shipping = if shipping_from_column.is_empty() {
            country.inferred_shipping.clone()
        } else {
            normalize_shipping(&shipping_from_column)
        };
        let single_shipment_value = mapping
            .single_shipment_column
            .map(|column| normalize_single_shipment_value(&cell_text(row, Some(column))))
            .unwrap_or_default();
        let single_shipment = !single_shipment_value.is_empty()
            && single_shipment_values
                .get(&single_shipment_value)
                .is_some_and(|orders| orders.len() == 1 && orders.contains(&business));
        if business.is_empty() {
            continue;
        }
        let mut row_has_sku = false;
        if let Some((sku_pair_priority, pair)) = highest_priority_sku_qty_pair(mapping) {
            let raw_sku = cell_text(row, Some(pair.sku_column));
            if raw_sku.is_empty() {
                continue;
            }
            row_has_sku = true;
            let quantity = row
                .get(pair.qty_column.saturating_sub(1))
                .and_then(parse_number);
            let Some(quantity) = quantity.filter(|value| *value >= 0.0) else {
                exceptions.push(PriceCheckException {
                    file_path: String::new(),
                    sheet_name: sheet.name.clone(),
                    source_row: Some(row_index + 1),
                    kind: "数量无效".to_string(),
                    message: format!("SKU {} 没有可用数量", raw_sku),
                });
                continue;
            };
            if quantity.fract() != 0.0 {
                exceptions.push(PriceCheckException {
                    file_path: String::new(),
                    sheet_name: sheet.name.clone(),
                    source_row: Some(row_index + 1),
                    kind: "数量无效".to_string(),
                    message: format!("SKU {} 的数量不是整数: {}", raw_sku, quantity),
                });
                continue;
            }
            if country.conflict {
                exceptions.push(PriceCheckException {
                    file_path: String::new(),
                    sheet_name: sheet.name.clone(),
                    source_row: Some(row_index + 1),
                    kind: "国家三要素冲突".to_string(),
                    message: country.reason.clone(),
                });
                continue;
            }
            let (matched_sku, sku_multiplier) = normalize_sku_and_multiplier(&raw_sku);
            lines.push(OrderLine {
                business_order_number: business.clone(),
                country: country.clone(),
                shipping_method: shipping.clone(),
                single_shipment,
                original_sku: raw_sku,
                matched_sku,
                quantity: quantity * sku_multiplier as f64,
                original_price: mapping
                    .order_price_column
                    .and_then(|column| row.get(column.saturating_sub(1)))
                    .and_then(parse_price),
                source_sheet: sheet.name.clone(),
                source_row: row_index + 1,
                sku_pair_priority,
            });
        }
        if !row_has_sku && !mapping.sku_qty_pairs.is_empty() {
            exceptions.push(PriceCheckException {
                file_path: String::new(),
                sheet_name: sheet.name.clone(),
                source_row: Some(row_index + 1),
                kind: "SKU为空".to_string(),
                message: "订单记录没有可用 SKU".to_string(),
            });
        }
        let has_enabled_country_value = [
            (CountryIdentity::Iso2, &code),
            (CountryIdentity::English, &english),
            (CountryIdentity::Chinese, &chinese),
        ]
        .into_iter()
        .any(|(identity, value)| {
            config.pricing.uses_country_identity(identity) && !value.is_empty()
        });
        if !country.conflict && country.code.is_empty() && has_enabled_country_value {
            country.reason = "国家字段无法标准化".to_string();
        }
    }
    (lines, exceptions)
}

fn build_price_index(sheet: &SheetData, mapping: &PriceCheckMapping) -> PriceIndex {
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
                        normalize_header(&cell.text())
                            == normalize_header(SINGLE_SHIPMENT_PRICE_MARKER)
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
    if raw_sku.is_empty() || raw_country.is_empty() {
        return;
    }
    let (country_base, country_shipping) = split_country_shipping(&raw_country);
    let country = normalize_country_fields(&country_base, "", "");
    if country.code.is_empty() {
        return;
    }
    let shipping_column = cell_text(row, mapping.pricing_shipping_method_column);
    let shipping = if shipping_column.is_empty() {
        normalize_shipping(&country_shipping)
    } else {
        normalize_shipping(&shipping_column)
    };
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
        let key = full_key(&country.code, &sku, &shipping, tier.quantity);
        index
            .quantity_keys
            .insert(prefix_key(&country.code, &sku, &shipping));
        index.entries.entry(key).or_default().push(entry);
    }
}

fn aggregate_lines(lines: &[OrderLine]) -> Vec<AggregatedOrderSku> {
    let mut result: Vec<AggregatedOrderSku> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for line in lines {
        let key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            line.business_order_number,
            line.country.code,
            line.matched_sku,
            line.shipping_method,
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
                shipping_method: line.shipping_method.clone(),
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

fn build_writeback_rows(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    candidates: &HashMap<usize, MatchedRowCandidate>,
) -> Vec<PriceWritebackRow> {
    let Some((_, pair)) = highest_priority_sku_qty_pair(mapping) else {
        return Vec::new();
    };
    let mut group_quantities: HashMap<(String, String), usize> = HashMap::new();
    for row in sheet.rows.iter().skip(mapping.order_header_row) {
        let order_number = cell_text(row, mapping.business_order_number_column);
        if order_number.is_empty() {
            continue;
        }
        let (sku, sku_multiplier) =
            normalize_sku_and_multiplier(&cell_text(row, Some(pair.sku_column)));
        let row_quantity = row
            .get(pair.qty_column.saturating_sub(1))
            .and_then(parse_number)
            .filter(|value| *value >= 0.0 && value.fract() == 0.0)
            .map(|value| value as usize * sku_multiplier);
        if !sku.is_empty() {
            *group_quantities.entry((order_number, sku)).or_default() +=
                row_quantity.unwrap_or_default();
        }
    }

    let mut seen_groups = HashSet::new();
    let mut rows = Vec::new();
    for (row_index, row) in sheet.rows.iter().enumerate().skip(mapping.order_header_row) {
        let order_number = cell_text(row, mapping.business_order_number_column);
        if order_number.is_empty() {
            continue;
        }
        let source_row = row_index + 1;
        let candidate = candidates.get(&source_row);
        let sku = normalize_sku(&cell_text(row, Some(pair.sku_column)));
        let quantity = if sku.is_empty() {
            0
        } else {
            let group = (order_number, sku);
            if seen_groups.insert(group.clone()) {
                group_quantities.get(&group).copied().unwrap_or_default()
            } else {
                0
            }
        };
        let merged_quantity = row
            .get(pair.merged_qty_column.saturating_sub(1))
            .and_then(parse_number)
            .filter(|value| *value >= 0.0 && value.fract() == 0.0)
            .map(|value| value as usize);
        let original_price = mapping
            .order_price_column
            .and_then(|column| row.get(column.saturating_sub(1)))
            .and_then(parse_price);
        rows.push(PriceWritebackRow {
            source_row,
            sku_pair_priority: candidate.map(|value| value.sku_pair_priority),
            matched: candidate.is_some(),
            pricing_price: candidate.map(|value| value.pricing_price),
            price_difference: candidate
                .and_then(|value| original_price.map(|original| value.pricing_price - original)),
            quantity,
            quantity_mismatch: merged_quantity != Some(quantity),
        });
    }
    rows
}

fn process_price_file(
    input_path: &Path,
    output_dir: &Path,
    mapping: &PriceCheckMapping,
    config: &Config,
    state: &RuntimeState,
) -> Result<PriceCheckReport> {
    crate::pricing_writer::validate_source_format(input_path)?;
    let order_price_column = mapping
        .order_price_column
        .ok_or_else(|| anyhow!("订单 Sheet 找不到 TOTAL Price/原始价格列，未生成结果文件"))?;
    let workbook = read_workbook_for_processing(input_path, config)?;
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
    let (lines, mut exceptions) = read_order_lines(order_sheet, mapping, config);
    for exception in &mut exceptions {
        exception.file_path = input_path.display().to_string();
    }
    let aggregated = aggregate_lines(&lines);
    let index = build_price_index(pricing_sheet, mapping);
    let mut rows = Vec::new();
    let mut matched_rows = 0;
    let mut matched_candidates = HashMap::new();
    for (position, item) in aggregated.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            break;
        }
        let lookup = index.lookup_with_single_shipment_preference(
            &item.country_code,
            &item.matched_sku,
            &item.shipping_method,
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
        let difference = match (item.original_price, lookup.price) {
            (Some(original), Some(pricing)) => Some(pricing - original),
            _ => None,
        };
        rows.push(PriceCheckRow {
            business_order_number: item.business_order_number.clone(),
            country_code: item.country_code.clone(),
            country_english_name: item.country_english_name.clone(),
            country_chinese_name: item.country_chinese_name.clone(),
            shipping_method: item.shipping_method.clone(),
            original_sku: item.original_sku.clone(),
            matched_sku: lookup.matched_sku.clone(),
            total_quantity: item.total_quantity,
            original_price: item.original_price,
            pricing_price: lookup.price,
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
    let output_path = output_path_for(input_path, output_dir);
    let writeback_rows = build_writeback_rows(order_sheet, mapping, &matched_candidates);
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
        mapping.order_header_row,
        order_price_column,
        &writeback_rows,
    )?;
    report.output_path = output_path.display().to_string();
    Ok(report)
}

impl PriceIndex {
    fn lookup_with_single_shipment_preference(
        &self,
        country: &str,
        sku: &str,
        shipping: &str,
        quantity: i64,
        prefer_single_shipment: bool,
    ) -> Lookup {
        if prefer_single_shipment && let Some(single_shipment) = &self.single_shipment {
            let lookup = single_shipment.lookup(country, sku, shipping, quantity);
            if lookup.status != "SKU或国家无法匹配" {
                return lookup;
            }
        }
        self.lookup(country, sku, shipping, quantity)
    }

    fn lookup(&self, country: &str, sku: &str, shipping: &str, quantity: i64) -> Lookup {
        if country.is_empty() || sku.is_empty() {
            return Lookup {
                status: "SKU或国家缺失",
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: String::new(),
                reason: "国家或 SKU 无法标准化".to_string(),
            };
        }
        let shipping = normalize_shipping(shipping);
        let saw_quantity_key = self
            .quantity_keys
            .contains(&prefix_key(country, sku, &shipping));
        let key = full_key(country, sku, &shipping, quantity);
        if let Some(entries) = self.entries.get(&key) {
            if entries.len() != 1 {
                let entry = &entries[0];
                return Lookup {
                    status: "核价键重复",
                    price: None,
                    matched_sku: sku.to_string(),
                    source_sheet: entry.sheet_name.clone(),
                    reason: "相同国家、SKU、数量和物流方式对应多个价格，未静默选择".to_string(),
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
                reason: format!("核价单元格不可用: {}", entry.raw_price),
            };
        }
        Lookup {
            status: if saw_quantity_key {
                "数量无对应档位"
            } else {
                "SKU或国家无法匹配"
            },
            price: None,
            matched_sku: sku.to_string(),
            source_sheet: String::new(),
            reason: if saw_quantity_key {
                format!("核价表没有数量 {} 对应的档位", quantity)
            } else {
                "核价表没有对应的国家和 SKU".to_string()
            },
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

fn prefix_key(country: &str, sku: &str, shipping: &str) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        country,
        sku,
        normalize_shipping(shipping)
    )
}

fn full_key(country: &str, sku: &str, shipping: &str, quantity: i64) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        country,
        sku,
        normalize_shipping(shipping),
        quantity
    )
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
mod tests {
    use super::*;
    use regex::Regex;

    #[test]
    fn configured_alias_order_breaks_header_ties() {
        let preferred_first = FieldRule {
            header_aliases: vec!["Stock code".to_string(), "SKU".to_string()],
            ..FieldRule::default()
        };
        let sku_first = FieldRule {
            header_aliases: vec!["SKU".to_string(), "Stock code".to_string()],
            ..FieldRule::default()
        };

        assert!(
            configured_header_score("Stock code", Some(&preferred_first), &[])
                > configured_header_score("Stock code", Some(&sku_first), &[])
        );
    }

    #[test]
    fn configured_value_pattern_disambiguates_duplicate_headers() {
        let rule = FieldRule {
            header_aliases: vec!["SKU".to_string()],
            value_patterns: vec!["(?i)^[a-z]{2}\\d{6}$".to_string()],
            compiled_value_patterns: vec![Regex::new("(?i)^[a-z]{2}\\d{6}$").unwrap()],
            ..FieldRule::default()
        };
        let sheet = SheetData {
            name: "order".to_string(),
            rows: vec![
                vec![CellValue::string("SKU"), CellValue::string("SKU")],
                vec![CellValue::string("Red shoe"), CellValue::string("AB260001")],
                vec![
                    CellValue::string("Blue shoe"),
                    CellValue::string("AB260002"),
                ],
            ],
        };

        assert_eq!(
            configured_best_column(&sheet, 0, Some(&rule), SKU_ALIASES),
            Some(1)
        );
    }

    #[test]
    fn pricing_country_prefers_code_then_english_then_chinese() {
        let sheet_with_code = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("国家"),
                    CellValue::string("COUNTRY"),
                    CellValue::string("Country Code"),
                ],
                vec![
                    CellValue::string("美国"),
                    CellValue::string("UNITED STATES-hold"),
                    CellValue::string("US-hold"),
                ],
                vec![
                    CellValue::string("英国"),
                    CellValue::string("UNITED KINGDOM"),
                    CellValue::string("GB"),
                ],
            ],
        };
        assert_eq!(
            best_pricing_country_column(&sheet_with_code, 0, None),
            Some(2)
        );

        let sheet_without_code = SheetData {
            name: "price".to_string(),
            rows: sheet_with_code
                .rows
                .iter()
                .map(|row| row[..2].to_vec())
                .collect(),
        };
        assert_eq!(
            best_pricing_country_column(&sheet_without_code, 0, None),
            Some(1)
        );
    }

    #[test]
    fn platform_order_header_is_treated_as_the_single_order_number() {
        let mut config = Config::default();
        config.pricing_fields.order.insert(
            "order_number".to_string(),
            FieldRule {
                header_aliases: vec!["平台订单号".to_string()],
                ..FieldRule::default()
            },
        );
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("平台订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("SKU"),
                    CellValue::string("数量"),
                ],
                vec![
                    CellValue::string("ORD-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-1"),
                    CellValue::string("1"),
                ],
            ],
        };

        let candidate =
            infer_order_candidate_with_config(&sheet, &config).expect("order candidate");
        assert_eq!(candidate.business_order_number_column, Some(1));
    }

    #[test]
    fn country_three_fields_are_one_identity() {
        let country = normalize_country_fields("US", "United States", "美国");
        assert_eq!(country.code, "US");
        assert_eq!(country.english, "United States");
        assert_eq!(country.chinese, "美国");
        assert!(!country.conflict);
    }

    #[test]
    fn country_catalog_covers_sheet1_countries_and_business_aliases() {
        assert_eq!(COUNTRY_ALIASES.len(), 254);

        let aruba = normalize_country_fields("", "", "阿鲁巴");
        assert_eq!(
            (
                aruba.code.as_str(),
                aruba.english.as_str(),
                aruba.chinese.as_str()
            ),
            ("AW", "Aruba", "阿鲁巴")
        );

        let united_states = normalize_country_fields("", "America", "");
        assert_eq!(
            (
                united_states.code.as_str(),
                united_states.english.as_str(),
                united_states.chinese.as_str()
            ),
            ("US", "United States", "美国")
        );
    }

    #[test]
    fn country_catalog_covers_current_iso_codes() {
        const CURRENT_ISO_CODES: &str = "\
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ \
BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR \
CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR \
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU \
ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ \
LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ \
MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF \
PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI \
SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR \
TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

        for code in CURRENT_ISO_CODES.split_whitespace() {
            assert!(
                country_lookup(code).is_some(),
                "国家维护表缺少当前 ISO 代码: {code}"
            );
        }
    }

    #[test]
    fn corrected_country_names_keep_legacy_aliases() {
        let cases = [
            ("United Arab Emirates", "AE"),
            ("United Arab Emirates 1", "AE"),
            ("阿联酋", "AE"),
            ("American Samoa", "AS"),
            ("Amercian Samoa", "AS"),
            ("Bangladesh", "BD"),
            ("Bengal", "BD"),
            ("Northern Mariana Islands", "MP"),
            ("Saipan lsland", "MP"),
            ("French Southern Territories", "TF"),
            ("fashunanbulingdi", "TF"),
            ("British Virgin Islands", "VG"),
            ("THE BRITISH VRIGIN ISLANDS", "VG"),
            ("Türkiye", "TR"),
            ("Turkey", "TR"),
        ];

        for (name, expected_code) in cases {
            assert_eq!(
                country_lookup(name).map(|country| country.0),
                Some(expected_code),
                "国家名称或历史别名无法识别: {name}"
            );
        }
    }

    #[test]
    fn country_catalog_rejects_source_placeholders_as_codes() {
        assert!(country_lookup("160").is_none());
        assert!(country_lookup("NULL").is_none());
        assert!(country_lookup("YT_n").is_none());
    }

    #[test]
    fn country_conflict_is_not_silently_resolved() {
        let country = normalize_country_fields("US", "Canada", "美国");
        assert!(country.conflict);
    }

    #[test]
    fn order_country_identity_uses_only_enabled_fields() {
        let english_only = PricingRules {
            country_identity: vec![CountryIdentity::English],
            ..PricingRules::default()
        };
        let country = normalize_order_country_fields("US", "Canada", "美国", &english_only);
        assert_eq!(country.code, "CA");
        assert!(!country.conflict);

        let iso2_only = PricingRules {
            country_identity: vec![CountryIdentity::Iso2],
            ..PricingRules::default()
        };
        let country = normalize_order_country_fields("US", "Canada", "加拿大", &iso2_only);
        assert_eq!(country.code, "US");
        assert!(!country.conflict);

        let chinese_only = PricingRules {
            country_identity: vec![CountryIdentity::Chinese],
            ..PricingRules::default()
        };
        let country = normalize_order_country_fields("US", "Canada", "加拿大", &chinese_only);
        assert_eq!(country.code, "CA");
        assert!(!country.conflict);
    }

    #[test]
    fn quantity_zero_and_invalid_price_are_distinct() {
        assert_eq!(parse_tier("0"), Some(0));
        assert_eq!(parse_price(&CellValue::string("0")), Some(0.0));
        assert_eq!(parse_price(&CellValue::string("/")), None);
        assert_eq!(parse_price(&CellValue::string("未核价")), None);
    }

    #[test]
    fn quantity_headers_accept_compact_units_and_reject_ranges() {
        for (header, expected) in [
            ("1", 1),
            ("2.0", 2),
            ("1 pcs", 1),
            ("2pcs", 2),
            ("3 PC", 3),
            ("4 piece", 4),
            ("5pieces", 5),
            ("6个", 6),
            ("7件", 7),
            ("Qty 8 pcs", 8),
        ] {
            assert_eq!(parse_tier(header), Some(expected), "header: {header}");
        }
        for header in ["1-2", "1~2", "1至2", "pcs1", "one pcs"] {
            assert_eq!(parse_tier(header), None, "header: {header}");
        }
    }

    #[test]
    fn quantity_header_ladder_scores_continuous_columns() {
        let row = vec![
            CellValue::string("SKU"),
            CellValue::string("Country"),
            CellValue::string("1pcs"),
            CellValue::string("2pcs"),
            CellValue::string("4pcs"),
        ];
        let excluded = [0usize, 1usize].into_iter().collect::<HashSet<_>>();
        assert_eq!(numeric_header_ladder_level(&row, &excluded), 2);
    }

    #[test]
    fn order_and_pricing_candidates_are_distinguished_by_fields_and_ladder() {
        let order_sheet = SheetData {
            name: "订单数据".to_string(),
            rows: vec![
                vec![
                    CellValue::string("业务订单号"),
                    CellValue::string("平台订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("英文国家"),
                    CellValue::string("中文国家"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORD-1"),
                    CellValue::string("PLAT-1"),
                    CellValue::string("US"),
                    CellValue::string("United States"),
                    CellValue::string("美国"),
                    CellValue::string("ABC123"),
                    CellValue::string("2"),
                ],
            ],
        };
        let pricing_sheet = SheetData {
            name: "核价表".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1pcs"),
                    CellValue::string("2pcs"),
                    CellValue::string("4pcs"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("9"),
                    CellValue::string("8"),
                ],
            ],
        };

        let order = infer_order_candidate(&order_sheet).expect("order candidate");
        let pricing = infer_pricing_candidate(&pricing_sheet).expect("pricing candidate");
        assert_eq!(order.sheet_name, "订单数据");
        assert!(order.sku_qty_pairs.is_empty());
        assert_eq!(order.country_coverage, 1.0);
        assert_eq!(pricing.sheet_name, "核价表");
        assert_eq!(
            pricing
                .tier_columns
                .iter()
                .map(|tier| tier.quantity)
                .collect::<Vec<_>>(),
            vec![1, 2, 4]
        );
        assert!(
            pricing
                .notes
                .iter()
                .any(|note| note.contains("连续数量档位"))
        );
    }

    #[test]
    fn header_template_matches_before_candidate_fallback() {
        let order_sheet = SheetData {
            name: "Incoming Order".to_string(),
            rows: vec![vec![
                CellValue::string("业务订单号"),
                CellValue::string("平台订单号"),
                CellValue::string("国家二字码"),
                CellValue::string("英文国家"),
                CellValue::string("中文国家"),
                CellValue::string("SKU"),
                CellValue::string("Qty"),
            ]],
        };
        let pricing_sheet = SheetData {
            name: "Incoming Price".to_string(),
            rows: vec![vec![
                CellValue::string("SKU"),
                CellValue::string("Country"),
                CellValue::string("1pcs"),
                CellValue::string("2pcs"),
            ]],
        };
        let order = OrderSheetCandidate {
            sheet_name: order_sheet.name.clone(),
            header_row: 1,
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 6,
                qty_column: 7,
                merged_qty_column: 8,
                sku_header: "SKU".to_string(),
                qty_header: "Qty".to_string(),
                merged_qty_header: "Merged Qty".to_string(),
            }],
            ..OrderSheetCandidate::default()
        };
        let pricing = PricingSheetCandidate {
            sheet_name: pricing_sheet.name.clone(),
            header_row: 1,
            sku_column: Some(1),
            country_column: Some(2),
            tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1pcs".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 4,
                    header: "2pcs".to_string(),
                },
            ],
            ..PricingSheetCandidate::default()
        };
        let template = HeaderTemplateRecord {
            file_name: "template.xlsx".to_string(),
            mappings: vec![
                ("order_number", "Order", 1, "业务订单号"),
                ("country_code", "Order", 3, "国家二字码"),
                ("sku_detail", "Order", 6, "SKU"),
                ("qty_detail", "Order", 7, "Qty"),
                ("pricing_sku", "Pricing", 1, "SKU"),
                ("pricing_country", "Pricing", 2, "Country"),
                ("price", "Pricing", 3, "1pcs"),
                ("price", "Pricing", 4, "2pcs"),
            ]
            .into_iter()
            .map(
                |(field_key, sheet_name, column, header)| HeaderTemplateFieldMapping {
                    field_key: field_key.to_string(),
                    sheet_name: sheet_name.to_string(),
                    column,
                    header: header.to_string(),
                },
            )
            .collect(),
        };

        let matched = match_header_template(
            &[order_sheet, pricing_sheet],
            &[order],
            &[pricing],
            &[template],
        )
        .expect("template match");
        assert_eq!(matched.0, "template.xlsx");
        assert_eq!(matched.1.order_sheet, "Incoming Order");
        assert_eq!(matched.1.pricing_sheet, "Incoming Price");
        assert_eq!(matched.1.sku_qty_pairs[0].sku_column, 6);
        assert_eq!(
            matched
                .1
                .quantity_tier_columns
                .iter()
                .map(|tier| (tier.quantity, tier.column))
                .collect::<Vec<_>>(),
            vec![(1, 3), (2, 4)]
        );
    }

    #[test]
    fn duplicate_sku_quantity_columns_are_ignored_for_valid_order_rows() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("SKU"),
                    CellValue::string("产品总数"),
                    CellValue::string("SKU"),
                    CellValue::string("产品总数"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("ABC-1"),
                    CellValue::string("2"),
                    CellValue::string("ABC-1"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("CA"),
                    CellValue::string("ABC-2"),
                    CellValue::string("1"),
                    CellValue::string("ABC-2"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("total"),
                    CellValue::string("3"),
                ],
            ],
        };

        let candidate = infer_order_candidate(&sheet).expect("order candidate");
        assert_eq!(candidate.sku_qty_pairs.len(), 1);
        assert_eq!(candidate.sku_qty_pairs[0].sku_column, 5);
        assert_eq!(candidate.sku_qty_pairs[0].qty_column, 4);
        assert!(candidate.notes.iter().any(|note| note.contains("完全重复")));
    }

    #[test]
    fn sku_quantity_pairing_uses_nearest_columns_locks_both_headers_and_prefers_right() {
        let header = vec![
            CellValue::string("SKU 1"),
            CellValue::string("Qty 1"),
            CellValue::string("备用"),
            CellValue::string("Qty 2"),
            CellValue::string("SKU 2"),
        ];

        let pairs = pair_sku_qty_columns(&header, &[0, 4], &[1, 3]);

        assert_eq!(
            pairs
                .iter()
                .map(|pair| (pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>(),
            vec![(5, 4), (1, 2)]
        );

        let overlapping_roles = pair_sku_qty_columns(&header, &[0, 2], &[1, 2]);
        assert_eq!(
            overlapping_roles
                .iter()
                .map(|pair| (pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>(),
            vec![(3, 2)]
        );
    }

    #[test]
    fn highest_sku_group_uses_quantity_before_sku_in_reference_layout() {
        let header = vec![
            CellValue::string("SKU"),
            CellValue::string("Qty"),
            CellValue::string("SKU"),
            CellValue::string("Qty"),
        ];

        let detected_pairs = pair_sku_qty_columns(&header, &[0, 2], &[1, 3]);
        let pairs = highest_sku_quantity_group(&header, &detected_pairs, &[1, 3]);

        assert_eq!(
            pairs
                .iter()
                .map(|pair| (pair.qty_column, pair.sku_column, pair.merged_qty_column,))
                .collect::<Vec<_>>(),
            vec![(2, 3, 4)]
        );
    }

    #[test]
    fn sku_quantity_pairing_does_not_fall_back_to_following_quantity() {
        let header = vec![CellValue::string("SKU"), CellValue::string("Qty")];

        let detected_pairs = pair_sku_qty_columns(&header, &[0], &[1]);
        assert!(highest_sku_quantity_group(&header, &detected_pairs, &[1]).is_empty());
    }

    #[test]
    fn sku_quantity_group_requires_merged_quantity_after_sku() {
        let header = vec![CellValue::string("Qty"), CellValue::string("SKU")];

        let detected_pairs = pair_sku_qty_columns(&header, &[1], &[0]);
        assert!(highest_sku_quantity_group(&header, &detected_pairs, &[0]).is_empty());
    }

    #[test]
    fn pricing_candidate_supports_item_number_and_non_contiguous_tiers() {
        let sheet = SheetData {
            name: "Price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item  No. "),
                    CellValue::string("Country"),
                    CellValue::string("Standard"),
                    CellValue::string("Standard"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("1个"),
                    CellValue::string("5个"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("8"),
                ],
            ],
        };
        let pricing = infer_pricing_candidate(&sheet).expect("pricing candidate");
        assert_eq!(pricing.quantity_header_row, Some(2));
        assert_eq!(
            pricing
                .tier_columns
                .iter()
                .map(|tier| tier.quantity)
                .collect::<Vec<_>>(),
            vec![1, 5]
        );
    }

    #[test]
    fn pricing_candidate_skips_blank_row_before_quantity_tiers() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item No."),
                    CellValue::string("Country"),
                    CellValue::string("Dropshipping price"),
                    CellValue::string(""),
                ],
                vec![CellValue::Empty; 4],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("0"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("0"),
                    CellValue::string("8.5"),
                ],
            ],
        };

        let pricing = infer_pricing_candidate(&sheet).expect("pricing candidate");
        assert_eq!(pricing.quantity_header_row, Some(3));
        assert_eq!(
            pricing
                .tier_columns
                .iter()
                .map(|tier| tier.quantity)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn pricing_candidate_supports_fixed_unit_price_column() {
        let sheet = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item No."),
                    CellValue::string("Country"),
                    CellValue::string("Product shipping VAT tax"),
                    CellValue::string("Shipping Country"),
                ],
                vec![
                    CellValue::string("QY2600223"),
                    CellValue::string("US"),
                    CellValue::string("112"),
                    CellValue::string("4PX"),
                ],
            ],
        };

        let pricing = infer_pricing_candidate(&sheet).expect("pricing candidate");
        assert_eq!(pricing.quantity_header_row, None);
        assert_eq!(pricing.tier_columns.len(), 1);
        assert_eq!(pricing.tier_columns[0].quantity, 1);
        assert_eq!(pricing.tier_columns[0].column, 3);
    }

    #[test]
    fn wide_shopline_order_sheet_requires_quantity_before_sku() {
        let mut header = vec![CellValue::Empty; 126];
        header[0] = CellValue::string("Order number");
        header[9] = CellValue::string("Product's SKU (sales number)");
        header[29] = CellValue::string("Quantity");
        header[92] = CellValue::string("Country/Region");
        let mut row = vec![CellValue::Empty; 126];
        row[0] = CellValue::string("GC-SL-15132");
        row[9] = CellValue::string("QY2600223");
        row[29] = CellValue::string("1");
        row[92] = CellValue::string("US");
        let sheet = SheetData {
            name: "Sheet1".to_string(),
            rows: vec![header, row],
        };

        let order = infer_order_candidate(&sheet).expect("order candidate");
        assert!(order.sku_qty_pairs.is_empty());
        assert_eq!(order.country_code_column, Some(93));
    }

    #[test]
    fn order_candidate_does_not_pair_product_name_with_following_quantity() {
        let mut header = vec![CellValue::Empty; 100];
        header[0] = CellValue::string("Order number");
        header[8] = CellValue::string("Product name");
        header[29] = CellValue::string("Quantity");
        header[92] = CellValue::string("Country/Region");
        let mut row = vec![CellValue::Empty; 100];
        row[0] = CellValue::string("GC-SL-15132");
        row[8] = CellValue::string("Cordless snow blower");
        row[29] = CellValue::string("1");
        row[92] = CellValue::string("US");
        let sheet = SheetData {
            name: "Sheet1 (2)".to_string(),
            rows: vec![header, row],
        };

        let order = infer_order_candidate(&sheet).expect("order candidate");
        assert!(order.sku_qty_pairs.is_empty());
    }

    #[test]
    fn fixed_price_index_requires_the_same_full_sku() {
        let sheet = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item No."),
                    CellValue::string("Country"),
                    CellValue::string("Product shipping VAT tax"),
                ],
                vec![
                    CellValue::string("QY2600223"),
                    CellValue::string("US"),
                    CellValue::string("112"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "Product shipping VAT tax".to_string(),
            }],
            ..PriceCheckMapping::default()
        };

        let index = build_price_index(&sheet, &mapping);
        let lookup = index.lookup("US", "CORDLESSSNOWBLOWER", "", 1);
        assert_eq!(lookup.status, "SKU或国家无法匹配");
        assert_eq!(index.lookup("US", "QY2600223", "", 1).price, Some(112.0));
    }

    #[test]
    fn country_shipping_suffix_requires_an_exact_match() {
        let sheet = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("UNITED STATES-hold"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };

        let index = build_price_index(&sheet, &mapping);
        assert_eq!(
            index.lookup("US", "ABC123", "", 1).status,
            "SKU或国家无法匹配"
        );
        assert_eq!(index.lookup("US", "ABC123", "hold", 1).price, Some(9.0));
    }

    #[test]
    fn pricing_matrix_without_order_fields_is_not_an_order_candidate() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1pcs"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                ],
            ],
        };
        assert!(infer_order_candidate(&sheet).is_none());
        assert!(infer_pricing_candidate(&sheet).is_some());
    }

    #[test]
    fn sku_normalization_keeps_the_full_sku() {
        assert_eq!(normalize_sku(" BK2600241-BEGI "), "BK2600241-BEGI");
        assert_eq!(normalize_sku(" abc 01 "), "ABC01");
    }

    #[test]
    fn aggregates_same_order_sku_and_quantity() {
        let country = normalize_country_fields("US", "United States", "美国");
        let line = |quantity: f64, source_row: usize| OrderLine {
            business_order_number: "ORDER-1".to_string(),
            country: country.clone(),
            shipping_method: String::new(),
            single_shipment: false,
            original_sku: "ABC123-RED".to_string(),
            matched_sku: "ABC123-RED".to_string(),
            quantity,
            original_price: Some(10.0),
            source_sheet: "订单".to_string(),
            source_row,
            sku_pair_priority: 0,
        };
        let rows = aggregate_lines(&[line(1.0, 2), line(2.0, 3)]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].total_quantity, 3.0);
        assert_eq!(rows[0].source_rows, vec![2, 3]);
    }

    #[test]
    fn order_lines_use_only_the_highest_scoring_pair_and_apply_sku_multiplier() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("Country"),
                    CellValue::string("低分 SKU"),
                    CellValue::string("低分 Qty"),
                    CellValue::string("高分 SKU"),
                    CellValue::string("高分 Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-B"),
                    CellValue::string("9"),
                    CellValue::string("SKU-A*2"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let (lines, exceptions) = read_order_lines(&sheet, &mapping, &Config::default());

        assert!(exceptions.is_empty());
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].matched_sku, "SKU-A");
        assert_eq!(lines[0].quantity, 2.0);
        assert_eq!(lines[0].sku_pair_priority, 1);
    }

    #[test]
    fn writeback_uses_the_highest_priority_successful_sku_group() {
        let mut candidates = HashMap::new();
        let item = |priority| AggregatedOrderSku {
            source_assignments: vec![SourceAssignment {
                source_row: 2,
                sku_pair_priority: priority,
            }],
            ..AggregatedOrderSku::default()
        };

        record_matched_candidates(&mut candidates, &item(2), 30.0);
        record_matched_candidates(&mut candidates, &item(0), 10.0);
        record_matched_candidates(&mut candidates, &item(1), 20.0);

        let selected = candidates.get(&2).expect("matched candidate");
        assert_eq!(selected.sku_pair_priority, 0);
        assert_eq!(selected.pricing_price, 10.0);
    }

    #[test]
    fn matched_group_writes_group_price_once_and_zero_to_merged_rows() {
        let item = AggregatedOrderSku {
            source_assignments: vec![
                SourceAssignment {
                    source_row: 3,
                    sku_pair_priority: 0,
                },
                SourceAssignment {
                    source_row: 2,
                    sku_pair_priority: 0,
                },
            ],
            ..AggregatedOrderSku::default()
        };
        let mut candidates = HashMap::new();

        record_matched_candidates(&mut candidates, &item, 25.0);

        assert_eq!(
            candidates.get(&2).map(|value| value.pricing_price),
            Some(25.0)
        );
        assert_eq!(
            candidates.get(&3).map(|value| value.pricing_price),
            Some(0.0)
        );
    }

    #[test]
    fn writeback_uses_paired_quantity_and_calculates_amount_difference() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string(" ORDER-1 "),
                    CellValue::string("INVALID"),
                    CellValue::string("12"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string(""),
                    CellValue::string("8"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-2"),
                    CellValue::string("20"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string("SKU-3"),
                    CellValue::string("6"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-4"),
                    CellValue::string("9"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(3),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 2,
                qty_column: 4,
                ..SkuQtyPair::default()
            }],
            ..PriceCheckMapping::default()
        };
        let candidates = HashMap::from([(
            4,
            MatchedRowCandidate {
                sku_pair_priority: 1,
                pricing_price: 18.0,
            },
        )]);

        let rows = build_writeback_rows(&sheet, &mapping, &candidates);

        assert_eq!(
            rows.iter()
                .map(|row| (row.source_row, row.quantity))
                .collect::<Vec<_>>(),
            vec![(2, 1), (3, 0), (4, 1), (6, 1)]
        );
        assert!(!rows[0].matched);
        assert_eq!(rows[2].sku_pair_priority, Some(1));
        assert_eq!(rows[2].pricing_price, Some(18.0));
        assert_eq!(rows[2].price_difference, Some(-2.0));
        assert!(!rows[3].matched);
        assert_eq!(rows[3].pricing_price, None);
        assert_eq!(rows[3].price_difference, None);
    }

    #[test]
    fn writeback_groups_quantity_by_order_number_and_sku() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("SKU-B"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("SKU-B"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("SKU-C"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(3),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 2,
                qty_column: 4,
                ..SkuQtyPair::default()
            }],
            ..PriceCheckMapping::default()
        };

        let rows = build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![3, 0, 0, 2, 0, 1]
        );
    }

    #[test]
    fn writeback_compares_calculated_quantity_with_merged_quantity_after_sku() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("数量"),
                    CellValue::string("SKU"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 3,
                qty_column: 2,
                merged_qty_column: 4,
                ..SkuQtyPair::default()
            }],
            ..PriceCheckMapping::default()
        };

        let rows = build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter()
                .map(|row| (row.quantity, row.quantity_mismatch))
                .collect::<Vec<_>>(),
            vec![(2, false), (0, true)]
        );
    }

    #[test]
    fn writeback_groups_only_by_the_highest_scoring_sku_pair() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("低分 SKU"),
                    CellValue::string("低分 Qty"),
                    CellValue::string("高分 SKU"),
                    CellValue::string("高分 Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("OTHER-A"),
                    CellValue::string("9"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("OTHER-B"),
                    CellValue::string("9"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("OTHER-C"),
                    CellValue::string("9"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };
        let candidates = HashMap::from_iter((2..=4).map(|source_row| {
            (
                source_row,
                MatchedRowCandidate {
                    sku_pair_priority: 1,
                    pricing_price: 10.0,
                },
            )
        }));

        let rows = build_writeback_rows(&sheet, &mapping, &candidates);

        assert_eq!(
            rows.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![3, 0, 0]
        );
    }

    #[test]
    fn sku_multiplier_is_added_to_repeated_base_sku_quantity() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A*2"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 2,
                qty_column: 3,
                ..SkuQtyPair::default()
            }],
            ..PriceCheckMapping::default()
        };

        let rows = build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![3, 0]
        );
        assert_eq!(
            normalize_sku_and_multiplier(" sku-a * 2 "),
            ("SKU-A".to_string(), 2)
        );
    }

    #[test]
    fn financial_price_uses_grouped_quantity_and_difference_uses_total_price() {
        let order_sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("Country"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("TOTAL Price"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-A*2"),
                    CellValue::string("1"),
                    CellValue::string("18"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("0"),
                ],
            ],
        };
        let pricing_sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                    CellValue::string("3"),
                ],
                vec![
                    CellValue::string("SKU-A"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("25"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            order_price_column: Some(5),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 3,
                qty_column: 4,
                ..SkuQtyPair::default()
            }],
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 3,
                    column: 4,
                    header: "3".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let lines = read_order_lines(&order_sheet, &mapping, &Config::default()).0;
        let aggregated = aggregate_lines(&lines);
        let index = build_price_index(&pricing_sheet, &mapping);
        let lookup = index.lookup("US", "SKU-A", "", 3);
        let mut candidates = HashMap::new();
        record_matched_candidates(
            &mut candidates,
            &aggregated[0],
            lookup.price.expect("grouped quantity price"),
        );

        let rows = build_writeback_rows(&order_sheet, &mapping, &candidates);

        assert_eq!(aggregated[0].total_quantity, 3.0);
        assert_eq!(rows[0].quantity, 3);
        assert_eq!(rows[0].pricing_price, Some(25.0));
        assert_eq!(rows[0].price_difference, Some(7.0));
        assert_eq!(rows[1].quantity, 0);
        assert_eq!(rows[1].pricing_price, Some(0.0));
        assert_eq!(rows[1].price_difference, Some(0.0));
    }

    #[test]
    fn exact_tier_supports_zero_and_marks_unavailable_price() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("Shipping"),
                    CellValue::string("0"),
                    CellValue::string("1"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string(""),
                    CellValue::string("0"),
                    CellValue::string("9.5"),
                    CellValue::string("/"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 0,
                    column: 4,
                    header: "0".to_string(),
                },
                PriceTierColumn {
                    quantity: 1,
                    column: 5,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 6,
                    header: "2".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping);
        assert_eq!(index.lookup("US", "ABC123", "", 0).status, "matched");
        assert_eq!(index.lookup("US", "ABC123", "", 0).price, Some(0.0));
        assert_eq!(index.lookup("US", "ABC123", "", 2).status, "价格不可用");
    }

    #[test]
    fn duplicate_price_key_is_not_silently_selected() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("8"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping);
        assert_eq!(index.lookup("US", "ABC123", "", 1).status, "核价键重复");
    }

    #[test]
    fn single_shipment_price_table_is_preferred_with_standard_fallback() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("8"),
                ],
                vec![
                    CellValue::string("DEF456"),
                    CellValue::string("US"),
                    CellValue::string("6"),
                ],
                vec![
                    CellValue::string(SINGLE_SHIPMENT_PRICE_MARKER),
                    CellValue::string(""),
                    CellValue::string(""),
                ],
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("11"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping);

        assert_eq!(index.lookup("US", "ABC123", "", 1).price, Some(8.0));
        assert_eq!(
            index
                .lookup_with_single_shipment_preference("US", "ABC123", "", 1, true)
                .price,
            Some(11.0)
        );
        assert_eq!(
            index
                .lookup_with_single_shipment_preference("US", "DEF456", "", 1, true)
                .price,
            Some(6.0)
        );
    }

    #[test]
    fn name_is_single_shipment_only_when_absent_from_other_orders() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Order number"),
                    CellValue::string("Name"),
                    CellValue::string("Qty"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("Country"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("Alice"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("2"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("Alice"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("0"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("Bob"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-3"),
                    CellValue::string("Bob"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_sheet: "订单".to_string(),
            order_header_row: 1,
            business_order_number_column: Some(1),
            single_shipment_column: Some(2),
            country_code_column: Some(6),
            sku_qty_pairs: vec![SkuQtyPair {
                qty_column: 3,
                sku_column: 4,
                merged_qty_column: 5,
                ..SkuQtyPair::default()
            }],
            ..PriceCheckMapping::default()
        };
        let (lines, exceptions) = read_order_lines(&sheet, &mapping, &Config::default());

        assert!(exceptions.is_empty());
        assert_eq!(lines.len(), 4);
        assert!(lines[0].single_shipment);
        assert!(lines[1].single_shipment);
        assert!(!lines[2].single_shipment);
        assert!(!lines[3].single_shipment);
    }

    #[test]
    fn order_candidate_defaults_single_shipment_field_to_name() {
        let sheet = SheetData {
            name: "order".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Order number"),
                    CellValue::string("Country"),
                    CellValue::string("Qty"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("Name"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("Alice"),
                ],
            ],
        };

        let candidate = infer_order_candidate(&sheet).expect("order candidate");
        assert_eq!(candidate.single_shipment_column, Some(6));
    }

    #[test]
    fn multi_pair_mapping_preserves_all_pairs_in_score_order() {
        let order = OrderSheetCandidate {
            sheet_name: "订单".to_string(),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 1,
                    qty_column: 2,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                },
            ],
            ..OrderSheetCandidate::default()
        };
        let pricing = PricingSheetCandidate {
            sheet_name: "核价".to_string(),
            sku_column: Some(1),
            country_column: Some(2),
            tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PricingSheetCandidate::default()
        };
        let variants = mapping_variants(&order, &pricing);
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].sku_qty_pairs.len(), 2);
    }

    fn complete_mapping() -> PriceCheckMapping {
        PriceCheckMapping {
            order_sheet: "订单".to_string(),
            pricing_sheet: "核价".to_string(),
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 4,
                qty_column: 3,
                merged_qty_column: 5,
                ..SkuQtyPair::default()
            }],
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        }
    }

    fn decision(rows: usize, coverage: f64, ambiguous: bool) -> AutomationDecision {
        let config = Config::default();
        let mapping = complete_mapping();
        decide_automation(
            &config,
            Some(&mapping),
            true,
            true,
            rows,
            (rows as f64 * coverage).round() as usize,
            coverage,
            Some(coverage - 0.01),
            Some(10.0),
            ambiguous.then_some("订单/核价 Sheet 候选差距不足"),
        )
    }

    #[test]
    fn automation_accepts_threshold_and_rejects_lower_coverage() {
        assert_eq!(decision(100, 0.98, false).status, "eligible");
        assert_eq!(decision(100, 0.979, false).status, "confirm");
    }

    #[test]
    fn automation_requires_full_coverage_for_small_samples() {
        assert_eq!(decision(9, 1.0, false).status, "eligible");
        assert_eq!(decision(9, 0.99, false).status, "confirm");
    }

    #[test]
    fn automation_rejects_missing_fields_same_sheet_and_tied_candidates() {
        let config = Config::default();
        let mut mapping = complete_mapping();
        mapping.sku_qty_pairs.clear();
        let missing = decide_automation(
            &config,
            Some(&mapping),
            true,
            true,
            20,
            20,
            1.0,
            None,
            None,
            None,
        );
        assert_eq!(missing.status, "confirm");
        assert!(
            missing
                .reasons
                .iter()
                .any(|reason| reason.contains("必需字段"))
        );

        let mut same_sheet = complete_mapping();
        same_sheet.pricing_sheet = same_sheet.order_sheet.clone();
        let conflict = decide_automation(
            &config,
            Some(&same_sheet),
            true,
            true,
            20,
            20,
            1.0,
            None,
            None,
            None,
        );
        assert_eq!(conflict.status, "confirm");
        assert!(
            conflict
                .reasons
                .iter()
                .any(|reason| reason.contains("不能相同"))
        );
        assert_eq!(decision(20, 1.0, true).status, "confirm");
    }

    #[test]
    fn ambiguity_distinguishes_sheet_and_column_candidates() {
        let config = Config::default();
        let best = complete_mapping();
        let mut column_runner_up = best.clone();
        column_runner_up.sku_qty_pairs[0].qty_column = 4;
        column_runner_up.sku_qty_pairs[0].sku_column = 5;
        column_runner_up.sku_qty_pairs[0].merged_qty_column = 6;
        assert_eq!(
            classify_candidate_ambiguity(&best, &column_runner_up, 0.0, 0.0, &config),
            Some(CandidateAmbiguity::Column)
        );

        let mut sheet_runner_up = best.clone();
        sheet_runner_up.order_sheet = "订单备选".to_string();
        assert_eq!(
            classify_candidate_ambiguity(&best, &sheet_runner_up, 0.0, 0.0, &config),
            Some(CandidateAmbiguity::Sheet)
        );
        let column_reason =
            candidate_ambiguity_reason(CandidateAmbiguity::Column, &best, &column_runner_up);
        assert!(column_reason.contains("最优 [原始数量 C / SKU D / 合并数量 E]"));
        assert!(column_reason.contains("次优 [原始数量 D / SKU E / 合并数量 F]"));
    }

    #[test]
    fn nested_mapping_is_not_a_distinct_runner_up() {
        let best = complete_mapping();
        let mut nested = best.clone();
        nested.sku_qty_pairs.push(SkuQtyPair {
            sku_column: 5,
            qty_column: 6,
            merged_qty_column: 7,
            sku_header: "备用 SKU".to_string(),
            qty_header: "备用数量".to_string(),
            merged_qty_header: "备用合并数量".to_string(),
        });
        assert!(mapping_is_nested_variant(&best, &nested));

        let mut distinct = best.clone();
        distinct.sku_qty_pairs[0] = nested.sku_qty_pairs[1].clone();
        assert!(!mapping_is_nested_variant(&best, &distinct));
    }

    #[test]
    fn field_mapping_score_prefers_recognized_sku_quantity_columns() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("数量"),
                    CellValue::string("备注"),
                    CellValue::string("说明"),
                ],
                vec![
                    CellValue::string("SKU-1"),
                    CellValue::string("2"),
                    CellValue::string("SKU-1"),
                    CellValue::string("two"),
                ],
            ],
        };
        let mut recognized = complete_mapping();
        recognized.sku_qty_pairs = vec![SkuQtyPair {
            sku_column: 1,
            qty_column: 2,
            merged_qty_column: 3,
            sku_header: "SKU".to_string(),
            qty_header: "数量".to_string(),
            merged_qty_header: "合并数量".to_string(),
        }];
        let mut unrecognized = recognized.clone();
        unrecognized.sku_qty_pairs[0] = SkuQtyPair {
            sku_column: 3,
            qty_column: 4,
            merged_qty_column: 5,
            sku_header: "备注".to_string(),
            qty_header: "说明".to_string(),
            merged_qty_header: "其他".to_string(),
        };

        assert!(
            sku_qty_field_score(&sheet, &recognized, &Config::default())
                > sku_qty_field_score(&sheet, &unrecognized, &Config::default())
        );
    }

    #[test]
    fn price_result_is_written_directly_to_the_selected_output_directory() {
        let output_dir = Path::new("output");
        let output_path = output_path_for(Path::new("orders/order.xlsx"), output_dir);
        assert_eq!(output_path, output_dir.join("order_核价结果.xlsx"));
        assert_eq!(
            output_path_for(Path::new("orders/order.xlsm"), output_dir),
            output_dir.join("order_核价结果.xlsm")
        );
    }

    #[test]
    fn manual_sku_column_validation_recalculates_coverage() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "auto-pricing-mapping-{}-{}.xlsx",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut workbook = rust_xlsxwriter::Workbook::new();
        {
            let order = workbook.add_worksheet();
            order.set_name("订单")?;
            for (column, value) in [
                "订单号",
                "国家二字码",
                "数量",
                "SKU",
                "合并数量",
                "数量",
                "SKU",
                "合并数量",
                "Total Price",
            ]
            .iter()
            .enumerate()
            {
                order.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["A-1", "US", "1", "10001", "1", "1", "GOOD-1", "1", "8"]
                .iter()
                .enumerate()
            {
                order.write_string(1, column as u16, *value)?;
            }
        }
        {
            let pricing = workbook.add_worksheet();
            pricing.set_name("核价")?;
            for (column, value) in ["SKU", "Country", "1"].iter().enumerate() {
                pricing.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["GOOD-1", "US", "9.5"].iter().enumerate() {
                pricing.write_string(1, column as u16, *value)?;
            }
        }
        workbook.save(&path)?;

        let mut mapping = PriceCheckMapping {
            order_sheet: "订单".to_string(),
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            order_price_column: Some(9),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 4,
                qty_column: 3,
                merged_qty_column: 5,
                sku_header: "SKU".to_string(),
                qty_header: "数量".to_string(),
                merged_qty_header: "合并数量".to_string(),
            }],
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let wrong =
            validate_price_mapping(&path, &mapping, &Config::default()).expect("valid mapping");
        assert_eq!(
            (wrong.evaluated_rows, wrong.matched_rows, wrong.coverage),
            (1, 0, 0.0)
        );
        assert!(wrong.matched_order_rows.is_empty());
        mapping.sku_qty_pairs[0].sku_column = 7;
        mapping.sku_qty_pairs[0].qty_column = 6;
        mapping.sku_qty_pairs[0].merged_qty_column = 8;
        let corrected =
            validate_price_mapping(&path, &mapping, &Config::default()).expect("valid mapping");
        assert_eq!(
            (
                corrected.evaluated_rows,
                corrected.matched_rows,
                corrected.coverage
            ),
            (1, 1, 1.0)
        );
        assert_eq!(corrected.matched_order_rows, vec![2]);
        assert_eq!(
            corrected.writeback_rows,
            vec![PricePreviewWritebackRow {
                source_row: 2,
                pricing_price: Some(9.5),
                price_difference: Some(1.5),
                quantity: 1,
            }]
        );
        mapping.sku_qty_pairs[0].qty_column = 8;
        let errors = validate_price_mapping(&path, &mapping, &Config::default())
            .expect_err("following quantity must be rejected");
        assert!(
            errors
                .iter()
                .any(|error| error == "SKU 组必须按“原始数量、SKU、合并数量”三列连续排列")
        );
        std::fs::remove_file(path)?;
        Ok(())
    }
}
