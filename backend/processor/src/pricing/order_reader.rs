use super::*;

pub(super) fn read_order_lines(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> (
    Vec<OrderLine>,
    Vec<PriceCheckException>,
    Vec<ResolvedOrderQuantity>,
) {
    let mut lines = Vec::new();
    let mut exceptions = Vec::new();
    let resolved_quantities = resolve_order_quantities(sheet, mapping, config);
    let single_shipment_orders =
        single_shipment_orders(sheet, mapping, config, &resolved_quantities);
    for resolved in &resolved_quantities {
        let row_index = resolved.source_row.saturating_sub(1);
        let Some(row) = sheet.rows.get(row_index) else {
            continue;
        };
        let business = resolved.business_order_number.clone();
        let code = cell_text(row, mapping.country_code_column);
        let english = cell_text(row, mapping.country_english_column);
        let chinese = cell_text(row, mapping.country_chinese_column);
        let country = normalize_order_country_fields(&code, &english, &chinese, &config.pricing);
        let single_shipment = single_shipment_orders.contains(&business);
        if let Some(error) = &resolved.quantity_error {
            exceptions.push(PriceCheckException {
                file_path: String::new(),
                sheet_name: sheet.name.clone(),
                source_row: Some(resolved.source_row),
                kind: if error.starts_with("数量") {
                    "数量无效".to_string()
                } else {
                    "SKU关系无法计算".to_string()
                },
                message: error.clone(),
            });
            continue;
        }
        if resolved.absorbed {
            continue;
        }
        if country.conflict {
            exceptions.push(PriceCheckException {
                file_path: String::new(),
                sheet_name: sheet.name.clone(),
                source_row: Some(resolved.source_row),
                kind: "国家三要素冲突".to_string(),
                message: country.reason.clone(),
            });
            continue;
        }
        if let Some(quantity) = resolved.quantity {
            lines.push(OrderLine {
                business_order_number: business,
                country,
                single_shipment,
                original_sku: resolved.raw_sku.clone(),
                matched_sku: resolved.matched_sku.clone(),
                quantity: quantity as f64,
                original_price: mapping
                    .order_price_column
                    .and_then(|column| row.get(column.saturating_sub(1)))
                    .and_then(parse_price),
                source_sheet: sheet.name.clone(),
                source_row: resolved.source_row,
                sku_pair_priority: resolved.sku_pair_priority,
            });
        }
    }
    (lines, exceptions, resolved_quantities)
}
