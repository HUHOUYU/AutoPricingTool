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

    fn writeback_layout(total_price_column: usize) -> PriceWritebackLayout {
        PriceWritebackLayout {
            header_row: 1,
            order_number_column: Some(1),
            total_price_column,
        }
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
            order.write_array_formula(4, 3, 4, 3, "=C2+C3")?;
            order.merge_range(5, 3, 5, 4, "merged", &Format::new())?;
            order.write_string(6, 1, "Total")?;
            order.write_number(6, 2, 30.0)?;
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
            writeback_layout(3),
            &[
                PriceWritebackRow {
                    source_row: 2,
                    pricing_price: Some(11.0),
                    price_difference: Some(1.0),
                    quantity: Some(3),
                    quantity_mismatch: true,
                    matched: true,
                    ..PriceWritebackRow::default()
                },
                PriceWritebackRow {
                    source_row: 3,
                    pricing_price: Some(9.0),
                    price_difference: Some(-3.0),
                    quantity: Some(0),
                    matched: true,
                    ..PriceWritebackRow::default()
                },
                PriceWritebackRow {
                    source_row: 4,
                    quantity: None,
                    quantity_error: Some("SKU关系无法计算".to_string()),
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
        assert_eq!(order.value("F4"), "");
        assert_eq!(order.value("B2"), "EDITED-SKU");
        assert_eq!(order.value("C2"), "15.5");
        assert_eq!(order.value("B7"), "Total");
        assert_eq!(order.value("C7"), "30");
        assert_eq!(order.value("D7"), "20");
        assert_eq!(order.value("E7"), "-2");
        assert_eq!(order.value("F7"), "3");
        for (column, minimum_width) in (4..=6).zip(WRITEBACK_MIN_COLUMN_WIDTHS) {
            assert!(
                order
                    .column_dimension_by_number(column)
                    .expect("writeback column dimension")
                    .width()
                    >= minimum_width
            );
        }
        assert_eq!(order.highest_row(), 7);
        assert_eq!(order.value("G2"), "Name-1");
        assert_eq!(output.sheet_by_name("核价")?.value("A1"), "已编辑核价表头");
        assert_eq!(order.cell("G5").expect("formula cell").formula(), "C2+C3");
        let formula = order
            .cell("G5")
            .and_then(|cell| cell.formula_obj())
            .expect("array formula metadata");
        assert_eq!(
            formula.formula_type(),
            &umya_spreadsheet::CellFormulaValues::Array
        );
        assert_eq!(formula.reference(), "G5");
        assert!(
            order
                .merge_cells()
                .iter()
                .any(|range| range.range() == "G6:H6")
        );
        for cell in ["D1", "E1", "F1", "D2", "E3", "F3"] {
            assert_eq!(
                order
                    .style(cell)
                    .background_color()
                    .expect("writeback background")
                    .argb_str(),
                "FFD8EEE0"
            );
        }
        for cell in ["D4", "E4", "F4"] {
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
    fn writeback_column_width_expands_for_long_numeric_content() -> Result<()> {
        let source_path = unique_path("writeback-width-source", "xlsx");
        let output_path = unique_path("writeback-width-output", "xlsx");
        create_source_workbook(&source_path)?;

        write_price_result(
            &source_path,
            &output_path,
            "订单",
            writeback_layout(3),
            &[PriceWritebackRow {
                source_row: 2,
                pricing_price: Some(123_456_789_012_345.0),
                matched: true,
                ..PriceWritebackRow::default()
            }],
            &[],
        )?;

        let output = umya_spreadsheet::reader::xlsx::read(&output_path)?;
        let order = output.sheet_by_name("订单")?;
        assert!(
            order
                .column_dimension_by_number(4)
                .expect("pricing column dimension")
                .width()
                > WRITEBACK_MIN_COLUMN_WIDTHS[0]
        );

        fs::remove_file(source_path)?;
        fs::remove_file(output_path)?;
        Ok(())
    }

    #[test]
    fn overwrites_source_by_copying_the_generated_result() -> Result<()> {
        let source_path = unique_path("overwrite-source", "xlsx");
        let output_path = unique_path("overwrite-output", "xlsx");
        fs::write(&source_path, b"original")?;
        fs::write(&output_path, b"generated-result")?;

        overwrite_source_with_result(&output_path, &source_path)?;

        assert_eq!(fs::read(&source_path)?, b"generated-result");
        assert_eq!(fs::read(&output_path)?, b"generated-result");
        fs::remove_file(source_path)?;
        fs::remove_file(output_path)?;
        Ok(())
    }

    #[test]
    fn rejects_legacy_formats_without_creating_output() {
        for extension in LEGACY_EXCEL_EXTENSIONS {
            let source_path = unique_path("legacy-source", extension);
            let output_path = unique_path("legacy-output", "xlsx");
            let error = write_price_result(
                &source_path,
                &output_path,
                "订单",
                writeback_layout(3),
                &[],
                &[],
            )
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

        let error = write_price_result(
            &source_path,
            &output_path,
            "订单",
            writeback_layout(0),
            &[],
            &[],
        )
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

        write_price_result(
            &source_path,
            &output_path,
            "订单",
            writeback_layout(3),
            &[],
            &[],
        )?;

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
