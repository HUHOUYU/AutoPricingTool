mod tests {
    use super::*;
    use crate::config::{FilenameDatePattern, SpecialFilename};

    fn parse_dates(text: &str) -> Option<String> {
        parse_filename_date(text, &FilenameRules::default()).map(|(dates, _, _)| dates)
    }

    #[test]
    fn parses_configured_filename_date_formats() {
        assert_eq!(
            parse_dates("Practs-export-0626"),
            Some("2026.06.26".to_string())
        );
        assert_eq!(
            parse_dates("Practs-export-06.26"),
            Some("2026.06.26".to_string())
        );
        assert_eq!(
            parse_dates("Practs-export-06.26-06.30"),
            Some("2026.06.26-2026.06.30".to_string())
        );
        assert_eq!(
            parse_dates("PYJ-LIP ORDER JAN-01"),
            Some("2026.01.01".to_string())
        );
        assert_eq!(parse_dates("Order-020626"), Some("2026.06.02".to_string()));
        assert_eq!(
            parse_dates("Michelle Orders 6.15.2026"),
            Some("2026.06.15".to_string())
        );
        assert_eq!(
            parse_dates("CEL order 6-JUN1"),
            Some("2026.06.01".to_string())
        );
    }

    #[test]
    fn ignores_embedded_digit_neighbors() {
        assert_eq!(parse_dates("Zyn 6.213 #1503-#11510"), None);
        assert_eq!(parse_dates("Brand 06.21-06.303"), None);
    }

    #[test]
    fn normalizes_filename_with_date_and_extra_keyword() {
        let config = Config::default();
        let standard_name = normalize_source_filename(
            Path::new("C:/orders/Brand orders_export 06.26.xlsx"),
            &config,
        );

        assert_eq!(standard_name, "Brand__2026.06.26__orders_export.xlsx");
    }

    #[test]
    fn normalizes_order_prefix_date_name_and_order_marker() {
        let config = Config::default();
        let standard_name =
            normalize_source_filename(Path::new("C:/orders/order_6.1 Murtaza #1013.xlsx"), &config);

        assert_eq!(standard_name, "Murtaza__2026.06.01__#1013.xlsx");
    }

    #[test]
    fn splits_order_marker_without_date_from_name() {
        let config = Config::default();
        let standard_name =
            normalize_source_filename(Path::new("C:/orders/Laams #1101-1105.xlsx"), &config);

        assert_eq!(standard_name, "Laams__无日期__#1101-1105.xlsx");
    }

    #[test]
    fn configured_named_date_group_keeps_brand_prefix() {
        let mut config = Config::default();
        let pattern = FilenameDatePattern {
            _name: "known_brand_month_day_compact".to_string(),
            regex: r"(?i)(?:Voldara|Georgi|Meloa|Somnora)[-_\s]*(?:orders?[-_\s]*)?(?P<date>(?P<m>0[1-9]|1[0-2])(?P<d>0[1-9]|[12]\d|3[01]))".to_string(),
            output: "{year}.{m}.{d}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        };
        let regex = Regex::new(&pattern.regex).expect("test regex must compile");
        config.filename_rules.date_patterns = vec![pattern];
        config.filename_rules.compiled_date_patterns = vec![(0, regex)];

        let standard_name =
            normalize_source_filename(Path::new("C:/orders/Voldara-0610.xlsx"), &config);

        assert_eq!(standard_name, "Voldara__2026.06.10__无额外信息.xlsx");
    }

    #[test]
    fn uses_configured_special_filename_rule() {
        let mut config = Config::default();
        config.filename_rules.special_filenames.insert(
            "VIP Source".to_string(),
            SpecialFilename {
                name: "VIP Brand".to_string(),
                dates: "2026.07.01".to_string(),
                extra: "manual".to_string(),
            },
        );

        let standard_name =
            normalize_source_filename(Path::new("C:/orders/VIP Source.xlsx"), &config);

        assert_eq!(standard_name, "VIP Brand__2026.07.01__manual.xlsx");
    }

    #[test]
    fn rejects_invalid_month_and_day_values() {
        assert_eq!(parse_dates("Brand 13.01"), None);
        assert_eq!(parse_dates("Brand 12.32"), None);
        assert_eq!(parse_dates("Brand 02.31"), None);
        assert_eq!(parse_dates("Brand FOO-01"), None);
    }

    #[test]
    fn detects_manual_confirmation_patterns_case_insensitively() {
        let mut config = Config::default();
        config.filename_rules.manual_confirm_patterns = vec!["need[-_ ]?check".to_string()];

        assert!(requires_manual_confirmation(
            Path::new("C:/orders/NEED_check.xlsx"),
            &config
        ));
        assert!(!requires_manual_confirmation(
            Path::new("C:/orders/Brand.xlsx"),
            &config
        ));
    }
}
