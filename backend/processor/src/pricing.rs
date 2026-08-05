use crate::config::{
    Config, CountryIdentity, FieldRule, PricingRules, SingleShipmentMatchField, load_config,
};
#[cfg(test)]
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

mod aggregation;
mod analysis_pipeline;
mod anomalies;
mod column_rules;
mod command_handlers;
mod country_rules;
mod field_diagnostics;
mod file_processing;
mod header_range;
mod header_scoring;
mod mapping_scoring;
mod mapping_validation;
mod order_candidate;
mod order_reader;
mod price_index;
mod pricing_candidate;
mod quantity_rules;
mod single_shipment;
mod sku;

#[cfg(test)]
use aggregation::MatchedRowCandidate;
use aggregation::{
    aggregate_lines, build_writeback_rows, normalize_price_difference, order_tax_amount,
    order_tax_column_index, record_matched_candidates,
};
use analysis_pipeline::{
    analyze_path_with_templates, excel_column_label, mapping_from_candidates, mapping_is_complete,
};
#[cfg(test)]
use analysis_pipeline::{
    candidate_ambiguity_reason, classify_candidate_ambiguity, decide_automation,
    mapping_is_nested_variant, mapping_variants,
};
use anomalies::summarize_pricing_anomalies;
use column_rules::{
    deduplicate_equivalent_sku_qty_pairs, highest_sku_quantity_group, numeric_header_ladder_level,
    pair_sku_qty_columns, parse_tier, tier_columns,
};
pub(crate) use command_handlers::{
    run_price_check, run_price_check_analyze, run_price_check_validate,
};
#[cfg(test)]
use country_rules::normalize_country_fields;
use country_rules::{
    CountryInfo, country_lookup, country_route_token, normalize_order_country_fields,
};
use field_diagnostics::{
    incomplete_mapping_reason, mapping_field_diagnostics, no_trial_rows_reason,
};
use file_processing::{PriceOutputOptions, apply_cell_edits, process_price_file};
#[cfg(test)]
use file_processing::{apply_writeback_overrides, output_path_for};
use header_range::{
    OrderCoreHeaderRange, core_columns_outside_range, core_mapping_columns,
    filter_columns_to_core_range, resolve_order_core_header_range, validate_mapping_core_range,
};
use header_scoring::{
    HEADER_EXACT_SCORE, configured_best_column, configured_exact_header_columns,
    configured_header_score, configured_matching_columns, field_sample_adjustment,
    normalize_header, order_field_rule, pricing_field_rule, quantity_one_price_rule,
};
use mapping_scoring::{match_header_template, sheet_cell_text, sku_qty_field_score};
#[cfg(test)]
use mapping_validation::validate_price_mapping;
use mapping_validation::{
    calculate_preview_writeback_rows, evaluate_matches, recalculate_price_row,
    unmatched_price_issues, validate_price_mapping_with_overrides,
};
#[cfg(test)]
use order_candidate::infer_order_candidate;
#[cfg(test)]
use order_candidate::infer_order_candidate_with_config;
use order_candidate::infer_order_candidate_with_diagnostics;
use order_reader::{read_order_lines, read_order_lines_with_overrides};
use price_index::build_price_index;
use pricing_candidate::infer_pricing_candidate_with_config;
#[cfg(test)]
use pricing_candidate::{best_pricing_country_column, infer_pricing_candidate};
#[cfg(test)]
use quantity_rules::{quantity_source_columns, resolve_direct_sku_quantity};
use quantity_rules::{resolve_order_quantities, resolve_order_quantities_with_overrides};
use single_shipment::{
    exact_header_columns, resolve_single_shipment_fields, single_shipment_matching_status,
    single_shipment_matching_unavailable, single_shipment_orders,
};
use sku::{calculate_related_quantity, normalize_sku, parse_sku_expression};

const ORDER_HEADER_SCAN_ROWS: usize = 30;
const PRICE_HEADER_SCAN_ROWS: usize = 24;
const PRICE_TIER_LOOKAHEAD_ROWS: usize = 2;
const QUANTITY_ONE_PRICE_QUANTITY: i64 = 1;

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
    pub(crate) field_diagnostics: Vec<PriceFieldDiagnostic>,
    pub(crate) issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceFieldDiagnostic {
    pub(crate) field: String,
    pub(crate) level: String,
    pub(crate) title: String,
    pub(crate) message: String,
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
    pub(crate) anomaly_summary: PricingAnomalySummary,
    pub(crate) coverage: f64,
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
    field_diagnostics: Vec<PriceFieldDiagnostic>,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct MappingValidationFailure {
    errors: Vec<String>,
    field_diagnostics: Vec<PriceFieldDiagnostic>,
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
    #[serde(default)]
    quantity_mismatch: bool,
    quantity_error: Option<String>,
    quantity_issue_context: Option<SkuQuantityIssueContext>,
    #[serde(default)]
    used_original_sku_quantity: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricingAnomalySample {
    source_row: usize,
    reason: String,
    pricing_price: Option<f64>,
    price_difference: Option<f64>,
    quantity: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricingAnomalySummary {
    affected_rows: usize,
    price_unavailable_rows: usize,
    amount_difference_rows: usize,
    positive_difference_rows: usize,
    negative_difference_rows: usize,
    quantity_anomaly_rows: usize,
    quantity_mismatch_rows: usize,
    quantity_calculation_error_rows: usize,
    price_unavailable_samples: Vec<PricingAnomalySample>,
    amount_difference_samples: Vec<PricingAnomalySample>,
    quantity_mismatch_samples: Vec<PricingAnomalySample>,
    quantity_calculation_error_samples: Vec<PricingAnomalySample>,
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
    #[serde(default)]
    use_original_sku_quantity: bool,
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

fn has_chinese(value: &str) -> bool {
    value
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
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

fn highest_priority_sku_qty_pair(mapping: &PriceCheckMapping) -> Option<(usize, &SkuQtyPair)> {
    mapping
        .sku_qty_pairs
        .iter()
        .enumerate()
        .max_by_key(|(_, pair)| (pair.merged_qty_column, pair.sku_column))
}

fn quantity_mismatch_for_row(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    source_row: usize,
    quantity: Option<usize>,
) -> bool {
    let Some((_, pair)) = highest_priority_sku_qty_pair(mapping) else {
        return false;
    };
    if pair.direct_quantity {
        return false;
    }
    let merged_quantity = sheet
        .rows
        .get(source_row.saturating_sub(1))
        .and_then(|row| row.get(pair.merged_qty_column.saturating_sub(1)))
        .and_then(parse_number)
        .filter(|value| *value >= 0.0 && value.fract() == 0.0)
        .map(|value| value as usize);
    quantity.is_some_and(|value| merged_quantity != Some(value))
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

fn cell_text(row: &[CellValue], column: Option<usize>) -> String {
    column
        .and_then(|value| value.checked_sub(1))
        .and_then(|index| row.get(index))
        .map(CellValue::text)
        .unwrap_or_default()
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
