use std::collections::HashMap;

pub(super) fn normalize_sku(value: &str) -> String {
    value
        .trim()
        .replace([' ', '\u{3000}', '\t', '\r', '\n'], "")
        .to_ascii_uppercase()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkuExpression {
    pub(super) normalized: String,
    pub(super) components: HashMap<String, usize>,
}

pub(super) fn parse_sku_expression(value: &str) -> Result<SkuExpression, String> {
    let normalized = normalize_sku(value);
    if normalized.is_empty() {
        return Err("SKU为空".to_string());
    }
    let mut components = HashMap::new();
    for raw_component in normalized.split('+') {
        if raw_component.is_empty() {
            return Err(format!("SKU格式无效: {normalized}"));
        }
        let (sku, multiplier) = if let Some((sku, multiplier)) = raw_component.rsplit_once('*') {
            let multiplier = multiplier
                .parse::<usize>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| format!("SKU倍数无效: {raw_component}"))?;
            if sku.is_empty() {
                return Err(format!("SKU格式无效: {raw_component}"));
            }
            (sku, multiplier)
        } else {
            (raw_component, 1)
        };
        let total = components.entry(sku.to_string()).or_insert(0usize);
        *total = total
            .checked_add(multiplier)
            .ok_or_else(|| format!("SKU倍数过大: {raw_component}"))?;
    }
    Ok(SkuExpression {
        normalized,
        components,
    })
}

pub(super) fn calculate_related_quantity(
    main_sku: &str,
    previous_sku: &str,
    source_quantity: usize,
) -> Result<usize, String> {
    let main = parse_sku_expression(main_sku)?;
    let previous = parse_sku_expression(previous_sku)?;
    if main.normalized == previous.normalized {
        return Ok(source_quantity);
    }

    // 主要 SKU 为基础子串时，累计前一 SKU 中所有对应组件的件数。
    if main.components.len() == 1
        && main.components.values().next() == Some(&1)
        && !main.normalized.contains(['+', '*'])
    {
        let multiplier = previous
            .components
            .iter()
            .filter_map(|(sku, quantity)| {
                sku_matches_base_sku(sku, &main.normalized).then_some(*quantity)
            })
            .try_fold(0usize, |total, quantity| total.checked_add(quantity));
        if let Some(multiplier) = multiplier.filter(|value| *value > 0) {
            return source_quantity
                .checked_mul(multiplier)
                .ok_or_else(|| "数量计算溢出".to_string());
        }
    }

    // 复合 SKU 不相同时，仅使用双方共同组件的倍数比例；比例冲突则不猜测。
    let shared_ratios = previous
        .components
        .iter()
        .filter_map(|(sku, previous_count)| {
            main.components
                .get(sku)
                .map(|main_count| (*previous_count, *main_count))
        })
        .collect::<Vec<_>>();
    let Some((ratio_numerator, ratio_denominator)) = shared_ratios.first().copied() else {
        return Err(format!(
            "SKU关系无法计算: 前一SKU {previous_sku} 与主要SKU {main_sku} 无共同组件"
        ));
    };
    if shared_ratios.iter().any(|(numerator, denominator)| {
        numerator.saturating_mul(ratio_denominator) != ratio_numerator.saturating_mul(*denominator)
    }) {
        return Err(format!(
            "SKU关系无法计算: 前一SKU {previous_sku} 与主要SKU {main_sku} 的组件比例冲突"
        ));
    }
    let scaled = source_quantity
        .checked_mul(ratio_numerator)
        .ok_or_else(|| "数量计算溢出".to_string())?;
    Ok(scaled.div_ceil(ratio_denominator))
}

fn sku_matches_base_sku(candidate: &str, base: &str) -> bool {
    if candidate.contains(base) {
        return true;
    }

    let candidate_segments = candidate.split('-').collect::<Vec<_>>();
    let base_segments = base.split('-').collect::<Vec<_>>();
    if base_segments.len() < 2
        || candidate_segments.len() <= base_segments.len()
        || candidate_segments.first() != base_segments.first()
        || candidate_segments.last() != base_segments.last()
    {
        return false;
    }

    let mut next_candidate_index = 0usize;
    base_segments.iter().all(|base_segment| {
        let Some(relative_index) = candidate_segments[next_candidate_index..]
            .iter()
            .position(|candidate_segment| candidate_segment == base_segment)
        else {
            return false;
        };
        next_candidate_index += relative_index + 1;
        true
    })
}
