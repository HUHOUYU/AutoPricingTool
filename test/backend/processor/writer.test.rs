mod tests {
    use super::*;
    use crate::reader::read_workbook;
    use std::collections::BTreeMap;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be available")
            .as_nanos();
        env::temp_dir().join(format!("table_handle_line_{name}_{stamp}"))
    }

    #[test]
    fn writes_scan_manifests_as_readable_xlsx_fixtures() -> Result<()> {
        let output_dir = fixture_dir("manifests");
        let rows = vec![ProcessorFile {
            id: 1,
            path: "C:/orders/Brand.xlsx".to_string(),
            original_name: "Brand.xlsx".to_string(),
            standard_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: "12 KB".to_string(),
            sheet_name: Some("订单".to_string()),
            header_row: Some(1),
            column_hints: None,
        }];

        write_scan_manifests(&output_dir, &rows)?;

        let manifest_path = output_dir.join(FORMAL_DIR).join(FORMAL_MANIFEST);
        assert!(manifest_path.exists());
        let workbook = read_workbook(&manifest_path)?;
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "原始文件名");
        assert_eq!(workbook.sheets[0].rows[1][0].text(), "Brand.xlsx");
        assert_eq!(
            workbook.sheets[0].rows[1][1].text(),
            "Brand__2026.06.02__batch.xlsx"
        );

        fs::remove_dir_all(output_dir).ok();
        Ok(())
    }

    #[test]
    fn writes_grouped_summary_from_extracted_records() -> Result<()> {
        let output_dir = fixture_dir("summary");
        let config = Config::default();
        let mut record = Record {
            source_path: "C:/orders/Brand.xlsx".to_string(),
            source_file: "Brand.xlsx".to_string(),
            source_sheet: "订单".to_string(),
            source_row: 2,
            ..Default::default()
        };
        record
            .values
            .insert("order_number".to_string(), CellValue::string("A-001"));
        record
            .values
            .insert("price".to_string(), CellValue::Float(12.5));
        record
            .values
            .insert("file_customer".to_string(), CellValue::string("Brand"));
        record
            .sku_pairs
            .push((CellValue::string("SKU-1"), CellValue::Int(2)));
        let groups = BTreeMap::from([("Brand".to_string(), vec![record])]);

        write_grouped_summaries(&output_dir, &groups, &config)?;

        let summary_path = output_dir.join(SUMMARY_DIR).join("Brand.xlsx");
        assert!(summary_path.exists());
        let workbook = read_workbook(&summary_path)?;
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "订单号");
        assert_eq!(workbook.sheets[0].rows[0][2].text(), "文件日期");
        assert_eq!(workbook.sheets[0].rows[0][3].text(), "文件客户信息");
        assert_eq!(workbook.sheets[0].rows[0][4].text(), "国家二字码");
        assert_eq!(workbook.sheets[0].rows[1][0].text(), "A-001");
        assert_eq!(workbook.sheets[0].rows[1][3].text(), "Brand");
        assert_eq!(workbook.sheets[0].rows[1][7].text(), "SKU-1");

        fs::remove_dir_all(output_dir).ok();
        Ok(())
    }

    #[test]
    fn merges_grouped_summary_workbooks() -> Result<()> {
        let output_dir = fixture_dir("merge_summary");
        let summary_dir = output_dir.join(SUMMARY_DIR);
        write_table(
            &summary_dir.join("BrandA.xlsx"),
            SUMMARY_SHEET,
            &["订单号", "销售金额"],
            &[
                vec![CellValue::string("A-001"), CellValue::Float(10.5)],
                vec![CellValue::string("A-002"), CellValue::Int(20)],
            ],
        )?;
        write_table(
            &summary_dir.join("BrandB.xlsx"),
            SUMMARY_SHEET,
            &["订单号", "销售金额"],
            &[vec![CellValue::string("B-001"), CellValue::Int(30)]],
        )?;
        write_table(
            &summary_dir.join(SUMMARY_INDEX),
            "汇总索引",
            &["分组名"],
            &[vec![CellValue::string("BrandA")]],
        )?;
        write_table(
            &summary_dir.join(MERGED_SUMMARY),
            SUMMARY_SHEET,
            &["订单号"],
            &[vec![CellValue::string("OLD")]],
        )?;

        let merged = merge_summary_workbooks(&output_dir)?;

        assert_eq!(merged.file_count, 2);
        assert_eq!(merged.row_count, 3);
        assert_eq!(merged.path, summary_dir.join(MERGED_SUMMARY));
        let workbook = read_workbook(&merged.path)?;
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "订单号");
        assert_eq!(workbook.sheets[0].rows[1][0].text(), "A-001");
        assert_eq!(workbook.sheets[0].rows[2][0].text(), "A-002");
        assert_eq!(workbook.sheets[0].rows[3][0].text(), "B-001");

        fs::remove_dir_all(output_dir).ok();
        Ok(())
    }
}
