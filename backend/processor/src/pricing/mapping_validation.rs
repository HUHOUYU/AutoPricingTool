use super::*;

pub(super) fn recalculate_price_row(
    path: &Path,
    mapping: &PriceCheckMapping,
    cell_edits: &[PriceCellEdit],
    config: &Config,
    row_edit: &PriceRowEdit,
) -> Result<PriceRowRecalculation> {
    if row_edit.source_row == 0 {
        return Err(anyhow!("源数据行必须大于 0"));
    }
    if mapping.order_sheet == mapping.pricing_sheet {
        return Err(anyhow!("订单 Sheet 与核价 Sheet 不能相同"));
    }
    if !mapping_is_complete(mapping) {
        return Err(anyhow!(
            incomplete_mapping_reason(mapping).unwrap_or_else(|| "字段映射不完整".to_string())
        ));
    }
    let mut workbook = read_workbook_for_processing(path, config)?;
    apply_cell_edits(&mut workbook, cell_edits)?;
    let order_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.order_sheet)
        .ok_or_else(|| anyhow!("找不到订单 Sheet: {}", mapping.order_sheet))?;
    if let Err(diagnostic) = validate_mapping_core_range(order_sheet, mapping, config) {
        return Err(anyhow!(diagnostic.message));
    }
    let pricing_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.pricing_sheet)
        .ok_or_else(|| anyhow!("找不到核价 Sheet: {}", mapping.pricing_sheet))?;
    let row = order_sheet
        .rows
        .get(row_edit.source_row.saturating_sub(1))
        .ok_or_else(|| anyhow!("第 {} 行超出订单 Sheet 范围", row_edit.source_row))?;
    let fallback_override = PricePreviewWritebackRow {
        source_row: row_edit.source_row,
        pricing_price: None,
        price_difference: None,
        quantity: None,
        quantity_mismatch: false,
        quantity_error: None,
        quantity_issue_context: None,
        used_original_sku_quantity: row_edit.use_original_sku_quantity,
    };
    let mut resolved_quantities = if row_edit.use_original_sku_quantity {
        resolve_order_quantities_with_overrides(
            order_sheet,
            mapping,
            config,
            std::slice::from_ref(&fallback_override),
        )
    } else {
        resolve_order_quantities(order_sheet, mapping, config)
    };
    let target_index = resolved_quantities
        .iter()
        .position(|resolved| resolved.source_row == row_edit.source_row)
        .ok_or_else(|| {
            anyhow!(
                "第 {} 行没有有效订单号或不属于订单数据行",
                row_edit.source_row
            )
        })?;
    {
        let target = &mut resolved_quantities[target_index];
        if !row_edit.use_original_sku_quantity {
            target.quantity = row_edit.quantity;
            target.quantity_error = None;
            target.quantity_issue_context = None;
            target.absorbed = false;
        }
    }
    let target = &resolved_quantities[target_index];
    let effective_quantity = if row_edit.use_original_sku_quantity {
        target.quantity
    } else {
        row_edit.quantity
    };
    let base_row = PricePreviewWritebackRow {
        source_row: row_edit.source_row,
        pricing_price: None,
        price_difference: None,
        quantity: effective_quantity,
        quantity_mismatch: quantity_mismatch_for_row(
            order_sheet,
            mapping,
            row_edit.source_row,
            effective_quantity,
        ),
        quantity_error: None,
        quantity_issue_context: None,
        used_original_sku_quantity: row_edit.use_original_sku_quantity
            && target.quantity_error.is_none(),
    };
    if let Some(error) = &target.quantity_error {
        return Ok(PriceRowRecalculation {
            row: PricePreviewWritebackRow {
                quantity_error: Some(error.clone()),
                used_original_sku_quantity: false,
                ..base_row
            },
            error: Some(error.clone()),
        });
    }
    let Some(quantity) = effective_quantity else {
        return Ok(PriceRowRecalculation {
            row: PricePreviewWritebackRow {
                quantity_error: Some("数量为空，无法重新核价".to_string()),
                used_original_sku_quantity: false,
                ..base_row
            },
            error: Some("数量为空，无法重新核价".to_string()),
        });
    };
    if target.matched_sku.is_empty() {
        return Ok(PriceRowRecalculation {
            row: base_row,
            error: Some("主要 SKU 为空，无法重新核价".to_string()),
        });
    }

    let country = normalize_order_country_fields(
        &cell_text(row, mapping.country_code_column),
        &cell_text(row, mapping.country_english_column),
        &cell_text(row, mapping.country_chinese_column),
        &config.pricing,
    );
    if country.conflict {
        return Ok(PriceRowRecalculation {
            row: base_row,
            error: Some(country.reason),
        });
    }
    let single_shipment =
        single_shipment_orders(order_sheet, mapping, config, &resolved_quantities)
            .contains(&target.business_order_number);
    let lookup = build_price_index(pricing_sheet, mapping, &config.pricing)
        .lookup_routes_with_single_shipment_preference(
            &country.routes,
            &target.matched_sku,
            quantity as i64,
            single_shipment,
        );
    let Some(base_price) = lookup.price.filter(|_| lookup.status == "matched") else {
        return Ok(PriceRowRecalculation {
            row: base_row,
            error: Some(lookup.reason),
        });
    };
    let pricing_price =
        base_price + order_tax_amount(row, order_tax_column_index(order_sheet, mapping));
    let original_price = mapping
        .order_price_column
        .and_then(|column| row.get(column.saturating_sub(1)))
        .and_then(parse_price);
    Ok(PriceRowRecalculation {
        row: PricePreviewWritebackRow {
            pricing_price: Some(pricing_price),
            price_difference: original_price
                .map(|original| normalize_price_difference(pricing_price - original)),
            ..base_row
        },
        error: None,
    })
}

#[cfg(test)]
pub(super) fn validate_price_mapping(
    path: &Path,
    mapping: &PriceCheckMapping,
    cell_edits: &[PriceCellEdit],
    config: &Config,
) -> std::result::Result<MappingValidationResult, Vec<String>> {
    validate_price_mapping_with_overrides(path, mapping, cell_edits, &[], config)
        .map_err(|failure| failure.errors)
}

pub(super) fn validate_price_mapping_with_overrides(
    path: &Path,
    mapping: &PriceCheckMapping,
    cell_edits: &[PriceCellEdit],
    writeback_overrides: &[PricePreviewWritebackRow],
    config: &Config,
) -> std::result::Result<MappingValidationResult, MappingValidationFailure> {
    let mut workbook =
        read_workbook_for_processing(path, config).map_err(|error| MappingValidationFailure {
            errors: vec![format!("读取文件失败: {error:#}")],
            field_diagnostics: Vec::new(),
        })?;
    let data_edits = cell_edits
        .iter()
        .filter(|edit| {
            !((edit.sheet_name == mapping.order_sheet && edit.row == mapping.order_header_row)
                || (edit.sheet_name == mapping.pricing_sheet
                    && (edit.row == mapping.pricing_header_row
                        || Some(edit.row) == mapping.pricing_quantity_header_row)))
        })
        .cloned()
        .collect::<Vec<_>>();
    apply_cell_edits(&mut workbook, &data_edits).map_err(|error| MappingValidationFailure {
        errors: vec![format!("应用单元格编辑失败: {error:#}")],
        field_diagnostics: Vec::new(),
    })?;
    let mut errors = Vec::new();
    let mut field_diagnostics = mapping_field_diagnostics(Some(mapping), true, true);
    if mapping.order_sheet == mapping.pricing_sheet {
        errors.push("订单 Sheet 与核价 Sheet 不能相同".to_string());
    }
    let order_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.order_sheet);
    let pricing_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.pricing_sheet);
    if order_sheet.is_none() {
        errors.push("订单 Sheet 不存在".to_string());
    }
    if pricing_sheet.is_none() {
        errors.push("核价 Sheet 不存在".to_string());
    }
    let (Some(order_sheet), Some(pricing_sheet)) = (order_sheet, pricing_sheet) else {
        return Err(MappingValidationFailure {
            errors,
            field_diagnostics,
        });
    };
    let single_shipment_matching = single_shipment_matching_status(order_sheet, mapping, config);
    if let Some(reason) = incomplete_mapping_reason(mapping) {
        errors.push(reason);
    }
    if mapping.order_header_row == 0 || mapping.order_header_row > order_sheet.rows.len() {
        errors.push("订单表头行超出有效范围".to_string());
    }
    if mapping.pricing_header_row == 0 || mapping.pricing_header_row > pricing_sheet.rows.len() {
        errors.push("核价表头行超出有效范围".to_string());
    }
    if mapping
        .pricing_quantity_header_row
        .is_some_and(|row| row == 0 || row > pricing_sheet.rows.len())
    {
        errors.push("数量档位表头行超出有效范围".to_string());
    }
    match validate_mapping_core_range(order_sheet, mapping, config) {
        Ok(Some(diagnostic)) => field_diagnostics.push(diagnostic),
        Ok(None) => {}
        Err(diagnostic) => {
            errors.push(diagnostic.message.clone());
            field_diagnostics.push(diagnostic);
        }
    }
    let order_columns = order_sheet
        .rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default();
    let pricing_columns = pricing_sheet
        .rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default();
    let mut order_mapped_columns = [
        mapping.business_order_number_column,
        mapping.order_price_column,
    ]
    .into_iter()
    .flatten()
    .chain(mapping.sku_qty_pairs.iter().flat_map(|pair| {
        if pair.direct_quantity {
            vec![pair.qty_column, pair.sku_column]
        } else {
            vec![pair.qty_column, pair.sku_column, pair.merged_qty_column]
        }
    }))
    .collect::<Vec<_>>();
    if mapping.single_shipment_fields.is_empty() {
        order_mapped_columns.extend(mapping.single_shipment_column);
    } else {
        order_mapped_columns.extend(
            mapping
                .single_shipment_fields
                .iter()
                .flat_map(|field| field.columns.iter().copied()),
        );
    }
    for (identity, column) in [
        (CountryIdentity::Iso2, mapping.country_code_column),
        (CountryIdentity::English, mapping.country_english_column),
        (CountryIdentity::Chinese, mapping.country_chinese_column),
    ] {
        if config.pricing.uses_country_identity(identity)
            && let Some(column) = column
        {
            order_mapped_columns.push(column);
        }
    }
    if order_mapped_columns
        .iter()
        .any(|column| *column == 0 || *column > order_columns)
    {
        errors.push("订单字段列超出有效范围".to_string());
    }
    if mapping.pricing_sku_column == 0
        || mapping.pricing_country_column == 0
        || mapping.pricing_sku_column > pricing_columns
        || mapping.pricing_country_column > pricing_columns
        || mapping
            .quantity_tier_columns
            .iter()
            .any(|tier| tier.column == 0 || tier.column > pricing_columns || tier.quantity < 0)
    {
        errors.push("核价字段列或数量档位超出有效范围".to_string());
    }
    if mapping.sku_qty_pairs.iter().any(|pair| {
        pair.sku_column == pair.qty_column
            || (!pair.direct_quantity
                && (pair.sku_column == pair.merged_qty_column
                    || pair.qty_column == pair.merged_qty_column))
    }) {
        errors.push("原始数量、SKU 与合并数量列不能相同".to_string());
    }
    // 单组模式只要求 SKU 与数量列有效；多组模式继续要求原始数量 → SKU → 合并数量。
    if mapping.sku_qty_pairs.iter().any(|pair| {
        pair.qty_column == 0
            || pair.sku_column == 0
            || pair.merged_qty_column == 0
            || !(pair.direct_quantity
                || pair.qty_column < pair.sku_column && pair.sku_column < pair.merged_qty_column)
    }) {
        errors.push(
            "单 SKU 组必须映射 SKU 与数量列；多 SKU 组必须按“原始数量、SKU、合并数量”从左到右排列（可不连续）"
                .to_string(),
        );
    }
    let recognized_quantity_columns = configured_matching_columns(
        order_sheet,
        mapping.order_header_row.saturating_sub(1),
        order_field_rule(config, "quantity"),
        QTY_ALIASES,
    );
    // 识别到的数量别名列，或空表头列（允许人工把空表头列当数量列）均可
    let is_acceptable_quantity_column = |column_1based: usize| -> bool {
        let index = column_1based.saturating_sub(1);
        if recognized_quantity_columns.contains(&index) {
            return true;
        }
        // sheet_cell_text 参数为 1-based 行列
        sheet_cell_text(order_sheet, mapping.order_header_row, column_1based)
            .trim()
            .is_empty()
    };
    if mapping.sku_qty_pairs.iter().any(|pair| {
        !is_acceptable_quantity_column(pair.qty_column)
            || (!pair.direct_quantity && !is_acceptable_quantity_column(pair.merged_qty_column))
    }) {
        errors.push("原始数量列与合并数量列必须为有效数量列或空表头列".to_string());
    }
    let mut order_unique_columns = HashSet::new();
    if order_mapped_columns
        .iter()
        .any(|column| !order_unique_columns.insert(*column))
    {
        errors.push("订单字段映射中存在重复列".to_string());
    }
    let mut pricing_unique_columns =
        HashSet::from([mapping.pricing_sku_column, mapping.pricing_country_column]);
    let mut tier_quantities = HashSet::new();
    if mapping.quantity_tier_columns.iter().any(|tier| {
        !pricing_unique_columns.insert(tier.column) || !tier_quantities.insert(tier.quantity)
    }) {
        errors.push("数量档位中存在重复列或重复数量".to_string());
    }
    if !errors.is_empty() {
        errors.sort();
        errors.dedup();
        return Err(MappingValidationFailure {
            errors,
            field_diagnostics,
        });
    }

    let index = build_price_index(pricing_sheet, mapping, &config.pricing);
    let (lines, quantity_exceptions, resolved_quantities) =
        read_order_lines_with_overrides(order_sheet, mapping, config, writeback_overrides);
    let evaluated_rows = lines.len();
    let (matched_rows, matched_order_rows) = evaluate_matches(&index, &lines);
    let unmatched_rows = unmatched_price_issues(&index, mapping, &lines);
    let writeback_rows = calculate_preview_writeback_rows(
        order_sheet,
        mapping,
        &index,
        &lines,
        &resolved_quantities,
        writeback_overrides,
    );
    let coverage = ratio(matched_rows, evaluated_rows);
    let mut warnings = Vec::new();
    let quantity_exception_count = quantity_exceptions
        .iter()
        .filter(|exception| matches!(exception.kind.as_str(), "数量无效" | "SKU关系无法计算"))
        .count();
    if quantity_exception_count > 0 {
        warnings.push(format!(
            "{} 行数量无法计算，需要确认",
            quantity_exception_count
        ));
    }
    if evaluated_rows == 0 {
        warnings.push("没有可用于试算的订单行".to_string());
    } else if evaluated_rows < config.automation.min_trial_rows && coverage < 1.0 {
        warnings.push(format!(
            "试算少于 {} 行时覆盖率必须达到 100%",
            config.automation.min_trial_rows
        ));
    } else if coverage < config.automation.coverage_threshold {
        warnings.push(format!(
            "试算覆盖率低于 {:.1}%",
            config.automation.coverage_threshold * 100.0
        ));
    }
    Ok(MappingValidationResult {
        evaluated_rows,
        matched_rows,
        coverage,
        matched_order_rows,
        writeback_rows,
        unmatched_rows,
        single_shipment_matching,
        field_diagnostics,
        warnings,
    })
}

pub(super) fn unmatched_price_issues(
    index: &PriceIndex,
    mapping: &PriceCheckMapping,
    lines: &[OrderLine],
) -> Vec<UnmatchedPriceIssue> {
    lines
        .iter()
        .filter_map(|line| {
            let lookup = index.lookup_routes_with_single_shipment_preference(
                &line.country.routes,
                &line.matched_sku,
                line.quantity.round() as i64,
                line.single_shipment,
            );
            (lookup.status != "matched").then(|| UnmatchedPriceIssue {
                source_row: line.source_row,
                sku_column: mapping
                    .sku_qty_pairs
                    .get(line.sku_pair_priority)
                    .map(|pair| pair.sku_column)
                    .unwrap_or_default(),
                sku: line.matched_sku.clone(),
                country: line.country.routes.join(" / "),
                quantity: line.quantity,
                reason: format!("{}：{}", lookup.status, lookup.reason),
            })
        })
        .collect()
}

pub(super) fn evaluate_matches(index: &PriceIndex, lines: &[OrderLine]) -> (usize, Vec<usize>) {
    let mut matched_rows = 0;
    let mut order_row_matches = HashMap::new();
    for line in lines {
        let lookup = index.lookup_routes_with_single_shipment_preference(
            &line.country.routes,
            &line.matched_sku,
            line.quantity.round() as i64,
            line.single_shipment,
        );
        let matched = lookup.status == "matched";
        order_row_matches
            .entry(line.source_row)
            .and_modify(|all_matched| *all_matched &= matched)
            .or_insert(matched);
        if matched {
            matched_rows += 1;
        }
    }
    let mut matched_order_rows = order_row_matches
        .into_iter()
        .filter_map(|(source_row, all_matched)| all_matched.then_some(source_row))
        .collect::<Vec<_>>();
    matched_order_rows.sort_unstable();
    (matched_rows, matched_order_rows)
}

pub(super) fn calculate_preview_writeback_rows(
    order_sheet: &SheetData,
    mapping: &PriceCheckMapping,
    index: &PriceIndex,
    lines: &[OrderLine],
    resolved_quantities: &[ResolvedOrderQuantity],
    writeback_overrides: &[PricePreviewWritebackRow],
) -> Vec<PricePreviewWritebackRow> {
    let quantity_issue_contexts = resolved_quantities
        .iter()
        .filter_map(|resolved| {
            resolved
                .quantity_issue_context
                .clone()
                .map(|context| (resolved.source_row, context))
        })
        .collect::<HashMap<_, _>>();
    let mut matched_candidates = HashMap::new();
    let original_value_rows = writeback_overrides
        .iter()
        .filter(|row| row.used_original_sku_quantity)
        .map(|row| row.source_row)
        .collect::<HashSet<_>>();
    for item in aggregate_lines(lines) {
        let lookup = index.lookup_routes_with_single_shipment_preference(
            &item.country_routes,
            &item.matched_sku,
            item.total_quantity.round() as i64,
            item.single_shipment,
        );
        if lookup.status == "matched"
            && let Some(pricing_price) = lookup.price
        {
            record_matched_candidates(&mut matched_candidates, &item, pricing_price);
        }
    }
    build_writeback_rows(
        order_sheet,
        mapping,
        &matched_candidates,
        resolved_quantities,
    )
    .into_iter()
    .map(|row| {
        let fallback_succeeded =
            original_value_rows.contains(&row.source_row) && row.quantity_error.is_none();
        PricePreviewWritebackRow {
            source_row: row.source_row,
            pricing_price: row.pricing_price,
            price_difference: row.price_difference,
            quantity: row.quantity,
            quantity_mismatch: row.quantity_mismatch,
            quantity_error: row.quantity_error,
            quantity_issue_context: quantity_issue_contexts.get(&row.source_row).cloned(),
            used_original_sku_quantity: fallback_succeeded,
        }
    })
    .collect()
}
