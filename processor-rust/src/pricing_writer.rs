use crate::pricing::{PriceCellEdit, PriceWritebackRow};
use anyhow::{Context, Result, anyhow};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const WRITEBACK_HEADERS: [&str; 3] = ["核价[财务]", "金额差", "数量"];
const WRITEBACK_COLUMN_COUNT: u32 = WRITEBACK_HEADERS.len() as u32;
const WRITEBACK_BACKGROUND_COLOR: &str = "D8EEE0";
const WRITEBACK_ALERT_BACKGROUND_COLOR: &str = "FFC7CE";
const WRITEBACK_FONT_COLOR: &str = "FF000000";
const WRITEBACK_TOTAL_LABEL: &str = "合计";
const SUPPORTED_WRITEBACK_EXTENSIONS: [&str; 2] = ["xlsx", "xlsm"];
const LEGACY_EXCEL_EXTENSIONS: [&str; 2] = ["xls", "xlsb"];

pub(crate) fn write_price_result(
    source_path: &Path,
    output_path: &Path,
    order_sheet_name: &str,
    header_row: usize,
    total_price_column: usize,
    rows: &[PriceWritebackRow],
    cell_edits: &[PriceCellEdit],
) -> Result<()> {
    validate_source_format(source_path)?;
    if total_price_column == 0 {
        return Err(anyhow!(
            "订单 Sheet 找不到 TOTAL Price/原始价格列，未生成结果文件"
        ));
    }
    if header_row == 0 {
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

    let insert_column = u32::try_from(total_price_column + 1)
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
        u32::try_from(total_price_column)?,
        insert_column,
        WRITEBACK_COLUMN_COUNT,
    );
    for (offset, header) in WRITEBACK_HEADERS.iter().enumerate() {
        let column = insert_column + offset as u32;
        worksheet
            .cell_mut((column, u32::try_from(header_row)?))
            .set_value(*header);
        apply_writeback_value_style(
            worksheet,
            column,
            u32::try_from(header_row)?,
            WRITEBACK_BACKGROUND_COLOR,
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
            );
        }
        if let Some(value) = row.price_difference {
            worksheet
                .cell_mut((insert_column + 1, row_number))
                .set_value_number(value);
            apply_writeback_value_style(
                worksheet,
                insert_column + 1,
                row_number,
                if value > 0.0 {
                    WRITEBACK_ALERT_BACKGROUND_COLOR
                } else {
                    WRITEBACK_BACKGROUND_COLOR
                },
            );
        }
        worksheet
            .cell_mut((insert_column + 2, row_number))
            .set_value_number(row.quantity as f64);
        apply_writeback_value_style(
            worksheet,
            insert_column + 2,
            row_number,
            if row.quantity_mismatch {
                WRITEBACK_ALERT_BACKGROUND_COLOR
            } else {
                WRITEBACK_BACKGROUND_COLOR
            },
        );
    }
    let total_row = worksheet.highest_row().saturating_add(1);
    worksheet
        .cell_mut((u32::try_from(total_price_column)?, total_row))
        .set_value(WRITEBACK_TOTAL_LABEL);
    let totals = rows.iter().fold((0.0, 0.0, 0usize), |total, row| {
        (
            total.0 + row.pricing_price.unwrap_or_default(),
            total.1 + row.price_difference.unwrap_or_default(),
            total.2 + row.quantity,
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
        apply_writeback_value_style(worksheet, column, total_row, WRITEBACK_BACKGROUND_COLOR);
    }

    let temporary_path = sibling_work_path(output_path, "tmp");
    let backup_path = sibling_work_path(output_path, "bak");
    let write_result = umya_spreadsheet::writer::xlsx::write(&workbook, &temporary_path)
        .with_context(|| format!("写入临时结果文件失败: {}", temporary_path.display()));
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    replace_output_file(&temporary_path, output_path, &backup_path)
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
) {
    let style = worksheet.style_mut((column, row));
    style.set_background_color(background_color);
    style
        .font_mut()
        .color_mut()
        .set_argb_str(WRITEBACK_FONT_COLOR);
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
mod tests {
    use super::*;
    use rust_xlsxwriter::{Format, Workbook};
    use std::io::Read;

    fn unique_path(name: &str, extension: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "auto-pricing-{name}-{}-{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            extension
        ))
    }

    fn create_source_workbook(path: &Path) -> Result<()> {
        let mut workbook = Workbook::new();
        {
            let order = workbook.add_worksheet();
            order.set_name("订单")?;
            let price_format = Format::new()
                .set_num_format("0.00")
                .set_background_color("#FFF2CC")
                .set_border(rust_xlsxwriter::FormatBorder::Thin);
            order.set_column_width(2, 16)?;
            order.write_string(0, 0, "订单号")?;
            order.write_string(0, 1, "SKU")?;
            order.write_string_with_format(0, 2, "TOTAL Price", &price_format)?;
            order.write_string(0, 3, "Name")?;
            order.write_string(0, 4, "Address")?;
            for (row, (order_number, price)) in
                [("ORDER-1", 10.0), ("ORDER-1", 12.0), ("ORDER-1", 8.0)]
                    .into_iter()
                    .enumerate()
            {
                let row = row as u32 + 1;
                order.write_string(row, 0, order_number)?;
                order.write_string(row, 1, format!("SKU-{row}"))?;
                order.write_number_with_format(row, 2, price, &price_format)?;
                order.write_string(row, 3, format!("Name-{row}"))?;
                order.write_string(row, 4, format!("Address-{row}"))?;
            }
            order.write_formula(4, 3, "=C2+C3")?;
            order.merge_range(5, 3, 5, 4, "merged", &Format::new())?;
        }
        {
            let pricing = workbook.add_worksheet();
            pricing.set_name("核价")?;
            pricing.write_string(0, 0, "保留内容")?;
            pricing.write_string(0, 3, "核价-D")?;
            pricing.write_string(0, 4, "核价-E")?;
            pricing.write_formula(1, 0, "=订单!C2")?;
            pricing.write_formula(2, 0, "=订单!D2")?;
        }
        workbook.save(path)?;
        Ok(())
    }

    #[test]
    fn writes_back_into_a_copy_and_preserves_workbook_structure() -> Result<()> {
        let source_path = unique_path("writeback-source", "xlsx");
        let output_path = unique_path("writeback-output", "xlsx");
        create_source_workbook(&source_path)?;
        let source_before = fs::read(&source_path)?;
        let source_modified_before = fs::metadata(&source_path)?.modified()?;
        fs::write(&output_path, b"existing-result")?;
        write_price_result(
            &source_path,
            &output_path,
            "订单",
            1,
            3,
            &[
                PriceWritebackRow {
                    source_row: 2,
                    pricing_price: Some(11.0),
                    price_difference: Some(1.0),
                    quantity: 3,
                    quantity_mismatch: true,
                    matched: true,
                    ..PriceWritebackRow::default()
                },
                PriceWritebackRow {
                    source_row: 3,
                    pricing_price: Some(9.0),
                    price_difference: Some(-3.0),
                    quantity: 0,
                    matched: true,
                    ..PriceWritebackRow::default()
                },
                PriceWritebackRow {
                    source_row: 4,
                    quantity: 0,
                    ..PriceWritebackRow::default()
                },
            ],
            &[
                PriceCellEdit {
                    sheet_name: "订单".to_string(),
                    row: 1,
                    column: 2,
                    value: "商品编码".to_string(),
                    numeric: false,
                },
                PriceCellEdit {
                    sheet_name: "订单".to_string(),
                    row: 2,
                    column: 2,
                    value: "EDITED-SKU".to_string(),
                    numeric: false,
                },
                PriceCellEdit {
                    sheet_name: "订单".to_string(),
                    row: 2,
                    column: 3,
                    value: "15.5".to_string(),
                    numeric: true,
                },
                PriceCellEdit {
                    sheet_name: "核价".to_string(),
                    row: 1,
                    column: 1,
                    value: "已编辑核价表头".to_string(),
                    numeric: false,
                },
            ],
        )?;

        assert_eq!(fs::read(&source_path)?, source_before);
        assert_eq!(
            fs::metadata(&source_path)?.modified()?,
            source_modified_before
        );
        let output = umya_spreadsheet::reader::xlsx::read(&output_path)?;
        assert_eq!(output.sheet_count(), 2);
        let order = output.sheet_by_name("订单")?;
        assert_eq!(order.value("D1"), "核价[财务]");
        assert_eq!(order.value("E1"), "金额差");
        assert_eq!(order.value("F1"), "数量");
        assert_eq!(order.value("G1"), "Name");
        assert_eq!(order.value("H1"), "Address");
        assert_eq!(order.value("B1"), "商品编码");
        assert_eq!(order.value("D2"), "11");
        assert_eq!(order.value("E2"), "1");
        assert_eq!(order.value("F2"), "3");
        assert_eq!(order.value("E3"), "-3");
        assert_eq!(order.value("F3"), "0");
        assert_eq!(order.value("D4"), "");
        assert_eq!(order.value("E4"), "");
        assert_eq!(order.value("F4"), "0");
        assert_eq!(order.value("B2"), "EDITED-SKU");
        assert_eq!(order.value("C2"), "15.5");
        assert_eq!(order.value("C7"), "合计");
        assert_eq!(order.value("D7"), "20");
        assert_eq!(order.value("E7"), "-2");
        assert_eq!(order.value("F7"), "3");
        assert_eq!(order.value("G2"), "Name-1");
        assert_eq!(output.sheet_by_name("核价")?.value("A1"), "已编辑核价表头");
        assert_eq!(order.cell("G5").expect("formula cell").formula(), "C2+C3");
        assert!(
            order
                .merge_cells()
                .iter()
                .any(|range| range.range() == "G6:H6")
        );
        for cell in ["D1", "E1", "F1", "D2", "E3", "F3", "F4"] {
            assert_eq!(
                order
                    .style(cell)
                    .background_color()
                    .expect("writeback background")
                    .argb_str(),
                "FFD8EEE0"
            );
        }
        for cell in ["D4", "E4"] {
            assert!(
                order.style(cell).background_color().is_none(),
                "{cell} should not have a background"
            );
        }
        for cell in ["E2", "F2"] {
            assert_eq!(
                order
                    .style(cell)
                    .background_color()
                    .expect("alert background")
                    .argb_str(),
                "FFFFC7CE"
            );
        }
        for cell in ["D1", "E2", "E3", "F2", "F3"] {
            assert_eq!(
                order
                    .style(cell)
                    .font()
                    .expect("writeback font")
                    .color()
                    .argb_str(),
                "FF000000"
            );
        }
        assert_eq!(
            order
                .style("C2")
                .numbering_format()
                .map(|format| format.format_code()),
            order
                .style("D2")
                .numbering_format()
                .map(|format| format.format_code())
        );
        assert_eq!(order.style("C2").borders(), order.style("D2").borders());
        let pricing = output.sheet_by_name("核价")?;
        assert_eq!(pricing.value("A1"), "已编辑核价表头");
        assert_eq!(pricing.value("D1"), "核价-D");
        assert_eq!(pricing.value("E1"), "核价-E");
        assert_eq!(pricing.highest_column(), 5);
        assert_eq!(
            pricing.cell("A3").expect("cross-sheet formula").formula(),
            "'订单'!G2"
        );

        fs::remove_file(source_path)?;
        fs::remove_file(output_path)?;
        Ok(())
    }

    #[test]
    fn rejects_legacy_formats_without_creating_output() {
        for extension in LEGACY_EXCEL_EXTENSIONS {
            let source_path = unique_path("legacy-source", extension);
            let output_path = unique_path("legacy-output", "xlsx");
            let error = write_price_result(&source_path, &output_path, "订单", 1, 3, &[], &[])
                .expect_err("legacy format must be rejected");
            assert!(error.to_string().contains("另存为 .xlsx"));
            assert!(!output_path.exists());
        }
    }

    #[test]
    fn missing_total_price_column_does_not_create_output() -> Result<()> {
        let source_path = unique_path("missing-price-source", "xlsx");
        let output_path = unique_path("missing-price-output", "xlsx");
        create_source_workbook(&source_path)?;

        let error = write_price_result(&source_path, &output_path, "订单", 1, 0, &[], &[])
            .expect_err("missing price column must fail");

        assert!(error.to_string().contains("TOTAL Price"));
        assert!(!output_path.exists());
        fs::remove_file(source_path)?;
        Ok(())
    }

    #[test]
    fn preserves_vba_project_when_writing_xlsm() -> Result<()> {
        let source_path = unique_path("macro-source", "xlsm");
        let output_path = unique_path("macro-output", "xlsm");
        create_source_workbook(&source_path)?;
        add_fake_vba_project(&source_path)?;

        write_price_result(&source_path, &output_path, "订单", 1, 3, &[], &[])?;

        let file = fs::File::open(&output_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        let mut macro_bytes = Vec::new();
        archive
            .by_name("xl/vbaProject.bin")?
            .read_to_end(&mut macro_bytes)?;
        assert_eq!(macro_bytes, b"fake-vba-project");

        fs::remove_file(source_path)?;
        fs::remove_file(output_path)?;
        Ok(())
    }

    fn add_fake_vba_project(path: &Path) -> Result<()> {
        let source = fs::read(path)?;
        let cursor = std::io::Cursor::new(source);
        let mut input = zip::ZipArchive::new(cursor)?;
        let rewritten = unique_path("macro-rewritten", "xlsm");
        let file = fs::File::create(&rewritten)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for index in 0..input.len() {
            let mut entry = input.by_index(index)?;
            writer.start_file(entry.name(), options)?;
            std::io::copy(&mut entry, &mut writer)?;
        }
        writer.start_file("xl/vbaProject.bin", options)?;
        use std::io::Write;
        writer.write_all(b"fake-vba-project")?;
        writer.finish()?;
        fs::rename(rewritten, path)?;
        Ok(())
    }
}
