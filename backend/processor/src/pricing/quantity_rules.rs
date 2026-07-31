use super::*;

pub(super) fn quantity_source_columns(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> Result<QuantitySourceColumns, String> {
    let Some((_, main_pair)) = highest_priority_sku_qty_pair(mapping) else {
        return Err("没有主要 SKU 映射".to_string());
    };
    let header_idx = mapping.order_header_row.saturating_sub(1);
    if header_idx >= sheet.rows.len() {
        return Err("订单表头行超出范围".to_string());
    }
    let main_sku = main_pair.sku_column.saturating_sub(1);
    if main_pair.direct_quantity {
        return Ok(QuantitySourceColumns {
            main_sku,
            previous_sku: None,
            quantity: main_pair.qty_column.saturating_sub(1),
            direct_quantity: true,
        });
    }
    let mut sku_columns = configured_matching_columns(
        sheet,
        header_idx,
        order_field_rule(config, "sku"),
        SKU_ALIASES,
    );
    sku_columns.extend(
        mapping
            .sku_qty_pairs
            .iter()
            .map(|pair| pair.sku_column.saturating_sub(1)),
    );
    sku_columns.push(main_sku);
    sku_columns.sort_unstable();
    sku_columns.dedup();
    let previous_sku = sku_columns
        .iter()
        .copied()
        .filter(|column| *column < main_sku)
        .max()
        .ok_or_else(|| "主要 SKU 左侧找不到前一个 SKU 列".to_string())?;

    let mut quantity_columns = configured_matching_columns(
        sheet,
        header_idx,
        order_field_rule(config, "quantity"),
        QTY_ALIASES,
    );
    quantity_columns.extend(
        mapping
            .sku_qty_pairs
            .iter()
            .map(|pair| pair.qty_column.saturating_sub(1)),
    );
    quantity_columns.sort_unstable();
    quantity_columns.dedup();

    let left_sku_boundary = sku_columns
        .iter()
        .copied()
        .filter(|column| *column < previous_sku)
        .max();
    let local_quantity = quantity_columns
        .iter()
        .copied()
        .filter(|column| {
            (*column > previous_sku && *column < main_sku)
                || (*column < previous_sku
                    && left_sku_boundary.is_none_or(|boundary| *column > boundary))
        })
        .min_by_key(|column| (previous_sku.abs_diff(*column), std::cmp::Reverse(*column)));
    let left_fallback = quantity_columns
        .iter()
        .copied()
        .filter(|column| *column < previous_sku)
        .max();
    let quantity = local_quantity
        .or(left_fallback)
        .ok_or_else(|| "前一个 SKU 左侧找不到对应数量列".to_string())?;
    Ok(QuantitySourceColumns {
        main_sku,
        previous_sku: Some(previous_sku),
        quantity,
        direct_quantity: false,
    })
}

pub(super) fn resolve_direct_sku_quantity(
    raw_sku: &str,
    source_quantity: usize,
) -> Result<(String, usize), String> {
    let normalized = normalize_sku(raw_sku);
    if normalized.is_empty() {
        return Err("主要 SKU 为空".to_string());
    }
    if normalized.contains('+') || !normalized.contains('*') {
        return Ok((normalized, source_quantity));
    }
    let Some((sku, multiplier)) = normalized.rsplit_once('*') else {
        return Ok((normalized, source_quantity));
    };
    if sku.is_empty() || sku.contains('*') {
        return Err(format!("SKU 倍数格式无效: {normalized}"));
    }
    let multiplier = multiplier
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("SKU 倍数必须为正整数: {normalized}"))?;
    let quantity = source_quantity
        .checked_mul(multiplier)
        .ok_or_else(|| format!("数量计算溢出: {source_quantity} × {multiplier}"))?;
    Ok((sku.to_string(), quantity))
}

pub(super) fn resolve_order_quantities(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> Vec<ResolvedOrderQuantity> {
    resolve_order_quantities_with_overrides(sheet, mapping, config, &[])
}

pub(super) fn resolve_order_quantities_with_overrides(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
    overrides: &[PricePreviewWritebackRow],
) -> Vec<ResolvedOrderQuantity> {
    let source_columns = quantity_source_columns(sheet, mapping, config);
    let sku_pair_priority = highest_priority_sku_qty_pair(mapping)
        .map(|(priority, _)| priority)
        .unwrap_or_default();
    let mut resolved = Vec::new();
    for (row_index, row) in sheet.rows.iter().enumerate().skip(mapping.order_header_row) {
        let source_row = row_index + 1;
        let business_order_number =
            normalize_order_number(&cell_text(row, mapping.business_order_number_column));
        let raw_sku = source_columns
            .as_ref()
            .ok()
            .and_then(|columns| row.get(columns.main_sku))
            .map(CellValue::text)
            .unwrap_or_else(|| {
                highest_priority_sku_qty_pair(mapping)
                    .map(|(_, pair)| cell_text(row, Some(pair.sku_column)))
                    .unwrap_or_default()
            });
        // 没有订单号的合计、说明或空白行不属于订单，不能进入数量计算与核价聚合。
        if business_order_number.is_empty() {
            continue;
        }
        let quantity_issue_context = source_columns.as_ref().ok().and_then(|columns| {
            columns
                .previous_sku
                .map(|previous_sku| SkuQuantityIssueContext {
                    previous_sku_column: previous_sku + 1,
                    previous_sku: row
                        .get(previous_sku)
                        .map(CellValue::text)
                        .unwrap_or_default(),
                    main_sku_column: columns.main_sku + 1,
                    main_sku: raw_sku.clone(),
                })
        });
        let mut component_source = None;
        let sku_quantity_result = if raw_sku.is_empty() {
            Err("主要 SKU 为空".to_string())
        } else {
            source_columns
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|columns| {
                    let quantity = row
                        .get(columns.quantity)
                        .and_then(parse_number)
                        .filter(|value| *value >= 0.0 && value.fract() == 0.0)
                        .ok_or_else(|| {
                            format!(
                                "数量无效: {} 列没有可用非负整数",
                                excel_column_label(columns.quantity + 1)
                            )
                        })?;
                    if columns.direct_quantity {
                        return resolve_direct_sku_quantity(&raw_sku, quantity as usize);
                    }
                    let previous_sku_column = columns
                        .previous_sku
                        .ok_or_else(|| "主要 SKU 左侧找不到前一个 SKU 列".to_string())?;
                    let previous_sku = row
                        .get(previous_sku_column)
                        .map(CellValue::text)
                        .unwrap_or_default();
                    if previous_sku.is_empty() {
                        return Err("前一个 SKU 为空，SKU关系无法计算".to_string());
                    }
                    component_source = Some(CompoundQuantitySource {
                        previous_sku: previous_sku.clone(),
                        source_quantity: quantity as usize,
                    });
                    calculate_related_quantity(&raw_sku, &previous_sku, quantity as usize)
                        .map(|resolved_quantity| (normalize_sku(&raw_sku), resolved_quantity))
                })
        };
        let quantity_error = sku_quantity_result.as_ref().err().cloned();
        let matched_sku = sku_quantity_result
            .as_ref()
            .map(|(sku, _)| sku.clone())
            .unwrap_or_else(|_| normalize_sku(&raw_sku));
        resolved.push(ResolvedOrderQuantity {
            source_row,
            business_order_number,
            raw_sku,
            matched_sku,
            component_source,
            quantity: sku_quantity_result
                .as_ref()
                .ok()
                .map(|(_, quantity)| *quantity),
            quantity_issue_context: quantity_error
                .as_ref()
                .is_some_and(|error| error.contains("SKU关系无法计算"))
                .then_some(quantity_issue_context)
                .flatten(),
            quantity_error,
            absorbed: false,
            sku_pair_priority,
        });
    }

    let original_value_rows = overrides
        .iter()
        .filter(|row| row.used_original_sku_quantity)
        .map(|row| row.source_row)
        .collect::<HashSet<_>>();
    if let Some((priority, pair)) = highest_priority_sku_qty_pair(mapping) {
        let quantity_column = if pair.direct_quantity {
            pair.qty_column
        } else {
            pair.merged_qty_column
        };
        for item in &mut resolved {
            if !original_value_rows.contains(&item.source_row) {
                continue;
            }
            let Some(row) = sheet.rows.get(item.source_row.saturating_sub(1)) else {
                continue;
            };
            let raw_sku = cell_text(row, Some(pair.sku_column));
            let quantity = row
                .get(quantity_column.saturating_sub(1))
                .and_then(parse_number)
                .filter(|value| *value >= 0.0 && value.fract() == 0.0)
                .map(|value| value as usize);
            item.raw_sku = raw_sku.clone();
            item.matched_sku = normalize_sku(&raw_sku);
            item.component_source = None;
            item.quantity = quantity;
            item.quantity_error = if raw_sku.trim().is_empty() {
                Some(format!(
                    "最高评分 SKU 组的 {} 列 SKU 为空",
                    excel_column_label(pair.sku_column)
                ))
            } else if quantity.is_none() {
                Some(format!(
                    "最高评分 SKU 组的 {} 列没有可用非负整数数量",
                    excel_column_label(quantity_column)
                ))
            } else {
                None
            };
            item.quantity_issue_context = None;
            item.absorbed = false;
            item.sku_pair_priority = priority;
        }
    }

    // 吸收严格按订单隔离，且仅处理原金额明确为 0 的独立 SKU 行。
    let mut order_rows: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, item) in resolved.iter().enumerate() {
        if !item.business_order_number.is_empty() {
            order_rows
                .entry(item.business_order_number.clone())
                .or_default()
                .push(index);
        }
    }
    for indexes in order_rows.values() {
        for source_index in indexes {
            let source = &resolved[*source_index];
            if source.quantity.is_none() {
                continue;
            }
            let original_price = mapping
                .order_price_column
                .and_then(|column| {
                    sheet
                        .rows
                        .get(source.source_row.saturating_sub(1))?
                        .get(column.saturating_sub(1))
                })
                .and_then(parse_price);
            if original_price != Some(0.0) {
                continue;
            }
            let Ok(source_expression) = parse_sku_expression(&source.matched_sku) else {
                continue;
            };
            let targets = indexes
                .iter()
                .filter_map(|target_index| {
                    if target_index == source_index {
                        return None;
                    }
                    let target = &resolved[*target_index];
                    target.quantity?;
                    let expression = parse_sku_expression(&target.matched_sku).ok()?;
                    (expression.components.len() > 1
                        && expression.normalized != source_expression.normalized
                        && source_expression.components.iter().all(|(sku, quantity)| {
                            expression
                                .components
                                .get(sku)
                                .is_some_and(|target_quantity| target_quantity >= quantity)
                        }))
                    .then_some(target.matched_sku.clone())
                })
                .collect::<HashSet<_>>();
            if targets.len() == 1 {
                let source = &mut resolved[*source_index];
                source.quantity = Some(0);
                source.absorbed = true;
            } else if targets.len() > 1 {
                let source = &mut resolved[*source_index];
                source.quantity = None;
                source.quantity_error =
                    Some("SKU关系无法计算: 同订单内存在多个可吸收的复合主要 SKU".to_string());
            }
        }
    }

    // 同订单、同主要 SKU 全局合并；首行保留合计，后续行写 0。
    let mut groups: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (index, item) in resolved.iter().enumerate() {
        if !item.absorbed
            && item.quantity.is_some()
            && !item.business_order_number.is_empty()
            && !item.matched_sku.is_empty()
        {
            groups
                .entry((item.business_order_number.clone(), item.matched_sku.clone()))
                .or_default()
                .push(index);
        }
    }
    for indexes in groups.values() {
        let main_sku = &resolved[indexes[0]].matched_sku;
        let is_compound_component_group = parse_sku_expression(main_sku)
            .is_ok_and(|expression| expression.components.len() > 1)
            && indexes
                .iter()
                .all(|index| resolved[*index].component_source.is_some());
        let total = if is_compound_component_group {
            calculate_grouped_compound_quantity(main_sku, indexes, &resolved)
        } else {
            indexes
                .iter()
                .try_fold(0usize, |total, index| {
                    total.checked_add(resolved[*index].quantity.unwrap_or_default())
                })
                .ok_or_else(|| "数量合并溢出".to_string())
        };
        match total {
            Ok(total) => {
                for (position, index) in indexes.iter().enumerate() {
                    resolved[*index].quantity = Some(if position == 0 { total } else { 0 });
                }
            }
            Err(error) => {
                for index in indexes {
                    resolved[*index].quantity = None;
                    resolved[*index].quantity_error = Some(error.clone());
                }
            }
        }
    }
    resolved
}

fn calculate_grouped_compound_quantity(
    main_sku: &str,
    indexes: &[usize],
    resolved: &[ResolvedOrderQuantity],
) -> Result<usize, String> {
    let main = parse_sku_expression(main_sku)?;
    let mut component_quantities = HashMap::<String, usize>::new();
    for index in indexes {
        let source = resolved[*index]
            .component_source
            .as_ref()
            .ok_or_else(|| "复合 SKU 缺少组件数量来源".to_string())?;
        let previous = parse_sku_expression(&source.previous_sku)?;
        for (sku, multiplier) in previous.components {
            if !main.components.contains_key(&sku) {
                continue;
            }
            let contribution = source
                .source_quantity
                .checked_mul(multiplier)
                .ok_or_else(|| "数量计算溢出".to_string())?;
            let total = component_quantities.entry(sku).or_default();
            *total = total
                .checked_add(contribution)
                .ok_or_else(|| "数量合并溢出".to_string())?;
        }
    }

    let mut grouped_quantity = None;
    for (sku, component_quantity) in component_quantities {
        let required_quantity = main.components[&sku];
        let candidate = component_quantity.div_ceil(required_quantity);
        if grouped_quantity.is_some_and(|quantity| quantity != candidate) {
            return Err(format!(
                "SKU关系无法计算: 同订单内主要SKU {main_sku} 的组件数量比例冲突"
            ));
        }
        grouped_quantity = Some(candidate);
    }
    grouped_quantity
        .ok_or_else(|| format!("SKU关系无法计算: 同订单内主要SKU {main_sku} 没有可用组件数量"))
}
