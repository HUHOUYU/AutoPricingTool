use super::*;

pub(super) fn aggregate_lines(lines: &[OrderLine]) -> Vec<AggregatedOrderSku> {
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
pub(super) struct MatchedRowCandidate {
    pub(super) sku_pair_priority: usize,
    pub(super) pricing_price: f64,
}

pub(super) fn record_matched_candidates(
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

pub(super) fn order_tax_column_index(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
) -> Option<usize> {
    let header_index = mapping.order_header_row.checked_sub(1)?;
    exact_header_columns(sheet, header_index, ORDER_TAX_ALIASES)
        .into_iter()
        .next()
}

pub(super) fn order_tax_amount(row: &[CellValue], tax_column_index: Option<usize>) -> f64 {
    tax_column_index
        .and_then(|column| row.get(column))
        .and_then(parse_price)
        .unwrap_or_default()
}

pub(super) fn normalize_price_difference(value: f64) -> f64 {
    if value.abs() < PRICE_DIFFERENCE_ZERO_EPSILON {
        0.0
    } else {
        value
    }
}

pub(super) fn build_writeback_rows(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    candidates: &HashMap<usize, MatchedRowCandidate>,
    resolved_quantities: &[ResolvedOrderQuantity],
) -> Vec<PriceWritebackRow> {
    let Some(_) = highest_priority_sku_qty_pair(mapping) else {
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
            quantity_mismatch: quantity_mismatch_for_row(sheet, mapping, source_row, quantity),
        });
    }
    rows
}
