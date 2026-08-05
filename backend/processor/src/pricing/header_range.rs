use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OrderCoreHeaderRange {
    pub(super) start: usize,
    pub(super) end: usize,
}

impl OrderCoreHeaderRange {
    pub(super) fn contains(self, column: usize) -> bool {
        column >= self.start && column <= self.end
    }

    pub(super) fn label(self) -> String {
        format!(
            "{}:{}",
            excel_column_label(self.start + 1),
            excel_column_label(self.end + 1)
        )
    }
}

pub(super) fn resolve_order_core_header_range(
    header: &[CellValue],
    config: &Config,
) -> std::result::Result<Option<OrderCoreHeaderRange>, String> {
    let configured = &config.pricing.order_core_header_range;
    if configured.is_empty() {
        return Ok(None);
    }
    let normalized = header
        .iter()
        .map(|cell| normalize_header(&cell.text()))
        .collect::<Vec<_>>();
    let find = |value: &str, start: usize| {
        let target = normalize_header(value);
        normalized
            .iter()
            .enumerate()
            .skip(start)
            .find_map(|(column, header)| (header == &target).then_some(column))
    };
    if configured.len() == 1 {
        let end_header = &configured[0];
        let end = find(end_header, 0).ok_or_else(|| format!("找不到结束表头“{end_header}”"))?;
        return Ok(Some(OrderCoreHeaderRange { start: 0, end }));
    }
    let start_header = &configured[0];
    let end_header = &configured[1];
    let start = find(start_header, 0).ok_or_else(|| format!("找不到起始表头“{start_header}”"))?;
    let end = find(end_header, start).ok_or_else(|| {
        if find(end_header, 0).is_some() {
            format!("结束表头“{end_header}”位于起始表头“{start_header}”之前")
        } else {
            format!("找不到结束表头“{end_header}”")
        }
    })?;
    Ok(Some(OrderCoreHeaderRange { start, end }))
}

pub(super) fn filter_columns_to_core_range(
    columns: Vec<usize>,
    range: Option<OrderCoreHeaderRange>,
) -> Vec<usize> {
    range.map_or(columns.clone(), |range| {
        columns
            .into_iter()
            .filter(|column| range.contains(*column))
            .collect()
    })
}

pub(super) fn core_columns_outside_range(
    header: &[CellValue],
    columns: impl IntoIterator<Item = usize>,
    range: Option<OrderCoreHeaderRange>,
) -> Vec<String> {
    let Some(range) = range else {
        return Vec::new();
    };
    let mut excluded = columns
        .into_iter()
        .filter(|column| !range.contains(*column))
        .map(|column| {
            let header = header.get(column).map(CellValue::text).unwrap_or_default();
            format!("{}({header})", excel_column_label(column + 1))
        })
        .collect::<Vec<_>>();
    excluded.sort();
    excluded.dedup();
    excluded
}

pub(super) fn core_mapping_columns(mapping: &PriceCheckMapping) -> Vec<usize> {
    let mut columns = [
        mapping.business_order_number_column,
        mapping.country_code_column,
        mapping.country_english_column,
        mapping.country_chinese_column,
        mapping.order_price_column,
    ]
    .into_iter()
    .flatten()
    .map(|column| column.saturating_sub(1))
    .collect::<Vec<_>>();
    columns.extend(mapping.sku_qty_pairs.iter().flat_map(|pair| {
        let mut pair_columns = vec![
            pair.sku_column.saturating_sub(1),
            pair.qty_column.saturating_sub(1),
        ];
        if !pair.direct_quantity {
            pair_columns.push(pair.merged_qty_column.saturating_sub(1));
        }
        pair_columns
    }));
    columns
}

pub(super) fn validate_mapping_core_range(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    config: &Config,
) -> std::result::Result<Option<PriceFieldDiagnostic>, PriceFieldDiagnostic> {
    if config.pricing.order_core_header_range.is_empty() {
        return Ok(None);
    }
    let Some(header) = sheet.rows.get(mapping.order_header_row.saturating_sub(1)) else {
        return Err(PriceFieldDiagnostic {
            field: "order_header_range".to_string(),
            level: "error".to_string(),
            title: "订单核心字段范围无效".to_string(),
            message: "订单表头行超出有效范围，无法解析配置边界".to_string(),
        });
    };
    let range = resolve_order_core_header_range(header, config)
        .map_err(|message| PriceFieldDiagnostic {
            field: "order_header_range".to_string(),
            level: "error".to_string(),
            title: "订单核心字段范围无效".to_string(),
            message: format!("{}：{message}，未退回整行扫描", sheet.name),
        })?
        .expect("configured range must resolve to a range");
    let outside = core_mapping_columns(mapping)
        .into_iter()
        .filter(|column| !range.contains(*column))
        .map(|column| {
            let header = header.get(column).map(CellValue::text).unwrap_or_default();
            format!("{}({header})", excel_column_label(column + 1))
        })
        .collect::<Vec<_>>();
    if !outside.is_empty() {
        return Err(PriceFieldDiagnostic {
            field: "order_header_range".to_string(),
            level: "error".to_string(),
            title: "订单核心字段超出范围".to_string(),
            message: format!(
                "允许范围 {}，以下映射位于区间外：{}",
                range.label(),
                outside.join("、")
            ),
        });
    }
    Ok(Some(PriceFieldDiagnostic {
        field: "order_header_range".to_string(),
        level: "info".to_string(),
        title: "订单核心字段范围".to_string(),
        message: format!(
            "{}!{}，核心字段映射均位于闭区间内",
            sheet.name,
            range.label()
        ),
    }))
}
