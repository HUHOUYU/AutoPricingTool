mod tests {
    use super::*;

    #[test]
    fn maps_permission_errors() {
        let mapped = map_error(
            "处理失败",
            "The process cannot access the file because it is being used by another process",
        );

        assert_eq!(mapped.title, "处理失败: 文件无法访问");
        assert!(mapped.suggestion.contains("Excel"));
    }

    #[test]
    fn maps_config_parse_errors() {
        let mapped = map_error(
            "扫描失败",
            "解析配置失败: expected value at line 4 column 2",
        );

        assert_eq!(mapped.title, "扫描失败: 配置文件格式错误");
        assert!(mapped.suggestion.contains("extract_rules.json"));
    }

    #[test]
    fn maps_invalid_regex_as_config_error() {
        let mapped = map_error(
            "扫描失败",
            "无效正则: fields.order_number.value_patterns[0]",
        );

        assert_eq!(mapped.title, "扫描失败: 配置文件格式错误");
        assert!(mapped.suggestion.contains("extract_rules.json"));
    }

    #[test]
    fn maps_excel_archive_errors() {
        let mapped = map_error(
            "处理失败",
            "invalid Zip archive: Could not find central directory end",
        );

        assert_eq!(mapped.title, "处理失败: Excel 文件无法读取");
        assert!(mapped.suggestion.contains("另存为 xlsx"));
    }

    #[test]
    fn maps_output_write_errors() {
        let mapped = map_error("处理失败", "No space left on device");

        assert_eq!(mapped.title, "处理失败: 输出目录无法写入");
        assert!(mapped.suggestion.contains("磁盘"));
    }

    #[test]
    fn maps_unmatched_order_sheet_errors() {
        let mapped = map_error(
            "处理失败",
            "已扫描所有 sheet，但没有找到满足订单主表条件的工作表",
        );

        assert_eq!(mapped.title, "处理失败: 未识别到订单数据");
        assert!(mapped.suggestion.contains("字段映射"));
    }

    #[test]
    fn maps_resource_limit_errors() {
        let mapped = map_error(
            "处理失败",
            "xl/worksheets/sheet1.xml 超过资源限制: 300.0 MB > 256.0 MB",
        );

        assert_eq!(mapped.title, "处理失败: Excel 文件超出安全限制");
        assert!(mapped.suggestion.contains("performance"));
    }
}
