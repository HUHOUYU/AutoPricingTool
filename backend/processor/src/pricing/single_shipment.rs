use super::*;

#[derive(Debug, Clone)]
struct SingleShipmentMatchColumns {
    field: SingleShipmentMatchField,
    columns: Vec<usize>,
}

pub(super) fn exact_header_columns(
    sheet: &SheetData,
    header_idx: usize,
    aliases: &[&str],
) -> Vec<usize> {
    let normalized_aliases = aliases
        .iter()
        .map(|alias| normalize_header(alias))
        .collect::<HashSet<_>>();
    sheet
        .rows
        .get(header_idx)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(column, cell)| {
            normalized_aliases
                .contains(&normalize_header(&cell.text()))
                .then_some(column)
        })
        .collect()
}

fn single_shipment_match_columns(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> Option<Vec<SingleShipmentMatchColumns>> {
    let status = single_shipment_matching_status(sheet, mapping, config);
    status.ready.then(|| {
        status
            .fields
            .into_iter()
            .map(|matched| SingleShipmentMatchColumns {
                field: matched.field,
                columns: matched
                    .columns
                    .into_iter()
                    .map(|column| column.saturating_sub(1))
                    .collect(),
            })
            .collect()
    })
}

fn single_shipment_field_label(field: SingleShipmentMatchField) -> &'static str {
    match field {
        SingleShipmentMatchField::RecipientName => "收件人姓名",
        SingleShipmentMatchField::Phone => "电话",
        SingleShipmentMatchField::PostalCode => "邮编",
        SingleShipmentMatchField::Address => "完整地址",
        SingleShipmentMatchField::Email => "邮箱",
    }
}

fn single_shipment_field_rule_key(field: SingleShipmentMatchField) -> &'static str {
    match field {
        SingleShipmentMatchField::RecipientName => "recipient_name",
        SingleShipmentMatchField::Phone => "phone",
        SingleShipmentMatchField::PostalCode => "postal_code",
        SingleShipmentMatchField::Address => "address",
        SingleShipmentMatchField::Email => "email",
    }
}

fn single_shipment_field_aliases(field: SingleShipmentMatchField) -> &'static [&'static str] {
    match field {
        SingleShipmentMatchField::RecipientName => SINGLE_SHIPMENT_FIELD_ALIASES,
        SingleShipmentMatchField::Phone => SINGLE_SHIPMENT_PHONE_ALIASES,
        SingleShipmentMatchField::PostalCode => SINGLE_SHIPMENT_POSTAL_CODE_ALIASES,
        SingleShipmentMatchField::Address => SINGLE_SHIPMENT_ADDRESS_ALIASES,
        SingleShipmentMatchField::Email => SINGLE_SHIPMENT_EMAIL_ALIASES,
    }
}

pub(super) fn resolve_single_shipment_fields(
    sheet: &SheetData,
    header_idx: usize,
    config: &Config,
    explicit_fields: &[SingleShipmentMatchFieldStatus],
    legacy_recipient_name_column: Option<usize>,
) -> Vec<SingleShipmentMatchFieldStatus> {
    config
        .pricing
        .single_shipment_match_fields
        .iter()
        .map(|field| {
            let explicit = explicit_fields
                .iter()
                .find(|matched| matched.field == *field);
            let mut zero_based_columns = if let Some(explicit) = explicit {
                explicit
                    .columns
                    .iter()
                    .filter_map(|column| column.checked_sub(1))
                    .collect()
            } else if *field == SingleShipmentMatchField::RecipientName {
                legacy_recipient_name_column
                    .and_then(|column| column.checked_sub(1))
                    .map(|column| vec![column])
                    .unwrap_or_else(|| {
                        configured_matching_columns(
                            sheet,
                            header_idx,
                            order_field_rule(config, single_shipment_field_rule_key(*field)),
                            single_shipment_field_aliases(*field),
                        )
                    })
            } else {
                configured_matching_columns(
                    sheet,
                    header_idx,
                    order_field_rule(config, single_shipment_field_rule_key(*field)),
                    single_shipment_field_aliases(*field),
                )
            };
            if *field != SingleShipmentMatchField::Address {
                zero_based_columns.truncate(1);
            }
            let columns = zero_based_columns
                .iter()
                .map(|column| column + 1)
                .collect::<Vec<_>>();
            let headers = columns
                .iter()
                .map(|column| {
                    sheet_cell_text(sheet, header_idx + 1, *column)
                        .trim()
                        .to_string()
                })
                .collect();
            SingleShipmentMatchFieldStatus {
                field: *field,
                columns,
                headers,
            }
        })
        .collect()
}

pub(super) fn single_shipment_matching_unavailable(
    config: &Config,
    unavailable_reason: &str,
) -> SingleShipmentMatchingStatus {
    let enabled = config.pricing.single_shipment_matching_enabled;
    SingleShipmentMatchingStatus {
        enabled,
        ready: false,
        fields: config
            .pricing
            .single_shipment_match_fields
            .iter()
            .map(|field| SingleShipmentMatchFieldStatus {
                field: *field,
                columns: Vec::new(),
                headers: Vec::new(),
            })
            .collect(),
        reason: if enabled {
            unavailable_reason.to_string()
        } else {
            "配置中心未启用，当前使用通用价格".to_string()
        },
    }
}

pub(super) fn single_shipment_matching_status(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> SingleShipmentMatchingStatus {
    let Some(header_idx) = mapping.order_header_row.checked_sub(1) else {
        return single_shipment_matching_unavailable(config, "订单表头行无效");
    };
    if header_idx >= sheet.rows.len() {
        return single_shipment_matching_unavailable(config, "订单表头行超出有效范围");
    }

    let fields = resolve_single_shipment_fields(
        sheet,
        header_idx,
        config,
        &mapping.single_shipment_fields,
        mapping.single_shipment_column,
    );
    let missing_fields = fields
        .iter()
        .filter(|matched| matched.columns.is_empty())
        .map(|matched| single_shipment_field_label(matched.field))
        .collect::<Vec<_>>();

    let enabled = config.pricing.single_shipment_matching_enabled;
    let ready = enabled && fields.len() >= 2 && missing_fields.is_empty();
    let reason = if !enabled {
        "配置中心未启用，当前使用通用价格".to_string()
    } else if fields.len() < 2 {
        "联合判断至少需要两个字段，当前使用通用价格".to_string()
    } else if !missing_fields.is_empty() {
        format!(
            "缺少联合字段表头：{}，当前使用通用价格",
            missing_fields.join("、")
        )
    } else {
        "联合字段完整；仅证据充分的单主 SKU 订单使用单独发货价格".to_string()
    };
    SingleShipmentMatchingStatus {
        enabled,
        ready,
        fields,
        reason,
    }
}

fn normalize_single_shipment_match_value(field: SingleShipmentMatchField, value: &str) -> String {
    match field {
        SingleShipmentMatchField::Phone | SingleShipmentMatchField::PostalCode => value
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_uppercase)
            .collect(),
        SingleShipmentMatchField::Email => value.trim().to_lowercase(),
        SingleShipmentMatchField::RecipientName | SingleShipmentMatchField::Address => value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_uppercase(),
    }
}

fn single_shipment_match_key(
    row: &[CellValue],
    columns: &[SingleShipmentMatchColumns],
) -> Option<String> {
    let mut values = Vec::with_capacity(columns.len());
    for matched in columns {
        let combined = matched
            .columns
            .iter()
            .filter_map(|column| row.get(*column).map(CellValue::text))
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let normalized = normalize_single_shipment_match_value(matched.field, &combined);
        if normalized.is_empty() {
            return None;
        }
        values.push(normalized);
    }
    Some(values.join("\u{1f}"))
}

pub(super) fn single_shipment_orders(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
    resolved_quantities: &[ResolvedOrderQuantity],
) -> HashSet<String> {
    let Some(match_columns) = single_shipment_match_columns(sheet, mapping, config) else {
        return HashSet::new();
    };
    let mut invalid_orders = HashSet::new();
    let mut keys_by_order: HashMap<String, HashSet<String>> = HashMap::new();
    let mut main_skus_by_order: HashMap<String, HashSet<String>> = HashMap::new();
    for resolved in resolved_quantities {
        if resolved.business_order_number.is_empty() {
            continue;
        }
        let Some(row) = sheet.rows.get(resolved.source_row.saturating_sub(1)) else {
            invalid_orders.insert(resolved.business_order_number.clone());
            continue;
        };
        if resolved.quantity_error.is_some() {
            invalid_orders.insert(resolved.business_order_number.clone());
        }
        if let Some(key) = single_shipment_match_key(row, &match_columns) {
            keys_by_order
                .entry(resolved.business_order_number.clone())
                .or_default()
                .insert(key);
        } else {
            invalid_orders.insert(resolved.business_order_number.clone());
        }
        if !resolved.absorbed
            && resolved.quantity.is_some_and(|quantity| quantity > 0)
            && !resolved.matched_sku.is_empty()
        {
            main_skus_by_order
                .entry(resolved.business_order_number.clone())
                .or_default()
                .insert(resolved.matched_sku.clone());
        }
    }

    let valid_keys = keys_by_order
        .into_iter()
        .filter_map(|(order, keys)| {
            (!invalid_orders.contains(&order) && keys.len() == 1)
                .then(|| (order, keys.into_iter().next().expect("one key")))
        })
        .collect::<HashMap<_, _>>();
    let mut orders_by_key: HashMap<String, HashSet<String>> = HashMap::new();
    for (order, key) in &valid_keys {
        orders_by_key
            .entry(key.clone())
            .or_default()
            .insert(order.clone());
    }

    valid_keys
        .into_iter()
        .filter_map(|(order, key)| {
            let one_order_per_key = orders_by_key
                .get(&key)
                .is_some_and(|orders| orders.len() == 1);
            let one_main_sku = main_skus_by_order
                .get(&order)
                .is_some_and(|skus| skus.len() == 1);
            (one_order_per_key && one_main_sku).then_some(order)
        })
        .collect()
}
