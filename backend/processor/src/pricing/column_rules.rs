use super::*;

pub(super) fn pair_sku_qty_columns(
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

pub(super) fn highest_sku_quantity_group(
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

pub(super) fn deduplicate_equivalent_sku_qty_pairs(
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

pub(super) fn tier_columns(
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

pub(super) fn numeric_header_ladder_level(row: &[CellValue], excluded: &HashSet<usize>) -> usize {
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

pub(super) fn parse_tier(value: &str) -> Option<i64> {
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
