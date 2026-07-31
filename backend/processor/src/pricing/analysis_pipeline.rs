use super::*;

pub(super) fn analyze_path_with_templates(
    path: &Path,
    config: &Config,
    header_templates: &[HeaderTemplateRecord],
) -> Result<PriceAnalysisFile> {
    let workbook = read_workbook_for_processing(path, config)?;
    let mut order_candidates = Vec::new();
    let mut pricing_candidates = Vec::new();
    for sheet in &workbook.sheets {
        if let Some(candidate) = infer_order_candidate_with_config(sheet, config) {
            order_candidates.push(candidate);
        }
        if let Some(candidate) = infer_pricing_candidate_with_config(sheet, config) {
            pricing_candidates.push(candidate);
        }
    }
    order_candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
    pricing_candidates.sort_by(|left, right| right.score.total_cmp(&left.score));

    let mut issues = Vec::new();
    if order_candidates.is_empty() {
        issues.push("未识别到包含订单号、SKU和数量的订单 Sheet".to_string());
    }
    if pricing_candidates.is_empty() {
        issues.push("未识别到包含 SKU、国家和数量档位的核价 Sheet".to_string());
    }

    let mut suggested_mapping = None;
    let mut coverage = 0.0;
    let mut evaluated_rows = 0;
    let mut matched_rows = 0;
    let mut matched_order_rows = Vec::new();
    let mut runner_up_coverage = None;
    let mut candidate_score = None;
    let mut runner_up_score = None;
    let mut automation_score_kind = None;
    let mut score_gap = None;
    let mut ambiguity_reason = None;
    let template_match = config
        .automation
        .template_match_priority
        .then(|| {
            match_header_template(
                &workbook.sheets,
                &order_candidates,
                &pricing_candidates,
                header_templates,
            )
        })
        .flatten();
    if let Some((template_name, mapping)) = template_match {
        if let (Some(order_sheet), Some(pricing_sheet)) = (
            workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.order_sheet),
            workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.pricing_sheet),
        ) {
            let index = build_price_index(pricing_sheet, &mapping, &config.pricing);
            let lines = read_order_lines(order_sheet, &mapping, config).0;
            evaluated_rows = lines.len();
            let evaluated = evaluate_matches(&index, &lines);
            matched_rows = evaluated.0;
            matched_order_rows = evaluated.1;
            coverage = ratio(matched_rows, evaluated_rows);
            suggested_mapping = Some(mapping);
            emit(json!({
                "type": "log",
                "level": "success",
                "message": format!("模板优先匹配成功：{template_name}"),
            }));
        }
    } else if !order_candidates.is_empty() && !pricing_candidates.is_empty() {
        let mut combinations = Vec::new();
        for order in order_candidates.iter().take(6) {
            for pricing in pricing_candidates.iter().take(6) {
                for mapping in mapping_variants(order, pricing) {
                    let order_sheet = workbook
                        .sheets
                        .iter()
                        .find(|sheet| sheet.name == mapping.order_sheet);
                    let pricing_sheet = workbook
                        .sheets
                        .iter()
                        .find(|sheet| sheet.name == mapping.pricing_sheet);
                    if let (Some(order_sheet), Some(pricing_sheet)) = (order_sheet, pricing_sheet) {
                        let index = build_price_index(pricing_sheet, &mapping, &config.pricing);
                        let lines = read_order_lines(order_sheet, &mapping, config).0;
                        let total = lines.len();
                        let (matched, matched_rows) = evaluate_matches(&index, &lines);
                        let pair_coverage = ratio(matched, total);
                        combinations.push(MappingCandidateEvaluation {
                            coverage: pair_coverage,
                            sheet_score: order.score + pricing.score,
                            field_score: sku_qty_field_score(order_sheet, &mapping, config),
                            total,
                            matched,
                            mapping,
                            matched_rows,
                        });
                    }
                }
            }
        }
        combinations.sort_by(|left, right| {
            right
                .coverage
                .total_cmp(&left.coverage)
                .then_with(|| right.sheet_score.total_cmp(&left.sheet_score))
                .then_with(|| right.field_score.total_cmp(&left.field_score))
                .then_with(|| right.total.cmp(&left.total))
                .then_with(|| {
                    left.mapping
                        .sku_qty_pairs
                        .len()
                        .cmp(&right.mapping.sku_qty_pairs.len())
                })
        });
        if combinations
            .iter()
            .any(|item| item.mapping.order_sheet != item.mapping.pricing_sheet)
        {
            combinations.retain(|item| item.mapping.order_sheet != item.mapping.pricing_sheet);
        }
        if let Some(best) = combinations.first().cloned() {
            coverage = best.coverage;
            evaluated_rows = best.total;
            matched_rows = best.matched;
            matched_order_rows = best.matched_rows.clone();
            if let Some(runner_up) = combinations
                .iter()
                .skip(1)
                .find(|candidate| !mapping_is_nested_variant(&best.mapping, &candidate.mapping))
            {
                runner_up_coverage = Some(runner_up.coverage);
                let same_sheet_pair = best.mapping.order_sheet == runner_up.mapping.order_sheet
                    && best.mapping.pricing_sheet == runner_up.mapping.pricing_sheet;
                let best_comparison_score = if same_sheet_pair {
                    best.field_score
                } else {
                    best.sheet_score
                };
                let runner_up_comparison_score = if same_sheet_pair {
                    runner_up.field_score
                } else {
                    runner_up.sheet_score
                };
                let comparison_score_kind = if same_sheet_pair { "field" } else { "sheet" };
                score_gap = Some((best_comparison_score - runner_up_comparison_score).max(0.0));
                if let Some(kind) = classify_candidate_ambiguity(
                    &best.mapping,
                    &runner_up.mapping,
                    best.coverage - runner_up.coverage,
                    best_comparison_score - runner_up_comparison_score,
                    config,
                ) {
                    candidate_score = Some(best_comparison_score);
                    runner_up_score = Some(runner_up_comparison_score);
                    automation_score_kind = Some(comparison_score_kind.to_string());
                    ambiguity_reason = Some(candidate_ambiguity_reason(
                        kind,
                        &best.mapping,
                        &runner_up.mapping,
                    ));
                }
            }
            suggested_mapping = Some(best.mapping);
            if let Some(reason) = ambiguity_reason.as_ref() {
                issues.push(format!("{reason}，需要确认"));
            }
        }
    }

    let mut automation_decision = decide_automation(
        config,
        suggested_mapping.as_ref(),
        !order_candidates.is_empty(),
        !pricing_candidates.is_empty(),
        evaluated_rows,
        matched_rows,
        coverage,
        runner_up_coverage,
        score_gap,
        ambiguity_reason.as_deref(),
    );
    automation_decision.candidate_score = candidate_score;
    automation_decision.runner_up_score = runner_up_score;
    automation_decision.score_kind = automation_score_kind;
    if let Some(mapping) = suggested_mapping.as_ref()
        && let Some(order_sheet) = workbook
            .sheets
            .iter()
            .find(|sheet| sheet.name == mapping.order_sheet)
    {
        let quantity_exception_count = read_order_lines(order_sheet, mapping, config)
            .1
            .iter()
            .filter(|exception| matches!(exception.kind.as_str(), "数量无效" | "SKU关系无法计算"))
            .count();
        if quantity_exception_count > 0 {
            let reason = format!("{quantity_exception_count} 行数量无法计算，需要确认");
            if !automation_decision.reasons.contains(&reason) {
                automation_decision.reasons.push(reason.clone());
            }
            if automation_decision.status == "eligible" {
                automation_decision.status = "confirm".to_string();
            }
            issues.push(reason);
        }
    }
    let requires_confirmation = automation_decision.status != "eligible";
    if suggested_mapping
        .as_ref()
        .is_some_and(|mapping| mapping.order_sheet == mapping.pricing_sheet)
    {
        issues.push("订单 Sheet 与核价 Sheet 被识别为同一页，需要确认".to_string());
    }
    if coverage < config.automation.coverage_threshold && suggested_mapping.is_some() {
        issues.push(format!(
            "当前建议映射的试算覆盖率为 {:.1}%",
            coverage * 100.0
        ));
    }
    let single_shipment_matching = suggested_mapping
        .as_ref()
        .and_then(|mapping| {
            workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.order_sheet)
                .map(|sheet| single_shipment_matching_status(sheet, mapping, config))
        })
        .unwrap_or_else(|| single_shipment_matching_unavailable(config, "尚未确定订单字段映射"));
    let (writeback_rows, unmatched_rows) = suggested_mapping
        .as_ref()
        .and_then(|mapping| {
            let order_sheet = workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.order_sheet)?;
            let pricing_sheet = workbook
                .sheets
                .iter()
                .find(|sheet| sheet.name == mapping.pricing_sheet)?;
            let index = build_price_index(pricing_sheet, mapping, &config.pricing);
            let (lines, _, resolved_quantities) = read_order_lines(order_sheet, mapping, config);
            Some((
                calculate_preview_writeback_rows(
                    order_sheet,
                    mapping,
                    &index,
                    &lines,
                    &resolved_quantities,
                    &[],
                ),
                unmatched_price_issues(&index, mapping, &lines),
            ))
        })
        .unwrap_or_default();
    Ok(PriceAnalysisFile {
        input_path: path.display().to_string(),
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        order_sheet_candidates: order_candidates,
        pricing_sheet_candidates: pricing_candidates,
        suggested_mapping,
        coverage,
        matched_order_rows,
        writeback_rows,
        unmatched_rows,
        single_shipment_matching,
        requires_confirmation,
        automation_decision,
        issues,
    })
}

pub(super) fn mapping_is_nested_variant(
    left_mapping: &PriceCheckMapping,
    right_mapping: &PriceCheckMapping,
) -> bool {
    let mut left_base = left_mapping.clone();
    let mut right_base = right_mapping.clone();
    left_base.sku_qty_pairs.clear();
    right_base.sku_qty_pairs.clear();
    if left_base != right_base {
        return false;
    }
    let left_pairs = left_mapping.sku_qty_pairs.iter().collect::<HashSet<_>>();
    let right_pairs = right_mapping.sku_qty_pairs.iter().collect::<HashSet<_>>();
    left_pairs.is_subset(&right_pairs) || right_pairs.is_subset(&left_pairs)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn decide_automation(
    config: &Config,
    mapping: Option<&PriceCheckMapping>,
    has_order_candidate: bool,
    has_pricing_candidate: bool,
    evaluated_rows: usize,
    matched_rows: usize,
    coverage: f64,
    runner_up_coverage: Option<f64>,
    score_gap: Option<f64>,
    ambiguity_reason: Option<&str>,
) -> AutomationDecision {
    let mut reasons = Vec::new();
    if mapping.is_none() {
        reasons.push("没有生成可用字段映射".to_string());
    } else if !mapping.is_some_and(mapping_is_complete) {
        reasons.push("订单号、国家、数量/SKU/合并数量或核价档位等必需字段不完整".to_string());
    }
    if mapping.is_some_and(|value| value.order_sheet == value.pricing_sheet) {
        reasons.push("订单 Sheet 与核价 Sheet 不能相同".to_string());
    }
    if evaluated_rows == 0 {
        reasons.push("没有可用于试算的订单行".to_string());
    } else if evaluated_rows < config.automation.min_trial_rows && coverage < 1.0 {
        reasons.push(format!(
            "试算少于 {} 行时覆盖率必须达到 100%",
            config.automation.min_trial_rows
        ));
    } else if evaluated_rows >= config.automation.min_trial_rows
        && coverage < config.automation.coverage_threshold
    {
        reasons.push(format!(
            "试算覆盖率低于 {:.1}%",
            config.automation.coverage_threshold * 100.0
        ));
    }
    if let Some(reason) = ambiguity_reason {
        reasons.push(reason.to_string());
    }
    if !config.automation.auto_run {
        reasons.push("配置已关闭自动核价".to_string());
    }
    let status = if mapping.is_none() || !has_order_candidate || !has_pricing_candidate {
        "error"
    } else if reasons.is_empty() {
        "eligible"
    } else {
        "confirm"
    };
    AutomationDecision {
        status: status.to_string(),
        reasons,
        evaluated_rows,
        matched_rows,
        coverage,
        runner_up_coverage,
        candidate_score: None,
        runner_up_score: None,
        score_kind: None,
        score_gap,
    }
}

pub(super) fn classify_candidate_ambiguity(
    best: &PriceCheckMapping,
    runner_up: &PriceCheckMapping,
    coverage_gap: f64,
    score_gap: f64,
    config: &Config,
) -> Option<CandidateAmbiguity> {
    if coverage_gap >= config.automation.candidate_coverage_gap
        || score_gap >= config.automation.candidate_score_gap
    {
        return None;
    }
    let same_sheet_pair =
        best.order_sheet == runner_up.order_sheet && best.pricing_sheet == runner_up.pricing_sheet;
    Some(if same_sheet_pair {
        CandidateAmbiguity::Column
    } else {
        CandidateAmbiguity::Sheet
    })
}

pub(super) fn candidate_ambiguity_reason(
    kind: CandidateAmbiguity,
    best: &PriceCheckMapping,
    runner_up: &PriceCheckMapping,
) -> String {
    match kind {
        CandidateAmbiguity::Sheet => format!(
            "订单/核价 Sheet 候选差距不足：最优 [订单 {} / 核价 {}]；次优 [订单 {} / 核价 {}]",
            best.order_sheet, best.pricing_sheet, runner_up.order_sheet, runner_up.pricing_sheet
        ),
        CandidateAmbiguity::Column => format!(
            "同一 Sheet 组合下，字段列候选差距不足：最优 [{}]；次优 [{}]",
            sku_qty_columns_summary(best),
            sku_qty_columns_summary(runner_up)
        ),
    }
}

fn sku_qty_columns_summary(mapping: &PriceCheckMapping) -> String {
    mapping
        .sku_qty_pairs
        .iter()
        .map(|pair| {
            format!(
                "原始数量 {}{} / SKU {}{} / 合并数量 {}{}",
                excel_column_label(pair.qty_column),
                header_suffix(&pair.qty_header),
                excel_column_label(pair.sku_column),
                header_suffix(&pair.sku_header),
                excel_column_label(pair.merged_qty_column),
                header_suffix(&pair.merged_qty_header)
            )
        })
        .collect::<Vec<_>>()
        .join("、")
}

fn header_suffix(header: &str) -> String {
    let header = header.trim();
    if header.is_empty() {
        String::new()
    } else {
        format!("（{header}）")
    }
}

pub(super) fn excel_column_label(mut column: usize) -> String {
    if column == 0 {
        return "未设置".to_string();
    }
    let mut label = String::new();
    while column > 0 {
        let remainder = (column - 1) % 26;
        label.insert(0, char::from(b'A' + remainder as u8));
        column = (column - 1) / 26;
    }
    label
}

pub(super) fn mapping_is_complete(mapping: &PriceCheckMapping) -> bool {
    mapping.business_order_number_column.is_some()
        && (mapping.country_code_column.is_some()
            || mapping.country_english_column.is_some()
            || mapping.country_chinese_column.is_some())
        && !mapping.sku_qty_pairs.is_empty()
        && mapping.pricing_sku_column > 0
        && mapping.pricing_country_column > 0
        && !mapping.quantity_tier_columns.is_empty()
}

pub(super) fn mapping_from_candidates(
    order: &OrderSheetCandidate,
    pricing: &PricingSheetCandidate,
) -> PriceCheckMapping {
    PriceCheckMapping {
        order_sheet: order.sheet_name.clone(),
        order_header_row: order.header_row,
        business_order_number_column: order.business_order_number_column,
        country_code_column: order.country_code_column,
        country_english_column: order.country_english_column,
        country_chinese_column: order.country_chinese_column,
        sku_qty_pairs: order.sku_qty_pairs.clone(),
        single_shipment_column: order.single_shipment_column,
        single_shipment_fields: order.single_shipment_fields.clone(),
        order_price_column: order.price_column,
        pricing_sheet: pricing.sheet_name.clone(),
        pricing_header_row: pricing.header_row,
        pricing_quantity_header_row: pricing.quantity_header_row,
        pricing_sku_column: pricing.sku_column.unwrap_or(1),
        pricing_country_column: pricing.country_column.unwrap_or(1),
        quantity_tier_columns: pricing.tier_columns.clone(),
    }
}

pub(super) fn mapping_variants(
    order: &OrderSheetCandidate,
    pricing: &PricingSheetCandidate,
) -> Vec<PriceCheckMapping> {
    vec![mapping_from_candidates(order, pricing)]
}
