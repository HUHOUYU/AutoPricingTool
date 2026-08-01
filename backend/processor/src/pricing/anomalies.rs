use super::*;
use std::collections::HashSet;

const PRICING_ANOMALY_SAMPLE_LIMIT: usize = 20;

fn push_sample(samples: &mut Vec<PricingAnomalySample>, row: &PriceWritebackRow, reason: String) {
    if samples.len() >= PRICING_ANOMALY_SAMPLE_LIMIT {
        return;
    }
    samples.push(PricingAnomalySample {
        source_row: row.source_row,
        reason,
        pricing_price: row.pricing_price,
        price_difference: row.price_difference,
        quantity: row.quantity,
    });
}

pub(super) fn summarize_pricing_anomalies(rows: &[PriceWritebackRow]) -> PricingAnomalySummary {
    let mut affected_rows = HashSet::new();
    let mut price_unavailable_rows = HashSet::new();
    let mut amount_difference_rows = HashSet::new();
    let mut positive_difference_rows = HashSet::new();
    let mut negative_difference_rows = HashSet::new();
    let mut quantity_anomaly_rows = HashSet::new();
    let mut quantity_mismatch_rows = HashSet::new();
    let mut quantity_calculation_error_rows = HashSet::new();
    let mut price_unavailable_samples = Vec::new();
    let mut amount_difference_samples = Vec::new();
    let mut quantity_mismatch_samples = Vec::new();
    let mut quantity_calculation_error_samples = Vec::new();

    for row in rows {
        if row.pricing_price.is_none() && price_unavailable_rows.insert(row.source_row) {
            affected_rows.insert(row.source_row);
            push_sample(
                &mut price_unavailable_samples,
                row,
                "核价价格为空".to_string(),
            );
        }

        if let Some(difference) = row.price_difference {
            let normalized = normalize_price_difference(difference);
            if normalized != 0.0 {
                if normalized > 0.0 {
                    positive_difference_rows.insert(row.source_row);
                } else {
                    negative_difference_rows.insert(row.source_row);
                }
                if amount_difference_rows.insert(row.source_row) {
                    affected_rows.insert(row.source_row);
                    push_sample(
                        &mut amount_difference_samples,
                        row,
                        format!(
                            "金额差{}{}",
                            if normalized > 0.0 {
                                "为正 "
                            } else {
                                "为负 "
                            },
                            normalized
                        ),
                    );
                }
            }
        }

        let quantity_error = row.quantity_error.as_deref().unwrap_or("").trim();
        if row.quantity_mismatch && quantity_mismatch_rows.insert(row.source_row) {
            affected_rows.insert(row.source_row);
            quantity_anomaly_rows.insert(row.source_row);
            push_sample(
                &mut quantity_mismatch_samples,
                row,
                "数量不一致".to_string(),
            );
        }
        if !quantity_error.is_empty() && quantity_calculation_error_rows.insert(row.source_row) {
            affected_rows.insert(row.source_row);
            quantity_anomaly_rows.insert(row.source_row);
            push_sample(
                &mut quantity_calculation_error_samples,
                row,
                quantity_error.to_string(),
            );
        }
    }

    PricingAnomalySummary {
        affected_rows: affected_rows.len(),
        price_unavailable_rows: price_unavailable_rows.len(),
        amount_difference_rows: amount_difference_rows.len(),
        positive_difference_rows: positive_difference_rows.len(),
        negative_difference_rows: negative_difference_rows.len(),
        quantity_anomaly_rows: quantity_anomaly_rows.len(),
        quantity_mismatch_rows: quantity_mismatch_rows.len(),
        quantity_calculation_error_rows: quantity_calculation_error_rows.len(),
        price_unavailable_samples,
        amount_difference_samples,
        quantity_mismatch_samples,
        quantity_calculation_error_samples,
    }
}
