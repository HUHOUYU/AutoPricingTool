mod tests {
    use super::*;
    use crate::config::load_config;
    use crate::reader::read_workbook;
    use rust_xlsxwriter::Workbook;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be available")
            .as_nanos();
        env::temp_dir().join(format!("table_handle_line_{name}_{stamp}"))
    }

    fn write_test_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
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
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_country_test_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "required": true
            },
            "country_code": {
              "header_aliases": ["Country", "Shipping Country"],
              "value_patterns": ["^[A-Z]{2}$"],
              "required": false
            },
            "country_en": {
              "header_aliases": ["Country"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": true
            },
            "country_cn": {
              "header_aliases": ["Country", "国家", "国家中文", "收货人国家中文"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Price"],
              "required": true
            }
          },
          "output": {
            "extracted_sku_group_limit": 1
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_financial_check_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "required": true
            },
            "price": {
              "header_aliases": ["金额"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            },
            "financial_check_price": {
              "output_header": "财务核价列",
              "header_aliases": [],
              "value_patterns": ["^-?\\d+\\.\\d+$"],
              "require_empty_header": true,
              "pair_with": "price",
              "required": false
            }
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_order_sheet_diagnostic_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "output_header": "订单号",
              "header_aliases": ["Order number", "订单号"],
              "required": true
            },
            "sku_detail": {
              "output_header": "SKU",
              "header_aliases": ["SKU"],
              "required": true
            },
            "qty_detail": {
              "output_header": "数量",
              "header_aliases": ["Lineitem quantity"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "output_header": "金额",
              "header_aliases": ["Cost"],
              "required": true
            }
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    fn write_three_sku_config(path: &Path) -> Result<Config> {
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^(?:[A-Z0-9]*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[0-9]+(?:-[0-9]+)*-[A-Z0-9]*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["数量"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "sku_group": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z0-9]+$"],
              "required": false
            },
            "qty_group": {
              "header_aliases": ["数量"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_group",
              "required": false
            }
          },
          "output": {
            "extracted_sku_group_limit": 3
          }
        }"#;
        fs::write(path, config_text)?;
        load_config(path)
    }

    #[test]
    fn extract_records_uses_scan_hints_and_stops_after_empty_rows() -> Result<()> {
        let dir = fixture_dir("extract_hints");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-1")?;
        worksheet.write_number(1, 2, 2.0)?;
        worksheet.write_string(5, 0, "A-LATE")?;
        worksheet.write_string(5, 1, "SKU-LATE")?;
        worksheet.write_number(5, 2, 1.0)?;
        workbook.save(&source)?;

        let hinted = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
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

        let result = extract_records(&source, &config, Some(&hinted))?;

        assert_eq!(result.sheet_name, "订单");
        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("order_number")
                .cloned()
                .unwrap_or_default()
                .text(),
            "A-001"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn country_cn_requires_chinese_sample_even_when_header_is_country() -> Result<()> {
        let dir = fixture_dir("country_cn");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_country_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("Sheet1")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "Country")?;
        worksheet.write_string(0, 2, "Country")?;
        worksheet.write_string(0, 3, "SKU")?;
        worksheet.write_string(0, 4, "Qty")?;
        worksheet.write_string(0, 5, "Price")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "United States")?;
        worksheet.write_string(1, 2, "美国")?;
        worksheet.write_string(1, 3, "SKU-US-001")?;
        worksheet.write_number(1, 4, 1.0)?;
        worksheet.write_number(1, 5, 12.0)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(resolved.get("country_en").and_then(|value| *value), Some(2));
        assert_eq!(resolved.get("country_cn").and_then(|value| *value), Some(3));

        let hinted = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            standard_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("Sheet1".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(1)),
                ("country_en".to_string(), Some(2)),
                ("country_cn".to_string(), Some(2)),
                ("sku_detail".to_string(), Some(4)),
                ("qty_detail".to_string(), Some(5)),
                ("price".to_string(), Some(6)),
            ])),
        };

        let result = extract_records(&source, &config, Some(&hinted))?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("country_en")
                .cloned()
                .unwrap_or_default()
                .text(),
            "United States"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("country_cn")
                .cloned()
                .unwrap_or_default()
                .text(),
            "美国"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn country_en_does_not_steal_chinese_country_column() -> Result<()> {
        let dir = fixture_dir("country_cn_not_stolen");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_country_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("Sheet1")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "国家")?;
        worksheet.write_string(0, 2, "Country")?;
        worksheet.write_string(0, 3, "地址")?;
        worksheet.write_string(0, 4, "SKU")?;
        worksheet.write_string(0, 5, "Qty")?;
        worksheet.write_string(0, 6, "Price")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "美国")?;
        worksheet.write_string(1, 2, "United States")?;
        worksheet.write_string(1, 3, "中文地址")?;
        worksheet.write_string(1, 4, "SKU-US-001")?;
        worksheet.write_number(1, 5, 1.0)?;
        worksheet.write_number(1, 6, 12.0)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);

        assert_eq!(resolved.get("country_en").and_then(|value| *value), Some(3));
        assert_eq!(resolved.get("country_cn").and_then(|value| *value), Some(2));

        let result = extract_records(&source, &config, None)?;
        assert_eq!(
            result.records[0]
                .values
                .get("country_en")
                .cloned()
                .unwrap_or_default()
                .text(),
            "United States"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("country_cn")
                .cloned()
                .unwrap_or_default()
                .text(),
            "美国"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn country_code_column_does_not_fill_english_or_chinese_country_names() -> Result<()> {
        let dir = fixture_dir("country_code_names");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Voja 6.4 orders #49058-49110.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_country_test_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("cost")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "Shipping Country")?;
        worksheet.write_string(0, 2, "SKU")?;
        worksheet.write_string(0, 3, "Qty")?;
        worksheet.write_string(0, 4, "Price")?;
        worksheet.write_string(0, 5, "Shipping Address2")?;
        worksheet.write_string(1, 0, "#49058")?;
        worksheet.write_string(1, 1, "NL")?;
        worksheet.write_string(1, 2, "AZ2600949")?;
        worksheet.write_number(1, 3, 1.0)?;
        worksheet.write_number(1, 4, 6.39)?;
        worksheet.write_string(2, 0, "#49059")?;
        worksheet.write_string(2, 1, "GB")?;
        worksheet.write_string(2, 2, "AZ2600158")?;
        worksheet.write_number(2, 3, 2.0)?;
        worksheet.write_number(2, 4, 8.49)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(
            resolved.get("country_code").and_then(|value| *value),
            Some(2)
        );
        assert_eq!(resolved.get("country_en").and_then(|value| *value), None);
        assert_eq!(resolved.get("country_cn").and_then(|value| *value), None);

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.records.len(), 2);
        assert_eq!(
            result.records[0]
                .values
                .get("country_code")
                .cloned()
                .unwrap_or_default()
                .text(),
            "NL"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("country_en")
                .cloned()
                .unwrap_or_default()
                .text(),
            ""
        );
        assert_eq!(
            result.records[1]
                .values
                .get("country_code")
                .cloned()
                .unwrap_or_default()
                .text(),
            "GB"
        );
        assert_eq!(
            result.records[1]
                .values
                .get("country_cn")
                .cloned()
                .unwrap_or_default()
                .text(),
            ""
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn stops_before_custom_footer_rows_after_structure_break() -> Result<()> {
        let dir = fixture_dir("custom_footer_rows");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Raul 06-26 #87783-87861 78单.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 10,
            "sample_column_scan_limit": 16,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号"],
              "value_patterns": ["^(?:[A-Za-z][A-Za-z0-9-]*[0-9][A-Za-z0-9-]*|[0-9][A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$"],
              "required": true
            },
            "country_code": {
              "header_aliases": ["国家二字码"],
              "value_patterns": ["^[A-Z]{2}$"],
              "required": false
            },
            "country_en": {
              "header_aliases": ["收货人国家"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": false
            },
            "country_cn": {
              "header_aliases": ["中文国家名"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": false
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["产品总数"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          },
          "output": {
            "extracted_sku_group_limit": 1
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("cost")?;
        worksheet.write_string(0, 0, "下单时间")?;
        worksheet.write_string(0, 1, "订单号")?;
        worksheet.write_string(0, 2, "订单金额")?;
        worksheet.write_string(0, 3, "Lineitem price")?;
        worksheet.write_string(0, 4, "国家二字码")?;
        worksheet.write_string(0, 5, "收货人国家")?;
        worksheet.write_string(0, 6, "中文国家名")?;
        worksheet.write_string(0, 7, "产品名称")?;
        worksheet.write_string(0, 8, "SKU")?;
        worksheet.write_string(0, 9, "产品总数")?;
        worksheet.write_string(0, 10, "SKU")?;
        worksheet.write_string(0, 11, "SKU")?;
        worksheet.write_string(0, 12, "产品总数")?;
        worksheet.write_string(0, 13, "price")?;
        worksheet.write_string(1, 1, "Raul87783")?;
        worksheet.write_string(1, 4, "US")?;
        worksheet.write_string(1, 5, "UNITED STATES")?;
        worksheet.write_string(1, 6, "美国")?;
        worksheet.write_string(1, 8, "FZ2400927-M")?;
        worksheet.write_number(1, 9, 1.0)?;
        worksheet.write_string(1, 10, "FZ2400927-M07")?;
        worksheet.write_string(1, 11, "FZ2400927")?;
        worksheet.write_number(1, 12, 1.0)?;
        worksheet.write_number(1, 13, 64.31)?;
        worksheet.write_formula(2, 12, "=SUM(M2:M2)")?;
        worksheet.write_formula(2, 13, "=SUM(N2:N2)")?;
        worksheet.write_string(4, 0, "84087")?;
        worksheet.write_string(4, 1, "AZ2600302")?;
        worksheet.write_string(4, 2, "Cancel")?;
        worksheet.write_number(4, 3, 44.32)?;
        worksheet.write_number(4, 4, -288.73)?;
        worksheet.write_string(4, 9, "collar labels")?;
        worksheet.write_number(4, 10, 169.0)?;
        worksheet.write_number(4, 11, 0.18)?;
        worksheet.write_number(4, 12, 30.42)?;
        workbook.save(&source)?;

        let hinted = ProcessorFile {
            id: 1,
            path: source.to_string_lossy().to_string(),
            original_name: "Raul 06-26 #87783-87861 78单.xlsx".to_string(),
            standard_name: "Raul__2026.06.26__orders.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: String::new(),
            sheet_name: Some("cost".to_string()),
            header_row: Some(1),
            column_hints: Some(BTreeMap::from([
                ("order_number".to_string(), Some(2)),
                ("country_code".to_string(), Some(5)),
                ("country_en".to_string(), Some(6)),
                ("country_cn".to_string(), Some(7)),
                ("sku_detail".to_string(), Some(9)),
                ("qty_detail".to_string(), Some(10)),
                ("price".to_string(), Some(14)),
            ])),
        };

        let result = extract_records(&source, &config, Some(&hinted))?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("country_code")
                .cloned()
                .unwrap_or_default()
                .text(),
            "US"
        );
        assert_eq!(
            result.records[0]
                .values
                .get("order_number")
                .cloned()
                .unwrap_or_default()
                .text(),
            "Raul87783"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn financial_check_price_requires_empty_header_and_decimal_samples() -> Result<()> {
        let dir = fixture_dir("financial_check_price");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "金额")?;
        worksheet.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        worksheet.write_string(0, 3, "备注")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_number(1, 1, 12.5)?;
        worksheet.write_number(1, 2, 8.75)?;
        worksheet.write_number(1, 3, 9.25)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(resolved.get("price").and_then(|value| *value), Some(2));
        assert_eq!(
            resolved
                .get("financial_check_price")
                .and_then(|value| *value),
            Some(3)
        );

        let result = extract_records(&source, &config, None)?;
        assert_eq!(
            result.records[0]
                .values
                .get("financial_check_price")
                .cloned()
                .unwrap_or_default()
                .text(),
            "8.75"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn financial_check_price_prefers_empty_decimal_column_near_price() -> Result<()> {
        let dir = fixture_dir("financial_check_near_price");
        fs::create_dir_all(&dir)?;
        let source = dir.join("TC-CB order 23-June.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("order_1")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "金额")?;
        worksheet.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        worksheet.write_string(0, 3, "备注")?;
        worksheet.write_blank(0, 7, &rust_xlsxwriter::Format::new())?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_number(1, 1, 10.0)?;
        worksheet.write_number(1, 2, 8.75)?;
        worksheet.write_string(1, 3, "near target")?;
        worksheet.write_number(1, 7, 99.11)?;
        worksheet.write_string(2, 0, "A-002")?;
        worksheet.write_number(2, 1, 12.0)?;
        worksheet.write_number(2, 2, 0.0)?;
        worksheet.write_number(2, 7, 88.22)?;
        worksheet.write_string(3, 0, "A-003")?;
        worksheet.write_number(3, 1, 14.0)?;
        worksheet.write_number(3, 2, 6.25)?;
        worksheet.write_number(3, 7, 77.33)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let resolved = resolve_columns(&preview.sheets[0], 1, &config);
        assert_eq!(resolved.get("price").and_then(|value| *value), Some(2));
        assert_eq!(
            resolved
                .get("financial_check_price")
                .and_then(|value| *value),
            Some(3)
        );

        let result = extract_records(&source, &config, None)?;
        assert_eq!(
            result.records[0]
                .values
                .get("financial_check_price")
                .cloned()
                .unwrap_or_default()
                .text(),
            "8.75"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_uses_financial_sheet_score_for_preview_hints() -> Result<()> {
        let dir = fixture_dir("header_preview_cost");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Raul 06-24 #87632-87715  84单.xlsx");
        let config_path = dir.join("extract_rules.json");
        let mut config = write_financial_check_config(&config_path)?;
        config.sheet_rules.preferred_sheet_names = vec!["cost".to_string()];

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("order_1")?;
        order.write_string(0, 0, "订单号")?;
        order.write_string(0, 1, "金额")?;
        order.write_string(1, 0, "Raul87632")?;
        order.write_number(1, 1, 360.98)?;

        let cost = workbook.add_worksheet();
        cost.set_name("cost")?;
        cost.write_string(0, 0, "订单号")?;
        cost.write_string(0, 1, "金额")?;
        cost.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        cost.write_string(1, 0, "Raul87632")?;
        cost.write_number(1, 1, 40.13)?;
        cost.write_number(1, 2, 40.13)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("cost"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_uses_preferred_sheet_order_as_tiebreaker() -> Result<()> {
        let dir = fixture_dir("header_preview_preferred_order");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Voja-1~6.18 orders.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["Cost", "cost", "order_1", "Sheet1", "orders_export", "Order", "order_"],
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 80,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Name"],
              "value_patterns": ["^#?[A-Za-z]+\\d+$"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Lineitem quantity"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price", "Lineitem price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let orders = workbook.add_worksheet();
        orders.set_name("orders_export")?;
        orders.write_string(0, 0, "Name")?;
        orders.write_string(0, 16, "Lineitem quantity")?;
        orders.write_string(0, 18, "Lineitem price")?;
        orders.write_string(0, 20, "Lineitem sku")?;
        for column in 1..25 {
            if !matches!(column, 16 | 18 | 20) {
                orders.write_string(0, column, format!("Extra {column}"))?;
            }
        }
        orders.write_string(1, 0, "#BLOOM1023")?;
        orders.write_number(1, 16, 1.0)?;
        orders.write_number(1, 18, 39.95)?;
        orders.write_string(1, 20, "AZ2601827")?;

        let cost = workbook.add_worksheet();
        cost.set_name("cost")?;
        cost.write_string(0, 0, "Name")?;
        cost.write_string(0, 1, "Email")?;
        cost.write_string(0, 2, "Shipping Country")?;
        cost.write_string(0, 3, "SKU")?;
        cost.write_string(0, 4, "Lineitem quantity")?;
        cost.write_string(0, 5, "price")?;
        for column in 6..16 {
            cost.write_string(0, column, format!("Cost Extra {column}"))?;
        }
        cost.write_string(1, 0, "#BLOOM1023")?;
        cost.write_string(1, 3, "AZ2601827")?;
        cost.write_number(1, 4, 1.0)?;
        cost.write_number(1, 5, 6.19)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("cost"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_prefers_sheet_with_sample_sku_over_empty_preferred_sheet() -> Result<()>
    {
        let dir = fixture_dir("header_preview_sample_sku");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Grafton store Order.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["Sheet1"],
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 20,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "value_patterns": ["^[A-Z]{2}-[A-Z]{2}-\\d+$"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Quantity"],
              "value_patterns": ["^\\d+$"],
              "pair_with": "sku_detail",
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let empty_preferred = workbook.add_worksheet();
        empty_preferred.set_name("Sheet1")?;
        empty_preferred.write_string(0, 0, "Order number")?;
        empty_preferred.write_string(0, 1, "SKU")?;
        empty_preferred.write_string(0, 2, "Quantity")?;
        empty_preferred.write_string(1, 0, "GC-SL-15003")?;
        empty_preferred.write_number(1, 2, 1.0)?;

        let order_sheet = workbook.add_worksheet();
        order_sheet.set_name("Sheet1 (2)")?;
        order_sheet.write_string(0, 0, "Order number")?;
        order_sheet.write_string(0, 1, "SKU")?;
        order_sheet.write_string(0, 2, "Quantity")?;
        order_sheet.write_string(1, 0, "GC-SL-15003")?;
        order_sheet.write_string(1, 1, "QY2600223")?;
        order_sheet.write_number(1, 2, 1.0)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);
        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("Sheet1 (2)"));
        assert_eq!(header_row, Some(1));

        let result = extract_records(&source, &config, None)?;
        assert_eq!(result.sheet_name, "Sheet1 (2)");
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].sku_pairs[0].0.text(), "QY2600223");

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_penalizes_wider_header_rows() -> Result<()> {
        let dir = fixture_dir("header_preview_wide_penalty");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Marlon__2026.06.12__orders_export.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 80,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Name"],
              "value_patterns": ["^#?\\d+$"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Lineitem quantity"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Cost", "Lineitem price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let wide = workbook.add_worksheet();
        wide.set_name("orders_export")?;
        wide.write_string(0, 0, "Name")?;
        wide.write_string(0, 16, "Lineitem quantity")?;
        wide.write_string(0, 18, "Lineitem price")?;
        wide.write_string(0, 20, "Lineitem sku")?;
        for column in 1..25 {
            if !matches!(column, 16 | 18 | 20) {
                wide.write_string(0, column, format!("Extra {column}"))?;
            }
        }
        wide.write_string(1, 0, "#1002")?;
        wide.write_number(1, 16, 1.0)?;
        wide.write_number(1, 18, 99.0)?;
        wide.write_string(1, 20, "QY2601025")?;

        let narrow = workbook.add_worksheet();
        narrow.set_name("orders_export (2)")?;
        narrow.write_string(0, 0, "Name")?;
        narrow.write_string(0, 2, "Lineitem quantity")?;
        narrow.write_string(0, 3, "Cost")?;
        narrow.write_string(0, 4, "SKU")?;
        narrow.write_string(1, 0, "#1002")?;
        narrow.write_number(1, 2, 1.0)?;
        narrow.write_number(1, 3, 45.39)?;
        narrow.write_string(1, 4, "QY2601025")?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("orders_export (2)"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_alias_score_uses_alias_order_as_tiebreaker() {
        let first = vec!["name".to_string(), "order number".to_string()];
        let second = vec!["order number".to_string(), "name".to_string()];
        assert!(
            header_alias_score_prepared("name", &first)
                > header_alias_score_prepared("name", &second)
        );

        let contains_first = vec!["sku".to_string(), "product".to_string()];
        let contains_second = vec!["product".to_string(), "sku".to_string()];
        assert!(
            header_alias_score_prepared("lineitem sku", &contains_first)
                > header_alias_score_prepared("lineitem sku", &contains_second)
        );
    }

    #[test]
    fn field_candidates_prioritize_exact_headers_over_content_scores() {
        let config = Config::default();
        let value_pattern = Regex::new("^MATCH$").unwrap();
        for (field_name, exact_header) in [
            ("order_number", "Order number-PY"),
            ("sku_detail", "SKU-PY"),
            ("qty_detail", "Qty-PY"),
            ("country_code", "Country-PY"),
        ] {
            let partial_header = exact_header.trim_end_matches("-PY");
            let rule = FieldRule {
                header_aliases: vec![exact_header.to_string()],
                value_patterns: vec!["^MATCH$".to_string()],
                normalized_header_aliases: vec![normalize_header(exact_header)],
                compiled_value_patterns: vec![value_pattern.clone()],
                ..FieldRule::default()
            };
            let sheet = SheetData {
                name: "order".to_string(),
                rows: vec![
                    vec![
                        CellValue::string(partial_header),
                        CellValue::string(exact_header),
                    ],
                    vec![CellValue::string("MATCH"), CellValue::string("MATCH")],
                    vec![CellValue::string("MATCH"), CellValue::string("NO_MATCH")],
                ],
            };

            assert_eq!(
                candidates_for_field(&sheet, field_name, &rule, 1, &config, &HashMap::new(),)
                    .first()
                    .map(|candidate| candidate.column),
                Some(2),
                "{exact_header} should prefer the exact header"
            );
        }
    }

    #[test]
    fn header_confirmation_reports_missing_order_number_with_found_candidates() -> Result<()> {
        let dir = fixture_dir("header_preview_missing_order_number");
        fs::create_dir_all(&dir)?;
        let source = dir.join("06.01 Anass orders_export.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_order_sheet_diagnostic_config(&config_path)?;

        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        sheet.set_name("orders_export  st (2)")?;
        sheet.write_string(0, 0, "Name")?;
        sheet.write_string(0, 1, "Lineitem quantity")?;
        sheet.write_string(0, 2, "Cost")?;
        sheet.write_string(0, 3, "SKU")?;
        sheet.write_string(1, 0, "#QQ17561141")?;
        sheet.write_number(1, 1, 1.0)?;
        sheet.write_number(1, 2, 10.39)?;
        sheet.write_string(1, 3, "ABC123")?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(
            reason.as_deref(),
            Some(
                "未找到满足订单主表条件的表头行：缺少 order_number；已发现 SKU/数量/金额候选，需人工确认"
            )
        );
        assert_eq!(sheet_name, None);
        assert_eq!(header_row, None);

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_keeps_order_sheet_over_price_sheet_without_order_number() -> Result<()> {
        let dir = fixture_dir("header_preview_order_required");
        fs::create_dir_all(&dir)?;
        let source = dir.join("10X868 order 5-JUN.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "required": true
            },
            "country_en": {
              "header_aliases": ["Country"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": true
            },
            "country_cn": {
              "header_aliases": ["Country", "中文国家名"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            },
            "financial_check_price": {
              "header_aliases": [],
              "value_patterns": ["^-?\\d+\\.\\d+$"],
              "require_empty_header": true,
              "pair_with": "price",
              "required": false
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("order_1")?;
        order.write_string(0, 0, "Order number")?;
        order.write_string(0, 1, "Country")?;
        order.write_string(0, 2, "中文国家名")?;
        order.write_string(0, 3, "SKU")?;
        order.write_string(0, 4, "Qty")?;
        order.write_string(0, 5, "Price")?;
        order.write_string(1, 0, "10X8681009")?;
        order.write_string(1, 1, "United States")?;
        order.write_string(1, 2, "美国")?;
        order.write_string(1, 3, "TC2501009-6pcs-H")?;
        order.write_number(1, 4, 1.0)?;
        order.write_number(1, 5, 11.8)?;

        let price = workbook.add_worksheet();
        price.set_name("Sheet1")?;
        price.write_string(0, 0, "SKU")?;
        price.write_string(0, 1, "Country")?;
        price.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        price.write_blank(0, 3, &rust_xlsxwriter::Format::new())?;
        price.write_string(1, 0, "TC2500124-S")?;
        price.write_string(1, 1, "United States")?;
        price.write_number(1, 2, 14.3)?;
        price.write_number(1, 3, 1.386)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("order_1"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_requires_real_alias_for_each_required_header() -> Result<()> {
        let dir = fixture_dir("header_preview_requires_real_aliases");
        fs::create_dir_all(&dir)?;
        let source = dir.join("sample.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "header_scan_rows": 3,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 10,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"]
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty"],
              "value_patterns": ["^\\d+$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["Price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("订单")?;
        worksheet.write_string(0, 0, "Order number")?;
        worksheet.write_string(0, 1, "Item")?;
        worksheet.write_string(0, 2, "Count")?;
        worksheet.write_string(0, 3, "Price")?;
        worksheet.write_string(1, 0, "TC-1001")?;
        worksheet.write_string(1, 1, "FZ2500304")?;
        worksheet.write_number(1, 2, 1.0)?;
        worksheet.write_number(1, 3, 10.5)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert!(reason.is_some());
        assert_eq!(sheet_name, None);
        assert_eq!(header_row, None);

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn header_confirmation_rejects_price_data_row_as_header() -> Result<()> {
        let dir = fixture_dir("header_preview_price_data");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Voja 6.1 orders #48869-48959.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["orders_export"],
            "header_scan_rows": 10,
            "data_sample_rows": 5,
            "sample_column_scan_limit": 20,
            "empty_gap_limit": 3
          },
          "fields": {
            "order_number": {
              "header_aliases": ["Order number", "Name"],
              "value_patterns": ["^(?:[A-Za-z][A-Za-z0-9-]*[0-9][A-Za-z0-9-]*|[0-9][A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$"],
              "required": true
            },
            "country_en": {
              "header_aliases": ["Country", "Shipping: Country"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": true
            },
            "country_cn": {
              "header_aliases": ["Country", "国家中文"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": true
            },
            "sku_detail": {
              "header_aliases": ["SKU", "Lineitem sku"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["Qty", "Lineitem quantity"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price", "Lineitem price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("orders_export")?;
        order.write_string(0, 0, "Name")?;
        order.write_string(0, 1, "Shipping Country")?;
        order.write_string(0, 2, "国家中文")?;
        order.write_string(0, 3, "Lineitem sku")?;
        order.write_string(0, 4, "Lineitem quantity")?;
        order.write_string(0, 5, "Lineitem price")?;
        order.write_string(1, 0, "#48869")?;
        order.write_string(1, 1, "Belgium")?;
        order.write_string(1, 2, "比利时")?;
        order.write_string(1, 3, "FZ2500304")?;
        order.write_number(1, 4, 1.0)?;
        order.write_number(1, 5, 29.99)?;

        let price = workbook.add_worksheet();
        price.set_name("price")?;
        price.write_string(0, 0, "Supplier address")?;
        price.write_string(2, 0, "Quotation")?;
        price.write_string(3, 0, "Clients")?;
        price.write_string(3, 1, "Item No.")?;
        price.write_string(3, 2, "Picture")?;
        price.write_string(3, 3, "Description")?;
        price.write_string(3, 5, "Country")?;
        price.write_string(3, 6, "Dropshipping price")?;
        price.write_string(7, 0, "Name")?;
        price.write_string(7, 1, "Voja Trifkovic SkinAnew")?;
        price.write_string(7, 2, "FZ2500304")?;
        price.write_string(7, 5, "BE")?;
        price.write_number(7, 6, 6.69)?;
        price.write_string(8, 0, "Voja48869")?;
        price.write_string(8, 1, "Voja Trifkovic SkinAnew")?;
        price.write_string(8, 2, "FZ2500305")?;
        price.write_string(8, 5, "United States")?;
        price.write_number(8, 6, 9.49)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("orders_export"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn sheet_selection_rejects_price_matrix_with_name_and_numeric_headers() -> Result<()> {
        let dir = fixture_dir("header_preview_price_matrix");
        fs::create_dir_all(&dir)?;
        let source = dir.join("06.10 Alurase order.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config_text = r#"{
          "sheet_rules": {
            "preferred_sheet_names": ["Sheet1", "order_"],
            "header_scan_rows": 20,
            "data_sample_rows": 10,
            "sample_column_scan_limit": 20,
            "empty_gap_limit": 3
          },
          "sheet_selection": {
            "required_header_fields": ["order_number", "sku_detail", "qty_detail"],
            "ignore_required_empty_header_fields": true,
            "empty_header_fields_can_boost_sheet": false,
            "weak_order_number_aliases": ["Name"],
            "reject_header_keywords": ["Dropshipping price", "Payment Way", "Picture"],
            "sequential_numeric_header_penalty": 500
          },
          "fields": {
            "order_number": {
              "header_aliases": ["订单号", "Name"],
              "value_patterns": ["^(?:[A-Za-z][A-Za-z0-9-]*[0-9][A-Za-z0-9-]*|[0-9][A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$"],
              "required": true
            },
            "country_code": {
              "header_aliases": ["Country", "国家二字码"],
              "value_patterns": ["^[A-Z]{2}$"],
              "required": false
            },
            "country_en": {
              "header_aliases": ["Country", "收货人国家"],
              "value_patterns": ["^[A-Z][A-Za-z\\s\\-()]{3,}$"],
              "required": false
            },
            "country_cn": {
              "header_aliases": ["Country", "中文国家名"],
              "value_patterns": ["[\\u4e00-\\u9fff]"],
              "required": false
            },
            "sku_detail": {
              "header_aliases": ["SKU"],
              "value_patterns": ["^[A-Z]{2}\\d{6,}$"],
              "required": true
            },
            "qty_detail": {
              "header_aliases": ["产品总数", "Qty"],
              "value_patterns": ["^\\d+(?:\\.0)?$"],
              "pair_with": "sku_detail",
              "required": true
            },
            "price": {
              "header_aliases": ["price", "Price", "Dropshipping price"],
              "value_patterns": ["^\\d+(?:\\.\\d+)?$"],
              "required": true
            },
            "financial_check_price": {
              "header_aliases": [],
              "value_patterns": ["^-?\\d+\\.\\d+$"],
              "require_empty_header": true,
              "pair_with": "price",
              "required": true
            }
          }
        }"#;
        fs::write(&config_path, config_text)?;
        let config = load_config(&config_path)?;

        let mut workbook = Workbook::new();
        let order = workbook.add_worksheet();
        order.set_name("Sheet1")?;
        order.write_string(0, 0, "订单号")?;
        order.write_string(0, 1, "国家二字码")?;
        order.write_string(0, 2, "收货人国家")?;
        order.write_string(0, 3, "中文国家名")?;
        order.write_string(0, 4, "SKU")?;
        order.write_string(0, 5, "产品总数")?;
        order.write_string(0, 6, "price")?;
        order.write_blank(0, 7, &rust_xlsxwriter::Format::new())?;
        order.write_string(1, 0, "7983668-1983")?;
        order.write_string(1, 1, "GB")?;
        order.write_string(1, 2, "UNITED KINGDOM")?;
        order.write_string(1, 3, "英国")?;
        order.write_string(1, 4, "KJ2500692")?;
        order.write_number(1, 5, 2.0)?;
        order.write_number(1, 6, 15.49)?;
        order.write_number(1, 7, 15.49)?;

        let price = workbook.add_worksheet();
        price.set_name("Sheet2")?;
        price.write_string(3, 0, "Item No.")?;
        price.write_string(3, 1, "Picture")?;
        price.write_string(3, 2, "Name")?;
        price.write_string(3, 3, "Description")?;
        price.write_string(3, 4, "Payment Way")?;
        price.write_string(3, 5, "SKU")?;
        price.write_string(3, 6, "Country")?;
        price.write_string(3, 7, "Dropshipping price")?;
        price.write_blank(3, 8, &rust_xlsxwriter::Format::new())?;
        price.write_blank(3, 9, &rust_xlsxwriter::Format::new())?;
        price.write_blank(3, 10, &rust_xlsxwriter::Format::new())?;
        price.write_number(4, 7, 1.0)?;
        price.write_number(4, 8, 2.0)?;
        price.write_number(4, 9, 3.0)?;
        price.write_number(4, 10, 5.0)?;
        price.write_string(5, 2, "Oregano Black Seed Boost")?;
        price.write_string(5, 5, "FZ2501254")?;
        price.write_string(5, 6, "US")?;
        price.write_number(5, 7, 7.19)?;
        price.write_number(5, 8, 10.99)?;
        price.write_number(5, 9, 14.79)?;
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let (reason, sheet_name, header_row) = header_confirmation(&preview, &config);

        assert_eq!(reason, None);
        assert_eq!(sheet_name.as_deref(), Some("Sheet1"));
        assert_eq!(header_row, Some(1));

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn numeric_header_ladder_detects_pcs_quantity_headers() {
        let headers = [
            "Item No.", "Name", "SKU", "Country", "1 pcs", "3 pcs", "4 pcs", "6 pcs", "7 pcs",
            "9 pcs", "10 pcs",
        ]
        .into_iter()
        .map(normalize_header)
        .collect::<Vec<_>>();

        assert!(has_numeric_header_ladder(&headers));
    }

    #[test]
    fn numeric_header_ladder_detects_three_numeric_headers() {
        let headers = ["SKU", "Country", "1 pcs", "2 pcs", "3 pcs"]
            .into_iter()
            .map(normalize_header)
            .collect::<Vec<_>>();

        assert!(has_numeric_header_ladder(&headers));
        assert_eq!(numeric_header_ladder_level(&headers), 1);
    }

    #[test]
    fn numeric_header_ladder_penalty_gets_stronger_with_more_numeric_headers() {
        let three_headers = ["SKU", "1 pcs", "3 pcs", "5 pcs"]
            .into_iter()
            .map(normalize_header)
            .collect::<Vec<_>>();
        let five_headers = ["SKU", "1 pcs", "2 pcs", "3 pcs", "4 pcs", "5 pcs"]
            .into_iter()
            .map(normalize_header)
            .collect::<Vec<_>>();

        assert_eq!(numeric_header_ladder_level(&three_headers), 1);
        assert!(
            numeric_header_ladder_level(&five_headers)
                > numeric_header_ladder_level(&three_headers)
        );
    }

    #[test]
    fn financial_check_empty_header_adjustment_rewards_single_and_penalizes_many() {
        let config = Config::default();

        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 1, &config),
            20.0
        );
        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 2, &config),
            10.0
        );
        assert!(
            (financial_check_empty_header_adjustment(20.0, 3, &config) - 20.0 / 3.0).abs() < 0.001
        );
        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 4, &config),
            -20.0
        );
        assert_eq!(
            financial_check_empty_header_adjustment(20.0, 5, &config),
            -40.0
        );
    }

    #[test]
    fn empty_header_decimal_column_boosts_sheet_selection() -> Result<()> {
        let dir = fixture_dir("financial_check_sheet");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let first = workbook.add_worksheet();
        first.set_name("普通订单")?;
        first.write_string(0, 0, "订单号")?;
        first.write_string(0, 1, "金额")?;
        first.write_string(0, 2, "备注")?;
        first.write_string(1, 0, "A-WRONG")?;
        first.write_number(1, 1, 12.0)?;
        first.write_string(1, 2, "not target")?;

        let target = workbook.add_worksheet();
        target.set_name("核价订单")?;
        target.write_string(0, 0, "订单号")?;
        target.write_string(0, 1, "金额")?;
        target.write_blank(0, 2, &rust_xlsxwriter::Format::new())?;
        target.write_string(1, 0, "A-001")?;
        target.write_number(1, 1, 12.5)?;
        target.write_number(1, 2, 8.75)?;
        target.write_string(2, 0, "A-002")?;
        target.write_number(2, 1, 0.0)?;
        target.write_number(2, 2, 0.0)?;
        target.write_string(3, 0, "A-003")?;
        target.write_number(3, 1, 9.5)?;
        target.write_number(3, 2, 6.25)?;
        workbook.save(&source)?;

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.sheet_name, "核价订单");
        assert_eq!(result.records.len(), 3);
        assert_eq!(
            result.records[0]
                .values
                .get("financial_check_price")
                .cloned()
                .unwrap_or_default()
                .text(),
            "8.75"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn financial_check_empty_header_signal_penalizes_more_than_three_columns() -> Result<()> {
        let dir = fixture_dir("financial_check_many_empty_headers");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.02__batch.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_financial_check_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("核价订单")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "金额")?;
        let blank_format = rust_xlsxwriter::Format::new();
        for column in 2..6 {
            worksheet.write_blank(0, column, &blank_format)?;
        }
        for row in 1..=3 {
            worksheet.write_string(row, 0, format!("A-{row:03}"))?;
            worksheet.write_number(row, 1, 10.0 + row as f64)?;
            for column in 2..6 {
                worksheet.write_number(row, column, 8.0 + column as f64 + row as f64 / 10.0)?;
            }
        }
        workbook.save(&source)?;

        let preview = read_workbook(&source)?;
        let sheet = preview.sheets.first().expect("fixture sheet exists");
        let columns = columns_to_candidates(sheet, 1, &config);

        assert!(columns.contains_key("financial_check_price"));
        assert_eq!(
            financial_check_sheet_adjustment(sheet, 1, &columns, &config),
            -20.0
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn extract_records_skips_summary_rows_without_sku_data() -> Result<()> {
        let dir = fixture_dir("skip_summary_without_sku");
        fs::create_dir_all(&dir)?;
        let source = dir.join("Brand__2026.06.26__orders.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_three_sku_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("order_1")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(0, 3, "金额")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-A-1")?;
        worksheet.write_number(1, 2, 1.0)?;
        worksheet.write_number(1, 3, 25.39)?;
        worksheet.write_string(2, 0, "Total")?;
        worksheet.write_number(2, 2, 3.0)?;
        worksheet.write_number(2, 3, 76.17)?;
        workbook.save(&source)?;

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(
            result.records[0]
                .values
                .get("order_number")
                .cloned()
                .unwrap_or_default()
                .text(),
            "A-001"
        );

        fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn extracts_three_sku_qty_pairs_when_output_allows_three_groups() -> Result<()> {
        let dir = fixture_dir("three_sku_groups");
        fs::create_dir_all(&dir)?;
        let source = dir.join("06.03 Shaun #1723-#1746 order.xlsx");
        let config_path = dir.join("extract_rules.json");
        let config = write_three_sku_config(&config_path)?;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name("order_1")?;
        worksheet.write_string(0, 0, "订单号")?;
        worksheet.write_string(0, 1, "SKU")?;
        worksheet.write_string(0, 2, "数量")?;
        worksheet.write_string(0, 3, "SKU")?;
        worksheet.write_string(0, 4, "数量")?;
        worksheet.write_string(0, 5, "SKU")?;
        worksheet.write_string(0, 6, "数量")?;
        worksheet.write_string(1, 0, "A-001")?;
        worksheet.write_string(1, 1, "SKU-A-1")?;
        worksheet.write_number(1, 2, 1.0)?;
        worksheet.write_string(1, 3, "SKU-B-2")?;
        worksheet.write_number(1, 4, 2.0)?;
        worksheet.write_string(1, 5, "SKU-C-3")?;
        worksheet.write_number(1, 6, 3.0)?;
        workbook.save(&source)?;

        let result = extract_records(&source, &config, None)?;

        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].sku_pairs.len(), 3);
        assert_eq!(result.records[0].sku_pairs[2].0.text(), "SKU-C-3");
        assert_eq!(result.records[0].sku_pairs[2].1.text(), "3");

        fs::remove_dir_all(dir).ok();
        Ok(())
    }
}
