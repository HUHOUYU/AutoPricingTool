use crate::config::{Config, load_config};
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
];
const PLATFORM_ORDER_ALIASES: &[&str] = &[
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkuQtyPair {
    pub(crate) sku_column: usize,
    pub(crate) qty_column: usize,
    pub(crate) sku_header: String,
    pub(crate) qty_header: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrderSheetCandidate {
    pub(crate) sheet_name: String,
    pub(crate) header_row: usize,
    pub(crate) score: f64,
    pub(crate) business_order_number_column: Option<usize>,
    pub(crate) platform_order_number_column: Option<usize>,
    pub(crate) country_code_column: Option<usize>,
    pub(crate) country_english_column: Option<usize>,
    pub(crate) country_chinese_column: Option<usize>,
    pub(crate) sku_qty_pairs: Vec<SkuQtyPair>,
    pub(crate) shipping_method_column: Option<usize>,
    pub(crate) price_column: Option<usize>,
    pub(crate) valid_order_rows: usize,
    pub(crate) country_coverage: f64,
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCheckMapping {
    pub(crate) order_sheet: String,
    pub(crate) order_header_row: usize,
    pub(crate) business_order_number_column: Option<usize>,
    pub(crate) platform_order_number_column: Option<usize>,
    pub(crate) country_code_column: Option<usize>,
    pub(crate) country_english_column: Option<usize>,
    pub(crate) country_chinese_column: Option<usize>,
    pub(crate) sku_qty_pairs: Vec<SkuQtyPair>,
    pub(crate) shipping_method_column: Option<usize>,
    pub(crate) order_price_column: Option<usize>,
    pub(crate) pricing_sheet: String,
    pub(crate) pricing_header_row: usize,
    pub(crate) pricing_quantity_header_row: Option<usize>,
    pub(crate) pricing_sku_column: usize,
    pub(crate) pricing_country_column: usize,
    pub(crate) pricing_shipping_method_column: Option<usize>,
    pub(crate) quantity_tier_columns: Vec<PriceTierColumn>,
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
    pub(crate) platform_order_number: String,
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
    platform_order_number: String,
    country: CountryInfo,
    shipping_method: String,
    original_sku: String,
    matched_sku: String,
    quantity: f64,
    original_price: Option<f64>,
    source_sheet: String,
    source_row: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AggregatedOrderSku {
    pub(crate) business_order_number: String,
    pub(crate) platform_order_number: String,
    pub(crate) country_code: String,
    pub(crate) country_english_name: String,
    pub(crate) country_chinese_name: String,
    pub(crate) shipping_method: String,
    pub(crate) original_sku: String,
    pub(crate) matched_sku: String,
    pub(crate) total_quantity: f64,
    pub(crate) original_price: Option<f64>,
    pub(crate) source_sheet: String,
    pub(crate) source_rows: Vec<usize>,
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
    quantity_entries: HashMap<String, Vec<(String, PriceEntry)>>,
    quantity_keys: HashSet<String>,
    sku_country_keys: HashSet<String>,
}

#[derive(Debug, Clone)]
struct Lookup {
    status: &'static str,
    price: Option<f64>,
    matched_sku: String,
    source_sheet: String,
    reason: String,
}

pub(crate) fn run_price_check_analyze(command: &Value, state: &RuntimeState) -> Result<()> {
    let files = command_files(command)?;
    let config = load_config(&config_path(command))?;
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
        match analyze_path(path, &config) {
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
                analyze_path(path, &config)
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
        Ok((evaluated_rows, matched_rows, coverage, warnings)) => emit(json!({
            "type": "price-validation",
            "inputPath": input_path,
            "requestVersion": request_version,
            "evaluatedRows": evaluated_rows,
            "matchedRows": matched_rows,
            "coverage": coverage,
            "errors": [],
            "warnings": warnings,
        })),
        Err(errors) => emit(json!({
            "type": "price-validation",
            "inputPath": input_path,
            "requestVersion": request_version,
            "evaluatedRows": 0,
            "matchedRows": 0,
            "coverage": 0.0,
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
) -> std::result::Result<(usize, usize, f64, Vec<String>), Vec<String>> {
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
        errors.push("订单号、国家、SKU/数量或核价档位等必需字段不完整".to_string());
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
    let order_mapped_columns = [
        mapping.business_order_number_column,
        mapping.platform_order_number_column,
        mapping.country_code_column,
        mapping.country_english_column,
        mapping.country_chinese_column,
        mapping.shipping_method_column,
        mapping.order_price_column,
    ]
    .into_iter()
    .flatten()
    .chain(
        mapping
            .sku_qty_pairs
            .iter()
            .flat_map(|pair| [pair.sku_column, pair.qty_column]),
    )
    .collect::<Vec<_>>();
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
    if mapping
        .sku_qty_pairs
        .iter()
        .any(|pair| pair.sku_column == pair.qty_column)
    {
        errors.push("SKU 列与数量列不能相同".to_string());
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
    let lines = read_order_lines(order_sheet, mapping).0;
    let evaluated_rows = lines.len();
    let matched_rows = lines
        .iter()
        .filter(|line| {
            index
                .lookup(
                    &line.country.code,
                    &line.matched_sku,
                    &line.shipping_method,
                    line.quantity.round() as i64,
                )
                .status
                == "matched"
        })
        .count();
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
    Ok((evaluated_rows, matched_rows, coverage, warnings))
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

fn analyze_path(path: &Path, config: &Config) -> Result<PriceAnalysisFile> {
    let workbook = read_workbook_for_processing(path, config)?;
    let mut order_candidates = Vec::new();
    let mut pricing_candidates = Vec::new();
    for sheet in &workbook.sheets {
        if let Some(candidate) = infer_order_candidate(sheet) {
            order_candidates.push(candidate);
        }
        if let Some(candidate) = infer_pricing_candidate(sheet) {
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
    let mut runner_up_coverage = None;
    let mut score_gap = None;
    let mut ambiguous = false;
    if !order_candidates.is_empty() && !pricing_candidates.is_empty() {
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
                        let lines = read_order_lines(order_sheet, &mapping).0;
                        let total = lines.len();
                        let matched = lines
                            .iter()
                            .filter(|line| {
                                index
                                    .lookup(
                                        &line.country.code,
                                        &line.matched_sku,
                                        &line.shipping_method,
                                        line.quantity.round() as i64,
                                    )
                                    .status
                                    == "matched"
                            })
                            .count();
                        let pair_coverage = ratio(matched, total);
                        combinations.push((
                            pair_coverage,
                            order.score + pricing.score,
                            total,
                            matched,
                            mapping,
                        ));
                    }
                }
            }
        }
        combinations.sort_by(|left, right| {
            right
                .0
                .total_cmp(&left.0)
                .then_with(|| right.1.total_cmp(&left.1))
        });
        if combinations
            .iter()
            .any(|item| item.4.order_sheet != item.4.pricing_sheet)
        {
            combinations.retain(|item| item.4.order_sheet != item.4.pricing_sheet);
        }
        if let Some((best_coverage, best_score, total, matched, best_mapping)) =
            combinations.first().cloned()
        {
            coverage = best_coverage;
            evaluated_rows = total;
            matched_rows = matched;
            suggested_mapping = Some(best_mapping);
            if let Some(runner_up) = combinations.get(1) {
                runner_up_coverage = Some(runner_up.0);
                score_gap = Some((best_score - runner_up.1).max(0.0));
                ambiguous = best_coverage - runner_up.0 < config.automation.candidate_coverage_gap
                    && best_score - runner_up.1 < config.automation.candidate_score_gap;
            }
            if ambiguous {
                issues.push("存在多个覆盖率接近的 Sheet/字段组合，需要确认".to_string());
            }
        }
    }

    let automation_decision = decide_automation(
        config,
        suggested_mapping.as_ref(),
        !order_candidates.is_empty(),
        !pricing_candidates.is_empty(),
        evaluated_rows,
        matched_rows,
        coverage,
        runner_up_coverage,
        score_gap,
        ambiguous,
    );
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
        requires_confirmation,
        automation_decision,
        issues,
    })
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
    ambiguous: bool,
) -> AutomationDecision {
    let mut reasons = Vec::new();
    if mapping.is_none() {
        reasons.push("没有生成可用字段映射".to_string());
    } else if !mapping.is_some_and(mapping_is_complete) {
        reasons.push("订单号、国家、SKU/数量或核价档位等必需字段不完整".to_string());
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
    if ambiguous {
        reasons.push("最优候选与次优候选差距不足".to_string());
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
        score_gap,
    }
}

fn mapping_is_complete(mapping: &PriceCheckMapping) -> bool {
    (mapping.business_order_number_column.is_some()
        || mapping.platform_order_number_column.is_some())
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
        platform_order_number_column: order.platform_order_number_column,
        country_code_column: order.country_code_column,
        country_english_column: order.country_english_column,
        country_chinese_column: order.country_chinese_column,
        sku_qty_pairs: order.sku_qty_pairs.clone(),
        shipping_method_column: order.shipping_method_column,
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
    let all = mapping_from_candidates(order, pricing);
    if order.sku_qty_pairs.len() <= 1 {
        return vec![all];
    }
    let mut variants = vec![all.clone()];
    for pair in &order.sku_qty_pairs {
        let mut variant = all.clone();
        variant.sku_qty_pairs = vec![pair.clone()];
        variants.push(variant);
    }
    variants
}

fn infer_order_candidate(sheet: &SheetData) -> Option<OrderSheetCandidate> {
    let mut best = None;
    let scan_limit = sheet.rows.len().min(ORDER_HEADER_SCAN_ROWS);
    for header_idx in 0..scan_limit {
        let header = &sheet.rows[header_idx];
        let sku_columns = matching_columns(header, SKU_ALIASES);
        let qty_columns = matching_columns(header, QTY_ALIASES);
        let pairs = pair_sku_qty_columns(header, &sku_columns, &qty_columns);
        let order_col = best_column(header, ORDER_ID_ALIASES);
        let platform_col = best_column(header, PLATFORM_ORDER_ALIASES);
        if order_col.is_none() && platform_col.is_none() && pairs.is_empty() {
            continue;
        }
        let (country_code, country_en, country_cn) = infer_order_country_columns(sheet, header_idx);
        let shipping = best_shipping_column(header);
        let price = best_column(header, PRICE_ALIASES);
        let (valid_rows, country_rows) = score_order_rows(
            sheet,
            header_idx + 1,
            &pairs,
            order_col,
            platform_col,
            [country_code, country_en, country_cn],
        );
        if valid_rows == 0
            || (order_col.is_none() && platform_col.is_none())
            || pairs.is_empty()
            || country_code.is_none() && country_en.is_none() && country_cn.is_none()
        {
            continue;
        }
        let mut notes = Vec::new();
        if pairs.len() > 1 {
            notes.push(format!("识别到 {} 组 SKU/数量字段", pairs.len()));
        }
        if country_code.is_none() || country_en.is_none() || country_cn.is_none() {
            notes.push("国家三要素未全部识别，运行时会尝试补全并记录冲突".to_string());
        }
        let field_score = (pairs.len() as f64 * 24.0)
            + if order_col.is_some() { 24.0 } else { 0.0 }
            + if platform_col.is_some() { 8.0 } else { 0.0 }
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
            platform_order_number_column: platform_col.map(|column| column + 1),
            country_code_column: country_code.map(|column| column + 1),
            country_english_column: country_en.map(|column| column + 1),
            country_chinese_column: country_cn.map(|column| column + 1),
            sku_qty_pairs: pairs,
            shipping_method_column: shipping.map(|column| column + 1),
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

fn infer_pricing_candidate(sheet: &SheetData) -> Option<PricingSheetCandidate> {
    let mut best = None;
    let scan_limit = sheet.rows.len().min(PRICE_HEADER_SCAN_ROWS);
    for header_idx in 0..scan_limit {
        let header = &sheet.rows[header_idx];
        let sku_columns = matching_columns(header, SKU_ALIASES);
        let qty_columns = matching_columns(header, QTY_ALIASES);
        let order_like = (best_column(header, ORDER_ID_ALIASES).is_some()
            || best_column(header, PLATFORM_ORDER_ALIASES).is_some())
            && !pair_sku_qty_columns(header, &sku_columns, &qty_columns).is_empty();
        if order_like {
            continue;
        }
        let sku_column = best_pricing_sku_column(sheet, header_idx);
        let country_column = best_pricing_country_column(sheet, header_idx);
        let shipping_column = best_shipping_column(header);
        let direct_tiers = tier_columns(header, sku_column, country_column, shipping_column);
        let next_tiers = sheet
            .rows
            .get(header_idx + 1)
            .map(|row| tier_columns(row, sku_column, country_column, shipping_column))
            .unwrap_or_default();
        let (quantity_header_row, tiers) =
            if direct_tiers.len() >= next_tiers.len() && !direct_tiers.is_empty() {
                (None, direct_tiers)
            } else {
                (Some(header_idx + 2), next_tiers)
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
            notes.push("使用双行表头识别数量档位".to_string());
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
) -> (Option<usize>, Option<usize>, Option<usize>) {
    let header = &sheet.rows[header_idx];
    let candidates = header
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            let value = cell.text();
            (header_score(&value, COUNTRY_CODE_ALIASES) > 0
                || header_score(&value, COUNTRY_EN_ALIASES) > 0
                || header_score(&value, COUNTRY_CN_ALIASES) > 0)
                .then_some(column)
        })
        .collect::<Vec<_>>();
    let mut code_column = best_column(header, COUNTRY_CODE_ALIASES);
    let mut english_column = best_column(header, COUNTRY_EN_ALIASES);
    let mut chinese_column = best_column(header, COUNTRY_CN_ALIASES);

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
        if is_code {
            code_column = Some(column);
        }
        if is_chinese {
            chinese_column = Some(column);
        }
        if is_english {
            english_column = Some(column);
        }
    }
    (code_column, english_column, chinese_column)
}

fn best_pricing_country_column(sheet: &SheetData, header_idx: usize) -> Option<usize> {
    let header = &sheet.rows[header_idx];
    header
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            if header_score(&cell.text(), PRICING_COUNTRY_ALIASES) == 0 {
                return None;
            }
            let mut non_empty = 0usize;
            let mut recognized = 0usize;
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
                }
            }
            (non_empty > 0).then_some((recognized * 10 + non_empty, column))
        })
        .max_by_key(|(score, column)| (*score, std::cmp::Reverse(*column)))
        .map(|(_, column)| column)
}

fn best_pricing_sku_column(sheet: &SheetData, header_idx: usize) -> Option<usize> {
    let header = &sheet.rows[header_idx];
    header
        .iter()
        .enumerate()
        .filter_map(|(column, cell)| {
            if header_score(&cell.text(), SKU_ALIASES) == 0 {
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
            (non_empty > 0).then_some((sku_like * 10 + non_empty, column))
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
    platform_column: Option<usize>,
    country_columns: [Option<usize>; 3],
) -> (usize, usize) {
    let mut valid = 0;
    let mut country_rows = 0;
    for row in sheet.rows.iter().skip(data_start).take(120) {
        let has_order = [order_column, platform_column]
            .into_iter()
            .flatten()
            .any(|column| row.get(column).is_some_and(|cell| !cell.is_empty()));
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
                .filter(|tier| row.get(tier.column).and_then(parse_price).is_some())
                .count();
        }
    }
    (valid, usable)
}

fn matching_columns(row: &[CellValue], aliases: &[&str]) -> Vec<usize> {
    row.iter()
        .enumerate()
        .filter_map(|(index, cell)| (header_score(&cell.text(), aliases) > 0).then_some(index))
        .collect()
}

fn best_column(row: &[CellValue], aliases: &[&str]) -> Option<usize> {
    row.iter()
        .enumerate()
        .filter_map(|(index, cell)| {
            let score = header_score(&cell.text(), aliases);
            (score > 0).then_some((score, index))
        })
        .max_by_key(|(score, index)| (*score, std::cmp::Reverse(*index)))
        .map(|(_, index)| index)
}

fn best_shipping_column(row: &[CellValue]) -> Option<usize> {
    row.iter()
        .enumerate()
        .filter_map(|(index, cell)| {
            let normalized = normalize_header(&cell.text());
            if normalized.contains("COUNTRY")
                || normalized.contains("国家")
                || (normalized.starts_with("SHIPPING")
                    && normalized != "SHIPPING"
                    && !normalized.contains("METHOD"))
            {
                return None;
            }
            let score = header_score(&normalized, SHIPPING_ALIASES);
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
    aliases.iter().fold(0, |best, alias| {
        let candidate = normalize_header(alias);
        let score = if normalized == candidate {
            4
        } else if normalized.contains(&candidate) || candidate.contains(&normalized) {
            2
        } else {
            0
        };
        best.max(score)
    })
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
    let mut pairs = Vec::new();
    let mut used_qty = HashSet::new();
    for sku_column in sku_columns {
        let Some((qty_column, _distance)) = qty_columns
            .iter()
            .map(|column| (*column, column.abs_diff(*sku_column)))
            .filter(|(column, distance)| {
                !used_qty.contains(column)
                    && (*distance <= 5 || (sku_columns.len() == 1 && qty_columns.len() == 1))
            })
            .min_by_key(|(_, distance)| *distance)
        else {
            continue;
        };
        used_qty.insert(qty_column);
        pairs.push(SkuQtyPair {
            sku_column: *sku_column + 1,
            qty_column: qty_column + 1,
            sku_header: header[*sku_column].text(),
            qty_header: header[qty_column].text(),
        });
    }
    pairs
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
    value
        .trim()
        .replace([' ', '\u{3000}', '\t', '\r', '\n'], "")
        .to_ascii_uppercase()
}

fn base_sku(value: &str) -> String {
    value
        .split_once('-')
        .or_else(|| value.split_once('_'))
        .map(|(base, _)| base.to_string())
        .filter(|base| base.len() >= 4)
        .unwrap_or_else(|| value.to_string())
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

const COUNTRY_ALIASES: &[(&str, &str, &str, &[&str])] = &[
    (
        "US",
        "United States",
        "美国",
        &["USA", "United States of America"],
    ),
    (
        "GB",
        "United Kingdom",
        "英国",
        &["UK", "Great Britain", "England"],
    ),
    ("AU", "Australia", "澳大利亚", &["澳洲"]),
    ("CA", "Canada", "加拿大", &[]),
    ("DE", "Germany", "德国", &["Deutschland"]),
    ("FR", "France", "法国", &[]),
    ("IT", "Italy", "意大利", &[]),
    ("ES", "Spain", "西班牙", &[]),
    ("NL", "Netherlands", "荷兰", &["Holland"]),
    ("BE", "Belgium", "比利时", &[]),
    ("AT", "Austria", "奥地利", &[]),
    ("CH", "Switzerland", "瑞士", &[]),
    ("SE", "Sweden", "瑞典", &[]),
    ("NO", "Norway", "挪威", &[]),
    ("DK", "Denmark", "丹麦", &[]),
    ("FI", "Finland", "芬兰", &[]),
    ("IE", "Ireland", "爱尔兰", &[]),
    ("NZ", "New Zealand", "新西兰", &[]),
    ("JP", "Japan", "日本", &[]),
    ("KR", "South Korea", "韩国", &["Korea"]),
    ("SG", "Singapore", "新加坡", &[]),
    ("MY", "Malaysia", "马来西亚", &[]),
    ("TH", "Thailand", "泰国", &[]),
    ("PH", "Philippines", "菲律宾", &[]),
    ("VN", "Vietnam", "越南", &[]),
    ("CN", "China", "中国", &[]),
    ("MX", "Mexico", "墨西哥", &[]),
    ("BR", "Brazil", "巴西", &[]),
];

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

fn read_order_lines(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
) -> (Vec<OrderLine>, Vec<PriceCheckException>) {
    let mut lines = Vec::new();
    let mut exceptions = Vec::new();
    let data_start = mapping.order_header_row;
    for (row_index, row) in sheet.rows.iter().enumerate().skip(data_start) {
        let business = cell_text(row, mapping.business_order_number_column);
        let platform = cell_text(row, mapping.platform_order_number_column);
        let code = cell_text(row, mapping.country_code_column);
        let english = cell_text(row, mapping.country_english_column);
        let chinese = cell_text(row, mapping.country_chinese_column);
        let mut country = normalize_country_fields(&code, &english, &chinese);
        let shipping_from_column = cell_text(row, mapping.shipping_method_column);
        let shipping = if shipping_from_column.is_empty() {
            country.inferred_shipping.clone()
        } else {
            normalize_shipping(&shipping_from_column)
        };
        if business.is_empty() && platform.is_empty() {
            continue;
        }
        let mut row_has_sku = false;
        for pair in &mapping.sku_qty_pairs {
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
            let matched_sku = normalize_sku(&raw_sku);
            lines.push(OrderLine {
                business_order_number: if business.is_empty() {
                    platform.clone()
                } else {
                    business.clone()
                },
                platform_order_number: platform.clone(),
                country: country.clone(),
                shipping_method: shipping.clone(),
                original_sku: raw_sku,
                matched_sku,
                quantity,
                original_price: mapping
                    .order_price_column
                    .and_then(|column| row.get(column.saturating_sub(1)))
                    .and_then(parse_price),
                source_sheet: sheet.name.clone(),
                source_row: row_index + 1,
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
        if !country.conflict
            && country.code.is_empty()
            && (!code.is_empty() || !english.is_empty() || !chinese.is_empty())
        {
            country.reason = "国家字段无法标准化".to_string();
        }
    }
    (lines, exceptions)
}

fn build_price_index(sheet: &SheetData, mapping: &PriceCheckMapping) -> PriceIndex {
    let mut index = PriceIndex::default();
    let data_start = mapping
        .pricing_header_row
        .max(mapping.pricing_quantity_header_row.unwrap_or(0));
    for (_row_index, row) in sheet.rows.iter().enumerate().skip(data_start) {
        let raw_sku = cell_text(row, Some(mapping.pricing_sku_column));
        let raw_country = cell_text(row, Some(mapping.pricing_country_column));
        if raw_sku.is_empty() || raw_country.is_empty() {
            continue;
        }
        let (country_base, country_shipping) = split_country_shipping(&raw_country);
        let country = normalize_country_fields(&country_base, "", "");
        if country.code.is_empty() {
            continue;
        }
        let shipping_column = cell_text(row, mapping.pricing_shipping_method_column);
        let shipping = if shipping_column.is_empty() {
            normalize_shipping(&country_shipping)
        } else {
            normalize_shipping(&shipping_column)
        };
        let sku = normalize_sku(&raw_sku);
        let country_sku_key = prefix_key(&country.code, &sku, &shipping);
        index.sku_country_keys.insert(country_sku_key.clone());
        let base = base_sku(&sku);
        if base != sku {
            index
                .sku_country_keys
                .insert(prefix_key(&country.code, &base, &shipping));
        }
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
            index
                .quantity_entries
                .entry(quantity_key(&country.code, &sku, tier.quantity))
                .or_default()
                .push((shipping.clone(), entry.clone()));
            index.entries.entry(key).or_default().push(entry);
        }
    }
    index
}

fn aggregate_lines(lines: &[OrderLine]) -> Vec<AggregatedOrderSku> {
    let mut result: Vec<AggregatedOrderSku> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for line in lines {
        let key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            line.business_order_number, line.country.code, line.matched_sku, line.shipping_method
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
            if !row
                .platform_order_number
                .split(" | ")
                .any(|value| value == line.platform_order_number)
                && !line.platform_order_number.is_empty()
            {
                if !row.platform_order_number.is_empty() {
                    row.platform_order_number.push_str(" | ");
                }
                row.platform_order_number
                    .push_str(&line.platform_order_number);
            }
            if row.original_price.is_none() {
                row.original_price = line.original_price;
            }
            row.source_rows.push(line.source_row);
        } else {
            positions.insert(key, result.len());
            result.push(AggregatedOrderSku {
                business_order_number: line.business_order_number.clone(),
                platform_order_number: line.platform_order_number.clone(),
                country_code: line.country.code.clone(),
                country_english_name: line.country.english.clone(),
                country_chinese_name: line.country.chinese.clone(),
                shipping_method: line.shipping_method.clone(),
                original_sku: line.original_sku.clone(),
                matched_sku: line.matched_sku.clone(),
                total_quantity: line.quantity,
                original_price: line.original_price,
                source_sheet: line.source_sheet.clone(),
                source_rows: vec![line.source_row],
            });
        }
    }
    result
}

fn process_price_file(
    input_path: &Path,
    output_dir: &Path,
    mapping: &PriceCheckMapping,
    config: &Config,
    state: &RuntimeState,
) -> Result<PriceCheckReport> {
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
    let (lines, mut exceptions) = read_order_lines(order_sheet, mapping);
    for exception in &mut exceptions {
        exception.file_path = input_path.display().to_string();
    }
    let aggregated = aggregate_lines(&lines);
    let index = build_price_index(pricing_sheet, mapping);
    let mut rows = Vec::new();
    let mut matched_rows = 0;
    for (position, item) in aggregated.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            break;
        }
        let lookup = index.lookup(
            &item.country_code,
            &item.matched_sku,
            &item.shipping_method,
            item.total_quantity.round() as i64,
        );
        if lookup.status == "matched" {
            matched_rows += 1;
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
            platform_order_number: item.platform_order_number.clone(),
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
    crate::pricing_writer::write_price_result(&output_path, &report)?;
    report.output_path = output_path.display().to_string();
    Ok(report)
}

impl PriceIndex {
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
        let mut sku_candidates = vec![sku.to_string()];
        let base = base_sku(sku);
        if base != sku {
            sku_candidates.push(base);
        }
        let mut shipping_candidates = vec![normalize_shipping(shipping)];
        if !shipping.is_empty() {
            shipping_candidates.push(String::new());
        }
        let mut ambiguous = Vec::new();
        let mut shipping_ambiguous = false;
        let mut saw_quantity_key = false;
        for candidate_sku in &sku_candidates {
            for candidate_shipping in &shipping_candidates {
                let prefix = prefix_key(country, candidate_sku, candidate_shipping);
                if self.quantity_keys.contains(&prefix) {
                    saw_quantity_key = true;
                }
                let key = full_key(country, candidate_sku, candidate_shipping, quantity);
                if let Some(entries) = self.entries.get(&key) {
                    if entries.len() != 1 {
                        ambiguous.extend(
                            entries
                                .iter()
                                .map(|entry| (candidate_sku.clone(), entry.clone())),
                        );
                        continue;
                    }
                    let entry = &entries[0];
                    if let Some(price) = entry.price {
                        return Lookup {
                            status: "matched",
                            price: Some(price),
                            matched_sku: candidate_sku.clone(),
                            source_sheet: entry.sheet_name.clone(),
                            reason: String::new(),
                        };
                    }
                    return Lookup {
                        status: "价格不可用",
                        price: None,
                        matched_sku: candidate_sku.clone(),
                        source_sheet: entry.sheet_name.clone(),
                        reason: format!("核价单元格不可用: {}", entry.raw_price),
                    };
                }
            }
        }
        if shipping.trim().is_empty() && ambiguous.is_empty() {
            for candidate_sku in &sku_candidates {
                let key = quantity_key(country, candidate_sku, quantity);
                let Some(entries) = self.quantity_entries.get(&key) else {
                    continue;
                };
                if entries.len() == 1 {
                    let entry = &entries[0].1;
                    if let Some(price) = entry.price {
                        return Lookup {
                            status: "matched",
                            price: Some(price),
                            matched_sku: candidate_sku.clone(),
                            source_sheet: entry.sheet_name.clone(),
                            reason: String::new(),
                        };
                    }
                    return Lookup {
                        status: "价格不可用",
                        price: None,
                        matched_sku: candidate_sku.clone(),
                        source_sheet: entry.sheet_name.clone(),
                        reason: format!("核价单元格不可用: {}", entry.raw_price),
                    };
                }
                if entries.len() > 1 {
                    shipping_ambiguous = true;
                    ambiguous.extend(
                        entries
                            .iter()
                            .map(|(_, entry)| (candidate_sku.clone(), entry.clone())),
                    );
                }
            }
        }
        if !ambiguous.is_empty() {
            return Lookup {
                status: if shipping_ambiguous {
                    "物流方式无法确认"
                } else {
                    "核价键重复"
                },
                price: None,
                matched_sku: ambiguous[0].0.clone(),
                source_sheet: ambiguous[0].1.sheet_name.clone(),
                reason: if shipping_ambiguous {
                    "订单没有物流方式，但核价表存在多个物流价格".to_string()
                } else {
                    "相同国家、SKU、数量和物流方式对应多个价格，未静默选择".to_string()
                },
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

fn quantity_key(country: &str, sku: &str, quantity: i64) -> String {
    format!("{}\u{1f}{}\u{1f}{}", country, sku, quantity)
}

fn output_path_for(input_path: &Path, output_dir: &Path) -> PathBuf {
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名");
    let file_name = format!("{}_核价结果.xlsx", safe_file_name(stem));
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

    #[test]
    fn country_three_fields_are_one_identity() {
        let country = normalize_country_fields("US", "United States", "美国");
        assert_eq!(country.code, "US");
        assert_eq!(country.english, "United States");
        assert_eq!(country.chinese, "美国");
        assert!(!country.conflict);
    }

    #[test]
    fn country_conflict_is_not_silently_resolved() {
        let country = normalize_country_fields("US", "Canada", "美国");
        assert!(country.conflict);
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
        assert_eq!(order.sku_qty_pairs.len(), 1);
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
    fn base_sku_is_only_a_fallback() {
        assert_eq!(base_sku("BK2600241-BEGI"), "BK2600241");
        assert_eq!(normalize_sku(" abc 01 "), "ABC01");
    }

    #[test]
    fn aggregates_same_order_sku_and_quantity() {
        let country = normalize_country_fields("US", "United States", "美国");
        let line = |quantity: f64, source_row: usize| OrderLine {
            business_order_number: "ORDER-1".to_string(),
            platform_order_number: "PLATFORM-1".to_string(),
            country: country.clone(),
            shipping_method: String::new(),
            original_sku: "ABC123-RED".to_string(),
            matched_sku: "ABC123-RED".to_string(),
            quantity,
            original_price: Some(10.0),
            source_sheet: "订单".to_string(),
            source_row,
        };
        let rows = aggregate_lines(&[line(1.0, 2), line(2.0, 3)]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].total_quantity, 3.0);
        assert_eq!(rows[0].source_rows, vec![2, 3]);
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
    fn multi_pair_mapping_tries_each_pair() {
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
        assert_eq!(variants.len(), 3);
        assert_eq!(variants[1].sku_qty_pairs.len(), 1);
        assert_eq!(variants[2].sku_qty_pairs.len(), 1);
    }

    fn complete_mapping() -> PriceCheckMapping {
        PriceCheckMapping {
            order_sheet: "订单".to_string(),
            pricing_sheet: "核价".to_string(),
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 3,
                qty_column: 4,
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
            ambiguous,
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
            false,
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
            false,
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
    fn price_result_is_written_directly_to_the_selected_output_directory() {
        let output_dir = Path::new("output");
        let output_path = output_path_for(Path::new("orders/order.xlsx"), output_dir);
        assert_eq!(output_path, output_dir.join("order_核价结果.xlsx"));
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
            for (column, value) in ["订单号", "国家二字码", "SKU", "SKU", "数量"]
                .iter()
                .enumerate()
            {
                order.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["A-1", "US", "10001", "GOOD-1", "1"].iter().enumerate() {
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
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 3,
                qty_column: 5,
                sku_header: "SKU".to_string(),
                qty_header: "数量".to_string(),
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
        assert_eq!((wrong.0, wrong.1, wrong.2), (1, 0, 0.0));
        mapping.sku_qty_pairs[0].sku_column = 4;
        let corrected =
            validate_price_mapping(&path, &mapping, &Config::default()).expect("valid mapping");
        assert_eq!((corrected.0, corrected.1, corrected.2), (1, 1, 1.0));
        std::fs::remove_file(path)?;
        Ok(())
    }
}
