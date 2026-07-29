use crate::config::{Config, FieldRule, normalize_header};
use crate::excel_engine::{CellValue, ProcessorFile, SheetData, WorkbookData};
use crate::reader::{
    is_resource_limit_error, read_workbook_for_processing, read_workbook_selected,
};
use crate::scanner::file_name;
use anyhow::{Result, anyhow};
use regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

const BASE_PREFERRED_SHEET_BONUS: f64 = 12.0;
const PREFERRED_SHEET_ORDER_STEP: f64 = 0.5;
const HEADER_ALIAS_ORDER_STEP: f64 = 0.1;

#[derive(Debug, Clone, Default)]
struct Candidate {
    column: usize,
    score: f64,
    pattern_hits: usize,
}

#[derive(Debug, Clone, Default)]
struct SkuPairColumns {
    sku_column: usize,
    qty_column: Option<usize>,
}

#[derive(Debug, Clone)]
struct SheetHeaderChoice {
    sheet_index: usize,
    header_row: usize,
    required_hits: usize,
    has_order_number: bool,
    has_sample_record: bool,
    score: f64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Record {
    pub(crate) values: BTreeMap<String, CellValue>,
    pub(crate) sku_pairs: Vec<(CellValue, CellValue)>,
    pub(crate) source_path: String,
    pub(crate) source_file: String,
    pub(crate) source_sheet: String,
    pub(crate) source_row: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ExtractTimings {
    pub(crate) open_ms: u128,
    pub(crate) identify_ms: u128,
    pub(crate) columns_ms: u128,
    pub(crate) extract_ms: u128,
    pub(crate) total_ms: u128,
}

#[derive(Debug, Clone)]
pub(crate) struct ExtractResult {
    pub(crate) records: Vec<Record>,
    pub(crate) sheet_name: String,
    pub(crate) row_count: usize,
    pub(crate) timings: ExtractTimings,
}

pub(crate) fn header_confirmation(
    workbook: &WorkbookData,
    config: &Config,
) -> (Option<String>, Option<String>, Option<usize>) {
    let required_fields = config
        .fields
        .iter()
        .filter(|(_, rule)| rule.required)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if required_fields.is_empty() {
        return (None, None, None);
    }

    let best = best_sheet_header(workbook, config);
    let best_hits = best
        .as_ref()
        .map(|choice| choice.required_hits)
        .unwrap_or(0);
    let best_sheet = best
        .as_ref()
        .and_then(|choice| workbook.sheets.get(choice.sheet_index))
        .map(|sheet| sheet.name.clone());
    let best_row = best.as_ref().map(|choice| choice.header_row);

    if best_hits < required_fields.len().min(4) {
        let reason = if best.is_none() {
            unmatched_order_sheet_reason(workbook, config).unwrap_or_else(|| {
                format!(
                    "表头匹配不足（{}/{})，需人工确认",
                    best_hits,
                    required_fields.len()
                )
            })
        } else {
            format!(
                "表头匹配不足（{}/{})，需人工确认",
                best_hits,
                required_fields.len()
            )
        };
        (Some(reason), best_sheet, best_row)
    } else {
        (None, best_sheet, best_row)
    }
}

fn unmatched_order_sheet_reason(workbook: &WorkbookData, config: &Config) -> Option<String> {
    let mut best: Option<(usize, Vec<String>, Vec<String>)> = None;
    for sheet in &workbook.sheets {
        for row_index in 1..=config.sheet_rules.header_scan_rows.min(sheet.rows.len()) {
            let columns = columns_to_candidates(sheet, row_index, config);
            let found_fields = config
                .fields
                .iter()
                .filter(|(_, rule)| {
                    rule.required && !ignore_field_for_sheet_selection(rule, config)
                })
                .filter(|(field_name, _)| columns.contains_key(*field_name))
                .map(|(field_name, _)| field_display_name(config, field_name))
                .collect::<Vec<_>>();
            if found_fields.is_empty() {
                continue;
            }
            let missing_sheet_fields = config
                .sheet_selection
                .required_header_fields
                .iter()
                .filter(|field_name| !columns.contains_key(*field_name))
                .cloned()
                .collect::<Vec<_>>();
            let found_count = found_fields.len();
            if best
                .as_ref()
                .map(|(best_count, _, _)| found_count > *best_count)
                .unwrap_or(true)
            {
                best = Some((found_count, missing_sheet_fields, found_fields));
            }
        }
    }
    let (_, missing_sheet_fields, found_fields) = best?;
    let missing = if missing_sheet_fields.is_empty() {
        String::new()
    } else {
        format!("：缺少 {}", missing_sheet_fields.join("/"))
    };
    Some(format!(
        "未找到满足订单主表条件的表头行{missing}；已发现 {}候选，需人工确认",
        found_fields.join("/")
    ))
}

fn field_display_name(config: &Config, field_name: &str) -> String {
    config
        .fields
        .get(field_name)
        .and_then(|rule| rule.output_header.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(field_name)
        .to_string()
}

pub(crate) fn resolve_columns(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
) -> BTreeMap<String, Option<usize>> {
    let mut resolved = BTreeMap::new();
    let mut selected = HashMap::new();
    for (field_name, rule) in &config.fields {
        let candidate = best_candidate(sheet, field_name, rule, header_row, config, &selected);
        if let Some(candidate) = candidate {
            selected.insert(field_name.clone(), candidate.clone());
            resolved.insert(field_name.clone(), Some(candidate.column));
        } else {
            resolved.insert(field_name.clone(), None);
        }
    }
    resolved
}

fn best_candidate(
    sheet: &SheetData,
    field_name: &str,
    rule: &FieldRule,
    header_row: usize,
    config: &Config,
    selected: &HashMap<String, Candidate>,
) -> Option<Candidate> {
    candidates_for_field(sheet, field_name, rule, header_row, config, selected)
        .into_iter()
        .next()
        .filter(|candidate| candidate.score > 0.0)
}

fn candidates_for_field(
    sheet: &SheetData,
    field_name: &str,
    rule: &FieldRule,
    header_row: usize,
    config: &Config,
    selected: &HashMap<String, Candidate>,
) -> Vec<Candidate> {
    let max_column = effective_max_column(sheet, config);
    let mut candidates = Vec::new();
    for column in 1..=max_column {
        if selected
            .values()
            .any(|candidate| candidate.column == column)
        {
            continue;
        }
        let header = cell_ref_at(sheet, header_row, column)
            .map(CellValue::text_cow)
            .unwrap_or_default();
        let normalized_header = normalize_header(&header);
        if rule.require_empty_header && !normalized_header.is_empty() {
            continue;
        }
        let alias_score =
            header_alias_score_prepared(&normalized_header, &rule.normalized_header_aliases);
        let samples = column_samples(
            sheet,
            column,
            header_row + 1,
            config.sheet_rules.data_sample_rows,
        );
        let value_pattern_hits = pattern_hits_compiled(&samples, &rule.compiled_value_patterns);
        let negative_hits = pattern_hits_compiled(&samples, &rule.compiled_negative_patterns);
        let mut score = alias_score
            + if samples.is_empty() {
                0.0
            } else {
                50.0 * value_pattern_hits as f64 / samples.len() as f64
            };
        score += empty_header_pattern_bonus(rule, &samples, value_pattern_hits);
        if !samples.is_empty() {
            let negative_penalty = if alias_score > 0.0 { 12.0 } else { 50.0 };
            score -= negative_penalty * negative_hits as f64 / samples.len() as f64;
        }

        if let Some(pair_with) = &rule.pair_with
            && let Some(pair) = selected.get(pair_with)
        {
            let distance = column.abs_diff(pair.column);
            score += pair_distance_bonus(field_name, pair_with, distance);
        }
        if rule
            .normalized_negative_headers
            .iter()
            .any(|negative| negative == &normalized_header)
        {
            score -= 45.0;
        }
        if rule
            .normalized_low_priority_headers
            .iter()
            .any(|low_priority| low_priority == &normalized_header)
        {
            score -= 22.0;
        }
        let has_header = alias_score > 0.0;
        let has_pattern = value_pattern_hits > 0;
        if matches!(field_name, "country_code" | "country_en" | "country_cn")
            && (!has_header || !has_pattern)
        {
            continue;
        }
        if field_name == "country_en" && has_chinese_sample(&samples) {
            continue;
        }
        if (field_name == "order_number" || field_name.ends_with("_group")) && !has_header {
            continue;
        }
        if has_header || has_pattern {
            candidates.push(Candidate {
                column,
                score,
                pattern_hits: value_pattern_hits,
            });
        }
    }
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.pattern_hits.cmp(&a.pattern_hits))
    });
    candidates
}

pub(crate) fn extract_records(
    path: &Path,
    config: &Config,
    hinted: Option<&ProcessorFile>,
) -> Result<ExtractResult> {
    let total_started = Instant::now();
    let open_started = Instant::now();
    let workbook = read_workbook_for_extraction(path, config, hinted)?;
    let open_ms = open_started.elapsed().as_millis();

    let identify_started = Instant::now();
    let (sheet_index, header_row) = if let Some(file) = hinted {
        if let (Some(sheet_name), Some(header_row)) = (&file.sheet_name, file.header_row) {
            if let Some(index) = workbook
                .sheets
                .iter()
                .position(|sheet| &sheet.name == sheet_name)
            {
                (index, header_row)
            } else {
                find_sheet_and_header(&workbook, config)?
            }
        } else {
            find_sheet_and_header(&workbook, config)?
        }
    } else {
        find_sheet_and_header(&workbook, config)?
    };
    let identify_ms = identify_started.elapsed().as_millis();

    let sheet = &workbook.sheets[sheet_index];
    let row_count = sheet.rows.len();
    let columns_started = Instant::now();
    let mut columns = if let Some(hints) = hinted.and_then(|file| file.column_hints.clone()) {
        candidates_from_hints(config, &hints)
    } else {
        columns_to_candidates(sheet, header_row, config)
    };
    repair_country_cn_candidate(sheet, header_row, config, &mut columns);
    let columns_ms = columns_started.elapsed().as_millis();

    let extract_started = Instant::now();
    let mut records = Vec::new();
    let tracked_columns = columns
        .values()
        .map(|candidate| candidate.column)
        .collect::<HashSet<_>>();
    let sku_pair_columns = sku_pair_columns(sheet, header_row, &columns, config);
    let mut empty_row_streak = 0usize;
    let mut after_structure_break = false;
    for row_index in (header_row + 1)..=sheet.rows.len() {
        if !tracked_columns.is_empty()
            && !tracked_columns
                .iter()
                .any(|column| !cell_at(sheet, row_index, *column).is_empty())
        {
            empty_row_streak += 1;
            if !records.is_empty() {
                after_structure_break = true;
            }
            if empty_row_streak >= config.sheet_rules.empty_gap_limit {
                break;
            }
            continue;
        }
        empty_row_streak = 0;
        let order_number = column_value(sheet, row_index, &columns, "order_number");
        if order_number.is_empty() {
            if !records.is_empty() {
                after_structure_break = true;
            }
            continue;
        }
        if !records.is_empty()
            && after_structure_break
            && !row_matches_table_structure(sheet, row_index, &columns, config, &sku_pair_columns)
        {
            break;
        }
        after_structure_break = false;
        let row_sku_pairs = sku_pairs(sheet, row_index, &sku_pair_columns);
        if !row_has_required_sku_data(
            sheet,
            row_index,
            &columns,
            &sku_pair_columns,
            &row_sku_pairs,
        ) {
            continue;
        }
        let mut record = Record {
            source_path: path.to_string_lossy().to_string(),
            source_file: file_name(path),
            source_sheet: sheet.name.clone(),
            source_row: row_index,
            ..Default::default()
        };
        for field_name in config.fields.keys() {
            let value = column_value_cell(sheet, row_index, &columns, field_name);
            record.values.insert(field_name.clone(), value);
        }
        sanitize_country_values(&mut record.values, config);
        record.sku_pairs = row_sku_pairs;
        records.push(record);
    }
    if records.is_empty() {
        return Err(anyhow!("未提取到订单数据"));
    }
    let extract_ms = extract_started.elapsed().as_millis();
    Ok(ExtractResult {
        records,
        sheet_name: sheet.name.clone(),
        row_count,
        timings: ExtractTimings {
            open_ms,
            identify_ms,
            columns_ms,
            extract_ms,
            total_ms: total_started.elapsed().as_millis(),
        },
    })
}

fn read_workbook_for_extraction(
    path: &Path,
    config: &Config,
    hinted: Option<&ProcessorFile>,
) -> Result<WorkbookData> {
    let Some(file) = hinted else {
        return read_workbook_for_processing(path, config);
    };
    let Some(sheet_name) = file.sheet_name.as_deref() else {
        return read_workbook_for_processing(path, config);
    };
    let max_columns = max_hint_column(file).or(Some(config.sheet_rules.sample_column_scan_limit));
    match read_workbook_selected(path, sheet_name, max_columns, config) {
        Ok((_, workbook)) => Ok(workbook),
        Err(error) if is_resource_limit_error(&error) => Err(error),
        Err(_) => read_workbook_for_processing(path, config),
    }
}

fn max_hint_column(file: &ProcessorFile) -> Option<usize> {
    file.column_hints
        .as_ref()
        .and_then(|hints| hints.values().filter_map(|value| *value).max())
}

fn find_sheet_and_header(workbook: &WorkbookData, config: &Config) -> Result<(usize, usize)> {
    let best =
        best_sheet_header(workbook, config).ok_or_else(|| anyhow!("没有找到可读取的工作表"))?;
    let sheet_index = best.sheet_index;
    let header_row = best.header_row;
    let columns = resolve_columns(&workbook.sheets[sheet_index], header_row, config);
    if columns
        .get("order_number")
        .and_then(|value| *value)
        .is_none()
    {
        return Err(anyhow!(
            "已扫描所有 sheet，但没有找到满足订单主表条件的工作表"
        ));
    }
    Ok((sheet_index, header_row))
}

fn best_sheet_header(workbook: &WorkbookData, config: &Config) -> Option<SheetHeaderChoice> {
    let mut best: Option<SheetHeaderChoice> = None;
    for (sheet_index, sheet) in workbook.sheets.iter().enumerate() {
        let preferred_bonus = preferred_sheet_bonus(config, &sheet.name);
        for row_index in 1..=config.sheet_rules.header_scan_rows.min(sheet.rows.len()) {
            let columns = columns_to_candidates(sheet, row_index, config);
            if !looks_like_single_row_header(sheet, row_index, config, &columns) {
                continue;
            }
            let required_hits = sheet_selection_required_hits(&columns, config);
            let has_order_number = columns.contains_key("order_number");
            let has_sample_record = has_sample_record(sheet, row_index, &columns, config);
            let financial_check_bonus =
                financial_check_sheet_adjustment(sheet, row_index, &columns, config);
            let non_empty =
                non_empty_cells_in_row(sheet, row_index, effective_max_column(sheet, config));
            let penalty = sheet_selection_penalty(sheet, row_index, config);
            let score = preferred_bonus + required_hits as f64 * 100.0 + financial_check_bonus
                - non_empty.min(25) as f64 * 0.2
                - penalty;
            if best
                .as_ref()
                .map(|choice| {
                    (has_order_number, has_sample_record, required_hits, score)
                        > (
                            choice.has_order_number,
                            choice.has_sample_record,
                            choice.required_hits,
                            choice.score,
                        )
                })
                .unwrap_or(true)
            {
                best = Some(SheetHeaderChoice {
                    sheet_index,
                    header_row: row_index,
                    required_hits,
                    has_order_number,
                    has_sample_record,
                    score,
                });
            }
        }
    }
    best
}

fn financial_check_sheet_adjustment(
    sheet: &SheetData,
    header_row: usize,
    columns: &BTreeMap<String, Candidate>,
    config: &Config,
) -> f64 {
    if !config.sheet_selection.empty_header_fields_can_boost_sheet {
        return 0.0;
    }
    let Some(selected_candidate) = columns.get("financial_check_price") else {
        return 0.0;
    };
    let Some(rule) = config.fields.get("financial_check_price") else {
        return 0.0;
    };
    let selected_without_financial = columns
        .iter()
        .filter(|(field_name, _)| field_name.as_str() != "financial_check_price")
        .map(|(field_name, candidate)| (field_name.clone(), candidate.clone()))
        .collect::<HashMap<_, _>>();
    let eligible_count = candidates_for_field(
        sheet,
        "financial_check_price",
        rule,
        header_row,
        config,
        &selected_without_financial,
    )
    .into_iter()
    .filter(|candidate| candidate.score > 0.0)
    .count();

    financial_check_empty_header_adjustment(
        selected_candidate.score.min(20.0),
        eligible_count,
        config,
    )
}

fn financial_check_empty_header_adjustment(
    single_bonus: f64,
    eligible_count: usize,
    config: &Config,
) -> f64 {
    if eligible_count == 0 || single_bonus <= 0.0 {
        return 0.0;
    }
    let bonus_limit = config
        .sheet_selection
        .financial_check_empty_header_bonus_limit
        .max(1);
    if eligible_count <= bonus_limit {
        return single_bonus / eligible_count as f64;
    }

    -config
        .sheet_selection
        .financial_check_empty_header_overflow_penalty
        .max(0.0)
        * eligible_count.saturating_sub(bonus_limit) as f64
}

fn has_sample_record(
    sheet: &SheetData,
    header_row: usize,
    columns: &BTreeMap<String, Candidate>,
    config: &Config,
) -> bool {
    let sku_pair_columns = sku_pair_columns(sheet, header_row, columns, config);
    let last_sample_row = sheet
        .rows
        .len()
        .min(header_row.saturating_add(config.sheet_rules.data_sample_rows));
    for row_index in (header_row + 1)..=last_sample_row {
        if column_value(sheet, row_index, columns, "order_number").is_empty() {
            continue;
        }
        let row_sku_pairs = sku_pairs(sheet, row_index, &sku_pair_columns);
        if row_has_required_sku_data(sheet, row_index, columns, &sku_pair_columns, &row_sku_pairs) {
            return true;
        }
    }
    false
}

fn preferred_sheet_bonus(config: &Config, sheet_name: &str) -> f64 {
    let normalized_sheet_name = normalize_header(sheet_name);
    let preferred_count = config.sheet_rules.preferred_sheet_names.len();
    config
        .sheet_rules
        .preferred_sheet_names
        .iter()
        .enumerate()
        .find(|(_, name)| normalize_header(name) == normalized_sheet_name)
        .map(|(index, _)| {
            BASE_PREFERRED_SHEET_BONUS
                + preferred_count.saturating_sub(index + 1) as f64 * PREFERRED_SHEET_ORDER_STEP
        })
        .unwrap_or(0.0)
}

fn ignore_field_for_sheet_selection(rule: &FieldRule, config: &Config) -> bool {
    config.sheet_selection.ignore_required_empty_header_fields && rule.require_empty_header
}

fn sheet_selection_required_hits(columns: &BTreeMap<String, Candidate>, config: &Config) -> usize {
    config
        .fields
        .iter()
        .filter(|(_, rule)| rule.required && !ignore_field_for_sheet_selection(rule, config))
        .filter(|(name, _)| columns.contains_key(*name))
        .count()
}

fn has_required_sheet_selection_fields(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
) -> bool {
    let Some(row) = sheet.rows.get(header_row.saturating_sub(1)) else {
        return false;
    };
    let max_column = effective_max_column(sheet, config);
    config
        .sheet_selection
        .required_header_fields
        .iter()
        .all(|field_name| {
            let Some(rule) = config.fields.get(field_name) else {
                return false;
            };
            row.iter().take(max_column).any(|cell| {
                let normalized = normalize_header(&cell.text_cow());
                header_alias_score_prepared(&normalized, &rule.normalized_header_aliases) > 0.0
            })
        })
}

fn weak_order_number_alias_is_valid(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
    columns: &BTreeMap<String, Candidate>,
) -> bool {
    let Some(candidate) = columns.get("order_number") else {
        return true;
    };
    let Some(header) = cell_ref_at(sheet, header_row, candidate.column) else {
        return true;
    };
    let normalized = normalize_header(&header.text_cow());
    if !config
        .sheet_selection
        .normalized_weak_order_number_aliases
        .iter()
        .any(|alias| alias == &normalized)
    {
        return true;
    }
    let samples = column_samples(
        sheet,
        candidate.column,
        header_row + 1,
        config.sheet_rules.data_sample_rows,
    );
    samples
        .iter()
        .any(|sample| looks_like_order_number_sample(&sample.text_cow()))
}

fn looks_like_order_number_sample(value: &str) -> bool {
    let text = value.trim();
    if text.is_empty() || text.len() > 32 || text.split_whitespace().count() > 1 {
        return false;
    }
    let has_digit = text.chars().any(|ch| ch.is_ascii_digit());
    let has_marker = text.starts_with('#')
        || text.contains('-')
        || text.chars().any(|ch| ch.is_ascii_alphabetic());
    has_digit && has_marker
}

fn sheet_selection_penalty(sheet: &SheetData, header_row: usize, config: &Config) -> f64 {
    let mut penalty = 0.0;
    let Some(row) = sheet.rows.get(header_row.saturating_sub(1)) else {
        return penalty;
    };
    let max_column = effective_max_column(sheet, config);
    let normalized_cells = row
        .iter()
        .take(max_column)
        .map(|cell| normalize_header(&cell.text_cow()))
        .collect::<Vec<_>>();
    if config
        .sheet_selection
        .normalized_reject_header_keywords
        .iter()
        .any(|keyword| {
            normalized_cells
                .iter()
                .any(|cell| !cell.is_empty() && cell.contains(keyword))
        })
    {
        penalty += 220.0;
    }
    let numeric_ladder_level = numeric_header_ladder_level(&normalized_cells);
    if numeric_ladder_level > 0 {
        penalty +=
            config.sheet_selection.sequential_numeric_header_penalty * numeric_ladder_level as f64;
    }
    penalty
}

#[cfg(test)]
fn has_numeric_header_ladder(cells: &[String]) -> bool {
    numeric_header_ladder_level(cells) > 0
}

fn numeric_header_ladder_level(cells: &[String]) -> usize {
    let numeric_count = cells
        .iter()
        .filter(|cell| numeric_header_value(cell).is_some())
        .count();
    let mut level = numeric_count.saturating_sub(2);

    let mut run = 0usize;
    let mut expected: Option<i64> = None;
    for cell in cells {
        let parsed = numeric_header_value(cell);
        match (expected, parsed) {
            (Some(next), Some(value)) if value == next => {
                run += 1;
                expected = Some(value + 1);
            }
            (_, Some(value)) => {
                run = 1;
                expected = Some(value + 1);
            }
            _ => {
                run = 0;
                expected = None;
            }
        }
        if run >= 3 {
            level = level.max(run - 2);
        }
    }
    level
}

fn numeric_header_value(cell: &str) -> Option<i64> {
    let mut parts = cell.split_whitespace();
    let number = parts.next()?.parse::<i64>().ok()?;
    let suffix = parts.next();
    if parts.next().is_some() {
        return None;
    }
    match suffix {
        None => Some(number),
        Some("pc" | "pcs" | "piece" | "pieces" | "件" | "个") => Some(number),
        _ => None,
    }
}

fn looks_like_single_row_header(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
    columns: &BTreeMap<String, Candidate>,
) -> bool {
    if !has_required_sheet_selection_fields(sheet, header_row, config) {
        return false;
    }

    if !weak_order_number_alias_is_valid(sheet, header_row, config, columns) {
        return false;
    }

    let required_count = config
        .fields
        .values()
        .filter(|rule| rule.required && !ignore_field_for_sheet_selection(rule, config))
        .count();
    let required_header_hits = config
        .fields
        .iter()
        .filter(|(_, rule)| rule.required && !ignore_field_for_sheet_selection(rule, config))
        .filter(|(field_name, rule)| {
            columns
                .get(*field_name)
                .and_then(|candidate| cell_ref_at(sheet, header_row, candidate.column))
                .map(|cell| {
                    let normalized = normalize_header(&cell.text_cow());
                    header_alias_score_prepared(&normalized, &rule.normalized_header_aliases) > 0.0
                })
                .unwrap_or(false)
        })
        .count();
    let min_header_hits = required_count.min(2);
    if required_header_hits < min_header_hits {
        return false;
    }

    config
        .fields
        .get("order_number")
        .and_then(|rule| {
            columns
                .get("order_number")
                .and_then(|candidate| cell_ref_at(sheet, header_row, candidate.column))
                .map(|cell| {
                    let normalized = normalize_header(&cell.text_cow());
                    header_alias_score_prepared(&normalized, &rule.normalized_header_aliases) > 0.0
                })
        })
        .unwrap_or(true)
}

fn columns_to_candidates(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
) -> BTreeMap<String, Candidate> {
    let mut resolved = BTreeMap::new();
    let mut selected = HashMap::new();
    for (field_name, rule) in &config.fields {
        if let Some(candidate) =
            best_candidate(sheet, field_name, rule, header_row, config, &selected)
        {
            selected.insert(field_name.clone(), candidate.clone());
            resolved.insert(field_name.clone(), candidate);
        }
    }
    resolved
}

fn candidates_from_hints(
    config: &Config,
    hints: &BTreeMap<String, Option<usize>>,
) -> BTreeMap<String, Candidate> {
    let mut columns = BTreeMap::new();
    for field_name in config.fields.keys() {
        if let Some(Some(column)) = hints.get(field_name) {
            columns.insert(
                field_name.clone(),
                Candidate {
                    column: *column,
                    score: 0.0,
                    pattern_hits: 0,
                },
            );
        }
    }
    columns
}

fn repair_country_cn_candidate(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
    columns: &mut BTreeMap<String, Candidate>,
) {
    let Some(rule) = config.fields.get("country_cn") else {
        return;
    };
    let current_has_chinese = columns.get("country_cn").is_some_and(|candidate| {
        let samples = column_samples(
            sheet,
            candidate.column,
            header_row + 1,
            config.sheet_rules.data_sample_rows,
        );
        pattern_hits_compiled(&samples, &rule.compiled_value_patterns) > 0
    });
    if current_has_chinese {
        return;
    }
    columns.remove("country_cn");
    let selected = columns
        .iter()
        .map(|(field, candidate)| (field.clone(), candidate.clone()))
        .collect::<HashMap<_, _>>();
    if let Some(candidate) =
        best_candidate(sheet, "country_cn", rule, header_row, config, &selected)
    {
        columns.insert("country_cn".to_string(), candidate);
    }
}

fn column_value(
    sheet: &SheetData,
    row_index: usize,
    columns: &BTreeMap<String, Candidate>,
    field_name: &str,
) -> String {
    column_value_cell(sheet, row_index, columns, field_name).text()
}

fn column_value_cell(
    sheet: &SheetData,
    row_index: usize,
    columns: &BTreeMap<String, Candidate>,
    field_name: &str,
) -> CellValue {
    columns
        .get(field_name)
        .map(|candidate| cell_at(sheet, row_index, candidate.column))
        .unwrap_or_default()
}

fn sanitize_country_values(values: &mut BTreeMap<String, CellValue>, config: &Config) {
    for field_name in ["country_code", "country_en", "country_cn"] {
        let Some(value) = values.get(field_name) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let Some(rule) = config.fields.get(field_name) else {
            continue;
        };
        if !cell_matches_rule(value, rule) {
            values.insert(field_name.to_string(), CellValue::Empty);
        }
    }
}

fn row_matches_table_structure(
    sheet: &SheetData,
    row_index: usize,
    columns: &BTreeMap<String, Candidate>,
    config: &Config,
    sku_pair_columns: &[SkuPairColumns],
) -> bool {
    for field_name in ["country_code", "country_en", "country_cn"] {
        let Some(candidate) = columns.get(field_name) else {
            continue;
        };
        let value = cell_at(sheet, row_index, candidate.column);
        if !value.is_empty() {
            let Some(rule) = config.fields.get(field_name) else {
                continue;
            };
            if !cell_matches_rule(&value, rule) {
                return false;
            }
        }
    }

    let sku_pairs = sku_pairs(sheet, row_index, sku_pair_columns);
    if sku_pair_columns.is_empty() {
        return true;
    }
    !sku_pairs.is_empty()
}

fn row_has_required_sku_data(
    sheet: &SheetData,
    row_index: usize,
    columns: &BTreeMap<String, Candidate>,
    sku_pair_columns: &[SkuPairColumns],
    sku_pairs: &[(CellValue, CellValue)],
) -> bool {
    let configured_sku_column = ["sku_detail", "sku_group"]
        .iter()
        .any(|field_name| columns.contains_key(*field_name))
        || !sku_pair_columns.is_empty();
    if !configured_sku_column {
        return true;
    }

    ["sku_detail", "sku_group"]
        .iter()
        .any(|field_name| !column_value_cell(sheet, row_index, columns, field_name).is_empty())
        || sku_pairs.iter().any(|(sku, _)| !sku.is_empty())
}

fn sku_pair_columns(
    sheet: &SheetData,
    header_row: usize,
    columns: &BTreeMap<String, Candidate>,
    config: &Config,
) -> Vec<SkuPairColumns> {
    let sku_candidates = multi_field_candidates(
        sheet,
        header_row,
        config,
        columns,
        &["sku_detail", "sku_group"],
        &["sku_detail", "sku_group"],
    );
    let qty_candidates = multi_field_candidates(
        sheet,
        header_row,
        config,
        columns,
        &["qty_detail", "qty_group"],
        &["qty_detail", "qty_group"],
    );
    let mut used_qty_columns = HashSet::new();
    let mut pair_columns = Vec::new();

    for sku in sku_candidates {
        let qty_column = qty_candidates
            .iter()
            .filter(|qty| !used_qty_columns.contains(&qty.column))
            .filter(|qty| qty.column.abs_diff(sku.column) <= 4)
            .min_by(|left, right| {
                let left_distance = left.column.abs_diff(sku.column);
                let right_distance = right.column.abs_diff(sku.column);
                left_distance
                    .cmp(&right_distance)
                    .then_with(|| {
                        is_right_column(right, sku.column).cmp(&is_right_column(left, sku.column))
                    })
                    .then_with(|| {
                        right
                            .score
                            .partial_cmp(&left.score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
            .map(|qty| qty.column);
        if let Some(column) = qty_column {
            used_qty_columns.insert(column);
        }
        pair_columns.push(SkuPairColumns {
            sku_column: sku.column,
            qty_column,
        });
        if pair_columns.len() >= config.output.extracted_sku_group_limit {
            break;
        }
    }

    pair_columns
}

fn multi_field_candidates(
    sheet: &SheetData,
    header_row: usize,
    config: &Config,
    columns: &BTreeMap<String, Candidate>,
    field_names: &[&str],
    allowed_selected_fields: &[&str],
) -> Vec<Candidate> {
    let max_column = effective_max_column(sheet, config);
    let blocked_columns = columns
        .iter()
        .filter(|(field_name, _)| !allowed_selected_fields.contains(&field_name.as_str()))
        .map(|(_, candidate)| candidate.column)
        .collect::<HashSet<_>>();
    let mut candidates_by_column = BTreeMap::<usize, Candidate>::new();

    for field_name in field_names {
        let Some(rule) = config.fields.get(*field_name) else {
            continue;
        };
        for column in 1..=max_column {
            if blocked_columns.contains(&column) {
                continue;
            }
            let header = cell_ref_at(sheet, header_row, column)
                .map(CellValue::text_cow)
                .unwrap_or_default();
            let normalized_header = normalize_header(&header);
            if rule.require_empty_header && !normalized_header.is_empty() {
                continue;
            }
            let alias_score =
                header_alias_score_prepared(&normalized_header, &rule.normalized_header_aliases);
            let samples = column_samples(
                sheet,
                column,
                header_row + 1,
                config.sheet_rules.data_sample_rows,
            );
            let value_pattern_hits = pattern_hits_compiled(&samples, &rule.compiled_value_patterns);
            let negative_hits = pattern_hits_compiled(&samples, &rule.compiled_negative_patterns);
            let mut score = alias_score
                + if samples.is_empty() {
                    0.0
                } else {
                    50.0 * value_pattern_hits as f64 / samples.len() as f64
                };
            score += empty_header_pattern_bonus(rule, &samples, value_pattern_hits);
            if !samples.is_empty() {
                let negative_penalty = if alias_score > 0.0 { 12.0 } else { 50.0 };
                score -= negative_penalty * negative_hits as f64 / samples.len() as f64;
            }
            if rule
                .normalized_negative_headers
                .iter()
                .any(|negative| negative == &normalized_header)
            {
                score -= 45.0;
            }
            if rule
                .normalized_low_priority_headers
                .iter()
                .any(|low_priority| low_priority == &normalized_header)
            {
                score -= 22.0;
            }
            let has_header = alias_score > 0.0;
            let has_pattern = value_pattern_hits > 0;
            if field_name.ends_with("_group") && !has_header {
                continue;
            }
            if !has_header && !has_pattern {
                continue;
            }
            if score <= 0.0 {
                continue;
            }
            let candidate = Candidate {
                column,
                score,
                pattern_hits: value_pattern_hits,
            };
            candidates_by_column
                .entry(column)
                .and_modify(|current| {
                    if candidate.score > current.score
                        || (candidate.score == current.score
                            && candidate.pattern_hits > current.pattern_hits)
                    {
                        *current = candidate.clone();
                    }
                })
                .or_insert(candidate);
        }
    }

    candidates_by_column.into_values().collect()
}

fn is_right_column(candidate: &Candidate, base_column: usize) -> bool {
    candidate.column > base_column
}

fn sku_pairs(
    sheet: &SheetData,
    row_index: usize,
    pair_columns: &[SkuPairColumns],
) -> Vec<(CellValue, CellValue)> {
    let mut pairs = Vec::new();
    for pair in pair_columns {
        let sku = cell_at(sheet, row_index, pair.sku_column);
        let qty = pair
            .qty_column
            .map(|column| cell_at(sheet, row_index, column))
            .unwrap_or_default();
        if !sku.is_empty() {
            pairs.push((sku, qty));
        }
    }
    pairs
}

fn empty_header_pattern_bonus(
    rule: &FieldRule,
    samples: &[&CellValue],
    value_pattern_hits: usize,
) -> f64 {
    if !rule.require_empty_header || samples.is_empty() || value_pattern_hits == 0 {
        return 0.0;
    }
    let hit_ratio = value_pattern_hits as f64 / samples.len() as f64;
    if hit_ratio >= 0.5 {
        220.0 + hit_ratio * 80.0
    } else {
        hit_ratio * 40.0
    }
}

fn pair_distance_bonus(field_name: &str, pair_with: &str, distance: usize) -> f64 {
    if field_name == "financial_check_price" && pair_with == "price" {
        if distance <= 4 {
            210.0 - distance as f64 * 35.0
        } else {
            -(distance.min(20) as f64 * 8.0)
        }
    } else {
        (18.0 - distance as f64 * 5.0).max(0.0)
    }
}

fn header_alias_score_prepared(normalized: &str, normalized_aliases: &[String]) -> f64 {
    if normalized.is_empty() {
        return 0.0;
    }
    let mut best = 0.0_f64;
    let alias_count = normalized_aliases.len();
    for (index, alias) in normalized_aliases.iter().enumerate() {
        if alias.is_empty() {
            continue;
        } else if normalized == alias {
            return 30.0 + alias_order_bonus(index, alias_count);
        } else if normalized.contains(alias.as_str()) || alias.contains(normalized) {
            best = best.max(16.0 + alias_order_bonus(index, alias_count));
        }
    }
    best
}

fn alias_order_bonus(index: usize, alias_count: usize) -> f64 {
    alias_count.saturating_sub(index + 1) as f64 * HEADER_ALIAS_ORDER_STEP
}

fn pattern_hits_compiled(values: &[&CellValue], patterns: &[Regex]) -> usize {
    values
        .iter()
        .filter(|value| {
            let text = value.text_cow();
            !text.is_empty() && patterns.iter().any(|pattern| pattern.is_match(&text))
        })
        .count()
}

fn cell_matches_rule(value: &CellValue, rule: &FieldRule) -> bool {
    let text = value.text_cow();
    !text.is_empty()
        && rule
            .compiled_value_patterns
            .iter()
            .any(|pattern| pattern.is_match(&text))
}

fn has_chinese_sample(values: &[&CellValue]) -> bool {
    values.iter().any(|value| {
        value
            .text_cow()
            .chars()
            .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
    })
}

fn effective_max_column(sheet: &SheetData, config: &Config) -> usize {
    let mut last_seen = 1;
    let max_rows = sheet
        .rows
        .len()
        .min(config.sheet_rules.header_scan_rows + config.sheet_rules.data_sample_rows);
    let max_columns = sheet
        .rows
        .iter()
        .take(max_rows)
        .map(Vec::len)
        .max()
        .unwrap_or(1)
        .min(config.sheet_rules.sample_column_scan_limit);
    for row in sheet.rows.iter().take(max_rows) {
        for (index, value) in row.iter().enumerate().take(max_columns) {
            if !value.is_empty() {
                last_seen = last_seen.max(index + 1);
            }
        }
    }
    (last_seen + config.sheet_rules.empty_gap_limit).min(max_columns.max(1))
}

#[allow(dead_code)]
fn sheet_row(sheet: &SheetData, row_index: usize, max_column: usize) -> Vec<CellValue> {
    let mut row = sheet
        .rows
        .get(row_index.saturating_sub(1))
        .cloned()
        .unwrap_or_default();
    row.resize(max_column, CellValue::Empty);
    row.truncate(max_column);
    row
}

fn non_empty_cells_in_row(sheet: &SheetData, row_index: usize, max_column: usize) -> usize {
    sheet
        .rows
        .get(row_index.saturating_sub(1))
        .map(|row| {
            row.iter()
                .take(max_column)
                .filter(|cell| !cell.is_empty())
                .count()
        })
        .unwrap_or(0)
}

fn cell_at(sheet: &SheetData, row_index: usize, column: usize) -> CellValue {
    cell_ref_at(sheet, row_index, column)
        .cloned()
        .unwrap_or_default()
}

fn cell_ref_at(sheet: &SheetData, row_index: usize, column: usize) -> Option<&CellValue> {
    sheet
        .rows
        .get(row_index.saturating_sub(1))
        .and_then(|row| row.get(column.saturating_sub(1)))
}

fn column_samples(
    sheet: &SheetData,
    column: usize,
    start_row: usize,
    sample_rows: usize,
) -> Vec<&CellValue> {
    (start_row..start_row + sample_rows)
        .filter_map(|row| cell_ref_at(sheet, row, column))
        .filter(|value| !value.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_config;
    use crate::reader::read_workbook;
    use rust_xlsxwriter::Workbook;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be available")
            .as_nanos();
        env::temp_dir().join(format!("table_handle_line_{name}_{stamp}"))
    }

    fn write_test_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 5,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"]
            },
            "qty_detail": {
              "header_aliases": ["数量"],
              "pair_with": "sku_detail"
            }
          },
          "output": {
            "extracted_sku_group_limit": 1
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_country_test_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "required": true
            },
            "country_code": {
              "header_aliases": ["Country", "Shipping Country"],
              "value_patterns": ["^[A-Z]{2}$"],
              "required": false
            },
            "country_en": {
              "header_aliases": ["Country"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": true
            },
            "country_cn": {
              "header_aliases": ["Country", "国家", "国家中文", "收货人国家中文"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Price"],
              "required": true
            }
          },
          "output": {
            "extracted_sku_group_limit": 1
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_financial_check_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "required": true
            },
            "price": {
              "header_aliases": ["金额"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            },
            "financial_check_price": {
              "output_header": "财务核价列",
              "header_aliases": [],
              "value_patterns": ["^-?\\d+\\.\\d+$"],
              "require_empty_header": true,
              "pair_with": "price",
              "required": false
            }
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_order_sheet_diagnostic_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "output_header": "订单号",
              "header_aliases": ["Order number", "订单号"],
              "required": true
            },
            "sku_detail": {
              "output_header": "SKU",
              "header_aliases": ["SKU"],
              "required": true
            },
            "qty_detail": {
              "output_header": "数量",
              "header_aliases": ["Lineitem quantity"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "output_header": "金额",
              "header_aliases": ["Cost"],
              "required": true
            }
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_three_sku_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^(?:[A-Z0-9]*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[0-9]+(?:-[0-9]+)*-[A-Z0-9]*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["数量"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "sku_group": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z0-9]+$"],
              "required": false
            },
            "qty_group": {
              "header_aliases": ["数量"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_group",
              "required": false
            }
          },
          "output": {
            "extracted_sku_group_limit": 3
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    #[test]
    fn extract_records_uses_scan_hints_and_stops_after_empty_rows() -> Result<()> {
        let dir = fixture_dir("extract_hints");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-1")?;
        worksheet.write_number(1, 2, 2.0)?;
        worksheet.write_string(5, 0, "A-LATE")?;
        worksheet.write_string(5, 1, "SKU-LATE")?;
        worksheet.write_number(5, 2, 1.0)?;
        workbook.save(&source)?;

        let hinted = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            standard_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("订单".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(1)),
                ("sku_detail".to_string(), Some(2)),
                ("qty_detail".to_string(), Some(3)),
            ])),
        };

        let result = extract_records(&source, &config, Some(&hinted))?;

        assert_eq!(result.sheet_name, "订单");
        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("order_number")
                .cloned()
                .unwrap_or_default()
                .text(),
            "A-001"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn country_cn_requires_chinese_sample_even_when_header_is_country() -> Result<()> {
        let dir = fixture_dir("country_cn");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_country_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("Sheet1")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "Country")?;
        worksheet.write_string(0, 2, "Country")?;
        worksheet.write_string(0, 3, "SKU")?;
        worksheet.write_string(0, 4, "Qty")?;
        worksheet.write_string(0, 5, "Price")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "United States")?;
        worksheet.write_string(1, 2, "美国")?;
        worksheet.write_string(1, 3, "SKU-US-001")?;
        worksheet.write_number(1, 4, 1.0)?;
        worksheet.write_number(1, 5, 12.0)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(resolved.get("country_en").and_then(|value| *value), Some(2));
        assert_eq!(resolved.get("country_cn").and_then(|value| *value), Some(3));

        let hinted = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            standard_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("Sheet1".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(1)),
                ("country_en".to_string(), Some(2)),
                ("country_cn".to_string(), Some(2)),
                ("sku_detail".to_string(), Some(4)),
                ("qty_detail".to_string(), Some(5)),
                ("price".to_string(), Some(6)),
            ])),
        };

        let result = extract_records(&source, &config, Some(&hinted))?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("country_en")
                .cloned()
                .unwrap_or_default()
                .text(),
            "United States"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("country_cn")
                .cloned()
                .unwrap_or_default()
                .text(),
            "美国"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn country_en_does_not_steal_chinese_country_column() -> Result<()> {
        let dir = fixture_dir("country_cn_not_stolen");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_country_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("Sheet1")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "国家")?;
        worksheet.write_string(0, 2, "Country")?;
        worksheet.write_string(0, 3, "地址")?;
        worksheet.write_string(0, 4, "SKU")?;
        worksheet.write_string(0, 5, "Qty")?;
        worksheet.write_string(0, 6, "Price")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "美国")?;
        worksheet.write_string(1, 2, "United States")?;
        worksheet.write_string(1, 3, "中文地址")?;
        worksheet.write_string(1, 4, "SKU-US-001")?;
        worksheet.write_number(1, 5, 1.0)?;
        worksheet.write_number(1, 6, 12.0)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);

        assert_eq!(resolved.get("country_en").and_then(|value| *value), Some(3));
        assert_eq!(resolved.get("country_cn").and_then(|value| *value), Some(2));

        let result = extract_records(&source, &config, None)?;
        assert_eq!(
            result.records[0]
                .values
                .get("country_en")
                .cloned()
                .unwrap_or_default()
                .text(),
            "United States"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("country_cn")
                .cloned()
                .unwrap_or_default()
                .text(),
            "美国"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn country_code_column_does_not_fill_english_or_chinese_country_names() -> Result<()> {
        let dir = fixture_dir("country_code_names");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Voja 6.4 orders #49058-49110.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_country_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("cost")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "Shipping Country")?;
        worksheet.write_string(0, 2, "SKU")?;
        worksheet.write_string(0, 3, "Qty")?;
        worksheet.write_string(0, 4, "Price")?;
        worksheet.write_string(0, 5, "Shipping Address2")?;
        worksheet.write_string(1, 0, "#49058")?;
        worksheet.write_string(1, 1, "NL")?;
        worksheet.write_string(1, 2, "AZ2600949")?;
        worksheet.write_number(1, 3, 1.0)?;
        worksheet.write_number(1, 4, 6.39)?;
        worksheet.write_string(2, 0, "#49059")?;
        worksheet.write_string(2, 1, "GB")?;
        worksheet.write_string(2, 2, "AZ2600158")?;
        worksheet.write_number(2, 3, 2.0)?;
        worksheet.write_number(2, 4, 8.49)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(
            resolved.get("country_code").and_then(|value| *value),
            Some(2)
        );
        assert_eq!(resolved.get("country_en").and_then(|value| *value), None);
        assert_eq!(resolved.get("country_cn").and_then(|value| *value), None);

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.records.len(), 2);
        assert_eq!(
            result.records[0]
                .values
                .get("country_code")
                .cloned()
                .unwrap_or_default()
                .text(),
            "NL"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("country_en")
                .cloned()
                .unwrap_or_default()
                .text(),
            ""
        );
        assert_eq!(
            result.records[1]
                .values
                .get("country_code")
                .cloned()
                .unwrap_or_default()
                .text(),
            "GB"
        );
        assert_eq!(
            result.records[1]
                .values
                .get("country_cn")
                .cloned()
                .unwrap_or_default()
                .text(),
            ""
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn stops_before_custom_footer_rows_after_structure_break() -> Result<()> {
        let dir = fixture_dir("custom_footer_rows");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Raul 06-26 #87783-87861 78单.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 10,
            "sample_column_scan_limit": 16,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "value_patterns": ["^(?:[A-Za-z][A-Za-z0-9-]*[0-9][A-Za-z0-9-]*|[0-9][A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$"],
              "required": true
            },
            "country_code": {
              "header_aliases": ["国家二字码"],
              "value_patterns": ["^[A-Z]{2}$"],
              "required": false
            },
            "country_en": {
              "header_aliases": ["收货人国家"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": false
            },
            "country_cn": {
              "header_aliases": ["中文国家名"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": false
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["产品总数"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          },
          "output": {
            "extracted_sku_group_limit": 1
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("cost")?;
        worksheet.write_string(0, 0, "下单时间")?;
        worksheet.write_string(0, 1, "订单号")?;
        worksheet.write_string(0, 2, "订单金额")?;
        worksheet.write_string(0, 3, "Lineitem price")?;
        worksheet.write_string(0, 4, "国家二字码")?;
        worksheet.write_string(0, 5, "收货人国家")?;
        worksheet.write_string(0, 6, "中文国家名")?;
        worksheet.write_string(0, 7, "产品名称")?;
        worksheet.write_string(0, 8, "SKU")?;
        worksheet.write_string(0, 9, "产品总数")?;
        worksheet.write_string(0, 10, "SKU")?;
        worksheet.write_string(0, 11, "SKU")?;
        worksheet.write_string(0, 12, "产品总数")?;
        worksheet.write_string(0, 13, "price")?;
        worksheet.write_string(1, 1, "Raul87783")?;
        worksheet.write_string(1, 4, "US")?;
        worksheet.write_string(1, 5, "UNITED STATES")?;
        worksheet.write_string(1, 6, "美国")?;
        worksheet.write_string(1, 8, "FZ2400927-M")?;
        worksheet.write_number(1, 9, 1.0)?;
        worksheet.write_string(1, 10, "FZ2400927-M07")?;
        worksheet.write_string(1, 11, "FZ2400927")?;
        worksheet.write_number(1, 12, 1.0)?;
        worksheet.write_number(1, 13, 64.31)?;
        worksheet.write_formula(2, 12, "=SUM(M2:M2)")?;
        worksheet.write_formula(2, 13, "=SUM(N2:N2)")?;
        worksheet.write_string(4, 0, "84087")?;
        worksheet.write_string(4, 1, "AZ2600302")?;
        worksheet.write_string(4, 2, "Cancel")?;
        worksheet.write_number(4, 3, 44.32)?;
        worksheet.write_number(4, 4, -288.73)?;
        worksheet.write_string(4, 9, "collar labels")?;
        worksheet.write_number(4, 10, 169.0)?;
        worksheet.write_number(4, 11, 0.18)?;
        worksheet.write_number(4, 12, 30.42)?;
        workbook.save(&source)?;

        let hinted = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: "Raul 06-26 #87783-87861 78单.xlsx".to_string(),
            standard_name: "Raul__2026.06.26__orders.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("cost".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(2)),
                ("country_code".to_string(), Some(5)),
                ("country_en".to_string(), Some(6)),
                ("country_cn".to_string(), Some(7)),
                ("sku_detail".to_string(), Some(9)),
                ("qty_detail".to_string(), Some(10)),
                ("price".to_string(), Some(14)),
            ])),
        };

        let result = extract_records(&source, &config, Some(&hinted))?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("country_code")
                .cloned()
                .unwrap_or_default()
                .text(),
            "US"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("order_number")
                .cloned()
                .unwrap_or_default()
                .text(),
            "Raul87783"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn financial_check_price_requires_empty_header_and_decimal_samples() -> Result<()> {
        let dir = fixture_dir("financial_check_price");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "金额")?;
        worksheet.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        worksheet.write_string(0, 3, "备注")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_number(1, 1, 12.5)?;
        worksheet.write_number(1, 2, 8.75)?;
        worksheet.write_number(1, 3, 9.25)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(resolved.get("price").and_then(|value| *value), Some(2));
        assert_eq!(
            resolved
                .get("financial_check_price")
                .and_then(|value| *value),
            Some(3)
        );

        let result = extract_records(&source, &config, None)?;
        assert_eq!(
            result.records[0]
                .values
                .get("financial_check_price")
                .cloned()
                .unwrap_or_default()
                .text(),
            "8.75"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn financial_check_price_prefers_empty_decimal_column_near_price() -> Result<()> {
        let dir = fixture_dir("financial_check_near_price");
        fs::create_dir_all(&dir)?;
        let source = dir.join("TC-CB order 23-June.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("order_1")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "金额")?;
        worksheet.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        worksheet.write_string(0, 3, "备注")?;
        worksheet.write_blank(0, 7, &rust_xlsxwriter::Format::new())?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_number(1, 1, 10.0)?;
        worksheet.write_number(1, 2, 8.75)?;
        worksheet.write_string(1, 3, "near target")?;
        worksheet.write_number(1, 7, 99.11)?;
        worksheet.write_string(2, 0, "A-002")?;
        worksheet.write_number(2, 1, 12.0)?;
        worksheet.write_number(2, 2, 0.0)?;
        worksheet.write_number(2, 7, 88.22)?;
        worksheet.write_string(3, 0, "A-003")?;
        worksheet.write_number(3, 1, 14.0)?;
        worksheet.write_number(3, 2, 6.25)?;
        worksheet.write_number(3, 7, 77.33)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(resolved.get("price").and_then(|value| *value), Some(2));
        assert_eq!(
            resolved
                .get("financial_check_price")
                .and_then(|value| *value),
            Some(3)
        );

        let result = extract_records(&source, &config, None)?;
        assert_eq!(
            result.records[0]
                .values
                .get("financial_check_price")
                .cloned()
                .unwrap_or_default()
                .text(),
            "8.75"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_uses_financial_sheet_score_for_preview_hints() -> Result<()> {
        let dir = fixture_dir("header_preview_cost");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Raul 06-24 #87632-87715  84单.xlsx");
        let config_path = dir.join("extract_rules.json");
        let mut config = write_financial_check_config(&config_path)?;
        config.sheet_rules.preferred_sheet_names = vec!["cost".to_string()];

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("order_1")?;
        order.write_string(0, 0, "订单号")?;
        order.write_string(0, 1, "金额")?;
        order.write_string(1, 0, "Raul87632")?;
        order.write_number(1, 1, 360.98)?;

        let cost = workbook.add_worksheet();
        cost.set_name("cost")?;
        cost.write_string(0, 0, "订单号")?;
        cost.write_string(0, 1, "金额")?;
        cost.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        cost.write_string(1, 0, "Raul87632")?;
        cost.write_number(1, 1, 40.13)?;
        cost.write_number(1, 2, 40.13)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("cost"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_uses_preferred_sheet_order_as_tiebreaker() -> Result<()> {
        let dir = fixture_dir("header_preview_preferred_order");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Voja-1~6.18 orders.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["Cost", "cost", "order_1", "Sheet1", "orders_export", "Order", "order_"],
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 80,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Name"],
              "value_patterns": ["^#?[A-Za-z]+\\d+$"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Lineitem quantity"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price", "Lineitem price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let orders = workbook.add_worksheet();
        orders.set_name("orders_export")?;
        orders.write_string(0, 0, "Name")?;
        orders.write_string(0, 16, "Lineitem quantity")?;
        orders.write_string(0, 18, "Lineitem price")?;
        orders.write_string(0, 20, "Lineitem sku")?;
        for column in 1..25 {
            if !matches!(column, 16 | 18 | 20) {
                orders.write_string(0, column, format!("Extra {column}"))?;
            }
        }
        orders.write_string(1, 0, "#BLOOM1023")?;
        orders.write_number(1, 16, 1.0)?;
        orders.write_number(1, 18, 39.95)?;
        orders.write_string(1, 20, "AZ2601827")?;

        let cost = workbook.add_worksheet();
        cost.set_name("cost")?;
        cost.write_string(0, 0, "Name")?;
        cost.write_string(0, 1, "Email")?;
        cost.write_string(0, 2, "Shipping Country")?;
        cost.write_string(0, 3, "SKU")?;
        cost.write_string(0, 4, "Lineitem quantity")?;
        cost.write_string(0, 5, "price")?;
        for column in 6..16 {
            cost.write_string(0, column, format!("Cost Extra {column}"))?;
        }
        cost.write_string(1, 0, "#BLOOM1023")?;
        cost.write_string(1, 3, "AZ2601827")?;
        cost.write_number(1, 4, 1.0)?;
        cost.write_number(1, 5, 6.19)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("cost"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_prefers_sheet_with_sample_sku_over_empty_preferred_sheet() -> Result<()>
    {
        let dir = fixture_dir("header_preview_sample_sku");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Grafton store Order.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["Sheet1"],
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 20,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "value_patterns": ["^[A-Z]{2}-[A-Z]{2}-\\d+$"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Quantity"],
              "value_patterns": ["^\\d+$"],
              "pair_with": "sku_detail",
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let empty_preferred = workbook.add_worksheet();
        empty_preferred.set_name("Sheet1")?;
        empty_preferred.write_string(0, 0, "Order number")?;
        empty_preferred.write_string(0, 1, "SKU")?;
        empty_preferred.write_string(0, 2, "Quantity")?;
        empty_preferred.write_string(1, 0, "GC-SL-15003")?;
        empty_preferred.write_number(1, 2, 1.0)?;

        let order_sheet = workbook.add_worksheet();
        order_sheet.set_name("Sheet1 (2)")?;
        order_sheet.write_string(0, 0, "Order number")?;
        order_sheet.write_string(0, 1, "SKU")?;
        order_sheet.write_string(0, 2, "Quantity")?;
        order_sheet.write_string(1, 0, "GC-SL-15003")?;
        order_sheet.write_string(1, 1, "QY2600223")?;
        order_sheet.write_number(1, 2, 1.0)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);
        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("Sheet1 (2)"));
        assert_eq!(header_row, Some(1));

        let result = extract_records(&source, &config, None)?;
        assert_eq!(result.sheet_name, "Sheet1 (2)");
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].sku_pairs[0].0.text(), "QY2600223");

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_penalizes_wider_header_rows() -> Result<()> {
        let dir = fixture_dir("header_preview_wide_penalty");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Marlon__2026.06.12__orders_export.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 80,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Name"],
              "value_patterns": ["^#?\\d+$"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Lineitem quantity"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Cost", "Lineitem price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let wide = workbook.add_worksheet();
        wide.set_name("orders_export")?;
        wide.write_string(0, 0, "Name")?;
        wide.write_string(0, 16, "Lineitem quantity")?;
        wide.write_string(0, 18, "Lineitem price")?;
        wide.write_string(0, 20, "Lineitem sku")?;
        for column in 1..25 {
            if !matches!(column, 16 | 18 | 20) {
                wide.write_string(0, column, format!("Extra {column}"))?;
            }
        }
        wide.write_string(1, 0, "#1002")?;
        wide.write_number(1, 16, 1.0)?;
        wide.write_number(1, 18, 99.0)?;
        wide.write_string(1, 20, "QY2601025")?;

        let narrow = workbook.add_worksheet();
        narrow.set_name("orders_export (2)")?;
        narrow.write_string(0, 0, "Name")?;
        narrow.write_string(0, 2, "Lineitem quantity")?;
        narrow.write_string(0, 3, "Cost")?;
        narrow.write_string(0, 4, "SKU")?;
        narrow.write_string(1, 0, "#1002")?;
        narrow.write_number(1, 2, 1.0)?;
        narrow.write_number(1, 3, 45.39)?;
        narrow.write_string(1, 4, "QY2601025")?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("orders_export (2)"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_alias_score_uses_alias_order_as_tiebreaker() {
        let first = vec!["name".to_string(), "order number".to_string()];
        let second = vec!["order number".to_string(), "name".to_string()];
        assert!(
            header_alias_score_prepared("name", &first)
                > header_alias_score_prepared("name", &second)
        );

        let contains_first = vec!["sku".to_string(), "product".to_string()];
        let contains_second = vec!["product".to_string(), "sku".to_string()];
        assert!(
            header_alias_score_prepared("lineitem sku", &contains_first)
                > header_alias_score_prepared("lineitem sku", &contains_second)
        );
    }

    #[test]
    fn header_confirmation_reports_missing_order_number_with_found_candidates() -> Result<()> {
        let dir = fixture_dir("header_preview_missing_order_number");
        fs::create_dir_all(&dir)?;
        let source = dir.join("06.01 Anass orders_export.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_order_sheet_diagnostic_config(&config_path)?;

        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        sheet.set_name("orders_export  st (2)")?;
        sheet.write_string(0, 0, "Name")?;
        sheet.write_string(0, 1, "Lineitem quantity")?;
        sheet.write_string(0, 2, "Cost")?;
        sheet.write_string(0, 3, "SKU")?;
        sheet.write_string(1, 0, "#QQ17561141")?;
        sheet.write_number(1, 1, 1.0)?;
        sheet.write_number(1, 2, 10.39)?;
        sheet.write_string(1, 3, "ABC123")?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(
            reason.as_deref(),
            Some(
                "未找到满足订单主表条件的表头行：缺少 order_number；已发现 SKU/数量/金额候选，需人工确认"
            )
        );
        assert_eq!(sheet_name, None);
        assert_eq!(header_row, None);

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_keeps_order_sheet_over_price_sheet_without_order_number() -> Result<()> {
        let dir = fixture_dir("header_preview_order_required");
        fs::create_dir_all(&dir)?;
        let source = dir.join("10X868 order 5-JUN.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "required": true
            },
            "country_en": {
              "header_aliases": ["Country"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": true
            },
            "country_cn": {
              "header_aliases": ["Country", "中文国家名"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            },
            "financial_check_price": {
              "header_aliases": [],
              "value_patterns": ["^-?\\d+\\.\\d+$"],
              "require_empty_header": true,
              "pair_with": "price",
              "required": false
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("order_1")?;
        order.write_string(0, 0, "Order number")?;
        order.write_string(0, 1, "Country")?;
        order.write_string(0, 2, "中文国家名")?;
        order.write_string(0, 3, "SKU")?;
        order.write_string(0, 4, "Qty")?;
        order.write_string(0, 5, "Price")?;
        order.write_string(1, 0, "10X8681009")?;
        order.write_string(1, 1, "United States")?;
        order.write_string(1, 2, "美国")?;
        order.write_string(1, 3, "TC2501009-6pcs-H")?;
        order.write_number(1, 4, 1.0)?;
        order.write_number(1, 5, 11.8)?;

        let price = workbook.add_worksheet();
        price.set_name("Sheet1")?;
        price.write_string(0, 0, "SKU")?;
        price.write_string(0, 1, "Country")?;
        price.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        price.write_blank(0, 3, &rust_xlsxwriter::Format::new())?;
        price.write_string(1, 0, "TC2500124-S")?;
        price.write_string(1, 1, "United States")?;
        price.write_number(1, 2, 14.3)?;
        price.write_number(1, 3, 1.386)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("order_1"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_requires_real_alias_for_each_required_header() -> Result<()> {
        let dir = fixture_dir("header_preview_requires_real_aliases");
        fs::create_dir_all(&dir)?;
        let source = dir.join("sample.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"]
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty"],
              "value_patterns": ["^\\d+$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "Item")?;
        worksheet.write_string(0, 2, "Count")?;
        worksheet.write_string(0, 3, "Price")?;
        worksheet.write_string(1, 0, "TC-1001")?;
        worksheet.write_string(1, 1, "FZ2500304")?;
        worksheet.write_number(1, 2, 1.0)?;
        worksheet.write_number(1, 3, 10.5)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert!(reason.is_some());
        assert_eq!(sheet_name, None);
        assert_eq!(header_row, None);

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_rejects_price_data_row_as_header() -> Result<()> {
        let dir = fixture_dir("header_preview_price_data");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Voja 6.1 orders #48869-48959.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["orders_export"],
            "header_scan_rows": 10,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 20,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number", "Name"],
              "value_patterns": ["^(?:[A-Za-z][A-Za-z0-9-]*[0-9][A-Za-z0-9-]*|[0-9][A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$"],
              "required": true
            },
            "country_en": {
              "header_aliases": ["Country", "Shipping: Country"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": true
            },
            "country_cn": {
              "header_aliases": ["Country", "国家中文"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU", "Lineitem sku"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty", "Lineitem quantity"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price", "Lineitem price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("orders_export")?;
        order.write_string(0, 0, "Name")?;
        order.write_string(0, 1, "Shipping Country")?;
        order.write_string(0, 2, "国家中文")?;
        order.write_string(0, 3, "Lineitem sku")?;
        order.write_string(0, 4, "Lineitem quantity")?;
        order.write_string(0, 5, "Lineitem price")?;
        order.write_string(1, 0, "#48869")?;
        order.write_string(1, 1, "Belgium")?;
        order.write_string(1, 2, "比利时")?;
        order.write_string(1, 3, "FZ2500304")?;
        order.write_number(1, 4, 1.0)?;
        order.write_number(1, 5, 29.99)?;

        let price = workbook.add_worksheet();
        price.set_name("price")?;
        price.write_string(0, 0, "Supplier address")?;
        price.write_string(2, 0, "Quotation")?;
        price.write_string(3, 0, "Clients")?;
        price.write_string(3, 1, "Item No.")?;
        price.write_string(3, 2, "Picture")?;
        price.write_string(3, 3, "Description")?;
        price.write_string(3, 5, "Country")?;
        price.write_string(3, 6, "Dropshipping price")?;
        price.write_string(7, 0, "Name")?;
        price.write_string(7, 1, "Voja Trifkovic SkinAnew")?;
        price.write_string(7, 2, "FZ2500304")?;
        price.write_string(7, 5, "BE")?;
        price.write_number(7, 6, 6.69)?;
        price.write_string(8, 0, "Voja48869")?;
        price.write_string(8, 1, "Voja Trifkovic SkinAnew")?;
        price.write_string(8, 2, "FZ2500305")?;
        price.write_string(8, 5, "United States")?;
        price.write_number(8, 6, 9.49)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("orders_export"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn sheet_selection_rejects_price_matrix_with_name_and_numeric_headers() -> Result<()> {
        let dir = fixture_dir("header_preview_price_matrix");
        fs::create_dir_all(&dir)?;
        let source = dir.join("06.10 Alurase order.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["Sheet1", "order_"],
            "header_scan_rows": 20,
            "data_sample_rows": 10,
            "sample_column_scan_limit": 20,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true,
            "empty_header_fields_can_boost_sheet": false,
            "weak_order_number_aliases": ["Name"],
            "reject_header_keywords": ["Dropshipping price", "Payment Way", "Picture"],
            "sequential_numeric_header_penalty": 500
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号", "Name"],
              "value_patterns": ["^(?:[A-Za-z][A-Za-z0-9-]*[0-9][A-Za-z0-9-]*|[0-9][A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$"],
              "required": true
            },
            "country_code": {
              "header_aliases": ["Country", "国家二字码"],
              "value_patterns": ["^[A-Z]{2}$"],
              "required": false
            },
            "country_en": {
              "header_aliases": ["Country", "收货人国家"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": false
            },
            "country_cn": {
              "header_aliases": ["Country", "中文国家名"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": false
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["产品总数", "Qty"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price", "Price", "Dropshipping price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            },
            "financial_check_price": {
              "header_aliases": [],
              "value_patterns": ["^-?\\d+\\.\\d+$"],
              "require_empty_header": true,
              "pair_with": "price",
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("Sheet1")?;
        order.write_string(0, 0, "订单号")?;
        order.write_string(0, 1, "国家二字码")?;
        order.write_string(0, 2, "收货人国家")?;
        order.write_string(0, 3, "中文国家名")?;
        order.write_string(0, 4, "SKU")?;
        order.write_string(0, 5, "产品总数")?;
        order.write_string(0, 6, "price")?;
        order.write_blank(0, 7, &rust_xlsxwriter::Format::new())?;
        order.write_string(1, 0, "7983668-1983")?;
        order.write_string(1, 1, "GB")?;
        order.write_string(1, 2, "UNITED KINGDOM")?;
        order.write_string(1, 3, "英国")?;
        order.write_string(1, 4, "KJ2500692")?;
        order.write_number(1, 5, 2.0)?;
        order.write_number(1, 6, 15.49)?;
        order.write_number(1, 7, 15.49)?;

        let price = workbook.add_worksheet();
        price.set_name("Sheet2")?;
        price.write_string(3, 0, "Item No.")?;
        price.write_string(3, 1, "Picture")?;
        price.write_string(3, 2, "Name")?;
        price.write_string(3, 3, "Description")?;
        price.write_string(3, 4, "Payment Way")?;
        price.write_string(3, 5, "SKU")?;
        price.write_string(3, 6, "Country")?;
        price.write_string(3, 7, "Dropshipping price")?;
        price.write_blank(3, 8, &rust_xlsxwriter::Format::new())?;
        price.write_blank(3, 9, &rust_xlsxwriter::Format::new())?;
        price.write_blank(3, 10, &rust_xlsxwriter::Format::new())?;
        price.write_number(4, 7, 1.0)?;
        price.write_number(4, 8, 2.0)?;
        price.write_number(4, 9, 3.0)?;
        price.write_number(4, 10, 5.0)?;
        price.write_string(5, 2, "Oregano Black Seed Boost")?;
        price.write_string(5, 5, "FZ2501254")?;
        price.write_string(5, 6, "US")?;
        price.write_number(5, 7, 7.19)?;
        price.write_number(5, 8, 10.99)?;
        price.write_number(5, 9, 14.79)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("Sheet1"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn numeric_header_ladder_detects_pcs_quantity_headers() {
        let headers = [
            "Item No.", "Name", "SKU", "Country", "1 pcs", "3 pcs", "4 pcs", "6 pcs", "7 pcs",
            "9 pcs", "10 pcs",
        ]
        .into_iter()
        .map(normalize_header)
        .collect::<Vec<_>>();

        assert!(has_numeric_header_ladder(&headers));
    }

    #[test]
    fn numeric_header_ladder_detects_three_numeric_headers() {
        let headers = ["SKU", "Country", "1 pcs", "2 pcs", "3 pcs"]
            .into_iter()
            .map(normalize_header)
            .collect::<Vec<_>>();

        assert!(has_numeric_header_ladder(&headers));
        assert_eq!(numeric_header_ladder_level(&headers), 1);
    }

    #[test]
    fn numeric_header_ladder_penalty_gets_stronger_with_more_numeric_headers() {
        let three_headers = ["SKU", "1 pcs", "3 pcs", "5 pcs"]
            .into_iter()
            .map(normalize_header)
            .collect::<Vec<_>>();
        let five_headers = ["SKU", "1 pcs", "2 pcs", "3 pcs", "4 pcs", "5 pcs"]
            .into_iter()
            .map(normalize_header)
            .collect::<Vec<_>>();

        assert_eq!(numeric_header_ladder_level(&three_headers), 1);
        assert!(
            numeric_header_ladder_level(&five_headers)
                > numeric_header_ladder_level(&three_headers)
        );
    }

    #[test]
    fn financial_check_empty_header_adjustment_rewards_single_and_penalizes_many() {
        let config = Config::default();

        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 1, &config),
            20.0
        );
        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 2, &config),
            10.0
        );
        assert!(
            (financial_check_empty_header_adjustment(20.0, 3, &config) - 20.0 / 3.0).abs() < 0.001
        );
        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 4, &config),
            -20.0
        );
        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 5, &config),
            -40.0
        );
    }

    #[test]
    fn empty_header_decimal_column_boosts_sheet_selection() -> Result<()> {
        let dir = fixture_dir("financial_check_sheet");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let first = workbook.add_worksheet();
        first.set_name("普通订单")?;
        first.write_string(0, 0, "订单号")?;
        first.write_string(0, 1, "金额")?;
        first.write_string(0, 2, "备注")?;
        first.write_string(1, 0, "A-WRONG")?;
        first.write_number(1, 1, 12.0)?;
        first.write_string(1, 2, "not target")?;

        let target = workbook.add_worksheet();
        target.set_name("核价订单")?;
        target.write_string(0, 0, "订单号")?;
        target.write_string(0, 1, "金额")?;
        target.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        target.write_string(1, 0, "A-001")?;
        target.write_number(1, 1, 12.5)?;
        target.write_number(1, 2, 8.75)?;
        target.write_string(2, 0, "A-002")?;
        target.write_number(2, 1, 0.0)?;
        target.write_number(2, 2, 0.0)?;
        target.write_string(3, 0, "A-003")?;
        target.write_number(3, 1, 9.5)?;
        target.write_number(3, 2, 6.25)?;
        workbook.save(&source)?;

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.sheet_name, "核价订单");
        assert_eq!(result.records.len(), 3);
        assert_eq!(
            result.records[0]
                .values
                .get("financial_check_price")
                .cloned()
                .unwrap_or_default()
                .text(),
            "8.75"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn financial_check_empty_header_signal_penalizes_more_than_three_columns() -> Result<()> {
        let dir = fixture_dir("financial_check_many_empty_headers");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("核价订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "金额")?;
        let blank_format = rust_xlsxwriter::Format::new();
        for column in 2..6 {
            worksheet.write_blank(0, column, &blank_format)?;
        }
        for row in 1..=3 {
            worksheet.write_string(row, 0, format!("A-{row:03}"))?;
            worksheet.write_number(row, 1, 10.0 + row as f64)?;
            for column in 2..6 {
                worksheet.write_number(row, column, 8.0 + column as f64 + row as f64 / 10.0)?;
            }
        }
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let sheet = preview.sheets.first().expect("fixture sheet exists");
        let columns = columns_to_candidates(sheet, 1, &config);

        assert!(columns.contains_key("financial_check_price"));
        assert_eq!(
            financial_check_sheet_adjustment(sheet, 1, &columns, &config),
            -20.0
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn extract_records_skips_summary_rows_without_sku_data() -> Result<()> {
        let dir = fixture_dir("skip_summary_without_sku");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.26__orders.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_three_sku_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("order_1")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(0, 3, "金额")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-A-1")?;
        worksheet.write_number(1, 2, 1.0)?;
        worksheet.write_number(1, 3, 25.39)?;
        worksheet.write_string(2, 0, "Total")?;
        worksheet.write_number(2, 2, 3.0)?;
        worksheet.write_number(2, 3, 76.17)?;
        workbook.save(&source)?;

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("order_number")
                .cloned()
                .unwrap_or_default()
                .text(),
            "A-001"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn extracts_three_sku_qty_pairs_when_output_allows_three_groups() -> Result<()> {
        let dir = fixture_dir("three_sku_groups");
        fs::create_dir_all(&dir)?;
        let source = dir.join("06.03 Shaun #1723-#1746 order.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_three_sku_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("order_1")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(0, 3, "SKU")?;
        worksheet.write_string(0, 4, "数量")?;
        worksheet.write_string(0, 5, "SKU")?;
        worksheet.write_string(0, 6, "数量")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-A-1")?;
        worksheet.write_number(1, 2, 1.0)?;
        worksheet.write_string(1, 3, "SKU-B-2")?;
        worksheet.write_number(1, 4, 2.0)?;
        worksheet.write_string(1, 5, "SKU-C-3")?;
        worksheet.write_number(1, 6, 3.0)?;
        workbook.save(&source)?;

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].sku_pairs.len(), 3);
        assert_eq!(result.records[0].sku_pairs[2].0.text(), "SKU-C-3");
        assert_eq!(result.records[0].sku_pairs[2].1.text(), "3");

        fs::remove_dir_all(dir).ok();
        Ok(())
    }
}
