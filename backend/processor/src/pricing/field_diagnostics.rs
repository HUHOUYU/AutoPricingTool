use super::*;

pub(super) fn missing_mapping_fields(
    mapping: &PriceCheckMapping,
) -> Vec<(&'static str, &'static str)> {
    let mut missing = Vec::new();
    if mapping.business_order_number_column.is_none() {
        missing.push(("order_number", "订单号"));
    }
    if mapping.country_code_column.is_none()
        && mapping.country_english_column.is_none()
        && mapping.country_chinese_column.is_none()
    {
        missing.push(("country", "订单国家"));
    }
    if mapping.sku_qty_pairs.is_empty() {
        missing.push(("sku_quantity", "订单 SKU/数量映射"));
    }
    if mapping.pricing_sku_column == 0 {
        missing.push(("pricing_sku", "核价 SKU"));
    }
    if mapping.pricing_country_column == 0 {
        missing.push(("pricing_country", "核价国家"));
    }
    if mapping.quantity_tier_columns.is_empty() {
        missing.push(("quantity_tiers", "核价数量档位"));
    }
    missing
}

pub(super) fn incomplete_mapping_reason(mapping: &PriceCheckMapping) -> Option<String> {
    let labels = missing_mapping_fields(mapping)
        .into_iter()
        .map(|(_, label)| label)
        .collect::<Vec<_>>();
    (!labels.is_empty()).then(|| format!("必需字段不完整：{}", labels.join("、")))
}

pub(super) fn no_trial_rows_reason(mapping: Option<&PriceCheckMapping>) -> String {
    mapping
        .and_then(incomplete_mapping_reason)
        .map(|reason| format!("未进行试算：{reason}"))
        .unwrap_or_else(|| "没有可用于试算的订单行".to_string())
}

pub(super) fn mapping_field_diagnostics(
    mapping: Option<&PriceCheckMapping>,
    has_order_candidate: bool,
    has_pricing_candidate: bool,
) -> Vec<PriceFieldDiagnostic> {
    let Some(mapping) = mapping else {
        let mut diagnostics = Vec::new();
        if !has_order_candidate {
            diagnostics.push(PriceFieldDiagnostic {
                field: "order_number".to_string(),
                level: "error".to_string(),
                title: "订单核心字段".to_string(),
                message: "未识别到同时包含订单号、国家和 SKU/数量的订单 Sheet".to_string(),
            });
        }
        if !has_pricing_candidate {
            diagnostics.push(PriceFieldDiagnostic {
                field: "pricing_sku".to_string(),
                level: "error".to_string(),
                title: "核价核心字段".to_string(),
                message: "未识别到同时包含 SKU、国家和数量档位的核价 Sheet".to_string(),
            });
        }
        return diagnostics;
    };
    let mut diagnostics = missing_mapping_fields(mapping)
        .into_iter()
        .map(|(field, label)| PriceFieldDiagnostic {
            field: field.to_string(),
            level: "error".to_string(),
            title: label.to_string(),
            message: format!("未生成{label}字段映射，请检查表头或手动选择列"),
        })
        .collect::<Vec<_>>();
    if mapping.order_price_column.is_none() {
        diagnostics.push(PriceFieldDiagnostic {
            field: "order_price".to_string(),
            level: "warning".to_string(),
            title: "订单原始价格".to_string(),
            message: "未识别到原始价格列；该字段保持可选，但无法计算价格差异".to_string(),
        });
    }
    diagnostics
}
