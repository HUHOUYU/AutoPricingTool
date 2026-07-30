use super::*;

pub(super) fn build_price_index(
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
    pricing_rules: &PricingRules,
) -> PriceIndex {
    let mut index = PriceIndex::default();
    let mut single_shipment_index = PriceIndex::default();
    let data_start = mapping
        .pricing_header_row
        .max(mapping.pricing_quantity_header_row.unwrap_or(0));
    let single_shipment_start =
        sheet
            .rows
            .iter()
            .enumerate()
            .skip(data_start)
            .find_map(|(row_index, row)| {
                row.iter()
                    .any(|cell| {
                        let normalized = normalize_header(&cell.text());
                        pricing_rules
                            .single_shipment_price_marker_aliases
                            .iter()
                            .any(|alias| normalized == normalize_header(alias))
                    })
                    .then_some(row_index)
            });
    for (row_index, row) in sheet.rows.iter().enumerate().skip(data_start) {
        let target = if single_shipment_start.is_some_and(|start| row_index > start) {
            &mut single_shipment_index
        } else {
            &mut index
        };
        insert_price_row(target, row, sheet, mapping);
    }
    if !single_shipment_index.entries.is_empty() {
        index.single_shipment = Some(Box::new(single_shipment_index));
    }
    index
}

fn insert_price_row(
    index: &mut PriceIndex,
    row: &[CellValue],
    sheet: &SheetData,
    mapping: &PriceCheckMapping,
) {
    let raw_sku = cell_text(row, Some(mapping.pricing_sku_column));
    let raw_country = cell_text(row, Some(mapping.pricing_country_column));
    let country_route = country_route_token(&raw_country);
    if country_route.is_empty() {
        return;
    }
    index.source_sheet = sheet.name.clone();
    index.country_routes.insert(country_route.clone());
    if raw_sku.is_empty() {
        return;
    }
    let sku = normalize_sku(&raw_sku);
    for tier in &mapping.quantity_tier_columns {
        let entry = PriceEntry {
            price: row.get(tier.column.saturating_sub(1)).and_then(parse_price),
            raw_price: row
                .get(tier.column.saturating_sub(1))
                .map(CellValue::text)
                .unwrap_or_default(),
            sheet_name: sheet.name.clone(),
        };
        let key = full_key(&country_route, &sku, tier.quantity);
        index.quantity_keys.insert(prefix_key(&country_route, &sku));
        index.entries.entry(key).or_default().push(entry);
    }
}

impl PriceIndex {
    #[cfg(test)]
    pub(super) fn lookup_with_single_shipment_preference(
        &self,
        country: &str,
        sku: &str,
        quantity: i64,
        prefer_single_shipment: bool,
    ) -> Lookup {
        self.lookup_routes_with_single_shipment_preference(
            &[country_route_token(country)],
            sku,
            quantity,
            prefer_single_shipment,
        )
    }

    pub(super) fn lookup_routes_with_single_shipment_preference(
        &self,
        country_routes: &[String],
        sku: &str,
        quantity: i64,
        prefer_single_shipment: bool,
    ) -> Lookup {
        if prefer_single_shipment
            && let Some(single_shipment) = &self.single_shipment
            && single_shipment.has_route_sku(country_routes, sku)
        {
            return single_shipment.lookup_routes(country_routes, sku, quantity);
        }
        self.lookup_routes(country_routes, sku, quantity)
    }

    #[cfg(test)]
    pub(super) fn lookup(&self, country: &str, sku: &str, quantity: i64) -> Lookup {
        self.lookup_routes(&[country_route_token(country)], sku, quantity)
    }

    pub(super) fn has_route_sku(&self, country_routes: &[String], sku: &str) -> bool {
        country_routes
            .iter()
            .any(|route| self.quantity_keys.contains(&prefix_key(route, sku)))
    }

    pub(super) fn lookup_routes(
        &self,
        country_routes: &[String],
        sku: &str,
        quantity: i64,
    ) -> Lookup {
        let country_routes = country_routes
            .iter()
            .map(|route| country_route_token(route))
            .filter(|route| !route.is_empty())
            .collect::<Vec<_>>();
        if country_routes.is_empty() || sku.is_empty() {
            return Lookup {
                status: "SKU或国家缺失",
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: self.source_sheet.clone(),
                reason: "订单国家原值或 SKU 缺失".to_string(),
            };
        }
        let route = country_routes
            .iter()
            .find(|route| self.quantity_keys.contains(&prefix_key(route, sku)));
        let Some(route) = route else {
            let existing_routes = country_routes
                .iter()
                .filter(|route| self.country_routes.contains(*route))
                .cloned()
                .collect::<Vec<_>>();
            let (status, reason) = if existing_routes.is_empty() {
                (
                    "国家路由不存在",
                    format!(
                        "核价 Sheet {} 没有国家路由 [{}]",
                        self.source_sheet,
                        country_routes.join(" / ")
                    ),
                )
            } else {
                (
                    "SKU不存在",
                    format!(
                        "核价 Sheet {} 的国家路由 [{}] 没有 SKU {}",
                        self.source_sheet,
                        existing_routes.join(" / "),
                        sku
                    ),
                )
            };
            return Lookup {
                status,
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: self.source_sheet.clone(),
                reason,
            };
        };
        let key = full_key(route, sku, quantity);
        if let Some(entries) = self.entries.get(&key) {
            if entries.len() != 1 {
                let entry = &entries[0];
                return Lookup {
                    status: "核价键重复",
                    price: None,
                    matched_sku: sku.to_string(),
                    source_sheet: entry.sheet_name.clone(),
                    reason: format!(
                        "核价 Sheet {} 中国家路由 {}、SKU {}、数量 {} 对应多个价格",
                        entry.sheet_name, route, sku, quantity
                    ),
                };
            }
            let entry = &entries[0];
            if let Some(price) = entry.price {
                return Lookup {
                    status: "matched",
                    price: Some(price),
                    matched_sku: sku.to_string(),
                    source_sheet: entry.sheet_name.clone(),
                    reason: String::new(),
                };
            }
            return Lookup {
                status: "价格不可用",
                price: None,
                matched_sku: sku.to_string(),
                source_sheet: entry.sheet_name.clone(),
                reason: format!(
                    "核价 Sheet {} 中国家路由 {}、SKU {}、数量 {} 的价格不可用: {}",
                    entry.sheet_name, route, sku, quantity, entry.raw_price
                ),
            };
        }
        Lookup {
            status: "数量档位不存在",
            price: None,
            matched_sku: sku.to_string(),
            source_sheet: self.source_sheet.clone(),
            reason: format!(
                "核价 Sheet {} 的国家路由 {}、SKU {} 没有数量 {} 对应的档位",
                self.source_sheet, route, sku, quantity
            ),
        }
    }
}

fn prefix_key(country: &str, sku: &str) -> String {
    format!("{}\u{1f}{}", country, sku)
}

fn full_key(country: &str, sku: &str, quantity: i64) -> String {
    format!("{}\u{1f}{}\u{1f}{}", country, sku, quantity)
}
