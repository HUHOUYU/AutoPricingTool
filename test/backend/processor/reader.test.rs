mod tests {
    use super::*;
    use rust_xlsxwriter::Workbook;
    use std::env;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn fixture_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be available")
            .as_nanos();
        env::temp_dir().join(format!("table_handle_line_{name}_{stamp}.xlsx"))
    }

    #[test]
    fn reads_generated_xlsx_fixture_with_limits_and_fast_preview() -> Result<()> {
        let path = fixture_path("reader");
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "数量")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_number(1, 1, 3.0)?;
        worksheet.write_string(2, 0, "A-002")?;
        workbook.save(&path)?;

        let (sheet_count, limited) = read_workbook_limited(&path, Some(1), Some(2), Some(2))?;
        assert_eq!(sheet_count, 1);
        assert_eq!(limited.sheets[0].name, "订单");
        assert_eq!(limited.sheets[0].rows.len(), 2);
        assert_eq!(limited.sheets[0].rows[1][0].text(), "A-001");

        let (preview_count, preview) = read_xlsx_preview_fast(
            &path,
            Some(1),
            Some(2),
            Some(2),
            u64::MAX,
            u64::MAX,
            false,
            None,
        )?;
        assert_eq!(preview_count, 1);
        assert_eq!(preview.sheets[0].rows.len(), 2);
        assert_eq!(preview.sheets[0].rows[0][0].text(), "订单号");

        fs::remove_file(path).ok();
        Ok(())
    }

    #[test]
    fn readers_skip_hidden_sheets() -> Result<()> {
        let path = fixture_path("hidden_sheet");
        let mut workbook = Workbook::new();
        let visible = workbook.add_worksheet();
        visible.set_name("订单")?;
        visible.write_string(0, 0, "订单号")?;
        visible.write_string(1, 0, "A-001")?;
        let hidden = workbook.add_worksheet();
        hidden.set_name("隐藏原始数据")?;
        hidden.set_hidden(true);
        hidden.write_string(0, 0, "SHOULD_NOT_SCAN")?;
        workbook.save(&path)?;

        let (limited_count, limited) = read_workbook_limited(&path, None, Some(5), Some(5))?;
        assert_eq!(limited_count, 2);
        assert_eq!(limited.sheets.len(), 1);
        assert_eq!(limited.sheets[0].name, "订单");

        let (sheet_count, preview) = read_xlsx_preview_fast(
            &path,
            Some(3),
            Some(5),
            Some(5),
            u64::MAX,
            u64::MAX,
            false,
            None,
        )?;

        assert_eq!(sheet_count, 2);
        assert_eq!(preview.sheets.len(), 1);
        assert_eq!(preview.sheets[0].name, "订单");
        fs::remove_file(path).ok();
        Ok(())
    }

    #[test]
    fn fast_preview_rejects_oversized_shared_strings() -> Result<()> {
        let path = fixture_path("shared_strings_guard");
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(1, 0, "A-001")?;
        workbook.save(&path)?;

        let error =
            read_xlsx_preview_fast(&path, Some(1), Some(2), Some(2), u64::MAX, 0, false, None)
                .expect_err("sharedStrings guard should reject this workbook");

        assert!(error.to_string().contains("sharedStrings.xml 超过资源限制"));
        fs::remove_file(path).ok();
        Ok(())
    }

    #[test]
    fn processing_limits_are_not_bypassed_by_fallback_reader() -> Result<()> {
        let path = fixture_path("processing_guard");
        let mut workbook = Workbook::new();
        workbook.add_worksheet().write_string(0, 0, "订单号")?;
        workbook.save(&path)?;

        let mut config = Config::default();
        config.performance.processing_workbook_max_mb = 0.000_001;
        let error = read_workbook_for_processing(&path, &config)
            .expect_err("processing guard should reject this workbook");

        assert!(is_resource_limit_error(&error));
        assert!(error.to_string().contains("工作簿文件"));
        assert!(error.to_string().contains("超过资源限制"));
        fs::remove_file(path).ok();
        Ok(())
    }

    #[test]
    fn processing_rejects_rows_beyond_configured_limit() -> Result<()> {
        let path = fixture_path("row_guard");
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(1, 0, "A-001")?;
        workbook.save(&path)?;

        let error = read_xlsx_preview_fast(
            &path,
            Some(1),
            Some(1),
            Some(2),
            u64::MAX,
            u64::MAX,
            true,
            None,
        )
        .expect_err("processing row guard should reject this workbook");

        assert!(is_resource_limit_error(&error));
        assert!(error.to_string().contains("行数 2 > 1"));
        fs::remove_file(path).ok();
        Ok(())
    }

    #[test]
    fn rejects_overflowing_cell_column_references() {
        assert_eq!(column_index_from_cell_ref("A1"), Some(1));
        assert_eq!(column_index_from_cell_ref("XFD1048576"), Some(16_384));
        assert_eq!(
            column_index_from_cell_ref(&format!("{}1", "Z".repeat(128))),
            None
        );
    }

    fn write_style_only_tail_fixture(path: &Path) -> Result<()> {
        let mut archive = ZipWriter::new(fs::File::create(path)?);
        let options = SimpleFileOptions::default();
        let mut style_rows = (2..=4)
            .map(|row| format!(r#"<row r="{row}" customHeight="1"/>"#))
            .collect::<String>();
        style_rows.push_str(r#"<row r="5"><c r="K5" s="2"/></row>"#);
        let entries = [
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="订单" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
        ];
        for (name, content) in entries {
            archive.start_file(name, options)?;
            archive.write_all(content.as_bytes())?;
        }
        archive.start_file("xl/worksheets/sheet1.xml", options)?;
        write!(
            archive,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>订单号</t></is></c></row>{style_rows}</sheetData></worksheet>"#
        )?;
        archive.finish()?;
        Ok(())
    }

    #[test]
    fn processing_ignores_style_only_tail_rows_before_row_limit() -> Result<()> {
        let path = fixture_path("style_only_tail");
        write_style_only_tail_fixture(&path)?;

        let (_, workbook) = read_xlsx_preview_fast(
            &path,
            Some(1),
            Some(3),
            Some(2),
            u64::MAX,
            u64::MAX,
            true,
            Some(3),
        )?;

        assert_eq!(workbook.sheets[0].rows.len(), 3);
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "订单号");
        fs::remove_file(path).ok();
        Ok(())
    }
}
