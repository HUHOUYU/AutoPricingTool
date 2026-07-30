use super::{CellValue, Config, FieldRule, ORDER_HEADER_SCAN_ROWS, SheetData};

pub(super) const HEADER_EXACT_SCORE: i32 = 300;
const HEADER_CONTAINS_SCORE: i32 = 160;
const HEADER_ALIAS_ORDER_STEP: i32 = 1;
const VALUE_PATTERN_MAX_SCORE: i32 = 500;
const NEGATIVE_PATTERN_MAX_PENALTY: i32 = 500;
const NEGATIVE_HEADER_PENALTY: i32 = 450;
const LOW_PRIORITY_HEADER_PENALTY: i32 = 220;

pub(super) fn order_field_rule<'a>(config: &'a Config, name: &str) -> Option<&'a FieldRule> {
    config.pricing_fields.order.get(name)
}

pub(super) fn pricing_field_rule<'a>(config: &'a Config, name: &str) -> Option<&'a FieldRule> {
    config.pricing_fields.pricing.get(name)
}

pub(super) fn quantity_one_price_rule(config: &Config) -> Option<&FieldRule> {
    pricing_field_rule(config, "quantity_one_price")
        .or_else(|| pricing_field_rule(config, "fixed_price"))
}

pub(super) fn configured_matching_columns(
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

pub(super) fn configured_exact_header_columns(
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

pub(super) fn configured_header_is_exact(
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

pub(super) fn configured_best_column(
    sheet: &SheetData,
    header_idx: usize,
    rule: Option<&FieldRule>,
    fallback_aliases: &[&str],
) -> Option<usize> {
    configured_matching_columns(sheet, header_idx, rule, fallback_aliases)
        .into_iter()
        .next()
}

pub(super) fn header_score(value: &str, aliases: &[&str]) -> i32 {
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

pub(super) fn configured_header_score(
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

pub(super) fn alias_match_score(
    normalized: &str,
    alias: &str,
    index: usize,
    alias_count: usize,
) -> i32 {
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

pub(super) fn field_sample_adjustment(
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

pub(super) fn normalize_header(value: &str) -> String {
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
