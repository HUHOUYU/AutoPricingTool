use super::*;

pub(super) fn process_price_file(
    input_path: &Path,
    output_options: PriceOutputOptions<'_>,
    mapping: &PriceCheckMapping,
    writeback_overrides: &[PricePreviewWritebackRow],
    cell_edits: &[PriceCellEdit],
    config: &Config,
    state: &RuntimeState,
) -> Result<PriceCheckReport> {
    crate::pricing_writer::validate_source_format(input_path)?;
    let order_price_column = mapping
        .order_price_column
        .ok_or_else(|| anyhow!("订单 Sheet 找不到 TOTAL Price/原始价格列，未生成结果文件"))?;
    let mut workbook = read_workbook_for_processing(input_path, config)?;
    apply_cell_edits(&mut workbook, cell_edits)?;
    let order_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.order_sheet)
        .ok_or_else(|| anyhow!("找不到订单 Sheet: {}", mapping.order_sheet))?;
    let pricing_sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.name == mapping.pricing_sheet)
        .ok_or_else(|| anyhow!("找不到核价 Sheet: {}", mapping.pricing_sheet))?;
    let (lines, mut exceptions, resolved_quantities) =
        read_order_lines_with_overrides(order_sheet, mapping, config, writeback_overrides);
    for exception in &mut exceptions {
        exception.file_path = input_path.display().to_string();
    }
    let aggregated = aggregate_lines(&lines);
    let index = build_price_index(pricing_sheet, mapping, &config.pricing);
    let tax_column_index = order_tax_column_index(order_sheet, mapping);
    let mut rows = Vec::new();
    let mut matched_rows = 0;
    let mut matched_candidates = HashMap::new();
    for (position, item) in aggregated.iter().enumerate() {
        state.wait_if_paused();
        if state.should_stop() {
            break;
        }
        let lookup = index.lookup_routes_with_single_shipment_preference(
            &item.country_routes,
            &item.matched_sku,
            item.total_quantity.round() as i64,
            item.single_shipment,
        );
        if lookup.status == "matched" {
            matched_rows += 1;
            if let Some(pricing_price) = lookup.price {
                record_matched_candidates(&mut matched_candidates, item, pricing_price);
            }
        } else {
            exceptions.push(PriceCheckException {
                file_path: input_path.display().to_string(),
                sheet_name: item.source_sheet.clone(),
                source_row: item.source_rows.first().copied(),
                kind: lookup.status.to_string(),
                message: lookup.reason.clone(),
            });
        }
        let tax_amount = item
            .source_rows
            .iter()
            .filter_map(|source_row| order_sheet.rows.get(source_row.saturating_sub(1)))
            .map(|row| order_tax_amount(row, tax_column_index))
            .sum::<f64>();
        let financial_price = lookup.price.map(|price| price + tax_amount);
        let difference = match (item.original_price, financial_price) {
            (Some(original), Some(pricing)) => Some(normalize_price_difference(pricing - original)),
            _ => None,
        };
        rows.push(PriceCheckRow {
            business_order_number: item.business_order_number.clone(),
            country_code: item.country_code.clone(),
            country_english_name: item.country_english_name.clone(),
            country_chinese_name: item.country_chinese_name.clone(),
            original_sku: item.original_sku.clone(),
            matched_sku: lookup.matched_sku.clone(),
            total_quantity: item.total_quantity,
            original_price: item.original_price,
            pricing_price: financial_price,
            price_difference: difference,
            status: if lookup.status == "matched" {
                "已核价".to_string()
            } else {
                "异常".to_string()
            },
            exception_reason: lookup.reason,
            order_source_sheet: item.source_sheet.clone(),
            pricing_source_sheet: lookup.source_sheet,
            source_rows: item
                .source_rows
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(","),
        });
        if position % 100 == 0 {
            emit(json!({
                "type": "price-progress",
                "phase": "rows",
                "current": position + 1,
                "total": aggregated.len(),
                "path": input_path,
            }));
        }
    }
    let total_rows = rows.len();
    let output_path = output_path_for(input_path, output_options.directory);
    let mut writeback_rows = build_writeback_rows(
        order_sheet,
        mapping,
        &matched_candidates,
        &resolved_quantities,
    );
    apply_writeback_overrides(&mut writeback_rows, writeback_overrides);
    let mut report = PriceCheckReport {
        input_path: input_path.display().to_string(),
        output_path: output_path.display().to_string(),
        mapping: mapping.clone(),
        rows,
        exceptions,
        total_rows,
        matched_rows,
        exception_rows: total_rows.saturating_sub(matched_rows),
        coverage: ratio(matched_rows, total_rows),
    };
    crate::pricing_writer::write_price_result(
        input_path,
        &output_path,
        &mapping.order_sheet,
        crate::pricing_writer::PriceWritebackLayout {
            header_row: mapping.order_header_row,
            order_number_column: mapping.business_order_number_column,
            total_price_column: order_price_column,
        },
        &writeback_rows,
        cell_edits,
    )?;
    if output_options.overwrite_source_files {
        crate::pricing_writer::overwrite_source_with_result(&output_path, input_path)?;
    }
    report.output_path = output_path.display().to_string();
    Ok(report)
}

#[derive(Debug, Clone, Copy)]
pub(super) struct PriceOutputOptions<'a> {
    pub(super) directory: &'a Path,
    pub(super) overwrite_source_files: bool,
}

pub(super) fn apply_cell_edits(workbook: &mut WorkbookData, edits: &[PriceCellEdit]) -> Result<()> {
    for edit in edits {
        if edit.row == 0 || edit.column == 0 {
            return Err(anyhow!("单元格行列必须从 1 开始"));
        }
        let sheet = workbook
            .sheets
            .iter_mut()
            .find(|sheet| sheet.name == edit.sheet_name)
            .ok_or_else(|| anyhow!("找不到编辑目标 Sheet: {}", edit.sheet_name))?;
        let row = sheet
            .rows
            .get_mut(edit.row - 1)
            .ok_or_else(|| anyhow!("编辑目标行超出范围: {}!{}", edit.sheet_name, edit.row))?;
        if row.len() < edit.column {
            row.resize(edit.column, CellValue::Empty);
        }
        row[edit.column - 1] = if edit.numeric {
            if edit.value.trim().is_empty() {
                CellValue::Empty
            } else {
                CellValue::Float(
                    edit.value
                        .replace(',', "")
                        .parse()
                        .map_err(|_| anyhow!("数字单元格编辑值无效: {}", edit.value))?,
                )
            }
        } else {
            CellValue::string(edit.value.trim())
        };
    }
    Ok(())
}

pub(super) fn apply_writeback_overrides(
    rows: &mut [PriceWritebackRow],
    overrides: &[PricePreviewWritebackRow],
) {
    let overrides = overrides
        .iter()
        .map(|row| (row.source_row, row))
        .collect::<HashMap<_, _>>();
    for row in rows {
        let Some(edited) = overrides.get(&row.source_row) else {
            continue;
        };
        row.pricing_price = edited.pricing_price;
        row.price_difference = edited.price_difference;
        row.quantity = edited.quantity;
        row.quantity_error = edited.quantity_error.clone();
        if row.quantity.is_some() {
            row.quantity_error = None;
        }
    }
}

pub(super) fn output_path_for(input_path: &Path, output_dir: &Path) -> PathBuf {
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名");
    let extension = match input_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("xlsm") => "xlsm",
        _ => "xlsx",
    };
    let file_name = format!("{}_核价结果.{extension}", safe_file_name(stem));
    output_dir.join(file_name)
}

fn safe_file_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches(['.', ' '])
        .to_string();
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned
    }
}
