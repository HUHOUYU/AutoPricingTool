mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn checked_in_config_compiles_all_regex_rules() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("config")
            .join("extract_rules.json");

        let config = load_config(&path).expect("checked-in extraction config must be valid");
        assert!(config.pricing_fields.order.contains_key("sku"));
        assert!(
            config
                .pricing_fields
                .pricing
                .contains_key("quantity_one_price")
        );
        assert_eq!(config.pricing.country_identity.len(), 3);
    }

    #[test]
    fn legacy_output_names_remain_compatible() {
        let config: Config = serde_json::from_str(
            r#"{
                "output": {
                    "max_sku_groups": 3,
                    "summary_flush_files": 60,
                    "summary_flush_rows": 100000
                }
            }"#,
        )
        .expect("legacy output names must remain compatible");

        assert_eq!(config.output.extracted_sku_group_limit, 3);
        assert_eq!(config.output.summary_buffer_file_limit, 60);
        assert_eq!(config.output.summary_buffer_row_limit, 100_000);
    }

    #[test]
    fn country_identity_defaults_to_all_supported_fields() {
        let config: Config = serde_json::from_str("{}").expect("empty config must use defaults");

        assert!(config.pricing.uses_country_identity(CountryIdentity::Iso2));
        assert!(
            config
                .pricing
                .uses_country_identity(CountryIdentity::English)
        );
        assert!(
            config
                .pricing
                .uses_country_identity(CountryIdentity::Chinese)
        );
    }

    #[test]
    fn order_core_header_range_accepts_zero_one_or_two_non_empty_headers() {
        for document in [
            r#"{}"#,
            r#"{"pricing":{"order_core_header_range":[]}}"#,
            r#"{"pricing":{"order_core_header_range":["Total Price"]}}"#,
            r#"{"pricing":{"order_core_header_range":["Name","Total Price"]}}"#,
        ] {
            let mut config: Config = serde_json::from_str(document).expect("valid range config");
            prepare_config(&mut config).expect("range config must validate");
        }
    }

    #[test]
    fn order_core_header_range_rejects_empty_or_excess_headers() {
        for document in [
            r#"{"pricing":{"order_core_header_range":[""]}}"#,
            r#"{"pricing":{"order_core_header_range":["A","B","C"]}}"#,
        ] {
            let mut config: Config = serde_json::from_str(document).expect("range JSON must parse");
            let error = prepare_config(&mut config).expect_err("invalid range must fail");
            assert!(format!("{error:#}").contains("pricing.order_core_header_range"));
        }
    }

    #[test]
    fn single_shipment_price_marker_aliases_use_defaults_when_missing() {
        let config: Config = serde_json::from_str("{}").expect("old config must use defaults");

        assert_eq!(
            config.pricing.single_shipment_price_marker_aliases,
            ["单独发货价格", "单独发货价", "单独发货报价"]
        );
    }

    #[test]
    fn single_shipment_price_marker_aliases_can_be_disabled() {
        let config: Config =
            serde_json::from_str(r#"{"pricing":{"single_shipment_price_marker_aliases":[]}}"#)
                .expect("empty marker alias list must parse");

        assert!(
            config
                .pricing
                .single_shipment_price_marker_aliases
                .is_empty()
        );
    }

    #[test]
    fn single_shipment_matching_is_disabled_for_old_configs() {
        let config: Config = serde_json::from_str("{}").expect("old config must use defaults");

        assert!(!config.pricing.single_shipment_matching_enabled);
        assert_eq!(
            config.pricing.single_shipment_match_fields,
            [
                SingleShipmentMatchField::RecipientName,
                SingleShipmentMatchField::Phone,
                SingleShipmentMatchField::PostalCode,
            ]
        );
    }

    #[test]
    fn enabled_single_shipment_matching_requires_two_distinct_fields() {
        let mut config: Config = serde_json::from_str(
            r#"{
                "pricing": {
                    "single_shipment_matching_enabled": true,
                    "single_shipment_match_fields": ["recipient_name", "recipient_name"]
                }
            }"#,
        )
        .expect("supported fields must parse");

        let error = prepare_config(&mut config).expect_err("duplicate fields must not be enough");

        assert!(error.to_string().contains("至少需要两个不同字段"));
    }

    #[test]
    fn rejects_pricing_field_rules_that_the_processor_does_not_consume() {
        let mut config: Config = serde_json::from_str(
            r#"{
                "pricing_fields": {
                    "order": {
                        "shipping_method": {"header_aliases": ["Shipping method"]}
                    }
                }
            }"#,
        )
        .expect("field rule document must parse");

        let error = prepare_config(&mut config).expect_err("unused field must be rejected");

        assert!(
            error
                .to_string()
                .contains("pricing_fields.order.shipping_method")
        );
    }

    #[test]
    fn country_identity_accepts_a_supported_subset() {
        let mut config: Config =
            serde_json::from_str(r#"{"pricing":{"country_identity":["english"]}}"#)
                .expect("supported identity must parse");

        prepare_config(&mut config).expect("supported identity must validate");
        assert!(!config.pricing.uses_country_identity(CountryIdentity::Iso2));
        assert!(
            config
                .pricing
                .uses_country_identity(CountryIdentity::English)
        );
        assert!(
            !config
                .pricing
                .uses_country_identity(CountryIdentity::Chinese)
        );
    }

    #[test]
    fn country_identity_rejects_an_empty_list() {
        let mut config: Config = serde_json::from_str(r#"{"pricing":{"country_identity":[]}}"#)
            .expect("empty identity list is valid JSON");

        let error = prepare_config(&mut config).expect_err("empty identity list must fail");
        assert!(format!("{error:#}").contains("pricing.country_identity 至少需要保留一个"));
    }

    #[test]
    fn country_identity_rejects_unknown_values() {
        let error = serde_json::from_str::<Config>(r#"{"pricing":{"country_identity":["iso3"]}}"#)
            .expect_err("unknown identity must fail");

        let message = error.to_string();
        assert!(message.contains("iso3"));
        assert!(message.contains("iso2"));
        assert!(message.contains("english"));
        assert!(message.contains("chinese"));
    }

    #[test]
    fn rejects_invalid_field_regex_instead_of_silently_ignoring_it() {
        let mut config: Config = serde_json::from_str(
            r#"{
              "fields": {
                "order_number": {
                  "header_aliases": ["订单号"],
                  "value_patterns": ["["]
                }
              }
            }"#,
        )
        .expect("test config must be valid JSON");

        let error = prepare_config(&mut config).expect_err("invalid regex must fail config load");
        assert!(format!("{error:#}").contains("fields.order_number.value_patterns[0]"));
    }

    #[test]
    fn rejects_invalid_pricing_field_regex_with_full_path() {
        let mut config: Config = serde_json::from_str(
            r#"{
              "pricing_fields": {
                "order": {
                  "sku": {
                    "header_aliases": ["SKU"],
                    "value_patterns": ["["]
                  }
                }
              }
            }"#,
        )
        .expect("test config must be valid JSON");

        let error = prepare_config(&mut config).expect_err("invalid regex must fail config load");
        assert!(format!("{error:#}").contains("pricing_fields.order.sku.value_patterns[0]"));
    }
}
