use crate::config::{CountryIdentity, PricingRules};
use crate::country_catalog::COUNTRY_ALIASES;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub(super) struct CountryInfo {
    pub(super) code: String,
    pub(super) english: String,
    pub(super) chinese: String,
    pub(super) routes: Vec<String>,
    pub(super) conflict: bool,
    pub(super) reason: String,
}

fn country_token(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(character, '-' | '_' | '/' | '—' | '（' | '）' | '(' | ')')
        })
        .flat_map(char::to_uppercase)
        .collect()
}

pub(super) fn country_lookup(value: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let token = country_token(value);
    COUNTRY_ALIASES
        .iter()
        .find_map(|(code, english, chinese, alias)| {
            (token == *code
                || token == country_token(english)
                || token == country_token(chinese)
                || alias.iter().any(|item| token == country_token(item)))
            .then_some((*code, *english, *chinese))
        })
}

pub(super) fn country_route_token(value: &str) -> String {
    value.trim().to_uppercase()
}

pub(super) fn normalize_country_fields(code: &str, english: &str, chinese: &str) -> CountryInfo {
    // 国家字段按整格识别，不再从「UNITED STATES-hold」一类字符串拆物流后缀
    let inputs = [code, english, chinese];
    let mut resolved = Vec::new();
    for input in inputs {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(item) = country_lookup(trimmed) {
            resolved.push((item.0.to_string(), item.1.to_string(), item.2.to_string()));
        } else if trimmed.len() == 2
            && trimmed
                .chars()
                .all(|character| character.is_ascii_alphabetic())
        {
            resolved.push((trimmed.to_ascii_uppercase(), String::new(), String::new()));
        }
    }
    let codes = resolved
        .iter()
        .map(|item| item.0.as_str())
        .collect::<HashSet<_>>();
    if codes.len() > 1 {
        return CountryInfo {
            code: resolved
                .first()
                .map(|item| item.0.clone())
                .unwrap_or_default(),
            english: english.trim().to_string(),
            chinese: chinese.trim().to_string(),
            routes: inputs
                .iter()
                .map(|value| country_route_token(value))
                .filter(|value| !value.is_empty())
                .collect(),
            conflict: true,
            reason: format!("国家三要素冲突: code={code}, en={english}, cn={chinese}"),
        };
    }
    let (resolved_code, resolved_en, resolved_cn) = resolved.first().cloned().unwrap_or_default();
    let resolved_code_empty = resolved_code.is_empty();
    CountryInfo {
        code: resolved_code,
        english: if resolved_en.is_empty() {
            english.trim().to_string()
        } else {
            resolved_en
        },
        chinese: if resolved_cn.is_empty() {
            chinese.trim().to_string()
        } else {
            resolved_cn
        },
        routes: inputs
            .iter()
            .map(|value| country_route_token(value))
            .filter(|value| !value.is_empty())
            .collect(),
        conflict: false,
        reason: if resolved_code_empty {
            "无法识别国家".to_string()
        } else {
            String::new()
        },
    }
}

pub(super) fn normalize_order_country_fields(
    code: &str,
    english: &str,
    chinese: &str,
    rules: &PricingRules,
) -> CountryInfo {
    let enabled_values = [
        (rules.uses_country_identity(CountryIdentity::Iso2), code),
        (
            rules.uses_country_identity(CountryIdentity::English),
            english,
        ),
        (
            rules.uses_country_identity(CountryIdentity::Chinese),
            chinese,
        ),
    ];
    let mut country = normalize_country_fields(
        if enabled_values[0].0 {
            enabled_values[0].1
        } else {
            ""
        },
        if enabled_values[1].0 {
            enabled_values[1].1
        } else {
            ""
        },
        if enabled_values[2].0 {
            enabled_values[2].1
        } else {
            ""
        },
    );
    country.routes = enabled_values
        .into_iter()
        .filter(|(enabled, _)| *enabled)
        .map(|(_, value)| country_route_token(value))
        .filter(|value| !value.is_empty())
        .fold(Vec::new(), |mut routes, route| {
            if !routes.contains(&route) {
                routes.push(route);
            }
            routes
        });
    country
}
