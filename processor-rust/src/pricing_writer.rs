use crate::pricing::{PriceCheckReport, PriceCheckRow};
use anyhow::Result;
use rust_xlsxwriter::{Format, Workbook, Worksheet};
use std::fs;
use std::path::Path;

pub(crate) fn write_price_result(path: &Path, report: &PriceCheckReport) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut workbook = Workbook::new();
    write_result_sheet(&mut workbook, report)?;
    write_exception_sheet(&mut workbook, report)?;
    write_mapping_sheet(&mut workbook, report)?;
    workbook.save(path)?;
    Ok(())
}

fn write_result_sheet(workbook: &mut Workbook, report: &PriceCheckReport) -> Result<()> {
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("核价结果")?;
    let headers = [
        "订单号",
        "国家二字码",
        "英文国家名",
        "中文国家名",
        "物流方式",
        "原始SKU",
        "匹配SKU",
        "合计数量",
        "原始价格",
        "核价价格",
        "价格差异",
        "核价状态",
        "异常说明",
        "订单来源Sheet",
        "核价来源Sheet",
        "原始行号",
    ];
    write_headers(worksheet, &headers)?;
    let sku_header_format = Format::new()
        .set_bold()
        .set_background_color("#E89B82")
        .set_font_color("#FFFFFF");
    worksheet.write_string_with_format(0, 5, headers[5], &sku_header_format)?;
    worksheet.write_string_with_format(0, 6, headers[6], &sku_header_format)?;
    for (row_index, row) in report.rows.iter().enumerate() {
        write_result_row(worksheet, row_index as u32 + 1, row)?;
    }
    worksheet.set_freeze_panes(1, 0)?;
    worksheet.autofilter(0, 0, report.rows.len() as u32, (headers.len() - 1) as u16)?;
    Ok(())
}

fn write_result_row(worksheet: &mut Worksheet, row: u32, value: &PriceCheckRow) -> Result<()> {
    let sku_format = Format::new().set_background_color("#FBE5DD");
    let strings = [
        &value.business_order_number,
        &value.country_code,
        &value.country_english_name,
        &value.country_chinese_name,
        &value.shipping_method,
        &value.original_sku,
        &value.matched_sku,
    ];
    for (column, text) in strings.iter().enumerate() {
        if column == 5 || column == 6 {
            worksheet.write_string_with_format(row, column as u16, text.as_str(), &sku_format)?;
        } else {
            worksheet.write_string(row, column as u16, text.as_str())?;
        }
    }
    worksheet.write_number(row, 7, value.total_quantity)?;
    write_optional_number(worksheet, row, 8, value.original_price)?;
    write_optional_number(worksheet, row, 9, value.pricing_price)?;
    write_optional_number(worksheet, row, 10, value.price_difference)?;
    worksheet.write_string(row, 11, &value.status)?;
    worksheet.write_string(row, 12, &value.exception_reason)?;
    worksheet.write_string(row, 13, &value.order_source_sheet)?;
    worksheet.write_string(row, 14, &value.pricing_source_sheet)?;
    worksheet.write_string(row, 15, &value.source_rows)?;
    Ok(())
}

fn write_exception_sheet(workbook: &mut Workbook, report: &PriceCheckReport) -> Result<()> {
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("核价异常")?;
    let headers = ["文件", "Sheet", "原始行号", "异常类型", "异常说明"];
    write_headers(worksheet, &headers)?;
    for (row_index, error) in report.exceptions.iter().enumerate() {
        let row = row_index as u32 + 1;
        worksheet.write_string(row, 0, &error.file_path)?;
        worksheet.write_string(row, 1, &error.sheet_name)?;
        if let Some(source_row) = error.source_row {
            worksheet.write_number(row, 2, source_row as f64)?;
        }
        worksheet.write_string(row, 3, &error.kind)?;
        worksheet.write_string(row, 4, &error.message)?;
    }
    worksheet.set_freeze_panes(1, 0)?;
    worksheet.autofilter(
        0,
        0,
        report.exceptions.len() as u32,
        (headers.len() - 1) as u16,
    )?;
    Ok(())
}

fn write_mapping_sheet(workbook: &mut Workbook, report: &PriceCheckReport) -> Result<()> {
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("字段映射")?;
    let headers = ["映射项目", "实际值"];
    write_headers(worksheet, &headers)?;
    let mapping = &report.mapping;
    let rows = [
        ("订单 Sheet", mapping.order_sheet.clone()),
        ("订单表头行", mapping.order_header_row.to_string()),
        (
            "订单号列",
            optional_column(mapping.business_order_number_column),
        ),
        ("国家二字码列", optional_column(mapping.country_code_column)),
        (
            "英文国家列",
            optional_column(mapping.country_english_column),
        ),
        (
            "中文国家列",
            optional_column(mapping.country_chinese_column),
        ),
        (
            "物流方式列",
            optional_column(mapping.shipping_method_column),
        ),
        ("订单价格列", optional_column(mapping.order_price_column)),
        ("核价 Sheet", mapping.pricing_sheet.clone()),
        ("核价表头行", mapping.pricing_header_row.to_string()),
        (
            "数量表头行",
            mapping
                .pricing_quantity_header_row
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        ("核价 SKU 列", mapping.pricing_sku_column.to_string()),
        ("核价国家列", mapping.pricing_country_column.to_string()),
        (
            "核价物流列",
            optional_column(mapping.pricing_shipping_method_column),
        ),
        (
            "数量档位列",
            mapping
                .quantity_tier_columns
                .iter()
                .map(|tier| format!("{}=>{}", tier.quantity, tier.column))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        (
            "SKU/数量配对",
            mapping
                .sku_qty_pairs
                .iter()
                .map(|pair| format!("{}=>{}", pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        ("试算覆盖率", format!("{:.1}%", report.coverage * 100.0)),
    ];
    for (row_index, (key, value)) in rows.iter().enumerate() {
        let row = row_index as u32 + 1;
        if key.contains("SKU") {
            let sku_format = Format::new().set_background_color("#FBE5DD");
            worksheet.write_string_with_format(row, 0, *key, &sku_format)?;
            worksheet.write_string_with_format(row, 1, value, &sku_format)?;
        } else {
            worksheet.write_string(row, 0, *key)?;
            worksheet.write_string(row, 1, value)?;
        }
    }
    worksheet.set_freeze_panes(1, 0)?;
    worksheet.autofilter(0, 0, rows.len() as u32, 1)?;
    Ok(())
}

fn write_headers(worksheet: &mut Worksheet, headers: &[&str]) -> Result<()> {
    let format = Format::new().set_bold().set_background_color("#D9EAF7");
    for (column, header) in headers.iter().enumerate() {
        worksheet.write_string_with_format(0, column as u16, *header, &format)?;
        worksheet.set_column_width(column as u16, if column == 13 { 30.0 } else { 18.0 })?;
    }
    Ok(())
}

fn write_optional_number(
    worksheet: &mut Worksheet,
    row: u32,
    column: u16,
    value: Option<f64>,
) -> Result<()> {
    if let Some(value) = value {
        worksheet.write_number(row, column, value)?;
    }
    Ok(())
}

fn optional_column(value: Option<usize>) -> String {
    value.map(|column| column.to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::{PriceCheckMapping, PriceTierColumn, SkuQtyPair};
    use regex::Regex;
    use std::io::Read;

    #[test]
    fn result_workbook_marks_sku_columns_and_mapping_rows() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "auto-pricing-sku-style-{}-{}.xlsx",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let report = PriceCheckReport {
            rows: vec![PriceCheckRow {
                original_sku: "RAW-1".to_string(),
                matched_sku: "MATCH-1".to_string(),
                ..PriceCheckRow::default()
            }],
            mapping: PriceCheckMapping {
                pricing_sku_column: 1,
                pricing_country_column: 2,
                sku_qty_pairs: vec![SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                }],
                quantity_tier_columns: vec![PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                }],
                ..PriceCheckMapping::default()
            },
            ..PriceCheckReport::default()
        };
        write_price_result(&path, &report)?;

        {
            let file = fs::File::open(&path)?;
            let mut archive = zip::ZipArchive::new(file)?;
            let mut result_xml = String::new();
            archive
                .by_name("xl/worksheets/sheet1.xml")?
                .read_to_string(&mut result_xml)?;
            let styled = |cell: &str| {
                Regex::new(&format!(r#"<c r="{cell}" s="\d+""#))
                    .expect("regex")
                    .is_match(&result_xml)
            };
            assert!(styled("F1") && styled("G1") && styled("F2") && styled("G2"));

            let mut mapping_xml = String::new();
            archive
                .by_name("xl/worksheets/sheet3.xml")?
                .read_to_string(&mut mapping_xml)?;
            for cell in ["A13", "B13", "A17", "B17"] {
                assert!(
                    Regex::new(&format!(r#"<c r="{cell}" s="\d+""#))
                        .expect("regex")
                        .is_match(&mapping_xml)
                );
            }
        }
        fs::remove_file(path)?;
        Ok(())
    }
}
