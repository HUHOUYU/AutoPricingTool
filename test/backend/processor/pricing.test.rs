mod tests {
    use super::*;
    use regex::Regex;

    fn test_build_writeback_rows(
        sheet: &SheetData,
        mapping: &PriceCheckMapping,
        candidates: &HashMap<usize, MatchedRowCandidate>,
    ) -> Vec<PriceWritebackRow> {
        let resolved_quantities = resolve_order_quantities(sheet, mapping, &Config::default());
        build_writeback_rows(sheet, mapping, candidates, &resolved_quantities)
    }

    #[test]
    fn configured_alias_order_breaks_header_ties() {
        let preferred_first = FieldRule {
            header_aliases: vec!["Stock code".to_string(), "SKU".to_string()],
            ..FieldRule::default()
        };
        let sku_first = FieldRule {
            header_aliases: vec!["SKU".to_string(), "Stock code".to_string()],
            ..FieldRule::default()
        };

        assert!(
            configured_header_score("Stock code", Some(&preferred_first), &[])
                > configured_header_score("Stock code", Some(&sku_first), &[])
        );
    }

    #[test]
    fn configured_value_pattern_disambiguates_duplicate_headers() {
        let rule = FieldRule {
            header_aliases: vec!["SKU".to_string()],
            value_patterns: vec!["(?i)^[a-z]{2}\\d{6}$".to_string()],
            compiled_value_patterns: vec![Regex::new("(?i)^[a-z]{2}\\d{6}$").unwrap()],
            ..FieldRule::default()
        };
        let sheet = SheetData {
            name: "order".to_string(),
            rows: vec![
                vec![CellValue::string("SKU"), CellValue::string("SKU")],
                vec![CellValue::string("Red shoe"), CellValue::string("AB260001")],
                vec![
                    CellValue::string("Blue shoe"),
                    CellValue::string("AB260002"),
                ],
            ],
        };

        assert_eq!(
            configured_best_column(&sheet, 0, Some(&rule), SKU_ALIASES),
            Some(1)
        );
    }

    #[test]
    fn exact_header_beats_partial_header_with_stronger_content_match_for_all_fields() {
        let value_pattern = Regex::new("^MATCH$").unwrap();
        for exact_header in ["Order number-PY", "SKU-PY", "Qty-PY", "Country-PY"] {
            let partial_header = exact_header.trim_end_matches("-PY");
            let rule = FieldRule {
                header_aliases: vec![exact_header.to_string()],
                value_patterns: vec!["^MATCH$".to_string()],
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
                    vec![CellValue::string("MATCH"), CellValue::string("NO_MATCH")],
                    vec![CellValue::string("MATCH"), CellValue::string("NO_MATCH")],
                ],
            };

            assert_eq!(
                configured_matching_columns(&sheet, 0, Some(&rule), &[])
                    .first()
                    .copied(),
                Some(1),
                "{exact_header} should prefer the exact header"
            );
        }
    }

    #[test]
    fn pricing_country_prefers_code_then_english_then_chinese() {
        let sheet_with_code = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("国家"),
                    CellValue::string("COUNTRY"),
                    CellValue::string("Country Code"),
                ],
                vec![
                    CellValue::string("美国"),
                    CellValue::string("UNITED STATES-hold"),
                    CellValue::string("US-hold"),
                ],
                vec![
                    CellValue::string("英国"),
                    CellValue::string("UNITED KINGDOM"),
                    CellValue::string("GB"),
                ],
            ],
        };
        assert_eq!(
            best_pricing_country_column(&sheet_with_code, 0, None),
            Some(2)
        );

        let sheet_without_code = SheetData {
            name: "price".to_string(),
            rows: sheet_with_code
                .rows
                .iter()
                .map(|row| row[..2].to_vec())
                .collect(),
        };
        assert_eq!(
            best_pricing_country_column(&sheet_without_code, 0, None),
            Some(1)
        );
    }

    #[test]
    fn platform_order_header_is_treated_as_the_single_order_number() {
        let mut config = Config::default();
        config.pricing_fields.order.insert(
            "order_number".to_string(),
            FieldRule {
                header_aliases: vec!["平台订单号".to_string()],
                ..FieldRule::default()
            },
        );
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("平台订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("SKU"),
                    CellValue::string("数量"),
                ],
                vec![
                    CellValue::string("ORD-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-1"),
                    CellValue::string("1"),
                ],
            ],
        };

        let candidate =
            infer_order_candidate_with_config(&sheet, &config).expect("order candidate");
        assert_eq!(candidate.business_order_number_column, Some(1));
    }

    #[test]
    fn single_shipment_fields_use_configured_alias_rules() {
        let mut config = Config::default();
        config.pricing.single_shipment_match_fields = vec![
            SingleShipmentMatchField::Phone,
            SingleShipmentMatchField::PostalCode,
        ];
        config.pricing_fields.order.insert(
            "phone".to_string(),
            FieldRule {
                header_aliases: vec!["Tel Custom".to_string()],
                ..FieldRule::default()
            },
        );
        config.pricing_fields.order.insert(
            "postal_code".to_string(),
            FieldRule {
                header_aliases: vec!["Post Custom".to_string()],
                ..FieldRule::default()
            },
        );
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![vec![
                CellValue::string("Tel Custom"),
                CellValue::string("Post Custom"),
            ]],
        };

        let fields = resolve_single_shipment_fields(&sheet, 0, &config, &[], None);

        assert_eq!(fields[0].columns, [1]);
        assert_eq!(fields[0].headers, ["Tel Custom"]);
        assert_eq!(fields[1].columns, [2]);
        assert_eq!(fields[1].headers, ["Post Custom"]);
    }

    #[test]
    fn country_three_fields_are_one_identity() {
        let country = normalize_country_fields("US", "United States", "美国");
        assert_eq!(country.code, "US");
        assert_eq!(country.english, "United States");
        assert_eq!(country.chinese, "美国");
        assert!(!country.conflict);
    }

    #[test]
    fn country_catalog_covers_sheet1_countries_and_business_aliases() {
        assert_eq!(COUNTRY_ALIASES.len(), 254);

        let aruba = normalize_country_fields("", "", "阿鲁巴");
        assert_eq!(
            (
                aruba.code.as_str(),
                aruba.english.as_str(),
                aruba.chinese.as_str()
            ),
            ("AW", "Aruba", "阿鲁巴")
        );

        let united_states = normalize_country_fields("", "America", "");
        assert_eq!(
            (
                united_states.code.as_str(),
                united_states.english.as_str(),
                united_states.chinese.as_str()
            ),
            ("US", "United States", "美国")
        );
    }

    #[test]
    fn country_catalog_covers_current_iso_codes() {
        const CURRENT_ISO_CODES: &str = "\
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ \
BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR \
CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR \
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU \
ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ \
LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ \
MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF \
PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI \
SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR \
TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

        for code in CURRENT_ISO_CODES.split_whitespace() {
            assert!(
                country_lookup(code).is_some(),
                "国家维护表缺少当前 ISO 代码: {code}"
            );
        }
    }

    #[test]
    fn corrected_country_names_keep_legacy_aliases() {
        let cases = [
            ("United Arab Emirates", "AE"),
            ("United Arab Emirates 1", "AE"),
            ("阿联酋", "AE"),
            ("American Samoa", "AS"),
            ("Amercian Samoa", "AS"),
            ("Bangladesh", "BD"),
            ("Bengal", "BD"),
            ("Northern Mariana Islands", "MP"),
            ("Saipan lsland", "MP"),
            ("French Southern Territories", "TF"),
            ("fashunanbulingdi", "TF"),
            ("British Virgin Islands", "VG"),
            ("THE BRITISH VRIGIN ISLANDS", "VG"),
            ("Türkiye", "TR"),
            ("Turkey", "TR"),
        ];

        for (name, expected_code) in cases {
            assert_eq!(
                country_lookup(name).map(|country| country.0),
                Some(expected_code),
                "国家名称或历史别名无法识别: {name}"
            );
        }
    }

    #[test]
    fn country_catalog_rejects_source_placeholders_as_codes() {
        assert!(country_lookup("160").is_none());
        assert!(country_lookup("NULL").is_none());
        assert!(country_lookup("YT_n").is_none());
    }

    #[test]
    fn country_conflict_is_not_silently_resolved() {
        let country = normalize_country_fields("US", "Canada", "美国");
        assert!(country.conflict);
    }

    #[test]
    fn order_country_identity_uses_only_enabled_fields() {
        let english_only = PricingRules {
            country_identity: vec![CountryIdentity::English],
            ..PricingRules::default()
        };
        let country = normalize_order_country_fields("US", "Canada", "美国", &english_only);
        assert_eq!(country.code, "CA");
        assert!(!country.conflict);

        let iso2_only = PricingRules {
            country_identity: vec![CountryIdentity::Iso2],
            ..PricingRules::default()
        };
        let country = normalize_order_country_fields("US", "Canada", "加拿大", &iso2_only);
        assert_eq!(country.code, "US");
        assert!(!country.conflict);

        let chinese_only = PricingRules {
            country_identity: vec![CountryIdentity::Chinese],
            ..PricingRules::default()
        };
        let country = normalize_order_country_fields("US", "Canada", "加拿大", &chinese_only);
        assert_eq!(country.code, "CA");
        assert!(!country.conflict);
    }

    #[test]
    fn quantity_zero_and_invalid_price_are_distinct() {
        assert_eq!(parse_tier("0"), Some(0));
        assert_eq!(parse_price(&CellValue::string("0")), Some(0.0));
        assert_eq!(parse_price(&CellValue::string("/")), None);
        assert_eq!(parse_price(&CellValue::string("未核价")), None);
    }

    #[test]
    fn quantity_headers_accept_compact_units_and_reject_ranges() {
        for (header, expected) in [
            ("1", 1),
            ("2.0", 2),
            ("1 pcs", 1),
            ("2pcs", 2),
            ("3 PC", 3),
            ("4 piece", 4),
            ("5pieces", 5),
            ("6个", 6),
            ("7件", 7),
            ("Qty 8 pcs", 8),
        ] {
            assert_eq!(parse_tier(header), Some(expected), "header: {header}");
        }
        for header in ["1-2", "1~2", "1至2", "pcs1", "one pcs"] {
            assert_eq!(parse_tier(header), None, "header: {header}");
        }
    }

    #[test]
    fn quantity_header_ladder_scores_continuous_columns() {
        let row = vec![
            CellValue::string("SKU"),
            CellValue::string("Country"),
            CellValue::string("1pcs"),
            CellValue::string("2pcs"),
            CellValue::string("4pcs"),
        ];
        let excluded = [0usize, 1usize].into_iter().collect::<HashSet<_>>();
        assert_eq!(numeric_header_ladder_level(&row, &excluded), 2);
    }

    #[test]
    fn order_and_pricing_candidates_are_distinguished_by_fields_and_ladder() {
        let order_sheet = SheetData {
            name: "订单数据".to_string(),
            rows: vec![
                vec![
                    CellValue::string("业务订单号"),
                    CellValue::string("平台订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("英文国家"),
                    CellValue::string("中文国家"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORD-1"),
                    CellValue::string("PLAT-1"),
                    CellValue::string("US"),
                    CellValue::string("United States"),
                    CellValue::string("美国"),
                    CellValue::string("ABC123"),
                    CellValue::string("2"),
                ],
            ],
        };
        let pricing_sheet = SheetData {
            name: "核价表".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1pcs"),
                    CellValue::string("2pcs"),
                    CellValue::string("4pcs"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("9"),
                    CellValue::string("8"),
                ],
            ],
        };

        let order = infer_order_candidate(&order_sheet).expect("order candidate");
        let pricing = infer_pricing_candidate(&pricing_sheet).expect("pricing candidate");
        assert_eq!(order.sheet_name, "订单数据");
        assert_eq!(order.sku_qty_pairs.len(), 1);
        assert_eq!(
            (
                order.sku_qty_pairs[0].sku_column,
                order.sku_qty_pairs[0].qty_column,
                order.sku_qty_pairs[0].direct_quantity,
            ),
            (6, 7, true)
        );
        assert_eq!(order.country_coverage, 1.0);
        assert_eq!(pricing.sheet_name, "核价表");
        assert_eq!(
            pricing
                .tier_columns
                .iter()
                .map(|tier| tier.quantity)
                .collect::<Vec<_>>(),
            vec![1, 2, 4]
        );
        assert!(
            pricing
                .notes
                .iter()
                .any(|note| note.contains("连续数量档位"))
        );
    }

    #[test]
    fn header_template_matches_before_candidate_fallback() {
        let order_sheet = SheetData {
            name: "Incoming Order".to_string(),
            rows: vec![vec![
                CellValue::string("业务订单号"),
                CellValue::string("平台订单号"),
                CellValue::string("国家二字码"),
                CellValue::string("英文国家"),
                CellValue::string("中文国家"),
                CellValue::string("SKU"),
                CellValue::string("Qty"),
            ]],
        };
        let pricing_sheet = SheetData {
            name: "Incoming Price".to_string(),
            rows: vec![vec![
                CellValue::string("SKU"),
                CellValue::string("Country"),
                CellValue::string("1pcs"),
                CellValue::string("2pcs"),
            ]],
        };
        let order = OrderSheetCandidate {
            sheet_name: order_sheet.name.clone(),
            header_row: 1,
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 6,
                qty_column: 7,
                merged_qty_column: 8,
                direct_quantity: false,
                sku_header: "SKU".to_string(),
                qty_header: "Qty".to_string(),
                merged_qty_header: "Merged Qty".to_string(),
            }],
            ..OrderSheetCandidate::default()
        };
        let pricing = PricingSheetCandidate {
            sheet_name: pricing_sheet.name.clone(),
            header_row: 1,
            sku_column: Some(1),
            country_column: Some(2),
            tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1pcs".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 4,
                    header: "2pcs".to_string(),
                },
            ],
            ..PricingSheetCandidate::default()
        };
        let template = HeaderTemplateRecord {
            file_name: "template.xlsx".to_string(),
            mappings: vec![
                ("order_number", "Order", 1, "业务订单号"),
                ("country_code", "Order", 3, "国家二字码"),
                ("sku_detail", "Order", 6, "SKU"),
                ("qty_detail", "Order", 7, "Qty"),
                ("pricing_sku", "Pricing", 1, "SKU"),
                ("pricing_country", "Pricing", 2, "Country"),
                ("price", "Pricing", 3, "1pcs"),
                ("price", "Pricing", 4, "2pcs"),
            ]
            .into_iter()
            .map(
                |(field_key, sheet_name, column, header)| HeaderTemplateFieldMapping {
                    field_key: field_key.to_string(),
                    sheet_name: sheet_name.to_string(),
                    column,
                    header: header.to_string(),
                },
            )
            .collect(),
        };

        let matched = match_header_template(
            &[order_sheet, pricing_sheet],
            &[order],
            &[pricing],
            &[template],
        )
        .expect("template match");
        assert_eq!(matched.0, "template.xlsx");
        assert_eq!(matched.1.order_sheet, "Incoming Order");
        assert_eq!(matched.1.pricing_sheet, "Incoming Price");
        assert_eq!(matched.1.sku_qty_pairs[0].sku_column, 6);
        assert_eq!(matched.1.sku_qty_pairs[0].qty_column, 7);
        assert!(matched.1.sku_qty_pairs[0].direct_quantity);
        assert_eq!(
            matched
                .1
                .quantity_tier_columns
                .iter()
                .map(|tier| (tier.quantity, tier.column))
                .collect::<Vec<_>>(),
            vec![(1, 3), (2, 4)]
        );
    }

    #[test]
    fn duplicate_sku_quantity_columns_are_ignored_for_valid_order_rows() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("SKU"),
                    CellValue::string("产品总数"),
                    CellValue::string("SKU"),
                    CellValue::string("产品总数"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("ABC-1"),
                    CellValue::string("2"),
                    CellValue::string("ABC-1"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("CA"),
                    CellValue::string("ABC-2"),
                    CellValue::string("1"),
                    CellValue::string("ABC-2"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("total"),
                    CellValue::string("3"),
                ],
            ],
        };

        let candidate = infer_order_candidate(&sheet).expect("order candidate");
        assert_eq!(candidate.sku_qty_pairs.len(), 1);
        assert_eq!(candidate.sku_qty_pairs[0].sku_column, 5);
        assert_eq!(candidate.sku_qty_pairs[0].qty_column, 4);
        assert!(candidate.notes.iter().any(|note| note.contains("完全重复")));
    }

    #[test]
    fn sku_quantity_pairing_uses_nearest_columns_locks_both_headers_and_prefers_right() {
        let header = vec![
            CellValue::string("SKU 1"),
            CellValue::string("Qty 1"),
            CellValue::string("备用"),
            CellValue::string("Qty 2"),
            CellValue::string("SKU 2"),
        ];

        let pairs = pair_sku_qty_columns(&header, &[0, 4], &[1, 3]);

        assert_eq!(
            pairs
                .iter()
                .map(|pair| (pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>(),
            vec![(5, 4), (1, 2)]
        );

        let overlapping_roles = pair_sku_qty_columns(&header, &[0, 2], &[1, 2]);
        assert_eq!(
            overlapping_roles
                .iter()
                .map(|pair| (pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>(),
            vec![(3, 2)]
        );
    }

    #[test]
    fn sku_quantity_pairing_falls_back_only_to_the_left_and_freezes_columns() {
        let header = vec![
            CellValue::string("Qty"),
            CellValue::string("Qty"),
            CellValue::string("SKU 1"),
            CellValue::string("SKU 2"),
            CellValue::string("SKU 3"),
            CellValue::string("Qty"),
        ];

        let pairs = pair_sku_qty_columns(&header, &[2, 3, 4], &[0, 1, 5]);

        assert_eq!(
            pairs
                .iter()
                .map(|pair| (pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>(),
            vec![(5, 6), (4, 1), (3, 2)]
        );
        let selected_columns = pairs
            .iter()
            .flat_map(|pair| [pair.sku_column, pair.qty_column])
            .collect::<HashSet<_>>();
        assert_eq!(selected_columns.len(), pairs.len() * 2);

        let right_crossing = pair_sku_qty_columns(&header, &[0, 2], &[3]);
        assert_eq!(
            right_crossing
                .iter()
                .map(|pair| (pair.sku_column, pair.qty_column))
                .collect::<Vec<_>>(),
            vec![(3, 4)]
        );
    }

    #[test]
    fn highest_sku_group_uses_quantity_before_sku_in_reference_layout() {
        let header = vec![
            CellValue::string("SKU"),
            CellValue::string("Qty"),
            CellValue::string("SKU"),
            CellValue::string("Qty"),
        ];

        let detected_pairs = pair_sku_qty_columns(&header, &[0, 2], &[1, 3]);
        let pairs = highest_sku_quantity_group(&header, &detected_pairs, &[1, 3]);

        assert_eq!(
            pairs
                .iter()
                .map(|pair| (pair.qty_column, pair.sku_column, pair.merged_qty_column,))
                .collect::<Vec<_>>(),
            vec![(2, 3, 4)]
        );
    }

    #[test]
    fn sku_quantity_pairing_does_not_fall_back_to_following_quantity() {
        let header = vec![CellValue::string("SKU"), CellValue::string("Qty")];

        let detected_pairs = pair_sku_qty_columns(&header, &[0], &[1]);
        assert!(highest_sku_quantity_group(&header, &detected_pairs, &[1]).is_empty());
    }

    #[test]
    fn sku_quantity_group_requires_merged_quantity_after_sku() {
        let header = vec![CellValue::string("Qty"), CellValue::string("SKU")];

        let detected_pairs = pair_sku_qty_columns(&header, &[1], &[0]);
        assert!(highest_sku_quantity_group(&header, &detected_pairs, &[0]).is_empty());
    }

    #[test]
    fn pricing_candidate_supports_item_number_and_non_contiguous_tiers() {
        let sheet = SheetData {
            name: "Price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item  No. "),
                    CellValue::string("Country"),
                    CellValue::string("Standard"),
                    CellValue::string("Standard"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("1个"),
                    CellValue::string("5个"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("8"),
                ],
            ],
        };
        let pricing = infer_pricing_candidate(&sheet).expect("pricing candidate");
        assert_eq!(pricing.quantity_header_row, Some(2));
        assert_eq!(
            pricing
                .tier_columns
                .iter()
                .map(|tier| tier.quantity)
                .collect::<Vec<_>>(),
            vec![1, 5]
        );
    }

    #[test]
    fn pricing_candidate_skips_blank_row_before_quantity_tiers() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item No."),
                    CellValue::string("Country"),
                    CellValue::string("Dropshipping price"),
                    CellValue::string(""),
                ],
                vec![CellValue::Empty; 4],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("0"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("0"),
                    CellValue::string("8.5"),
                ],
            ],
        };

        let pricing = infer_pricing_candidate(&sheet).expect("pricing candidate");
        assert_eq!(pricing.quantity_header_row, Some(3));
        assert_eq!(
            pricing
                .tier_columns
                .iter()
                .map(|tier| tier.quantity)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn pricing_candidate_supports_quantity_one_price_column() {
        let sheet = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item No."),
                    CellValue::string("Country"),
                    CellValue::string("Product shipping VAT tax"),
                    CellValue::string("Shipping Country"),
                ],
                vec![
                    CellValue::string("QY2600223"),
                    CellValue::string("US"),
                    CellValue::string("112"),
                    CellValue::string("4PX"),
                ],
            ],
        };

        let pricing = infer_pricing_candidate(&sheet).expect("pricing candidate");
        assert_eq!(pricing.quantity_header_row, None);
        assert_eq!(pricing.tier_columns.len(), 1);
        assert_eq!(pricing.tier_columns[0].quantity, 1);
        assert_eq!(pricing.tier_columns[0].column, 3);
    }

    #[test]
    fn wide_shopline_order_sheet_requires_quantity_before_sku() {
        let mut header = vec![CellValue::Empty; 126];
        header[0] = CellValue::string("Order number");
        header[9] = CellValue::string("Product's SKU (sales number)");
        header[29] = CellValue::string("Quantity");
        header[92] = CellValue::string("Country/Region");
        let mut row = vec![CellValue::Empty; 126];
        row[0] = CellValue::string("GC-SL-15132");
        row[9] = CellValue::string("QY2600223");
        row[29] = CellValue::string("1");
        row[92] = CellValue::string("US");
        let sheet = SheetData {
            name: "Sheet1".to_string(),
            rows: vec![header, row],
        };

        let order = infer_order_candidate(&sheet).expect("order candidate");
        assert!(order.sku_qty_pairs.is_empty());
        assert_eq!(order.country_code_column, Some(93));
    }

    #[test]
    fn order_candidate_does_not_pair_product_name_with_following_quantity() {
        let mut header = vec![CellValue::Empty; 100];
        header[0] = CellValue::string("Order number");
        header[8] = CellValue::string("Product name");
        header[29] = CellValue::string("Quantity");
        header[92] = CellValue::string("Country/Region");
        let mut row = vec![CellValue::Empty; 100];
        row[0] = CellValue::string("GC-SL-15132");
        row[8] = CellValue::string("Cordless snow blower");
        row[29] = CellValue::string("1");
        row[92] = CellValue::string("US");
        let sheet = SheetData {
            name: "Sheet1 (2)".to_string(),
            rows: vec![header, row],
        };

        let order = infer_order_candidate(&sheet).expect("order candidate");
        assert!(order.sku_qty_pairs.is_empty());
    }

    #[test]
    fn quantity_one_price_index_requires_the_same_full_sku() {
        let sheet = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Item No."),
                    CellValue::string("Country"),
                    CellValue::string("Product shipping VAT tax"),
                ],
                vec![
                    CellValue::string("QY2600223"),
                    CellValue::string("US"),
                    CellValue::string("112"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "Product shipping VAT tax".to_string(),
            }],
            ..PriceCheckMapping::default()
        };

        let index = build_price_index(&sheet, &mapping, &PricingRules::default());
        let lookup = index.lookup("US", "CORDLESSSNOWBLOWER", 1);
        assert_eq!(lookup.status, "SKU不存在");
        assert_eq!(index.lookup("US", "QY2600223", 1).price, Some(112.0));
    }

    #[test]
    fn quantity_one_price_rule_prefers_new_name_and_supports_legacy_name() {
        let mut config = Config::default();
        config.pricing_fields.pricing.insert(
            "fixed_price".to_string(),
            FieldRule {
                header_aliases: vec!["旧名称".to_string()],
                ..FieldRule::default()
            },
        );
        config.pricing_fields.pricing.insert(
            "quantity_one_price".to_string(),
            FieldRule {
                header_aliases: vec!["新名称".to_string()],
                ..FieldRule::default()
            },
        );

        assert_eq!(
            quantity_one_price_rule(&config)
                .and_then(|rule| rule.header_aliases.first())
                .map(String::as_str),
            Some("新名称")
        );

        config
            .pricing_fields
            .pricing
            .shift_remove("quantity_one_price");
        assert_eq!(
            quantity_one_price_rule(&config)
                .and_then(|rule| rule.header_aliases.first())
                .map(String::as_str),
            Some("旧名称")
        );
    }

    #[test]
    fn pricing_country_routes_require_the_same_original_value() {
        // 国家列整格匹配：UNITED STATES-hold 不是「美国+物流 hold」，不能识别为 US
        let hold_only = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("UNITED STATES-hold"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let index_hold = build_price_index(&hold_only, &mapping, &PricingRules::default());
        assert_eq!(
            index_hold.lookup("US", "ABC123", 1).status,
            "国家路由不存在",
            "核价表原值不能被程序转换为标准国家代码"
        );
        assert_eq!(
            index_hold.lookup("UNITED STATES-hold", "ABC123", 1).price,
            Some(9.0)
        );

        // 英文国名同样只接受订单原值精确路由，不再转换为 US。
        let formal = SheetData {
            name: "price".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("UNITED STATES"),
                    CellValue::string("8.79"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("UNITED STATES-hold"),
                    CellValue::string("9"),
                ],
            ],
        };
        let index_formal = build_price_index(&formal, &mapping, &PricingRules::default());
        assert_eq!(
            index_formal.lookup("US", "ABC123", 1).status,
            "国家路由不存在"
        );
        assert_eq!(
            index_formal.lookup("UNITED STATES", "ABC123", 1).price,
            Some(8.79),
            "订单与核价表国家原值一致时应命中"
        );
    }

    #[test]
    fn exact_country_route_wins_without_standard_country_fallback() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("AL2500463-LA1-5"),
                    CellValue::string(" FR-D "),
                    CellValue::string("4.39"),
                    CellValue::string("5.19"),
                ],
                vec![
                    CellValue::string("AL2500463-LA1-5"),
                    CellValue::string("FR"),
                    CellValue::string("1.5"),
                    CellValue::string("3"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 4,
                    header: "2".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping, &PricingRules::default());

        let fairtex_price = index
            .lookup_routes(
                &["fr-d".to_string(), "FRANCE".to_string(), "法国".to_string()],
                "AL2500463-LA1-5",
                2,
            )
            .price
            .expect("FR-D quantity 2 price");
        assert_eq!(fairtex_price, 5.19);
        assert!((fairtex_price + 3.5 - 8.69).abs() < PRICE_DIFFERENCE_ZERO_EPSILON);
        assert_eq!(
            index
                .lookup_routes(
                    &["FRANCE".to_string(), "法国".to_string()],
                    "AL2500463-LA1-5",
                    2,
                )
                .status,
            "国家路由不存在"
        );
    }

    #[test]
    fn existing_country_route_does_not_fallback_on_sku_or_tier_failure() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("OTHER-SKU"),
                    CellValue::string("FR-D"),
                    CellValue::string("4.39"),
                    CellValue::string("5.19"),
                ],
                vec![
                    CellValue::string("TARGET-SKU"),
                    CellValue::string("FR"),
                    CellValue::string("1.5"),
                    CellValue::string("3"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 4,
                    header: "2".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping, &PricingRules::default());

        assert_eq!(
            index
                .lookup_routes(&["FR-D".to_string()], "TARGET-SKU", 2)
                .status,
            "SKU不存在"
        );
        assert_eq!(
            index
                .lookup_routes(&["FR-D".to_string()], "OTHER-SKU", 4)
                .status,
            "数量档位不存在"
        );
    }

    #[test]
    fn pricing_matrix_without_order_fields_is_not_an_order_candidate() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1pcs"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                ],
            ],
        };
        assert!(infer_order_candidate(&sheet).is_none());
        assert!(infer_pricing_candidate(&sheet).is_some());
    }

    #[test]
    fn sku_normalization_keeps_the_full_sku() {
        assert_eq!(normalize_sku(" BK2600241-BEGI "), "BK2600241-BEGI");
        assert_eq!(normalize_sku(" abc 01 "), "ABC01");
    }

    #[test]
    fn aggregates_same_order_sku_and_quantity() {
        let country = normalize_country_fields("US", "United States", "美国");
        let line = |quantity: f64, source_row: usize| OrderLine {
            business_order_number: "ORDER-1".to_string(),
            country: country.clone(),
            single_shipment: false,
            original_sku: "ABC123-RED".to_string(),
            matched_sku: "ABC123-RED".to_string(),
            quantity,
            original_price: Some(10.0),
            source_sheet: "订单".to_string(),
            source_row,
            sku_pair_priority: 0,
        };
        let rows = aggregate_lines(&[line(1.0, 2), line(2.0, 3)]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].total_quantity, 3.0);
        assert_eq!(rows[0].source_rows, vec![2, 3]);
    }

    #[test]
    fn mapping_validation_preserves_unmatched_row_details() {
        let mapping = PriceCheckMapping {
            sku_qty_pairs: vec![SkuQtyPair {
                qty_column: 10,
                sku_column: 11,
                merged_qty_column: 12,
                ..SkuQtyPair::default()
            }],
            ..PriceCheckMapping::default()
        };
        let lines = vec![OrderLine {
            business_order_number: "ORDER-1".to_string(),
            country: normalize_country_fields("US", "United States", "美国"),
            single_shipment: false,
            original_sku: "TC2500348".to_string(),
            matched_sku: "TC2500348".to_string(),
            quantity: 4.0,
            original_price: Some(12.0),
            source_sheet: "订单".to_string(),
            source_row: 37,
            sku_pair_priority: 0,
        }];

        let issues = unmatched_price_issues(&PriceIndex::default(), &mapping, &lines);

        assert_eq!(
            issues,
            vec![UnmatchedPriceIssue {
                source_row: 37,
                sku_column: 11,
                sku: "TC2500348".to_string(),
                country: "US / UNITED STATES / 美国".to_string(),
                quantity: 4.0,
                reason: "国家路由不存在：核价 Sheet  没有国家路由 [US / UNITED STATES / 美国]"
                    .to_string(),
            }]
        );
    }

    #[test]
    fn order_lines_use_only_the_highest_scoring_pair_and_apply_sku_multiplier() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("Country"),
                    CellValue::string("低分 SKU"),
                    CellValue::string("低分 Qty"),
                    CellValue::string("高分 SKU"),
                    CellValue::string("高分 Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-A*2"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let (lines, exceptions, _) = read_order_lines(&sheet, &mapping, &Config::default());

        assert!(exceptions.is_empty());
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].matched_sku, "SKU-A");
        assert_eq!(lines[0].quantity, 2.0);
        assert_eq!(lines[0].sku_pair_priority, 1);
    }

    #[test]
    fn writeback_uses_the_highest_priority_successful_sku_group() {
        let mut candidates = HashMap::new();
        let item = |priority| AggregatedOrderSku {
            source_assignments: vec![SourceAssignment {
                source_row: 2,
                sku_pair_priority: priority,
            }],
            ..AggregatedOrderSku::default()
        };

        record_matched_candidates(&mut candidates, &item(2), 30.0);
        record_matched_candidates(&mut candidates, &item(0), 10.0);
        record_matched_candidates(&mut candidates, &item(1), 20.0);

        let selected = candidates.get(&2).expect("matched candidate");
        assert_eq!(selected.sku_pair_priority, 0);
        assert_eq!(selected.pricing_price, 10.0);
    }

    #[test]
    fn matched_group_writes_group_price_once_and_zero_to_merged_rows() {
        let item = AggregatedOrderSku {
            source_assignments: vec![
                SourceAssignment {
                    source_row: 3,
                    sku_pair_priority: 0,
                },
                SourceAssignment {
                    source_row: 2,
                    sku_pair_priority: 0,
                },
            ],
            ..AggregatedOrderSku::default()
        };
        let mut candidates = HashMap::new();

        record_matched_candidates(&mut candidates, &item, 25.0);

        assert_eq!(
            candidates.get(&2).map(|value| value.pricing_price),
            Some(25.0)
        );
        assert_eq!(
            candidates.get(&3).map(|value| value.pricing_price),
            Some(0.0)
        );
    }

    #[test]
    fn writeback_uses_paired_quantity_and_calculates_amount_difference() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string(" ORDER-1 "),
                    CellValue::string("INVALID"),
                    CellValue::string("1"),
                    CellValue::string("INVALID"),
                    CellValue::string("12"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string(""),
                    CellValue::string("1"),
                    CellValue::string(""),
                    CellValue::string("8"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-2"),
                    CellValue::string("1"),
                    CellValue::string("SKU-2"),
                    CellValue::string("20"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string("SKU-3"),
                    CellValue::string("1"),
                    CellValue::string("SKU-3"),
                    CellValue::string("6"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-4"),
                    CellValue::string("1"),
                    CellValue::string("SKU-4"),
                    CellValue::string("9"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(5),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };
        let candidates = HashMap::from([(
            4,
            MatchedRowCandidate {
                sku_pair_priority: 1,
                pricing_price: 18.0,
            },
        )]);

        let rows = test_build_writeback_rows(&sheet, &mapping, &candidates);

        assert_eq!(
            rows.iter()
                .map(|row| (row.source_row, row.quantity))
                .collect::<Vec<_>>(),
            vec![(2, Some(1)), (3, None), (4, Some(1)), (6, Some(1))]
        );
        assert!(rows.iter().all(|row| row.source_row != 5));
        assert!(!rows[0].matched);
        assert_eq!(rows[2].sku_pair_priority, Some(1));
        assert_eq!(rows[2].pricing_price, Some(18.0));
        assert_eq!(rows[2].price_difference, Some(-2.0));
        assert!(!rows[3].matched);
        assert_eq!(rows[3].pricing_price, None);
        assert_eq!(rows[3].price_difference, None);
    }

    #[test]
    fn writeback_groups_quantity_by_order_number_and_sku() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("SKU-B"),
                    CellValue::string("1"),
                    CellValue::string("SKU-B"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("SKU-B"),
                    CellValue::string("1"),
                    CellValue::string("SKU-B"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("SKU-C"),
                    CellValue::string("1"),
                    CellValue::string("SKU-C"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(5),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let rows = test_build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![Some(3), Some(0), Some(0), Some(2), Some(0), Some(1)]
        );
    }

    #[test]
    fn compound_sku_aggregates_components_before_calculating_package_quantity() {
        let sheet = SheetData {
            name: "order".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("BEX1072"),
                    CellValue::string("TC2601409"),
                    CellValue::string("1"),
                    CellValue::string("TC2601418+TC2601409*2"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("BEX1072"),
                    CellValue::string("TC2601409"),
                    CellValue::string("1"),
                    CellValue::string("TC2601418+TC2601409*2"),
                    CellValue::string("0"),
                ],
                vec![
                    CellValue::string("BEX1072"),
                    CellValue::string("TC2601418"),
                    CellValue::string("1"),
                    CellValue::string("TC2601418+TC2601409*2"),
                    CellValue::string("0"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    merged_qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let rows = test_build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter()
                .map(|row| (row.quantity, row.quantity_mismatch))
                .collect::<Vec<_>>(),
            vec![(Some(1), false), (Some(0), false), (Some(0), false)]
        );
    }

    #[test]
    fn writeback_compares_calculated_quantity_with_merged_quantity_after_sku() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("数量"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    merged_qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let rows = test_build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter()
                .map(|row| (row.quantity, row.quantity_mismatch))
                .collect::<Vec<_>>(),
            vec![(Some(2), false), (Some(0), true)]
        );
    }

    #[test]
    fn writeback_groups_only_by_the_highest_scoring_sku_pair() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("低分 SKU"),
                    CellValue::string("低分 Qty"),
                    CellValue::string("高分 SKU"),
                    CellValue::string("高分 Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                    CellValue::string("PRICED-SKU"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };
        let candidates = HashMap::from_iter((2..=4).map(|source_row| {
            (
                source_row,
                MatchedRowCandidate {
                    sku_pair_priority: 1,
                    pricing_price: 10.0,
                },
            )
        }));

        let rows = test_build_writeback_rows(&sheet, &mapping, &candidates);

        assert_eq!(
            rows.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![Some(3), Some(0), Some(0)]
        );
    }

    #[test]
    fn sku_multiplier_is_added_to_repeated_base_sku_quantity() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A*2"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    merged_qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let rows = test_build_writeback_rows(&sheet, &mapping, &HashMap::new());

        assert_eq!(
            rows.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![Some(3), Some(0)]
        );
        assert_eq!(
            parse_sku_expression(" sku-a * 2 ")
                .expect("valid expression")
                .components,
            HashMap::from([("SKU-A".to_string(), 2)])
        );
    }

    #[test]
    fn daryll_quantity_cannot_cross_main_sku_and_falls_back_left() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("较早 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("DARYLL-1"),
                    CellValue::string("OTHER"),
                    CellValue::string("1"),
                    CellValue::string("FL2600814*5"),
                    CellValue::string("FL2600814"),
                    CellValue::string("99"),
                ],
                vec![
                    CellValue::string("DARYLL-2"),
                    CellValue::string("OTHER"),
                    CellValue::string("1"),
                    CellValue::string("FL2600913-1*10"),
                    CellValue::string("FL2600913-1*10"),
                    CellValue::string("99"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 6,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let columns =
            quantity_source_columns(&sheet, &mapping, &Config::default()).expect("quantity source");
        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());

        assert_eq!(
            columns,
            QuantitySourceColumns {
                main_sku: 4,
                previous_sku: Some(3),
                quantity: 2,
                direct_quantity: false,
            }
        );
        assert_eq!(
            resolved.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![Some(5), Some(1)]
        );
    }

    #[test]
    fn rows_without_order_number_do_not_participate_in_quantity_calculation() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string(""),
                    CellValue::string(""),
                    CellValue::string("75"),
                    CellValue::string("Total"),
                    CellValue::string("75"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    merged_qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let (lines, exceptions, resolved) = read_order_lines(&sheet, &mapping, &Config::default());

        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].source_row, 2);
        assert_eq!(resolved[0].business_order_number, "ORDER-1");
        assert_eq!(lines.len(), 1);
        assert!(exceptions.is_empty());
    }

    #[test]
    fn pya_and_maka_relationships_use_bounded_quantity_and_component_ratios() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("说明"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("PYA-1"),
                    CellValue::string("TC2501602*3"),
                    CellValue::string("1"),
                    CellValue::string(""),
                    CellValue::string("TC2501602"),
                    CellValue::string("3"),
                ],
                vec![
                    CellValue::string("MAKA-1"),
                    CellValue::string("A"),
                    CellValue::string("4"),
                    CellValue::string(""),
                    CellValue::string("A*4+B"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ERROR-1"),
                    CellValue::string("TC3348-L-4"),
                    CellValue::string("1"),
                    CellValue::string(""),
                    CellValue::string("TC2500348"),
                    CellValue::string(""),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };
        let columns =
            quantity_source_columns(&sheet, &mapping, &Config::default()).expect("quantity source");
        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());

        assert_eq!(columns.quantity, 2);
        assert_eq!(
            resolved.iter().map(|row| row.quantity).collect::<Vec<_>>(),
            vec![Some(3), Some(1), None]
        );
        assert_eq!(
            resolved[2].quantity_issue_context,
            Some(SkuQuantityIssueContext {
                previous_sku_column: 2,
                previous_sku: "TC3348-L-4".to_string(),
                main_sku_column: 5,
                main_sku: "TC2500348".to_string(),
            })
        );
        assert_eq!(
            calculate_related_quantity("TC2501602", "TC2501602*3", 1),
            Ok(3)
        );
        assert_eq!(
            calculate_related_quantity("TC2601361", "TC2601361-01+TC2601361-02", 1),
            Ok(2)
        );
        assert_eq!(calculate_related_quantity("A*4+B", "A", 4), Ok(1));
        assert_eq!(calculate_related_quantity("A*3+B", "A", 1), Ok(1));
        assert_eq!(
            calculate_related_quantity("A+B", "A*2+B", 1),
            Err("SKU关系无法计算: 前一SKU A*2+B 与主要SKU A+B 的组件比例冲突".to_string())
        );
        assert!(calculate_related_quantity("A+B", "C+D", 1).is_err());
    }

    #[test]
    fn single_sku_group_uses_direct_sku_and_quantity_rules() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("国家二字码"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("FR"),
                    CellValue::string("PLAIN-SKU"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("FR"),
                    CellValue::string("PACK-SKU*3"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-3"),
                    CellValue::string("FR"),
                    CellValue::string("A*2+B*3"),
                    CellValue::string("4"),
                ],
            ],
        };
        let candidate = infer_order_candidate(&sheet).expect("order candidate");
        assert_eq!(candidate.sku_qty_pairs.len(), 1);
        assert_eq!(
            (
                candidate.sku_qty_pairs[0].sku_column,
                candidate.sku_qty_pairs[0].qty_column,
                candidate.sku_qty_pairs[0].merged_qty_column,
                candidate.sku_qty_pairs[0].direct_quantity,
            ),
            (3, 4, 4, true)
        );

        let mapping = PriceCheckMapping {
            order_sheet: sheet.name.clone(),
            order_header_row: candidate.header_row,
            business_order_number_column: candidate.business_order_number_column,
            country_code_column: candidate.country_code_column,
            sku_qty_pairs: candidate.sku_qty_pairs,
            ..PriceCheckMapping::default()
        };
        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());
        assert_eq!(
            resolved
                .iter()
                .map(|row| (row.matched_sku.as_str(), row.quantity))
                .collect::<Vec<_>>(),
            vec![
                ("PLAIN-SKU", Some(2)),
                ("PACK-SKU", Some(6)),
                ("A*2+B*3", Some(4)),
            ]
        );
    }

    #[test]
    fn direct_sku_multiplier_rejects_invalid_trailing_multiplier() {
        assert!(resolve_direct_sku_quantity("PACK-SKU*0", 2).is_err());
        assert!(resolve_direct_sku_quantity("PACK-SKU*X", 2).is_err());
        assert!(resolve_direct_sku_quantity("PACK-SKU*2*3", 2).is_err());
        assert_eq!(
            resolve_direct_sku_quantity("A*X+B*0", 2),
            Ok(("A*X+B*0".to_string(), 2))
        );
    }

    #[test]
    fn related_quantity_matches_anchored_sku_segments() {
        assert_eq!(calculate_related_quantity("MR-H", "MR-WARM-H", 1), Ok(1));
        assert_eq!(calculate_related_quantity("MR-H", "MR-IVORY-H", 2), Ok(2));
        assert!(calculate_related_quantity("MR-X-H", "MR-WARM-H", 1).is_err());
        assert!(calculate_related_quantity("MR-H", "XMR-WARM-H", 1).is_err());
        assert!(calculate_related_quantity("MR-H", "MR-WARM-HX", 1).is_err());
    }

    #[test]
    fn quantity_lookup_releases_candidate_freezes_for_the_selected_group() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("Qty"),
                    CellValue::string("较早 SKU"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("7"),
                    CellValue::string("OLD"),
                    CellValue::string("MAIN"),
                    CellValue::string("MAIN"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 2,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 6,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());

        assert_eq!(resolved[0].quantity, Some(7));
        assert_eq!(resolved[0].quantity_error, None);
    }

    #[test]
    fn quantity_lookup_uses_nearest_left_fallback_after_releasing_freezes() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Qty"),
                    CellValue::string("Qty"),
                    CellValue::string("较早 SKU"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("8"),
                    CellValue::string("7"),
                    CellValue::string("OLD"),
                    CellValue::string("MAIN"),
                    CellValue::string("MAIN"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 2,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 1,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());

        assert_eq!(resolved[0].quantity, Some(7));
        assert_eq!(resolved[0].quantity_error, None);
    }

    #[test]
    fn quantity_lookup_never_crosses_the_main_sku_to_the_right() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("较早 SKU"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("Qty"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("OLD"),
                    CellValue::string("MAIN"),
                    CellValue::string("MAIN"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 5,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 5,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    merged_qty_column: 5,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());

        assert_eq!(resolved[0].quantity, None);
        assert_eq!(
            resolved[0].quantity_error.as_deref(),
            Some("前一个 SKU 左侧找不到对应数量列")
        );
    }

    #[test]
    fn absorption_and_merging_are_strictly_isolated_by_order_number() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("A"),
                    CellValue::string("4"),
                    CellValue::string("A*4+B"),
                    CellValue::string("20"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("A"),
                    CellValue::string("2"),
                    CellValue::string("A"),
                    CellValue::string("0"),
                    CellValue::string("0"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("A"),
                    CellValue::string("2"),
                    CellValue::string("A"),
                    CellValue::string("0"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("A"),
                    CellValue::string("4"),
                    CellValue::string("A*4+B"),
                    CellValue::string("20"),
                    CellValue::string("0"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(5),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let (lines, exceptions, resolved) = read_order_lines(&sheet, &mapping, &Config::default());

        assert!(exceptions.is_empty());
        assert_eq!(
            resolved
                .iter()
                .map(|row| (row.quantity, row.absorbed))
                .collect::<Vec<_>>(),
            vec![
                (Some(2), false),
                (Some(0), true),
                (Some(2), false),
                (Some(0), false)
            ]
        );
        assert_eq!(
            lines
                .iter()
                .map(|line| (
                    line.business_order_number.as_str(),
                    line.matched_sku.as_str(),
                    line.quantity
                ))
                .collect::<Vec<_>>(),
            vec![
                ("ORDER-1", "A*4+B", 2.0),
                ("ORDER-2", "A", 2.0),
                ("ORDER-1", "A*4+B", 0.0)
            ]
        );
    }

    #[test]
    fn ambiguous_absorption_leaves_quantity_blank() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("A"),
                    CellValue::string("1"),
                    CellValue::string("A+B"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("A"),
                    CellValue::string("1"),
                    CellValue::string("A+C"),
                    CellValue::string("10"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("A"),
                    CellValue::string("1"),
                    CellValue::string("A"),
                    CellValue::string("0"),
                    CellValue::string(""),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(5),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 6,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };

        let resolved = resolve_order_quantities(&sheet, &mapping, &Config::default());

        assert_eq!(resolved[2].quantity, None);
        assert_eq!(
            resolved[2].quantity_error.as_deref(),
            Some("SKU关系无法计算: 同订单内存在多个可吸收的复合主要 SKU")
        );
    }

    #[test]
    fn pricing_uses_full_compound_sku_and_calculated_quantity_tier() {
        let pricing_sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                    CellValue::string("5"),
                ],
                vec![
                    CellValue::string("FL2600814"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("40"),
                ],
                vec![
                    CellValue::string("A*4+B"),
                    CellValue::string("US"),
                    CellValue::string("25"),
                    CellValue::string("100"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 5,
                    column: 4,
                    header: "5".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&pricing_sheet, &mapping, &PricingRules::default());

        assert_eq!(index.lookup("US", "FL2600814", 5).price, Some(40.0));
        assert_eq!(index.lookup("US", "A*4+B", 1).price, Some(25.0));
        assert_eq!(index.lookup("US", "A", 1).price, None);
    }

    #[test]
    fn financial_price_uses_grouped_quantity_and_difference_uses_total_price() {
        let order_sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("Country"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-A*2"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("18"),
                    CellValue::string("3"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("0"),
                    CellValue::string("0"),
                ],
            ],
        };
        let pricing_sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                    CellValue::string("3"),
                ],
                vec![
                    CellValue::string("SKU-A"),
                    CellValue::string("US"),
                    CellValue::string("10"),
                    CellValue::string("25"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            order_price_column: Some(6),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 7,
                    merged_qty_column: 7,
                    ..SkuQtyPair::default()
                },
            ],
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 3,
                    column: 4,
                    header: "3".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let lines = read_order_lines(&order_sheet, &mapping, &Config::default()).0;
        let aggregated = aggregate_lines(&lines);
        let index = build_price_index(&pricing_sheet, &mapping, &PricingRules::default());
        let lookup = index.lookup("US", "SKU-A", 3);
        let mut candidates = HashMap::new();
        record_matched_candidates(
            &mut candidates,
            &aggregated[0],
            lookup.price.expect("grouped quantity price"),
        );

        let resolved_quantities =
            resolve_order_quantities(&order_sheet, &mapping, &Config::default());
        let rows = build_writeback_rows(&order_sheet, &mapping, &candidates, &resolved_quantities);

        assert_eq!(aggregated[0].total_quantity, 3.0);
        assert_eq!(rows[0].quantity, Some(3));
        assert_eq!(rows[0].pricing_price, Some(25.0));
        assert_eq!(rows[0].price_difference, Some(7.0));
        assert_eq!(rows[1].quantity, Some(0));
        assert_eq!(rows[1].pricing_price, Some(0.0));
        assert_eq!(rows[1].price_difference, Some(0.0));
    }

    #[test]
    fn financial_price_adds_eu_tax_before_comparing_total_price() {
        let order_sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("订单号"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("EU TAX"),
                    CellValue::string("TOTAL Price"),
                    CellValue::string("合并数量"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("1"),
                    CellValue::string("SKU-A"),
                    CellValue::string("3"),
                    CellValue::string("28"),
                    CellValue::string("1"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_header_row: 1,
            business_order_number_column: Some(1),
            order_price_column: Some(6),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 2,
                    qty_column: 3,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 7,
                    merged_qty_column: 7,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };
        let candidates = HashMap::from([(
            2,
            MatchedRowCandidate {
                sku_pair_priority: 1,
                pricing_price: 25.0,
            },
        )]);

        let rows = test_build_writeback_rows(&order_sheet, &mapping, &candidates);

        assert_eq!(rows[0].pricing_price, Some(28.0));
        assert_eq!(rows[0].price_difference, Some(0.0));
    }

    #[test]
    fn near_zero_price_difference_is_written_as_zero() {
        assert_eq!(normalize_price_difference(0.1 + 0.2 - 0.3), 0.0);
    }

    #[test]
    fn exact_tier_supports_zero_and_marks_unavailable_price() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("Shipping"),
                    CellValue::string("0"),
                    CellValue::string("1"),
                    CellValue::string("2"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string(""),
                    CellValue::string("0"),
                    CellValue::string("9.5"),
                    CellValue::string("/"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 0,
                    column: 4,
                    header: "0".to_string(),
                },
                PriceTierColumn {
                    quantity: 1,
                    column: 5,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 6,
                    header: "2".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping, &PricingRules::default());
        assert_eq!(index.lookup("US", "ABC123", 0).status, "matched");
        assert_eq!(index.lookup("US", "ABC123", 0).price, Some(0.0));
        assert_eq!(index.lookup("US", "ABC123", 2).status, "价格不可用");
    }

    #[test]
    fn duplicate_price_key_is_not_silently_selected() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("8"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("9"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping, &PricingRules::default());
        assert_eq!(index.lookup("US", "ABC123", 1).status, "核价键重复");
    }

    #[test]
    fn single_shipment_price_table_is_preferred_with_standard_fallback() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("8"),
                ],
                vec![
                    CellValue::string("DEF456"),
                    CellValue::string("US"),
                    CellValue::string("6"),
                ],
                vec![
                    CellValue::string("单独 发货 报价："),
                    CellValue::string(""),
                    CellValue::string(""),
                ],
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("11"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping, &PricingRules::default());

        assert_eq!(index.lookup("US", "ABC123", 1).price, Some(8.0));
        assert_eq!(
            index
                .lookup_with_single_shipment_preference("US", "ABC123", 1, true)
                .price,
            Some(11.0)
        );
        assert_eq!(
            index
                .lookup_with_single_shipment_preference("US", "DEF456", 1, true)
                .price,
            Some(6.0)
        );
    }

    #[test]
    fn single_shipment_price_marker_requires_an_exact_normalized_alias() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("8"),
                ],
                vec![
                    CellValue::string("备注：单独发货报价"),
                    CellValue::string(""),
                    CellValue::string(""),
                ],
                vec![
                    CellValue::string("单独发货"),
                    CellValue::string(""),
                    CellValue::string(""),
                ],
                vec![
                    CellValue::string("DEF456"),
                    CellValue::string("US"),
                    CellValue::string("6"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let index = build_price_index(&sheet, &mapping, &PricingRules::default());

        assert!(index.single_shipment.is_none());
        assert_eq!(index.lookup("US", "ABC123", 1).price, Some(8.0));
        assert_eq!(index.lookup("US", "DEF456", 1).price, Some(6.0));
    }

    #[test]
    fn empty_single_shipment_price_marker_aliases_disable_section_detection() {
        let sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("ABC123"),
                    CellValue::string("US"),
                    CellValue::string("8"),
                ],
                vec![
                    CellValue::string("单独发货价格"),
                    CellValue::string(""),
                    CellValue::string(""),
                ],
                vec![
                    CellValue::string("DEF456"),
                    CellValue::string("US"),
                    CellValue::string("6"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let pricing_rules = PricingRules {
            single_shipment_price_marker_aliases: Vec::new(),
            ..PricingRules::default()
        };
        let index = build_price_index(&sheet, &mapping, &pricing_rules);

        assert!(index.single_shipment.is_none());
        assert_eq!(index.lookup("US", "ABC123", 1).price, Some(8.0));
        assert_eq!(index.lookup("US", "DEF456", 1).price, Some(6.0));
    }

    #[test]
    fn writeback_edits_override_calculated_values_by_source_row() {
        let mut rows = vec![
            PriceWritebackRow {
                source_row: 2,
                pricing_price: Some(8.0),
                price_difference: Some(1.0),
                quantity: Some(1),
                ..PriceWritebackRow::default()
            },
            PriceWritebackRow {
                source_row: 3,
                pricing_price: Some(6.0),
                price_difference: Some(0.0),
                quantity: Some(2),
                ..PriceWritebackRow::default()
            },
        ];

        apply_writeback_overrides(
            &mut rows,
            &[PricePreviewWritebackRow {
                source_row: 2,
                pricing_price: Some(9.5),
                price_difference: Some(2.5),
                quantity: Some(4),
                quantity_mismatch: false,
                quantity_error: None,
                quantity_issue_context: None,
                used_original_sku_quantity: false,
            }],
        );

        assert_eq!(rows[0].pricing_price, Some(9.5));
        assert_eq!(rows[0].price_difference, Some(2.5));
        assert_eq!(rows[0].quantity, Some(4));
        assert_eq!(rows[1].pricing_price, Some(6.0));
        assert_eq!(rows[1].quantity, Some(2));
    }

    #[test]
    fn mapped_cell_edits_update_text_and_numeric_values_before_pricing() {
        let mut workbook = WorkbookData {
            sheets: vec![SheetData {
                name: "订单".to_string(),
                rows: vec![
                    vec![CellValue::string("SKU"), CellValue::string("数量")],
                    vec![CellValue::string("OLD-1"), CellValue::Int(1)],
                ],
            }],
        };

        apply_cell_edits(
            &mut workbook,
            &[
                PriceCellEdit {
                    sheet_name: "订单".to_string(),
                    row: 2,
                    column: 1,
                    value: "NEW-1".to_string(),
                    numeric: false,
                },
                PriceCellEdit {
                    sheet_name: "订单".to_string(),
                    row: 2,
                    column: 2,
                    value: "3".to_string(),
                    numeric: true,
                },
            ],
        )
        .expect("mapped edits must apply");

        assert_eq!(workbook.sheets[0].rows[1][0].text(), "NEW-1");
        assert_eq!(workbook.sheets[0].rows[1][1].text(), "3");
    }

    #[test]
    fn joint_headers_require_complete_unique_single_sku_order() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Order number"),
                    CellValue::string("Name"),
                    CellValue::string("Phone"),
                    CellValue::string("前一 SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("主要 SKU"),
                    CellValue::string("合并数量"),
                    CellValue::string("Country"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("Alice"),
                    CellValue::string("111"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("2"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("Alice"),
                    CellValue::string("111"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("0"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-2"),
                    CellValue::string("Bob"),
                    CellValue::string("222"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-3"),
                    CellValue::string("Bob"),
                    CellValue::string("222"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-4"),
                    CellValue::string("Carol"),
                    CellValue::string(""),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-5"),
                    CellValue::string("Dan"),
                    CellValue::string("444"),
                    CellValue::string("TC2500348"),
                    CellValue::string("1"),
                    CellValue::string("TC2500348"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
                vec![
                    CellValue::string("ORDER-5"),
                    CellValue::string("Dan"),
                    CellValue::string("444"),
                    CellValue::string("TC2500830"),
                    CellValue::string("1"),
                    CellValue::string("TC2500830"),
                    CellValue::string("1"),
                    CellValue::string("US"),
                ],
            ],
        };
        let mapping = PriceCheckMapping {
            order_sheet: "订单".to_string(),
            order_header_row: 1,
            business_order_number_column: Some(1),
            single_shipment_column: Some(2),
            country_code_column: Some(8),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 4,
                    qty_column: 5,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 6,
                    qty_column: 7,
                    merged_qty_column: 7,
                    ..SkuQtyPair::default()
                },
            ],
            ..PriceCheckMapping::default()
        };
        let (default_lines, _, _) = read_order_lines(&sheet, &mapping, &Config::default());
        let disabled_status = single_shipment_matching_status(&sheet, &mapping, &Config::default());
        assert!(!disabled_status.enabled);
        assert!(!disabled_status.ready);
        assert!(disabled_status.reason.contains("配置中心未启用"));
        let mut config = Config::default();
        config.pricing.single_shipment_matching_enabled = true;
        config.pricing.single_shipment_match_fields = vec![
            SingleShipmentMatchField::RecipientName,
            SingleShipmentMatchField::Phone,
        ];
        let enabled_status = single_shipment_matching_status(&sheet, &mapping, &config);
        assert!(enabled_status.enabled);
        assert!(enabled_status.ready);
        assert_eq!(enabled_status.fields[0].columns, vec![2]);
        assert_eq!(enabled_status.fields[0].headers, vec!["Name"]);
        assert_eq!(enabled_status.fields[1].columns, vec![3]);
        assert_eq!(enabled_status.fields[1].headers, vec!["Phone"]);
        let (lines, exceptions, _) = read_order_lines(&sheet, &mapping, &config);

        assert!(exceptions.is_empty());
        assert!(default_lines.iter().all(|line| !line.single_shipment));
        assert_eq!(lines.len(), 7);
        assert!(lines[0].single_shipment);
        assert!(lines[1].single_shipment);
        assert!(!lines[2].single_shipment);
        assert!(!lines[3].single_shipment);
        assert!(!lines[4].single_shipment);
        assert!(!lines[5].single_shipment);
        assert!(!lines[6].single_shipment);

        let pricing_sheet = SheetData {
            name: "核价".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("TC2500830"),
                    CellValue::string("US"),
                    CellValue::string("2.9"),
                ],
                vec![
                    CellValue::string("单独发货价格"),
                    CellValue::string(""),
                    CellValue::string(""),
                ],
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("Country"),
                    CellValue::string("1"),
                ],
                vec![
                    CellValue::string("TC2500830"),
                    CellValue::string("US"),
                    CellValue::string("5.59"),
                ],
            ],
        };
        let pricing_mapping = PriceCheckMapping {
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let price_index = build_price_index(&pricing_sheet, &pricing_mapping, &config.pricing);
        let accessory = lines
            .iter()
            .find(|line| line.business_order_number == "ORDER-5" && line.matched_sku == "TC2500830")
            .expect("joint shipment accessory");

        assert_eq!(
            price_index
                .lookup_with_single_shipment_preference(
                    &accessory.country.code,
                    &accessory.matched_sku,
                    accessory.quantity as i64,
                    accessory.single_shipment,
                )
                .price,
            Some(2.9)
        );
    }

    #[test]
    fn order_candidate_defaults_single_shipment_field_to_name() {
        let sheet = SheetData {
            name: "order".to_string(),
            rows: vec![
                vec![
                    CellValue::string("Order number"),
                    CellValue::string("Country"),
                    CellValue::string("Qty"),
                    CellValue::string("SKU"),
                    CellValue::string("Qty"),
                    CellValue::string("Name"),
                ],
                vec![
                    CellValue::string("ORDER-1"),
                    CellValue::string("US"),
                    CellValue::string("1"),
                    CellValue::string("ABC123"),
                    CellValue::string("1"),
                    CellValue::string("Alice"),
                ],
            ],
        };

        let candidate = infer_order_candidate(&sheet).expect("order candidate");
        assert_eq!(candidate.single_shipment_column, Some(6));
    }

    #[test]
    fn multi_pair_mapping_preserves_all_pairs_in_score_order() {
        let order = OrderSheetCandidate {
            sheet_name: "订单".to_string(),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 1,
                    qty_column: 2,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                },
            ],
            ..OrderSheetCandidate::default()
        };
        let pricing = PricingSheetCandidate {
            sheet_name: "核价".to_string(),
            sku_column: Some(1),
            country_column: Some(2),
            tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PricingSheetCandidate::default()
        };
        let variants = mapping_variants(&order, &pricing);
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].sku_qty_pairs.len(), 2);
    }

    fn complete_mapping() -> PriceCheckMapping {
        PriceCheckMapping {
            order_sheet: "订单".to_string(),
            pricing_sheet: "核价".to_string(),
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 4,
                qty_column: 3,
                merged_qty_column: 5,
                ..SkuQtyPair::default()
            }],
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        }
    }

    fn decision(rows: usize, coverage: f64, ambiguous: bool) -> AutomationDecision {
        let config = Config::default();
        let mapping = complete_mapping();
        decide_automation(
            &config,
            Some(&mapping),
            true,
            true,
            rows,
            (rows as f64 * coverage).round() as usize,
            coverage,
            Some(coverage - 0.01),
            Some(10.0),
            ambiguous.then_some("订单/核价 Sheet 候选差距不足"),
        )
    }

    #[test]
    fn automation_accepts_threshold_and_rejects_lower_coverage() {
        assert_eq!(decision(100, 0.98, false).status, "eligible");
        assert_eq!(decision(100, 0.979, false).status, "confirm");
    }

    #[test]
    fn automation_requires_full_coverage_for_small_samples() {
        assert_eq!(decision(9, 1.0, false).status, "eligible");
        assert_eq!(decision(9, 0.99, false).status, "confirm");
    }

    #[test]
    fn automation_rejects_missing_fields_same_sheet_and_tied_candidates() {
        let config = Config::default();
        let mut mapping = complete_mapping();
        mapping.sku_qty_pairs.clear();
        let missing = decide_automation(
            &config,
            Some(&mapping),
            true,
            true,
            20,
            20,
            1.0,
            None,
            None,
            None,
        );
        assert_eq!(missing.status, "confirm");
        assert!(
            missing
                .reasons
                .iter()
                .any(|reason| reason.contains("必需字段"))
        );

        let mut same_sheet = complete_mapping();
        same_sheet.pricing_sheet = same_sheet.order_sheet.clone();
        let conflict = decide_automation(
            &config,
            Some(&same_sheet),
            true,
            true,
            20,
            20,
            1.0,
            None,
            None,
            None,
        );
        assert_eq!(conflict.status, "confirm");
        assert!(
            conflict
                .reasons
                .iter()
                .any(|reason| reason.contains("不能相同"))
        );
        assert_eq!(decision(20, 1.0, true).status, "confirm");
    }

    #[test]
    fn ambiguity_distinguishes_sheet_and_column_candidates() {
        let config = Config::default();
        let best = complete_mapping();
        let mut column_runner_up = best.clone();
        column_runner_up.sku_qty_pairs[0].qty_column = 4;
        column_runner_up.sku_qty_pairs[0].sku_column = 5;
        column_runner_up.sku_qty_pairs[0].merged_qty_column = 6;
        assert_eq!(
            classify_candidate_ambiguity(&best, &column_runner_up, 0.0, 0.0, &config),
            Some(CandidateAmbiguity::Column)
        );

        let mut sheet_runner_up = best.clone();
        sheet_runner_up.order_sheet = "订单备选".to_string();
        assert_eq!(
            classify_candidate_ambiguity(&best, &sheet_runner_up, 0.0, 0.0, &config),
            Some(CandidateAmbiguity::Sheet)
        );
        let column_reason =
            candidate_ambiguity_reason(CandidateAmbiguity::Column, &best, &column_runner_up);
        assert!(column_reason.contains("最优 [原始数量 C / SKU D / 合并数量 E]"));
        assert!(column_reason.contains("次优 [原始数量 D / SKU E / 合并数量 F]"));
    }

    #[test]
    fn nested_mapping_is_not_a_distinct_runner_up() {
        let best = complete_mapping();
        let mut nested = best.clone();
        nested.sku_qty_pairs.push(SkuQtyPair {
            sku_column: 5,
            qty_column: 6,
            merged_qty_column: 7,
            direct_quantity: false,
            sku_header: "备用 SKU".to_string(),
            qty_header: "备用数量".to_string(),
            merged_qty_header: "备用合并数量".to_string(),
        });
        assert!(mapping_is_nested_variant(&best, &nested));

        let mut distinct = best.clone();
        distinct.sku_qty_pairs[0] = nested.sku_qty_pairs[1].clone();
        assert!(!mapping_is_nested_variant(&best, &distinct));
    }

    #[test]
    fn field_mapping_score_prefers_recognized_sku_quantity_columns() {
        let sheet = SheetData {
            name: "订单".to_string(),
            rows: vec![
                vec![
                    CellValue::string("SKU"),
                    CellValue::string("数量"),
                    CellValue::string("备注"),
                    CellValue::string("说明"),
                ],
                vec![
                    CellValue::string("SKU-1"),
                    CellValue::string("2"),
                    CellValue::string("SKU-1"),
                    CellValue::string("two"),
                ],
            ],
        };
        let mut recognized = complete_mapping();
        recognized.sku_qty_pairs = vec![SkuQtyPair {
            sku_column: 1,
            qty_column: 2,
            merged_qty_column: 3,
            direct_quantity: false,
            sku_header: "SKU".to_string(),
            qty_header: "数量".to_string(),
            merged_qty_header: "合并数量".to_string(),
        }];
        let mut unrecognized = recognized.clone();
        unrecognized.sku_qty_pairs[0] = SkuQtyPair {
            sku_column: 3,
            qty_column: 4,
            merged_qty_column: 5,
            direct_quantity: false,
            sku_header: "备注".to_string(),
            qty_header: "说明".to_string(),
            merged_qty_header: "其他".to_string(),
        };

        assert!(
            sku_qty_field_score(&sheet, &recognized, &Config::default())
                > sku_qty_field_score(&sheet, &unrecognized, &Config::default())
        );
    }

    #[test]
    fn price_result_is_written_directly_to_the_selected_output_directory() {
        let output_dir = Path::new("output");
        let output_path = output_path_for(Path::new("orders/order.xlsx"), output_dir);
        assert_eq!(output_path, output_dir.join("order_核价结果.xlsx"));
        assert_eq!(
            output_path_for(Path::new("orders/order.xlsm"), output_dir),
            output_dir.join("order_核价结果.xlsm")
        );
    }

    #[test]
    fn manual_sku_column_validation_recalculates_coverage() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "auto-pricing-mapping-{}-{}.xlsx",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut workbook = rust_xlsxwriter::Workbook::new();
        {
            let order = workbook.add_worksheet();
            order.set_name("订单")?;
            for (column, value) in [
                "订单号",
                "国家二字码",
                "数量",
                "SKU",
                "合并数量",
                "数量",
                "SKU",
                "合并数量",
                "Total Price",
            ]
            .iter()
            .enumerate()
            {
                order.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["A-1", "US", "1", "GOOD-1", "1", "1", "GOOD-1", "1", "8"]
                .iter()
                .enumerate()
            {
                order.write_string(1, column as u16, *value)?;
            }
        }
        {
            let pricing = workbook.add_worksheet();
            pricing.set_name("核价")?;
            for (column, value) in ["SKU", "Country", "1"].iter().enumerate() {
                pricing.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["GOOD-1", "US", "9.5"].iter().enumerate() {
                pricing.write_string(1, column as u16, *value)?;
            }
        }
        workbook.save(&path)?;

        let mut mapping = PriceCheckMapping {
            order_sheet: "订单".to_string(),
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            order_price_column: Some(9),
            sku_qty_pairs: vec![SkuQtyPair {
                sku_column: 4,
                qty_column: 3,
                merged_qty_column: 5,
                direct_quantity: false,
                sku_header: "SKU".to_string(),
                qty_header: "数量".to_string(),
                merged_qty_header: "合并数量".to_string(),
            }],
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![PriceTierColumn {
                quantity: 1,
                column: 3,
                header: "1".to_string(),
            }],
            ..PriceCheckMapping::default()
        };
        let wrong = validate_price_mapping(&path, &mapping, &[], &Config::default())
            .expect("valid mapping");
        assert_eq!(
            (wrong.evaluated_rows, wrong.matched_rows, wrong.coverage),
            (0, 0, 0.0)
        );
        assert!(wrong.matched_order_rows.is_empty());
        mapping.sku_qty_pairs.push(SkuQtyPair {
            sku_column: 7,
            qty_column: 6,
            merged_qty_column: 8,
            direct_quantity: false,
            sku_header: "SKU".to_string(),
            qty_header: "数量".to_string(),
            merged_qty_header: "合并数量".to_string(),
        });
        let corrected = validate_price_mapping(&path, &mapping, &[], &Config::default())
            .expect("valid mapping");
        assert_eq!(
            (
                corrected.evaluated_rows,
                corrected.matched_rows,
                corrected.coverage
            ),
            (1, 1, 1.0)
        );
        assert_eq!(corrected.matched_order_rows, vec![2]);
        assert_eq!(
            corrected.writeback_rows,
            vec![PricePreviewWritebackRow {
                source_row: 2,
                pricing_price: Some(9.5),
                price_difference: Some(1.5),
                quantity: Some(1),
                quantity_mismatch: false,
                quantity_error: None,
                quantity_issue_context: None,
                used_original_sku_quantity: false,
            }]
        );
        // 顺序错误：SKU 在原始数量左侧
        mapping.sku_qty_pairs[1].qty_column = 8;
        mapping.sku_qty_pairs[1].sku_column = 7;
        mapping.sku_qty_pairs[1].merged_qty_column = 9;
        let errors = validate_price_mapping(&path, &mapping, &[], &Config::default())
            .expect_err("wrong column order must be rejected");
        assert!(
            errors.iter().any(|error| {
                error
                    == "单 SKU 组必须映射 SKU 与数量列；多 SKU 组必须按“原始数量、SKU、合并数量”从左到右排列（可不连续）"
            }),
            "errors: {errors:?}"
        );
        // 可不连续：原始数量(C) / SKU(G) / 合并数量(H)，中间夹其他列，顺序正确
        mapping.sku_qty_pairs[1].qty_column = 6;
        mapping.sku_qty_pairs[1].sku_column = 7;
        mapping.sku_qty_pairs[1].merged_qty_column = 8;
        let non_contiguous = validate_price_mapping(&path, &mapping, &[], &Config::default())
            .expect("non-contiguous ordered trio should be accepted");
        assert_eq!(
            (
                non_contiguous.evaluated_rows,
                non_contiguous.matched_rows,
                non_contiguous.coverage
            ),
            (1, 1, 1.0)
        );
        std::fs::remove_file(path)?;
        Ok(())
    }

    #[test]
    fn quantity_edit_recalculates_only_the_requested_row_with_tax() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "auto-pricing-row-edit-{}-{}.xlsx",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut workbook = rust_xlsxwriter::Workbook::new();
        {
            let order = workbook.add_worksheet();
            order.set_name("订单")?;
            for (column, value) in [
                "订单号",
                "国家二字码",
                "前一 SKU",
                "Qty",
                "主要 SKU",
                "合并数量",
                "Total Price",
                "EU TAX",
            ]
            .iter()
            .enumerate()
            {
                order.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["A-1", "US", "LEFT-1", "1", "GOOD-1", "2", "9", "1"]
                .iter()
                .enumerate()
            {
                order.write_string(1, column as u16, *value)?;
            }
        }
        {
            let pricing = workbook.add_worksheet();
            pricing.set_name("核价")?;
            for (column, value) in ["SKU", "Country", "1", "2"].iter().enumerate() {
                pricing.write_string(0, column as u16, *value)?;
            }
            for (column, value) in ["GOOD-1", "US", "8", "12"].iter().enumerate() {
                pricing.write_string(1, column as u16, *value)?;
            }
        }
        workbook.save(&path)?;
        let mapping = PriceCheckMapping {
            order_sheet: "订单".to_string(),
            order_header_row: 1,
            business_order_number_column: Some(1),
            country_code_column: Some(2),
            order_price_column: Some(7),
            sku_qty_pairs: vec![
                SkuQtyPair {
                    sku_column: 3,
                    qty_column: 4,
                    ..SkuQtyPair::default()
                },
                SkuQtyPair {
                    sku_column: 5,
                    qty_column: 4,
                    merged_qty_column: 6,
                    ..SkuQtyPair::default()
                },
            ],
            pricing_sheet: "核价".to_string(),
            pricing_header_row: 1,
            pricing_sku_column: 1,
            pricing_country_column: 2,
            quantity_tier_columns: vec![
                PriceTierColumn {
                    quantity: 1,
                    column: 3,
                    header: "1".to_string(),
                },
                PriceTierColumn {
                    quantity: 2,
                    column: 4,
                    header: "2".to_string(),
                },
            ],
            ..PriceCheckMapping::default()
        };

        let result = recalculate_price_row(
            &path,
            &mapping,
            &[],
            &Config::default(),
            &PriceRowEdit {
                source_row: 2,
                quantity: Some(2),
                use_original_sku_quantity: false,
            },
        )?;

        assert_eq!(
            result.row,
            PricePreviewWritebackRow {
                source_row: 2,
                pricing_price: Some(13.0),
                price_difference: Some(4.0),
                quantity: Some(2),
                quantity_mismatch: false,
                quantity_error: None,
                quantity_issue_context: None,
                used_original_sku_quantity: false,
            }
        );
        assert_eq!(result.error, None);

        let fallback = recalculate_price_row(
            &path,
            &mapping,
            &[],
            &Config::default(),
            &PriceRowEdit {
                source_row: 2,
                quantity: None,
                use_original_sku_quantity: true,
            },
        )?;
        assert_eq!(
            fallback.row,
            PricePreviewWritebackRow {
                source_row: 2,
                pricing_price: Some(13.0),
                price_difference: Some(4.0),
                quantity: Some(2),
                quantity_mismatch: false,
                quantity_error: None,
                quantity_issue_context: None,
                used_original_sku_quantity: true,
            }
        );
        assert_eq!(fallback.error, None);
        std::fs::remove_file(path)?;
        Ok(())
    }
}
