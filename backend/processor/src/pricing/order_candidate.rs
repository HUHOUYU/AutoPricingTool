use super::*;

#[cfg(test)]
pub(super) fn infer_order_candidate(sheet: &SheetData) -> Option<OrderSheetCandidate> {
    infer_order_candidate_with_config(sheet, &Config::default())
}

pub(super) fn infer_order_candidate_with_config(
    sheet: &SheetData,
    config: &Config,
) -> Option<OrderSheetCandidate> {
    let mut best = None;
    let scan_limit = sheet.rows.len().min(ORDER_HEADER_SCAN_ROWS);
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
        let order_col = configured_best_column(
            sheet,
            header_idx,
            order_field_rule(config, "order_number"),
            ORDER_ID_ALIASES,
        );
        let mut raw_pairs = pair_sku_qty_columns(header, &sku_columns, &qty_columns);
        let using_product_name = raw_pairs.is_empty();
        if using_product_name {
            let product_name_columns = configured_matching_columns(
                sheet,
                header_idx,
                order_field_rule(config, "product_name"),
                PRODUCT_NAME_ALIASES,
            );
            raw_pairs = pair_sku_qty_columns(header, &product_name_columns, &qty_columns);
        }
        let mut detected_pairs =
            deduplicate_equivalent_sku_qty_pairs(sheet, header_idx + 1, &raw_pairs, order_col);
        detected_pairs.sort_by_key(|pair| {
            (
                std::cmp::Reverse(pair.sku_column.max(pair.qty_column)),
                std::cmp::Reverse(pair.sku_column),
            )
        });
        let exact_sku_columns =
            configured_exact_header_columns(header, order_field_rule(config, "sku"), SKU_ALIASES);
        let exact_qty_columns = configured_exact_header_columns(
            header,
            order_field_rule(config, "quantity"),
            QTY_ALIASES,
        );
        let direct_single_group = !using_product_name
            && exact_sku_columns.len() == 1
            && exact_qty_columns.len() == 1
            && exact_sku_columns[0] != exact_qty_columns[0];
        let pairs = if direct_single_group {
            let sku_column = exact_sku_columns[0];
            let qty_column = exact_qty_columns[0];
            vec![SkuQtyPair {
                sku_column: sku_column + 1,
                qty_column: qty_column + 1,
                merged_qty_column: qty_column + 1,
                direct_quantity: true,
                sku_header: header[sku_column].text(),
                qty_header: header[qty_column].text(),
                merged_qty_header: header[qty_column].text(),
            }]
        } else {
            highest_sku_quantity_group(header, &detected_pairs, &qty_columns)
        };
        if order_col.is_none() && detected_pairs.is_empty() {
            continue;
        }
        let (country_code, country_en, country_cn) =
            infer_order_country_columns(sheet, header_idx, config);
        let country_en = country_en.filter(|column| Some(*column) != country_code);
        let country_cn = country_cn
            .filter(|column| Some(*column) != country_code && Some(*column) != country_en);
        let single_shipment_fields =
            resolve_single_shipment_fields(sheet, header_idx, config, &[], None);
        let single_shipment = single_shipment_fields
            .iter()
            .find(|matched| matched.field == SingleShipmentMatchField::RecipientName)
            .and_then(|matched| matched.columns.first().copied());
        let price = configured_best_column(
            sheet,
            header_idx,
            order_field_rule(config, "price"),
            PRICE_ALIASES,
        );
        let (valid_rows, country_rows) = score_order_rows(
            sheet,
            header_idx + 1,
            &detected_pairs,
            order_col,
            [country_code, country_en, country_cn],
        );
        if valid_rows == 0
            || order_col.is_none()
            || detected_pairs.is_empty()
            || country_code.is_none() && country_en.is_none() && country_cn.is_none()
        {
            continue;
        }
        let mut notes = Vec::new();
        if raw_pairs.len() > detected_pairs.len() {
            notes.push(format!(
                "忽略 {} 组数据完全重复的数量/SKU/合并数量字段",
                raw_pairs.len() - detected_pairs.len()
            ));
        }
        if detected_pairs.len() > 1 && !direct_single_group {
            notes.push(format!(
                "识别到 {} 组数量/SKU/合并数量字段，仅使用最高优先级 SKU 组",
                detected_pairs.len()
            ));
        }
        if direct_single_group {
            notes.push("识别到单 SKU/数量组，直接使用 SKU 与数量列".to_string());
        }
        if pairs.is_empty() {
            notes.push(
                "最高优先级 SKU 未形成“数量 / SKU / 合并数量”三列组，需要人工确认".to_string(),
            );
        }
        if country_code.is_none() || country_en.is_none() || country_cn.is_none() {
            notes.push("国家三要素未全部识别，运行时会尝试补全并记录冲突".to_string());
        }
        if using_product_name && !pairs.is_empty() {
            notes.push("未识别到 SKU，使用产品名称作为临时匹配键".to_string());
        }
        let field_score = (detected_pairs.len() as f64 * 24.0)
            + if order_col.is_some() { 24.0 } else { 0.0 }
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
            country_code_column: country_code.map(|column| column + 1),
            country_english_column: country_en.map(|column| column + 1),
            country_chinese_column: country_cn.map(|column| column + 1),
            sku_qty_pairs: pairs,
            single_shipment_column: single_shipment,
            single_shipment_fields,
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

pub(super) fn infer_order_country_columns(
    sheet: &SheetData,
    header_idx: usize,
    config: &Config,
) -> (Option<usize>, Option<usize>, Option<usize>) {
    let code_rule = order_field_rule(config, "country_code");
    let english_rule = order_field_rule(config, "country_english");
    let chinese_rule = order_field_rule(config, "country_chinese");
    let mut candidates =
        configured_matching_columns(sheet, header_idx, code_rule, COUNTRY_CODE_ALIASES);
    candidates.extend(configured_matching_columns(
        sheet,
        header_idx,
        english_rule,
        COUNTRY_EN_ALIASES,
    ));
    candidates.extend(configured_matching_columns(
        sheet,
        header_idx,
        chinese_rule,
        COUNTRY_CN_ALIASES,
    ));
    candidates.sort_unstable();
    candidates.dedup();
    let mut code_column =
        configured_best_column(sheet, header_idx, code_rule, COUNTRY_CODE_ALIASES);
    let mut english_column =
        configured_best_column(sheet, header_idx, english_rule, COUNTRY_EN_ALIASES);
    let mut chinese_column =
        configured_best_column(sheet, header_idx, chinese_rule, COUNTRY_CN_ALIASES);

    let mut classified = Vec::new();
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
        let is_english = samples
            .iter()
            .any(|value| !has_chinese(value) && value.len() > 2 && country_lookup(value).is_some());
        classified.push((column, is_code, is_english, is_chinese));
    }
    if code_column.is_none_or(|current| {
        !classified
            .iter()
            .any(|(column, is_code, _, _)| *column == current && *is_code)
    }) {
        code_column = classified
            .iter()
            .find_map(|(column, is_code, _, _)| is_code.then_some(*column));
    }
    if english_column.is_none_or(|current| {
        !classified
            .iter()
            .any(|(column, _, is_english, _)| *column == current && *is_english)
    }) {
        english_column = classified
            .iter()
            .find_map(|(column, _, is_english, _)| is_english.then_some(*column));
    }
    if chinese_column.is_none_or(|current| {
        !classified
            .iter()
            .any(|(column, _, _, is_chinese)| *column == current && *is_chinese)
    }) {
        chinese_column = classified
            .iter()
            .find_map(|(column, _, _, is_chinese)| is_chinese.then_some(*column));
    }
    (code_column, english_column, chinese_column)
}

pub(super) fn score_order_rows(
    sheet: &SheetData,
    data_start: usize,
    pairs: &[SkuQtyPair],
    order_column: Option<usize>,
    country_columns: [Option<usize>; 3],
) -> (usize, usize) {
    let mut valid = 0;
    let mut country_rows = 0;
    for row in sheet.rows.iter().skip(data_start).take(120) {
        let has_order = order_column
            .and_then(|column| row.get(column))
            .is_some_and(|cell| !cell.is_empty());
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
