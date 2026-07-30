use super::*;

pub(super) fn sku_qty_pair_score(
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

pub(super) fn sku_qty_field_score(
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

pub(super) fn match_header_template(
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

pub(super) fn sheet_cell_text(sheet: &SheetData, row: usize, column: usize) -> String {
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
