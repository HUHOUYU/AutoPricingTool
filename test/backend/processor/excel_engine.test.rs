mod tests {
    use super::*;
    use crate::reader::read_workbook;
    use crate::state::RuntimeState;
    use rust_xlsxwriter::Workbook;
    use std::env;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be available")
            .as_nanos();
        env::temp_dir().join(format!("table_handle_line_{name}_{stamp}"))
    }

    fn write_config(path: &Path) -> Result<()> {
        let config_text = r##"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 5,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"]
            },
            "qty_detail": {
              "header_aliases": ["数量"],
              "pair_with": "sku_detail"
            }
          },
          "output": {
            "extracted_sku_group_limit": 1
          }
        }"##;
        fs::write(path, config_text)?;
        Ok(())
    }

    fn write_source_workbook(path: &Path) -> Result<()> {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-1")?;
        worksheet.write_number(1, 2, 2.0)?;
        workbook.save(path)?;
        Ok(())
    }

    #[test]
    fn processing_worker_count_uses_most_cpu_but_reserves_capacity() {
        assert_eq!(processing_worker_count_for_available(100, 1, 0), 1);
        assert_eq!(processing_worker_count_for_available(100, 4, 0), 3);
        assert_eq!(processing_worker_count_for_available(100, 8, 0), 6);
        assert_eq!(processing_worker_count_for_available(100, 16, 0), 12);
    }

    #[test]
    fn processing_worker_count_respects_file_count_and_configuration() {
        assert_eq!(processing_worker_count_for_available(5, 16, 0), 5);
        assert_eq!(processing_worker_count_for_available(100, 16, 6), 6);
        assert_eq!(processing_worker_count_for_available(100, 16, 32), 16);
        assert_eq!(processing_result_channel_capacity(1), 2);
        assert_eq!(processing_result_channel_capacity(16), 16);
    }

    #[test]
    fn scan_preview_considers_all_visible_sheets() -> Result<()> {
        let root = fixture_dir("scan_all_visible_sheets");
        fs::create_dir_all(&root)?;
        let config_path = root.join("extract_rules.json");
        write_config(&config_path)?;
        let config = load_config(&config_path)?;
        let source = root.join("four_sheets.xlsx");

        let mut workbook = Workbook::new();
        for sheet_name in ["说明一", "说明二", "说明三"] {
            let worksheet = workbook.add_worksheet();
            worksheet.set_name(sheet_name)?;
            worksheet.write_string(0, 0, "说明")?;
        }
        let order = workbook.add_worksheet();
        order.set_name("订单")?;
        order.write_string(0, 0, "订单号")?;
        order.write_string(0, 1, "SKU")?;
        order.write_string(0, 2, "数量")?;
        order.write_string(1, 0, "A-001")?;
        order.write_string(1, 1, "SKU-1")?;
        order.write_number(1, 2, 2.0)?;
        workbook.save(&source)?;

        let preview = scan_workbook_preview(&source, &config)?;

        assert_eq!(preview.sheet_count, 4);
        assert_eq!(preview.sheet_name.as_deref(), Some("订单"));
        assert_eq!(preview.header_row, Some(1));
        assert_eq!(preview.reason, None);

        fs::remove_dir_all(root).ok();
        Ok(())
    }

    #[test]
    fn run_processing_does_not_copy_standard_file_when_archive_is_disabled() -> Result<()> {
        let root = fixture_dir("archive_disabled");
        let input_dir = root.join("input");
        let output_dir = root.join("output");
        fs::create_dir_all(&input_dir)?;
        fs::create_dir_all(&output_dir)?;
        let config_path = root.join("extract_rules.json");
        write_config(&config_path)?;
        let source = input_dir.join("Brand__2026.06.02__batch.xlsx");
        write_source_workbook(&source)?;

        let confirmed_file = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            standard_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("订单".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(1)),
                ("sku_detail".to_string(), Some(2)),
                ("qty_detail".to_string(), Some(3)),
            ])),
        };
        let command = json!({
            "outputDir": output_dir,
            "configPath": config_path,
            "files": [source],
            "confirmedFiles": [confirmed_file],
            "pendingFiles": [],
            "errorFiles": [],
            "archiveStandardFiles": false
        });

        run_processing(&command, &RuntimeState::new())?;

        let formal_dir = output_dir.join("正式命名");
        assert!(formal_dir.join("正式命名清单.xlsx").exists());
        assert!(!formal_dir.join("Brand__2026.06.02__batch.xlsx").exists());
        assert!(output_dir.join("汇总").join("Brand.xlsx").exists());

        fs::remove_dir_all(root).ok();
        Ok(())
    }

    #[test]
    fn run_processing_writes_processing_failures_to_error_manifest() -> Result<()> {
        let root = fixture_dir("processing_error_manifest");
        let input_dir = root.join("input");
        let output_dir = root.join("output");
        fs::create_dir_all(&input_dir)?;
        fs::create_dir_all(&output_dir)?;
        let config_path = root.join("extract_rules.json");
        write_config(&config_path)?;
        let source = input_dir.join("Broken__2026.06.02__batch.xlsx");
        fs::write(&source, b"not a real workbook")?;

        let confirmed_file = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: "Broken__2026.06.02__batch.xlsx".to_string(),
            standard_name: "Broken__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("订单".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(1)),
                ("sku_detail".to_string(), Some(2)),
                ("qty_detail".to_string(), Some(3)),
            ])),
        };
        let command = json!({
            "outputDir": output_dir,
            "configPath": config_path,
            "files": [source],
            "confirmedFiles": [confirmed_file],
            "pendingFiles": [],
            "errorFiles": [],
            "archiveStandardFiles": false
        });

        run_processing(&command, &RuntimeState::new())?;

        let error_manifest = output_dir.join("异常").join("异常清单.xlsx");
        assert!(error_manifest.exists());
        let workbook = read_workbook(&error_manifest)?;
        let sheet = workbook.sheets.first().expect("manifest sheet exists");
        let error_row = sheet.rows.get(1).expect("processing error row exists");
        assert_eq!(error_row[0].text(), "Broken__2026.06.02__batch.xlsx");
        assert_eq!(error_row[4].text(), "处理");

        fs::remove_dir_all(root).ok();
        Ok(())
    }
}
