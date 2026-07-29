use anyhow::{Context, Result};
use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const SCAN_PREVIEW_COLUMN_LIMIT: usize = 130;
const QUICK_HEADER_SCAN_MAX_BYTES: u64 = 120 * 1024 * 1024;
const QUICK_SHARED_STRINGS_MAX_BYTES: u64 = 32 * 1024 * 1024;
const PROCESSING_WORKBOOK_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PROCESSING_XML_ENTRY_MAX_BYTES: u64 = 256 * 1024 * 1024;
const PROCESSING_SHARED_STRINGS_MAX_BYTES: u64 = 128 * 1024 * 1024;
const PROCESSING_MAX_ROWS: usize = 200_000;
const PRICING_ORDER_FIELD_KEYS: &[&str] = &[
    "order_number",
    "country_code",
    "country_english",
    "country_chinese",
    "sku",
    "product_name",
    "quantity",
    "price",
    "recipient_name",
    "phone",
    "postal_code",
    "address",
    "email",
];
const PRICING_TABLE_FIELD_KEYS: &[&str] = &["sku", "country", "quantity_one_price", "fixed_price"];

#[derive(Debug, Deserialize, Clone, Default)]
pub(crate) struct Config {
    #[serde(default)]
    pub(crate) sheet_rules: SheetRules,
    #[serde(default)]
    pub(crate) sheet_selection: SheetSelectionRules,
    #[serde(default)]
    pub(crate) performance: PerformanceRules,
    #[serde(default)]
    pub(crate) pricing: PricingRules,
    #[serde(default)]
    pub(crate) automation: AutomationRules,
    #[serde(default)]
    pub(crate) filename_rules: FilenameRules,
    #[serde(default)]
    pub(crate) fields: IndexMap<String, FieldRule>,
    #[serde(default)]
    pub(crate) pricing_fields: PricingFieldRules,
    #[serde(default)]
    pub(crate) output: OutputRules,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CountryIdentity {
    #[serde(rename = "iso2")]
    Iso2,
    English,
    Chinese,
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct PricingRules {
    #[serde(default = "default_country_identity")]
    pub(crate) country_identity: Vec<CountryIdentity>,
    #[serde(default = "default_single_shipment_price_marker_aliases")]
    pub(crate) single_shipment_price_marker_aliases: Vec<String>,
    #[serde(default)]
    pub(crate) single_shipment_matching_enabled: bool,
    #[serde(default = "default_single_shipment_match_fields")]
    pub(crate) single_shipment_match_fields: Vec<SingleShipmentMatchField>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SingleShipmentMatchField {
    RecipientName,
    Phone,
    PostalCode,
    Address,
    Email,
}

impl PricingRules {
    pub(crate) fn uses_country_identity(&self, identity: CountryIdentity) -> bool {
        self.country_identity.contains(&identity)
    }
}

impl Default for PricingRules {
    fn default() -> Self {
        Self {
            country_identity: default_country_identity(),
            single_shipment_price_marker_aliases: default_single_shipment_price_marker_aliases(),
            single_shipment_matching_enabled: false,
            single_shipment_match_fields: default_single_shipment_match_fields(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct AutomationRules {
    #[serde(default = "default_auto_run")]
    pub(crate) auto_run: bool,
    #[serde(default)]
    pub(crate) template_match_priority: bool,
    #[serde(default = "default_coverage_threshold")]
    pub(crate) coverage_threshold: f64,
    #[serde(default = "default_min_trial_rows")]
    pub(crate) min_trial_rows: usize,
    #[serde(default = "default_candidate_coverage_gap")]
    pub(crate) candidate_coverage_gap: f64,
    #[serde(default = "default_candidate_score_gap")]
    pub(crate) candidate_score_gap: f64,
}

impl Default for AutomationRules {
    fn default() -> Self {
        Self {
            auto_run: default_auto_run(),
            template_match_priority: false,
            coverage_threshold: default_coverage_threshold(),
            min_trial_rows: default_min_trial_rows(),
            candidate_coverage_gap: default_candidate_coverage_gap(),
            candidate_score_gap: default_candidate_score_gap(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct SheetSelectionRules {
    #[serde(default)]
    pub(crate) required_header_fields: Vec<String>,
    #[serde(default)]
    pub(crate) ignore_required_empty_header_fields: bool,
    #[serde(default)]
    pub(crate) empty_header_fields_can_boost_sheet: bool,
    #[serde(default = "default_financial_check_empty_header_bonus_limit")]
    pub(crate) financial_check_empty_header_bonus_limit: usize,
    #[serde(default = "default_financial_check_empty_header_overflow_penalty")]
    pub(crate) financial_check_empty_header_overflow_penalty: f64,
    #[serde(default)]
    pub(crate) weak_order_number_aliases: Vec<String>,
    #[serde(default)]
    pub(crate) reject_header_keywords: Vec<String>,
    #[serde(default = "default_sequential_numeric_header_penalty")]
    pub(crate) sequential_numeric_header_penalty: f64,
    #[serde(skip)]
    pub(crate) normalized_weak_order_number_aliases: Vec<String>,
    #[serde(skip)]
    pub(crate) normalized_reject_header_keywords: Vec<String>,
}

impl Default for SheetSelectionRules {
    fn default() -> Self {
        Self {
            required_header_fields: Vec::new(),
            ignore_required_empty_header_fields: false,
            empty_header_fields_can_boost_sheet: true,
            financial_check_empty_header_bonus_limit:
                default_financial_check_empty_header_bonus_limit(),
            financial_check_empty_header_overflow_penalty:
                default_financial_check_empty_header_overflow_penalty(),
            weak_order_number_aliases: Vec::new(),
            reject_header_keywords: Vec::new(),
            sequential_numeric_header_penalty: default_sequential_numeric_header_penalty(),
            normalized_weak_order_number_aliases: Vec::new(),
            normalized_reject_header_keywords: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct PerformanceRules {
    #[serde(default = "default_quick_header_scan_max_mb")]
    pub(crate) quick_header_scan_max_mb: f64,
    #[serde(default = "default_quick_shared_strings_max_mb")]
    pub(crate) quick_shared_strings_max_mb: f64,
    #[serde(default = "default_processing_workbook_max_mb")]
    pub(crate) processing_workbook_max_mb: f64,
    #[serde(default = "default_processing_xml_entry_max_mb")]
    pub(crate) processing_xml_entry_max_mb: f64,
    #[serde(default = "default_processing_shared_strings_max_mb")]
    pub(crate) processing_shared_strings_max_mb: f64,
    #[serde(default = "default_processing_max_rows")]
    pub(crate) processing_max_rows: usize,
    #[serde(default)]
    pub(crate) processing_workers: usize,
}

impl Default for PerformanceRules {
    fn default() -> Self {
        Self {
            quick_header_scan_max_mb: default_quick_header_scan_max_mb(),
            quick_shared_strings_max_mb: default_quick_shared_strings_max_mb(),
            processing_workbook_max_mb: default_processing_workbook_max_mb(),
            processing_xml_entry_max_mb: default_processing_xml_entry_max_mb(),
            processing_shared_strings_max_mb: default_processing_shared_strings_max_mb(),
            processing_max_rows: default_processing_max_rows(),
            processing_workers: 0,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct SheetRules {
    #[serde(default = "default_header_scan_rows")]
    pub(crate) header_scan_rows: usize,
    #[serde(default = "default_data_sample_rows")]
    pub(crate) data_sample_rows: usize,
    #[serde(default = "default_sample_column_scan_limit")]
    pub(crate) sample_column_scan_limit: usize,
    #[serde(default = "default_empty_gap_limit")]
    pub(crate) empty_gap_limit: usize,
    #[serde(default)]
    pub(crate) preferred_sheet_names: Vec<String>,
}

impl Default for SheetRules {
    fn default() -> Self {
        Self {
            header_scan_rows: default_header_scan_rows(),
            data_sample_rows: default_data_sample_rows(),
            sample_column_scan_limit: default_sample_column_scan_limit(),
            empty_gap_limit: default_empty_gap_limit(),
            preferred_sheet_names: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct FilenameRules {
    #[serde(default = "default_year")]
    pub(crate) default_year: i32,
    #[serde(default = "default_filename_date_patterns")]
    pub(crate) date_patterns: Vec<FilenameDatePattern>,
    #[serde(default = "default_exclude_keywords")]
    pub(crate) exclude_keywords: Vec<String>,
    #[serde(default)]
    pub(crate) manual_confirm_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) special_filenames: HashMap<String, SpecialFilename>,
    #[serde(skip)]
    pub(crate) compiled_date_patterns: Vec<(usize, Regex)>,
    #[serde(skip)]
    pub(crate) compiled_manual_confirm_patterns: Vec<Regex>,
}

impl Default for FilenameRules {
    fn default() -> Self {
        let date_patterns = default_filename_date_patterns();
        let compiled_date_patterns = compile_indexed_patterns(&date_patterns)
            .expect("built-in filename date patterns must compile");
        Self {
            default_year: default_year(),
            date_patterns,
            exclude_keywords: default_exclude_keywords(),
            manual_confirm_patterns: Vec::new(),
            special_filenames: HashMap::new(),
            compiled_date_patterns,
            compiled_manual_confirm_patterns: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct FilenameDatePattern {
    #[serde(rename = "name")]
    pub(crate) _name: String,
    pub(crate) regex: String,
    pub(crate) output: String,
    #[serde(default)]
    pub(crate) no_digit_neighbors: bool,
    #[serde(default)]
    pub(crate) exclude_prefixes: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct SpecialFilename {
    pub(crate) name: String,
    pub(crate) dates: String,
    #[serde(default)]
    pub(crate) extra: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub(crate) struct FieldRule {
    #[serde(default)]
    pub(crate) output_header: Option<String>,
    #[serde(default)]
    pub(crate) header_aliases: Vec<String>,
    #[serde(default)]
    pub(crate) value_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) negative_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) negative_headers: Vec<String>,
    #[serde(default)]
    pub(crate) low_priority_headers: Vec<String>,
    #[serde(default)]
    pub(crate) require_empty_header: bool,
    #[serde(default)]
    pub(crate) required: bool,
    #[serde(default)]
    pub(crate) pair_with: Option<String>,
    #[serde(skip)]
    pub(crate) normalized_header_aliases: Vec<String>,
    #[serde(skip)]
    pub(crate) normalized_negative_headers: Vec<String>,
    #[serde(skip)]
    pub(crate) normalized_low_priority_headers: Vec<String>,
    #[serde(skip)]
    pub(crate) compiled_value_patterns: Vec<Regex>,
    #[serde(skip)]
    pub(crate) compiled_negative_patterns: Vec<Regex>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub(crate) struct PricingFieldRules {
    #[serde(default)]
    pub(crate) order: IndexMap<String, FieldRule>,
    #[serde(default)]
    pub(crate) pricing: IndexMap<String, FieldRule>,
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct OutputRules {
    #[serde(
        default = "default_extracted_sku_group_limit",
        alias = "max_sku_groups"
    )]
    pub(crate) extracted_sku_group_limit: usize,
    #[serde(
        default = "default_summary_buffer_file_limit",
        alias = "summary_flush_files"
    )]
    pub(crate) summary_buffer_file_limit: usize,
    #[serde(
        default = "default_summary_buffer_row_limit",
        alias = "summary_flush_rows"
    )]
    pub(crate) summary_buffer_row_limit: usize,
}

impl Default for OutputRules {
    fn default() -> Self {
        Self {
            extracted_sku_group_limit: default_extracted_sku_group_limit(),
            summary_buffer_file_limit: default_summary_buffer_file_limit(),
            summary_buffer_row_limit: default_summary_buffer_row_limit(),
        }
    }
}

fn default_header_scan_rows() -> usize {
    20
}

fn default_country_identity() -> Vec<CountryIdentity> {
    vec![
        CountryIdentity::Iso2,
        CountryIdentity::English,
        CountryIdentity::Chinese,
    ]
}

fn default_single_shipment_price_marker_aliases() -> Vec<String> {
    ["单独发货价格", "单独发货价", "单独发货报价"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn default_single_shipment_match_fields() -> Vec<SingleShipmentMatchField> {
    [
        SingleShipmentMatchField::RecipientName,
        SingleShipmentMatchField::Phone,
        SingleShipmentMatchField::PostalCode,
    ]
    .to_vec()
}

fn default_auto_run() -> bool {
    true
}

fn default_coverage_threshold() -> f64 {
    0.98
}

fn default_min_trial_rows() -> usize {
    10
}

fn default_candidate_coverage_gap() -> f64 {
    0.02
}

fn default_candidate_score_gap() -> f64 {
    12.0
}

fn default_data_sample_rows() -> usize {
    30
}

fn default_sample_column_scan_limit() -> usize {
    SCAN_PREVIEW_COLUMN_LIMIT
}

fn default_quick_header_scan_max_mb() -> f64 {
    QUICK_HEADER_SCAN_MAX_BYTES as f64 / 1024.0 / 1024.0
}

fn default_quick_shared_strings_max_mb() -> f64 {
    QUICK_SHARED_STRINGS_MAX_BYTES as f64 / 1024.0 / 1024.0
}

fn default_processing_workbook_max_mb() -> f64 {
    PROCESSING_WORKBOOK_MAX_BYTES as f64 / 1024.0 / 1024.0
}

fn default_processing_xml_entry_max_mb() -> f64 {
    PROCESSING_XML_ENTRY_MAX_BYTES as f64 / 1024.0 / 1024.0
}

fn default_processing_shared_strings_max_mb() -> f64 {
    PROCESSING_SHARED_STRINGS_MAX_BYTES as f64 / 1024.0 / 1024.0
}

fn default_processing_max_rows() -> usize {
    PROCESSING_MAX_ROWS
}

fn default_empty_gap_limit() -> usize {
    15
}

fn default_sequential_numeric_header_penalty() -> f64 {
    500.0
}

fn default_financial_check_empty_header_bonus_limit() -> usize {
    3
}

fn default_financial_check_empty_header_overflow_penalty() -> f64 {
    20.0
}

fn default_year() -> i32 {
    2026
}

fn default_extracted_sku_group_limit() -> usize {
    2
}

fn default_summary_buffer_file_limit() -> usize {
    50
}

fn default_summary_buffer_row_limit() -> usize {
    100_000
}

fn default_exclude_keywords() -> Vec<String> {
    vec![
        "orders_export".to_string(),
        "order_export".to_string(),
        "orders".to_string(),
        "order".to_string(),
        "export".to_string(),
    ]
}

fn default_filename_date_patterns() -> Vec<FilenameDatePattern> {
    vec![
        FilenameDatePattern {
            _name: "month_day_dot_range".to_string(),
            regex: r"(?P<m1>\d{1,2})[.](?P<d1>\d{1,2})\s*-\s*(?P<m2>\d{1,2})[.](?P<d2>\d{1,2})".to_string(),
            output: "{year}.{m1:02}.{d1:02}-{year}.{m2:02}.{d2:02}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        },
        FilenameDatePattern {
            _name: "month_day_year_dot".to_string(),
            regex: r"(?P<m>\d{1,2})[.](?P<d>\d{1,2})[.](?P<y>\d{4})".to_string(),
            output: "{y}.{m:02}.{d:02}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        },
        FilenameDatePattern {
            _name: "month_day_separator".to_string(),
            regex: r"(?P<m>\d{1,2})[.-](?P<d>\d{1,2})".to_string(),
            output: "{year}.{m:02}.{d:02}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        },
        FilenameDatePattern {
            _name: "order_day_month_year_compact".to_string(),
            regex: r"(?i)orders?[-_\s]*(?P<date>(?P<d>0[1-9]|[12]\d|3[01])(?P<m>0[1-9]|1[0-2])(?P<yy>\d{2}))".to_string(),
            output: "{year}.{m}.{d}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        },
        FilenameDatePattern {
            _name: "month_day_compact".to_string(),
            regex: r"(?P<m>0[1-9]|1[0-2])(?P<d>0[1-9]|[12]\d|3[01])".to_string(),
            output: "{year}.{m}.{d}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        },
        FilenameDatePattern {
            _name: "month_name_day".to_string(),
            regex: r"(?i)(?P<mon>JAN|FEB|MAR|APR|MAY|JUN|JUNE|JUL|AUG|SEP|OCT|NOV|DEC)[-.\s_]*(?P<d>\d{1,2})".to_string(),
            output: "{year}.{mon:02}.{d:02}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        },
    ]
}

pub(crate) fn load_config(path: &Path) -> Result<Config> {
    let text =
        fs::read_to_string(path).with_context(|| format!("读取配置失败: {}", path.display()))?;
    let mut config: Config =
        serde_json::from_str(&text).with_context(|| format!("解析配置失败: {}", path.display()))?;
    prepare_config(&mut config)?;
    Ok(config)
}

fn prepare_config(config: &mut Config) -> Result<()> {
    if config.pricing.country_identity.is_empty() {
        anyhow::bail!("pricing.country_identity 至少需要保留一个国家身份字段");
    }
    if config.pricing.single_shipment_matching_enabled
        && config
            .pricing
            .single_shipment_match_fields
            .iter()
            .collect::<HashSet<_>>()
            .len()
            < 2
    {
        anyhow::bail!(
            "pricing.single_shipment_match_fields 开启单独发货匹配时至少需要两个不同字段"
        );
    }
    for key in config.pricing_fields.order.keys() {
        if !PRICING_ORDER_FIELD_KEYS.contains(&key.as_str()) {
            anyhow::bail!("pricing_fields.order.{key} 当前处理器不读取该字段");
        }
    }
    for key in config.pricing_fields.pricing.keys() {
        if !PRICING_TABLE_FIELD_KEYS.contains(&key.as_str()) {
            anyhow::bail!("pricing_fields.pricing.{key} 当前处理器不读取该字段");
        }
    }
    config.filename_rules.compiled_date_patterns =
        compile_indexed_patterns(&config.filename_rules.date_patterns)?;
    config.filename_rules.compiled_manual_confirm_patterns = compile_patterns(
        &config.filename_rules.manual_confirm_patterns,
        "filename_rules.manual_confirm_patterns",
        true,
    )?;
    config.sheet_selection.normalized_weak_order_number_aliases = config
        .sheet_selection
        .weak_order_number_aliases
        .iter()
        .map(|value| normalize_header(value))
        .filter(|value| !value.is_empty())
        .collect();
    config.sheet_selection.normalized_reject_header_keywords = config
        .sheet_selection
        .reject_header_keywords
        .iter()
        .map(|value| normalize_header(value))
        .filter(|value| !value.is_empty())
        .collect();

    prepare_field_rules(&mut config.fields, "fields")?;
    prepare_field_rules(&mut config.pricing_fields.order, "pricing_fields.order")?;
    prepare_field_rules(&mut config.pricing_fields.pricing, "pricing_fields.pricing")?;

    Ok(())
}

fn prepare_field_rules(rules: &mut IndexMap<String, FieldRule>, path: &str) -> Result<()> {
    for (field_name, rule) in rules {
        rule.normalized_header_aliases = rule
            .header_aliases
            .iter()
            .map(|value| normalize_header(value))
            .filter(|value| !value.is_empty())
            .collect();
        rule.normalized_negative_headers = rule
            .negative_headers
            .iter()
            .map(|value| normalize_header(value))
            .filter(|value| !value.is_empty())
            .collect();
        rule.normalized_low_priority_headers = rule
            .low_priority_headers
            .iter()
            .map(|value| normalize_header(value))
            .filter(|value| !value.is_empty())
            .collect();
        rule.compiled_value_patterns = compile_patterns(
            &rule.value_patterns,
            &format!("{path}.{field_name}.value_patterns"),
            false,
        )?;
        rule.compiled_negative_patterns = compile_patterns(
            &rule.negative_patterns,
            &format!("{path}.{field_name}.negative_patterns"),
            false,
        )?;
    }

    Ok(())
}

fn compile_indexed_patterns(patterns: &[FilenameDatePattern]) -> Result<Vec<(usize, Regex)>> {
    patterns
        .iter()
        .enumerate()
        .map(|(index, pattern)| {
            Regex::new(&pattern.regex)
                .with_context(|| {
                    format!(
                        "无效正则: filename_rules.date_patterns[{index}] ({})",
                        pattern._name
                    )
                })
                .map(|regex| (index, regex))
        })
        .collect()
}

fn compile_patterns(
    patterns: &[String],
    field_path: &str,
    case_insensitive: bool,
) -> Result<Vec<Regex>> {
    patterns
        .iter()
        .enumerate()
        .map(|(index, pattern)| {
            let expression = if case_insensitive {
                format!("(?i){pattern}")
            } else {
                pattern.clone()
            };
            Regex::new(&expression).with_context(|| format!("无效正则: {field_path}[{index}]"))
        })
        .collect()
}

fn normalize_text(value: &str) -> String {
    value.trim().to_string()
}

pub(crate) fn normalize_header(value: &str) -> String {
    normalize_text(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn checked_in_config_compiles_all_regex_rules() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("config")
            .join("extract_rules.json");

        let config = load_config(&path).expect("checked-in extraction config must be valid");
        assert!(config.pricing_fields.order.contains_key("sku"));
        assert!(
            config
                .pricing_fields
                .pricing
                .contains_key("quantity_one_price")
        );
        assert_eq!(config.pricing.country_identity.len(), 3);
    }

    #[test]
    fn legacy_output_names_remain_compatible() {
        let config: Config = serde_json::from_str(
            r#"{
                "output": {
                    "max_sku_groups": 3,
                    "summary_flush_files": 60,
                    "summary_flush_rows": 100000
                }
            }"#,
        )
        .expect("legacy output names must remain compatible");

        assert_eq!(config.output.extracted_sku_group_limit, 3);
        assert_eq!(config.output.summary_buffer_file_limit, 60);
        assert_eq!(config.output.summary_buffer_row_limit, 100_000);
    }

    #[test]
    fn country_identity_defaults_to_all_supported_fields() {
        let config: Config = serde_json::from_str("{}").expect("empty config must use defaults");

        assert!(config.pricing.uses_country_identity(CountryIdentity::Iso2));
        assert!(
            config
                .pricing
                .uses_country_identity(CountryIdentity::English)
        );
        assert!(
            config
                .pricing
                .uses_country_identity(CountryIdentity::Chinese)
        );
    }

    #[test]
    fn single_shipment_price_marker_aliases_use_defaults_when_missing() {
        let config: Config = serde_json::from_str("{}").expect("old config must use defaults");

        assert_eq!(
            config.pricing.single_shipment_price_marker_aliases,
            ["单独发货价格", "单独发货价", "单独发货报价"]
        );
    }

    #[test]
    fn single_shipment_price_marker_aliases_can_be_disabled() {
        let config: Config =
            serde_json::from_str(r#"{"pricing":{"single_shipment_price_marker_aliases":[]}}"#)
                .expect("empty marker alias list must parse");

        assert!(
            config
                .pricing
                .single_shipment_price_marker_aliases
                .is_empty()
        );
    }

    #[test]
    fn single_shipment_matching_is_disabled_for_old_configs() {
        let config: Config = serde_json::from_str("{}").expect("old config must use defaults");

        assert!(!config.pricing.single_shipment_matching_enabled);
        assert_eq!(
            config.pricing.single_shipment_match_fields,
            [
                SingleShipmentMatchField::RecipientName,
                SingleShipmentMatchField::Phone,
                SingleShipmentMatchField::PostalCode,
            ]
        );
    }

    #[test]
    fn enabled_single_shipment_matching_requires_two_distinct_fields() {
        let mut config: Config = serde_json::from_str(
            r#"{
                "pricing": {
                    "single_shipment_matching_enabled": true,
                    "single_shipment_match_fields": ["recipient_name", "recipient_name"]
                }
            }"#,
        )
        .expect("supported fields must parse");

        let error = prepare_config(&mut config).expect_err("duplicate fields must not be enough");

        assert!(error.to_string().contains("至少需要两个不同字段"));
    }

    #[test]
    fn rejects_pricing_field_rules_that_the_processor_does_not_consume() {
        let mut config: Config = serde_json::from_str(
            r#"{
                "pricing_fields": {
                    "order": {
                        "shipping_method": {"header_aliases": ["Shipping method"]}
                    }
                }
            }"#,
        )
        .expect("field rule document must parse");

        let error = prepare_config(&mut config).expect_err("unused field must be rejected");

        assert!(
            error
                .to_string()
                .contains("pricing_fields.order.shipping_method")
        );
    }

    #[test]
    fn country_identity_accepts_a_supported_subset() {
        let mut config: Config =
            serde_json::from_str(r#"{"pricing":{"country_identity":["english"]}}"#)
                .expect("supported identity must parse");

        prepare_config(&mut config).expect("supported identity must validate");
        assert!(!config.pricing.uses_country_identity(CountryIdentity::Iso2));
        assert!(
            config
                .pricing
                .uses_country_identity(CountryIdentity::English)
        );
        assert!(
            !config
                .pricing
                .uses_country_identity(CountryIdentity::Chinese)
        );
    }

    #[test]
    fn country_identity_rejects_an_empty_list() {
        let mut config: Config = serde_json::from_str(r#"{"pricing":{"country_identity":[]}}"#)
            .expect("empty identity list is valid JSON");

        let error = prepare_config(&mut config).expect_err("empty identity list must fail");
        assert!(format!("{error:#}").contains("pricing.country_identity 至少需要保留一个"));
    }

    #[test]
    fn country_identity_rejects_unknown_values() {
        let error = serde_json::from_str::<Config>(r#"{"pricing":{"country_identity":["iso3"]}}"#)
            .expect_err("unknown identity must fail");

        let message = error.to_string();
        assert!(message.contains("iso3"));
        assert!(message.contains("iso2"));
        assert!(message.contains("english"));
        assert!(message.contains("chinese"));
    }

    #[test]
    fn rejects_invalid_field_regex_instead_of_silently_ignoring_it() {
        let mut config: Config = serde_json::from_str(
            r#"{
              "fields": {
                "order_number": {
                  "header_aliases": ["订单号"],
                  "value_patterns": ["["]
                }
              }
            }"#,
        )
        .expect("test config must be valid JSON");

        let error = prepare_config(&mut config).expect_err("invalid regex must fail config load");
        assert!(format!("{error:#}").contains("fields.order_number.value_patterns[0]"));
    }

    #[test]
    fn rejects_invalid_pricing_field_regex_with_full_path() {
        let mut config: Config = serde_json::from_str(
            r#"{
              "pricing_fields": {
                "order": {
                  "sku": {
                    "header_aliases": ["SKU"],
                    "value_patterns": ["["]
                  }
                }
              }
            }"#,
        )
        .expect("test config must be valid JSON");

        let error = prepare_config(&mut config).expect_err("invalid regex must fail config load");
        assert!(format!("{error:#}").contains("pricing_fields.order.sku.value_patterns[0]"));
    }
}
