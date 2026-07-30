use super::*;

#[cfg(test)]
pub(super) fn infer_pricing_candidate(sheet: &SheetData) -> Option<PricingSheetCandidate> {
    infer_pricing_candidate_with_config(sheet, &Config::default())
}

pub(super) fn infer_pricing_candidate_with_config(
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

pub(super) fn best_pricing_country_column(
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

pub(super) fn best_quantity_one_price_column(
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

pub(super) fn best_pricing_sku_column(
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

pub(super) fn score_price_rows(
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
