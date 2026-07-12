use crate::config::{Config, FilenameRules};
use chrono::NaiveDate;
use regex::{Captures, Regex};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

static DUPLICATE_MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[（(]\d+[）)]|\s*[-_]?\s*副本").expect("duplicate marker regex must compile")
});
static DATE_PLACEHOLDER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{(?P<name>[A-Za-z0-9_]+)(?::(?P<width>0?\d+))?\}")
        .expect("date placeholder regex must compile")
});
static RENDERED_DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<y>\d{4})[.](?P<m>\d{1,2})[.](?P<d>\d{1,2})")
        .expect("rendered date regex must compile")
});

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

pub(crate) fn duplicate_groups(files: &[PathBuf]) -> HashSet<String> {
    files
        .iter()
        .filter(|path| has_duplicate_marker(path))
        .map(|path| duplicate_group_key(path))
        .collect()
}

fn has_duplicate_marker(path: &Path) -> bool {
    DUPLICATE_MARKER_RE.is_match(&file_stem(path))
}

pub(crate) fn duplicate_group_key(path: &Path) -> String {
    DUPLICATE_MARKER_RE
        .replace_all(&file_stem(path), "")
        .trim()
        .to_lowercase()
}

pub(crate) fn normalize_source_filename(path: &Path, config: &Config) -> String {
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let stem = compact_spaces(&file_stem(path));
    if let Some(rule) = config.filename_rules.special_filenames.get(&stem) {
        return build_standard_name(
            &rule.name,
            &rule.dates,
            if rule.extra.is_empty() {
                "无额外信息"
            } else {
                &rule.extra
            },
            &suffix,
        );
    }
    if let Some((dates, before, after)) = parse_filename_date(&stem, &config.filename_rules) {
        let before = compact_spaces(&before);
        let after = compact_spaces(&after);
        let (name, extra) = if before.is_empty() {
            split_name_and_extra(&after, &config.filename_rules.exclude_keywords)
        } else if let Some((name, before_extra)) =
            split_by_keyword(&before, &config.filename_rules.exclude_keywords)
        {
            if name.is_empty() {
                split_name_and_extra(&after, &config.filename_rules.exclude_keywords)
            } else {
                (name, compact_spaces(&format!("{before_extra} {after}")))
            }
        } else {
            (before, after)
        };
        return build_standard_name(&name, &dates, &extra, &suffix);
    }
    if let Some((name, extra)) = split_by_keyword(&stem, &config.filename_rules.exclude_keywords) {
        return build_standard_name(&name, "无日期", &extra, &suffix);
    }
    let (name, extra) = split_name_and_extra(&stem, &config.filename_rules.exclude_keywords);
    build_standard_name(&name, "无日期", &extra, &suffix)
}

fn parse_filename_date(text: &str, rules: &FilenameRules) -> Option<(String, String, String)> {
    for (pattern_index, regex) in &rules.compiled_date_patterns {
        let Some(pattern) = rules.date_patterns.get(*pattern_index) else {
            continue;
        };
        let Some(caps) = regex.captures(text) else {
            continue;
        };
        let Some(matched) = caps.name("date").or_else(|| caps.get(0)) else {
            continue;
        };
        if pattern.no_digit_neighbors && has_digit_neighbor(text, matched.start(), matched.end()) {
            continue;
        }
        if !pattern.exclude_prefixes.is_empty() {
            let before = text[..matched.start()]
                .trim_end_matches(['-', '_', ' ', '.'])
                .to_lowercase();
            if pattern
                .exclude_prefixes
                .iter()
                .any(|p| before.ends_with(&p.to_lowercase()))
            {
                continue;
            }
        }
        let Some(dates) = render_filename_date_output(&pattern.output, &caps, rules.default_year)
        else {
            continue;
        };
        return Some((
            dates,
            text[..matched.start()].to_string(),
            text[matched.end()..].to_string(),
        ));
    }
    None
}

fn render_filename_date_output(
    template: &str,
    caps: &Captures<'_>,
    default_year: i32,
) -> Option<String> {
    let mut output = String::new();
    let mut last_end = 0;
    for item in DATE_PLACEHOLDER_RE.captures_iter(template) {
        let matched = item.get(0)?;
        output.push_str(&template[last_end..matched.start()]);
        let name = item.name("name")?.as_str();
        let width = item
            .name("width")
            .and_then(|value| value.as_str().trim_start_matches('0').parse::<usize>().ok());
        let value = filename_date_token_value(name, caps, default_year, width)?;
        output.push_str(&value);
        last_end = matched.end();
    }
    output.push_str(&template[last_end..]);
    validate_rendered_dates(&output)?;
    Some(output)
}

fn filename_date_token_value(
    name: &str,
    caps: &Captures<'_>,
    default_year: i32,
    width: Option<usize>,
) -> Option<String> {
    if name == "year" {
        return Some(default_year.to_string());
    }
    let raw = caps.name(name)?.as_str();
    let value = if name == "mon" || name.starts_with("mon") {
        month_name_number(raw)?
    } else {
        raw.parse::<u32>().ok()?
    };
    validate_filename_date_part(name, value)?;
    if let Some(width) = width {
        Some(format!("{value:0width$}"))
    } else {
        Some(raw.to_string())
    }
}

fn month_name_number(value: &str) -> Option<u32> {
    match value.to_ascii_uppercase().as_str() {
        "JAN" => Some(1),
        "FEB" => Some(2),
        "MAR" => Some(3),
        "APR" => Some(4),
        "MAY" => Some(5),
        "JUN" | "JUNE" => Some(6),
        "JUL" => Some(7),
        "AUG" => Some(8),
        "SEP" => Some(9),
        "OCT" => Some(10),
        "NOV" => Some(11),
        "DEC" => Some(12),
        _ => None,
    }
}

fn validate_filename_date_part(name: &str, value: u32) -> Option<()> {
    let first = name.chars().next()?;
    match first {
        'm' => (1..=12).contains(&value).then_some(()),
        'd' => (1..=31).contains(&value).then_some(()),
        _ => Some(()),
    }
}

fn validate_rendered_dates(output: &str) -> Option<()> {
    for caps in RENDERED_DATE_RE.captures_iter(output) {
        let year = caps.name("y")?.as_str().parse::<i32>().ok()?;
        let month = caps.name("m")?.as_str().parse::<u32>().ok()?;
        let day = caps.name("d")?.as_str().parse::<u32>().ok()?;
        NaiveDate::from_ymd_opt(year, month, day)?;
    }
    Some(())
}

fn has_digit_neighbor(text: &str, start: usize, end: usize) -> bool {
    text[..start]
        .chars()
        .next_back()
        .is_some_and(|value| value.is_ascii_digit())
        || text[end..]
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_digit())
        || has_date_separator_neighbor(text, start, end)
}

fn has_date_separator_neighbor(text: &str, _start: usize, end: usize) -> bool {
    let mut after = text[end..].chars();
    let Some(separator @ ('.' | '-')) = after.next() else {
        return false;
    };
    let digits = after
        .take_while(|value| value.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return false;
    }
    if separator == '.'
        && digits.len() == 4
        && (digits.starts_with("19") || digits.starts_with("20"))
    {
        return false;
    }
    digits.len() >= 2
}

fn build_standard_name(name: &str, dates: &str, extra: &str, suffix: &str) -> String {
    format!(
        "{}__{}__{}{}",
        clean_name_part(name).unwrap_or_else(|| "未命名".to_string()),
        dates,
        normalize_extra(extra),
        suffix
    )
}

fn compact_spaces(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '_', '-'])
        .to_string()
}

fn clean_name_part(value: &str) -> Option<String> {
    let value = compact_spaces(value)
        .trim_matches([' ', '.', '_', '~', '-'])
        .to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn normalize_extra(value: &str) -> String {
    let value = clean_name_part(value).unwrap_or_default();
    if value.is_empty() {
        "无额外信息".to_string()
    } else {
        value
    }
}

fn split_name_and_extra(text: &str, keywords: &[String]) -> (String, String) {
    split_by_keyword(text, keywords)
        .or_else(|| split_by_order_marker(text))
        .unwrap_or_else(|| (text.to_string(), String::new()))
}

fn split_by_keyword(text: &str, keywords: &[String]) -> Option<(String, String)> {
    let lower = text.to_lowercase();
    let mut best = None;
    for keyword in keywords {
        if let Some(index) = lower.find(&keyword.to_lowercase()) {
            best = Some(best.map_or(index, |current: usize| current.min(index)));
        }
    }
    best.map(|index| {
        (
            clean_name_part(&text[..index]).unwrap_or_default(),
            compact_spaces(&text[index..]),
        )
    })
}

fn split_by_order_marker(text: &str) -> Option<(String, String)> {
    let index = text.find('#')?;
    let name = clean_name_part(&text[..index])?;
    Some((name, compact_spaces(&text[index..])))
}

pub(crate) fn requires_manual_confirmation(path: &Path, config: &Config) -> bool {
    let stem = file_stem(path);
    if config
        .filename_rules
        .compiled_manual_confirm_patterns
        .iter()
        .any(|regex| regex.is_match(&stem))
    {
        return true;
    }

    config
        .filename_rules
        .compiled_manual_confirm_patterns
        .is_empty()
        && config
            .filename_rules
            .manual_confirm_patterns
            .iter()
            .filter_map(|pattern| Regex::new(&format!("(?i){pattern}")).ok())
            .any(|regex| regex.is_match(&stem))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{FilenameDatePattern, SpecialFilename};

    fn parse_dates(text: &str) -> Option<String> {
        parse_filename_date(text, &FilenameRules::default()).map(|(dates, _, _)| dates)
    }

    #[test]
    fn parses_configured_filename_date_formats() {
        assert_eq!(
            parse_dates("Practs-export-0626"),
            Some("2026.06.26".to_string())
        );
        assert_eq!(
            parse_dates("Practs-export-06.26"),
            Some("2026.06.26".to_string())
        );
        assert_eq!(
            parse_dates("Practs-export-06.26-06.30"),
            Some("2026.06.26-2026.06.30".to_string())
        );
        assert_eq!(
            parse_dates("PYJ-LIP ORDER JAN-01"),
            Some("2026.01.01".to_string())
        );
        assert_eq!(parse_dates("Order-020626"), Some("2026.06.02".to_string()));
        assert_eq!(
            parse_dates("Michelle Orders 6.15.2026"),
            Some("2026.06.15".to_string())
        );
        assert_eq!(
            parse_dates("CEL order 6-JUN1"),
            Some("2026.06.01".to_string())
        );
    }

    #[test]
    fn ignores_embedded_digit_neighbors() {
        assert_eq!(parse_dates("Zyn 6.213 #1503-#11510"), None);
        assert_eq!(parse_dates("Brand 06.21-06.303"), None);
    }

    #[test]
    fn normalizes_filename_with_date_and_extra_keyword() {
        let config = Config::default();
        let standard_name = normalize_source_filename(
            Path::new("C:/orders/Brand orders_export 06.26.xlsx"),
            &config,
        );

        assert_eq!(standard_name, "Brand__2026.06.26__orders_export.xlsx");
    }

    #[test]
    fn normalizes_order_prefix_date_name_and_order_marker() {
        let config = Config::default();
        let standard_name =
            normalize_source_filename(Path::new("C:/orders/order_6.1 Murtaza #1013.xlsx"), &config);

        assert_eq!(standard_name, "Murtaza__2026.06.01__#1013.xlsx");
    }

    #[test]
    fn splits_order_marker_without_date_from_name() {
        let config = Config::default();
        let standard_name =
            normalize_source_filename(Path::new("C:/orders/Laams #1101-1105.xlsx"), &config);

        assert_eq!(standard_name, "Laams__无日期__#1101-1105.xlsx");
    }

    #[test]
    fn configured_named_date_group_keeps_brand_prefix() {
        let mut config = Config::default();
        let pattern = FilenameDatePattern {
            _name: "known_brand_month_day_compact".to_string(),
            regex: r"(?i)(?:Voldara|Georgi|Meloa|Somnora)[-_\s]*(?:orders?[-_\s]*)?(?P<date>(?P<m>0[1-9]|1[0-2])(?P<d>0[1-9]|[12]\d|3[01]))".to_string(),
            output: "{year}.{m}.{d}".to_string(),
            no_digit_neighbors: true,
            exclude_prefixes: Vec::new(),
        };
        let regex = Regex::new(&pattern.regex).expect("test regex must compile");
        config.filename_rules.date_patterns = vec![pattern];
        config.filename_rules.compiled_date_patterns = vec![(0, regex)];

        let standard_name =
            normalize_source_filename(Path::new("C:/orders/Voldara-0610.xlsx"), &config);

        assert_eq!(standard_name, "Voldara__2026.06.10__无额外信息.xlsx");
    }

    #[test]
    fn uses_configured_special_filename_rule() {
        let mut config = Config::default();
        config.filename_rules.special_filenames.insert(
            "VIP Source".to_string(),
            SpecialFilename {
                name: "VIP Brand".to_string(),
                dates: "2026.07.01".to_string(),
                extra: "manual".to_string(),
            },
        );

        let standard_name =
            normalize_source_filename(Path::new("C:/orders/VIP Source.xlsx"), &config);

        assert_eq!(standard_name, "VIP Brand__2026.07.01__manual.xlsx");
    }

    #[test]
    fn rejects_invalid_month_and_day_values() {
        assert_eq!(parse_dates("Brand 13.01"), None);
        assert_eq!(parse_dates("Brand 12.32"), None);
        assert_eq!(parse_dates("Brand 02.31"), None);
        assert_eq!(parse_dates("Brand FOO-01"), None);
    }

    #[test]
    fn detects_manual_confirmation_patterns_case_insensitively() {
        let mut config = Config::default();
        config.filename_rules.manual_confirm_patterns = vec!["need[-_ ]?check".to_string()];

        assert!(requires_manual_confirmation(
            Path::new("C:/orders/NEED_check.xlsx"),
            &config
        ));
        assert!(!requires_manual_confirmation(
            Path::new("C:/orders/Brand.xlsx"),
            &config
        ));
    }
}
