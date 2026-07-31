use crate::pricing::{PriceCellEdit, PriceWritebackRow};
use anyhow::{Context, Result, anyhow};
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const WRITEBACK_HEADERS: [&str; 3] = ["核价[财务]", "金额差", "数量"];
const WRITEBACK_COLUMN_COUNT: u32 = WRITEBACK_HEADERS.len() as u32;
const WRITEBACK_BACKGROUND_COLOR: &str = "D8EEE0";
const WRITEBACK_NEGATIVE_BACKGROUND_COLOR: &str = "A9D6B5";
const WRITEBACK_ALERT_BACKGROUND_COLOR: &str = "FFC7CE";
const WRITEBACK_FONT_COLOR: &str = "FF000000";
const WRITEBACK_NEGATIVE_FONT_COLOR: &str = "FF14532D";
const WRITEBACK_ALERT_FONT_COLOR: &str = "FF842029";
const WRITEBACK_MIN_COLUMN_WIDTHS: [f64; 3] = [15.0, 15.0, 12.0];
const WRITEBACK_MAX_COLUMN_WIDTH: f64 = 32.0;
const WRITEBACK_COLUMN_PADDING: f64 = 2.0;
const TOTAL_ROW_LABELS: [&str; 3] = ["total", "合计", "总计"];
const SUPPORTED_WRITEBACK_EXTENSIONS: [&str; 2] = ["xlsx", "xlsm"];
const LEGACY_EXCEL_EXTENSIONS: [&str; 2] = ["xls", "xlsb"];

#[derive(Debug, Clone)]
struct ArrayFormulaMetadata {
    cell_reference: String,
    range_reference: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PriceWritebackLayout {
    pub(crate) header_row: usize,
    pub(crate) order_number_column: Option<usize>,
    pub(crate) total_price_column: usize,
}

pub(crate) fn write_price_result(
    source_path: &Path,
    output_path: &Path,
    order_sheet_name: &str,
    layout: PriceWritebackLayout,
    rows: &[PriceWritebackRow],
    cell_edits: &[PriceCellEdit],
) -> Result<()> {
    validate_source_format(source_path)?;
    if layout.total_price_column == 0 {
        return Err(anyhow!(
            "订单 Sheet 找不到 TOTAL Price/原始价格列，未生成结果文件"
        ));
    }
    if layout.header_row == 0 {
        return Err(anyhow!("订单 Sheet 表头行无效，未生成结果文件"));
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut workbook = umya_spreadsheet::reader::xlsx::read(source_path)
        .with_context(|| format!("读取源工作簿失败: {}", source_path.display()))?;
    workbook
        .sheet_by_name(order_sheet_name)
        .with_context(|| format!("找不到订单 Sheet: {order_sheet_name}"))?;
    apply_cell_edits(&mut workbook, cell_edits)?;
    let total_row = existing_total_row(
        workbook
            .sheet_by_name(order_sheet_name)
            .with_context(|| format!("找不到订单 Sheet: {order_sheet_name}"))?,
        layout.header_row,
        layout.order_number_column,
        rows,
    );

    let insert_column = u32::try_from(layout.total_price_column + 1)
        .map_err(|_| anyhow!("TOTAL Price 列号超出支持范围"))?;
    workbook.insert_new_column_by_index(order_sheet_name, insert_column, WRITEBACK_COLUMN_COUNT);
    for worksheet in workbook.sheet_collection_mut() {
        if worksheet.name() != order_sheet_name {
            worksheet.remove_column_by_index(insert_column, WRITEBACK_COLUMN_COUNT);
        }
    }

    let worksheet = workbook
        .sheet_by_name_mut(order_sheet_name)
        .with_context(|| format!("找不到订单 Sheet: {order_sheet_name}"))?;
    copy_column_layout(
        worksheet,
        u32::try_from(layout.total_price_column)?,
        insert_column,
        WRITEBACK_COLUMN_COUNT,
    );
    for (offset, header) in WRITEBACK_HEADERS.iter().enumerate() {
        let column = insert_column + offset as u32;
        worksheet
            .cell_mut((column, u32::try_from(layout.header_row)?))
            .set_value(*header);
        apply_writeback_value_style(
            worksheet,
            column,
            u32::try_from(layout.header_row)?,
            WRITEBACK_BACKGROUND_COLOR,
            WRITEBACK_FONT_COLOR,
        );
    }
    for row in rows {
        let row_number = u32::try_from(row.source_row)?;
        if let Some(value) = row.pricing_price {
            worksheet
                .cell_mut((insert_column, row_number))
                .set_value_number(value);
            apply_writeback_value_style(
                worksheet,
                insert_column,
                row_number,
                WRITEBACK_BACKGROUND_COLOR,
                WRITEBACK_FONT_COLOR,
            );
        }
        if let Some(value) = row.price_difference {
            worksheet
                .cell_mut((insert_column + 1, row_number))
                .set_value_number(value);
            let (background_color, font_color) = if value > 0.0 {
                (WRITEBACK_ALERT_BACKGROUND_COLOR, WRITEBACK_ALERT_FONT_COLOR)
            } else if value < 0.0 {
                (
                    WRITEBACK_NEGATIVE_BACKGROUND_COLOR,
                    WRITEBACK_NEGATIVE_FONT_COLOR,
                )
            } else {
                (WRITEBACK_BACKGROUND_COLOR, WRITEBACK_FONT_COLOR)
            };
            apply_writeback_value_style(
                worksheet,
                insert_column + 1,
                row_number,
                background_color,
                font_color,
            );
        }
        if let Some(quantity) = row.quantity {
            worksheet
                .cell_mut((insert_column + 2, row_number))
                .set_value_number(quantity as f64);
            apply_writeback_value_style(
                worksheet,
                insert_column + 2,
                row_number,
                if row.quantity_mismatch {
                    WRITEBACK_ALERT_BACKGROUND_COLOR
                } else {
                    WRITEBACK_BACKGROUND_COLOR
                },
                if row.quantity_mismatch {
                    WRITEBACK_ALERT_FONT_COLOR
                } else {
                    WRITEBACK_FONT_COLOR
                },
            );
        }
    }
    if let Some(total_row) = total_row {
        let totals = rows.iter().fold((0.0, 0.0, 0usize), |total, row| {
            (
                total.0 + row.pricing_price.unwrap_or_default(),
                total.1 + row.price_difference.unwrap_or_default(),
                total.2 + row.quantity.unwrap_or_default(),
            )
        });
        for (offset, value) in [totals.0, totals.1, totals.2 as f64]
            .into_iter()
            .enumerate()
        {
            let column = insert_column + offset as u32;
            worksheet
                .cell_mut((column, total_row))
                .set_value_number(value);
            apply_writeback_value_style(
                worksheet,
                column,
                total_row,
                WRITEBACK_BACKGROUND_COLOR,
                WRITEBACK_FONT_COLOR,
            );
        }
    }
    fit_writeback_column_widths(worksheet, insert_column);
    let array_formulas = collect_array_formula_metadata(&workbook);

    let temporary_path = sibling_work_path(output_path, "tmp");
    let backup_path = sibling_work_path(output_path, "bak");
    let write_result = umya_spreadsheet::writer::xlsx::write(&workbook, &temporary_path)
        .with_context(|| format!("写入临时结果文件失败: {}", temporary_path.display()));
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    if let Err(error) = restore_array_formula_metadata(&temporary_path, &array_formulas) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    replace_output_file(&temporary_path, output_path, &backup_path)
}

pub(crate) fn overwrite_source_with_result(output_path: &Path, source_path: &Path) -> Result<()> {
    fs::copy(output_path, source_path).with_context(|| {
        format!(
            "目标文件已生成，但覆盖源文件失败: {}",
            source_path.display()
        )
    })?;
    Ok(())
}

fn existing_total_row(
    worksheet: &umya_spreadsheet::Worksheet,
    header_row: usize,
    order_number_column: Option<usize>,
    rows: &[PriceWritebackRow],
) -> Option<u32> {
    let order_number_column = u32::try_from(order_number_column?).ok()?;
    let last_order_row = rows
        .iter()
        .filter_map(|row| u32::try_from(row.source_row).ok())
        .max()
        .unwrap_or_else(|| u32::try_from(header_row).unwrap_or_default());
    let highest_column = worksheet.highest_column();
    let candidates = (last_order_row.saturating_add(1)..=worksheet.highest_row())
        .filter(|row| {
            worksheet
                .value((order_number_column, *row))
                .trim()
                .is_empty()
                && (1..=highest_column)
                    .any(|column| !worksheet.value((column, *row)).trim().is_empty())
        })
        .collect::<Vec<_>>();
    candidates
        .iter()
        .rev()
        .copied()
        .find(|row| {
            (1..=highest_column).any(|column| {
                let value = worksheet.value((column, *row)).trim().to_lowercase();
                TOTAL_ROW_LABELS.contains(&value.as_str())
            })
        })
        .or_else(|| candidates.last().copied())
}

fn apply_cell_edits(
    workbook: &mut umya_spreadsheet::Workbook,
    edits: &[PriceCellEdit],
) -> Result<()> {
    for edit in edits {
        if edit.row == 0 || edit.column == 0 {
            return Err(anyhow!("单元格行列必须从 1 开始"));
        }
        let worksheet = workbook
            .sheet_by_name_mut(&edit.sheet_name)
            .with_context(|| format!("找不到编辑目标 Sheet: {}", edit.sheet_name))?;
        let cell = worksheet.cell_mut((u32::try_from(edit.column)?, u32::try_from(edit.row)?));
        if edit.numeric && !edit.value.trim().is_empty() {
            let value = edit
                .value
                .replace(',', "")
                .parse::<f64>()
                .map_err(|_| anyhow!("数字单元格编辑值无效: {}", edit.value))?;
            cell.set_value_number(value);
        } else {
            cell.set_value(edit.value.trim());
        }
    }
    Ok(())
}

pub(crate) fn validate_source_format(source_path: &Path) -> Result<()> {
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if SUPPORTED_WRITEBACK_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(());
    }
    if LEGACY_EXCEL_EXTENSIONS.contains(&extension.as_str()) {
        return Err(anyhow!(
            "原表回写不支持 .{extension}，请先将源文件另存为 .xlsx 后重试"
        ));
    }
    Err(anyhow!(
        "原表回写仅支持 .xlsx/.xlsm，请先将源文件另存为 .xlsx 后重试"
    ))
}

fn apply_writeback_value_style(
    worksheet: &mut umya_spreadsheet::Worksheet,
    column: u32,
    row: u32,
    background_color: &str,
    font_color: &str,
) {
    let style = worksheet.style_mut((column, row));
    style.set_background_color(background_color);
    style.font_mut().color_mut().set_argb_str(font_color);
}

fn fit_writeback_column_widths(worksheet: &mut umya_spreadsheet::Worksheet, first_column: u32) {
    let highest_row = worksheet.highest_row();
    for (offset, minimum_width) in WRITEBACK_MIN_COLUMN_WIDTHS.iter().enumerate() {
        let column = first_column + offset as u32;
        let content_width = (1..=highest_row)
            .map(|row| excel_text_width(&worksheet.value((column, row))))
            .max()
            .unwrap_or_default() as f64;
        let width = (content_width + WRITEBACK_COLUMN_PADDING)
            .max(*minimum_width)
            .min(WRITEBACK_MAX_COLUMN_WIDTH);
        worksheet
            .column_dimension_by_number_mut(column)
            .set_width(width)
            .set_best_fit(false)
            .set_auto_width(false);
    }
}

fn excel_text_width(value: &str) -> usize {
    value
        .lines()
        .map(|line| {
            line.chars()
                .map(|character| if character.is_ascii() { 1 } else { 2 })
                .sum()
        })
        .max()
        .unwrap_or_default()
}

fn collect_array_formula_metadata(
    workbook: &umya_spreadsheet::Workbook,
) -> HashMap<String, Vec<ArrayFormulaMetadata>> {
    workbook
        .sheet_collection()
        .iter()
        .enumerate()
        .filter_map(|(sheet_index, worksheet)| {
            let formulas = worksheet
                .cells()
                .into_iter()
                .filter_map(|cell| {
                    let formula = cell.formula_obj()?;
                    (formula.formula_type() == &umya_spreadsheet::CellFormulaValues::Array).then(
                        || {
                            let cell_reference = cell.coordinate().to_string();
                            ArrayFormulaMetadata {
                                range_reference: adjusted_array_formula_reference(
                                    &cell_reference,
                                    formula.reference(),
                                ),
                                cell_reference,
                            }
                        },
                    )
                })
                .collect::<Vec<_>>();
            (!formulas.is_empty()).then_some((
                format!("xl/worksheets/sheet{}.xml", sheet_index + 1),
                formulas,
            ))
        })
        .collect()
}

fn adjusted_array_formula_reference(cell_reference: &str, original_reference: &str) -> String {
    let Some((original_start, original_end)) = original_reference.split_once(':') else {
        return cell_reference.to_string();
    };
    let (Some(original_column), Some(original_row), _, _) =
        umya_spreadsheet::helper::coordinate::index_from_coordinate(original_start)
    else {
        return original_reference.to_string();
    };
    let (Some(end_column), Some(end_row), _, _) =
        umya_spreadsheet::helper::coordinate::index_from_coordinate(original_end)
    else {
        return original_reference.to_string();
    };
    let (Some(current_column), Some(current_row), _, _) =
        umya_spreadsheet::helper::coordinate::index_from_coordinate(cell_reference)
    else {
        return original_reference.to_string();
    };
    let Some(column_span) = end_column.checked_sub(original_column) else {
        return original_reference.to_string();
    };
    let Some(row_span) = end_row.checked_sub(original_row) else {
        return original_reference.to_string();
    };
    let Some(shifted_end_column) = current_column.checked_add(column_span) else {
        return original_reference.to_string();
    };
    let Some(shifted_end_row) = current_row.checked_add(row_span) else {
        return original_reference.to_string();
    };
    format!(
        "{}:{}",
        cell_reference,
        umya_spreadsheet::helper::coordinate::coordinate_from_index(
            shifted_end_column,
            shifted_end_row
        )
    )
}

fn restore_array_formula_metadata(
    workbook_path: &Path,
    formulas_by_entry: &HashMap<String, Vec<ArrayFormulaMetadata>>,
) -> Result<()> {
    if formulas_by_entry.is_empty() {
        return Ok(());
    }

    let workbook_bytes = fs::read(workbook_path)?;
    let mut input = zip::ZipArchive::new(Cursor::new(workbook_bytes))?;
    let rewritten_path = sibling_work_path(workbook_path, "array-formulas");
    let rewritten_file = fs::File::create(&rewritten_path)?;
    let mut writer = zip::ZipWriter::new(rewritten_file);

    let rewrite_result = (|| -> Result<()> {
        for index in 0..input.len() {
            let mut entry = input.by_index(index)?;
            let entry_name = entry.name().to_string();
            let Some(formulas) = formulas_by_entry.get(&entry_name) else {
                writer.raw_copy_file(entry)?;
                continue;
            };

            let compression = entry.compression();
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            for formula in formulas {
                let pattern = Regex::new(&format!(
                    r#"(?s)(<c\b[^>]*\br="{}"[^>]*>.*?<f)(?:\s[^>]*)?>"#,
                    regex::escape(&formula.cell_reference)
                ))?;
                if pattern.find_iter(&xml).count() != 1 {
                    return Err(anyhow!(
                        "恢复数组公式失败: {entry_name}!{}",
                        formula.cell_reference
                    ));
                }
                xml = pattern
                    .replacen(
                        &xml,
                        1,
                        format!("${{1}} t=\"array\" ref=\"{}\">", formula.range_reference),
                    )
                    .into_owned();
            }

            writer.start_file(
                entry_name,
                zip::write::SimpleFileOptions::default().compression_method(compression),
            )?;
            writer.write_all(xml.as_bytes())?;
        }
        writer.finish()?;
        Ok(())
    })();

    if let Err(error) = rewrite_result {
        let _ = fs::remove_file(&rewritten_path);
        return Err(error).context("保留原工作簿数组公式失败");
    }
    let backup_path = sibling_work_path(workbook_path, "array-backup");
    replace_output_file(&rewritten_path, workbook_path, &backup_path)
}

fn copy_column_layout(
    worksheet: &mut umya_spreadsheet::Worksheet,
    source_column: u32,
    first_target_column: u32,
    target_count: u32,
) {
    let source_dimension = worksheet
        .column_dimension_by_number(source_column)
        .map(|column| {
            (
                column.width(),
                column.hidden(),
                column.best_fit(),
                column.auto_width(),
                column.style().clone(),
            )
        });
    if let Some((width, hidden, best_fit, auto_width, mut style)) = source_dimension {
        style.remove_fill();
        for column_number in first_target_column..first_target_column + target_count {
            worksheet
                .column_dimension_by_number_mut(column_number)
                .set_width(width)
                .set_hidden(hidden)
                .set_best_fit(best_fit)
                .set_auto_width(auto_width)
                .set_style(style.clone());
        }
    }

    let highest_row = worksheet.highest_row();
    for row_number in 1..=highest_row {
        for column_number in first_target_column..first_target_column + target_count {
            worksheet.copy_cell_styling((source_column, row_number), (column_number, row_number));
            worksheet
                .style_mut((column_number, row_number))
                .remove_fill();
        }
    }
}

fn sibling_work_path(output_path: &Path, marker: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("核价结果");
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx");
    output_path.with_file_name(format!(
        ".{stem}.{marker}-{}-{nonce}.{extension}",
        std::process::id()
    ))
}

fn replace_output_file(
    temporary_path: &Path,
    output_path: &Path,
    backup_path: &Path,
) -> Result<()> {
    let had_existing_output = output_path.exists();
    if had_existing_output {
        fs::rename(output_path, backup_path)
            .with_context(|| format!("暂存已有结果文件失败: {}", output_path.display()))?;
    }
    if let Err(error) = fs::rename(temporary_path, output_path) {
        if had_existing_output {
            let _ = fs::rename(backup_path, output_path);
        }
        let _ = fs::remove_file(temporary_path);
        return Err(error).with_context(|| format!("替换结果文件失败: {}", output_path.display()));
    }
    if had_existing_output {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

#[cfg(test)]
include!("../../../test/backend/processor/pricing_writer.test.rs");
