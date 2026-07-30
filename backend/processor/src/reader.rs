use crate::config::Config;
use crate::excel_engine::{CellValue, SheetData, WorkbookData};
use anyhow::{Context, Result, anyhow};
use calamine::{Data, Reader, SheetVisible, open_workbook_auto};
use quick_xml::Reader as XmlReader;
use quick_xml::escape::unescape;
use quick_xml::events::{BytesStart, BytesText, Event};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read};
use std::path::Path;
use std::sync::Arc;
use zip::ZipArchive;
use zip::result::ZipError;

const QUICK_HEADER_SCAN_MAX_BYTES: u64 = 120 * 1024 * 1024;
const QUICK_SHARED_STRINGS_MAX_BYTES: u64 = 32 * 1024 * 1024;
const PROCESSING_WORKBOOK_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PROCESSING_XML_ENTRY_MAX_BYTES: u64 = 256 * 1024 * 1024;
const PROCESSING_SHARED_STRINGS_MAX_BYTES: u64 = 128 * 1024 * 1024;
const PROCESSING_MAX_ROWS: usize = 200_000;

#[derive(Debug)]
struct ResourceLimitError(String);

impl fmt::Display for ResourceLimitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ResourceLimitError {}

#[derive(Debug, Clone, Copy)]
struct ProcessingLimits {
    workbook_bytes: u64,
    xml_entry_bytes: u64,
    shared_strings_bytes: u64,
    max_rows: usize,
    max_columns: usize,
    trailing_empty_row_limit: usize,
}

impl ProcessingLimits {
    fn from_config(config: &Config, max_columns: Option<usize>) -> Self {
        Self {
            workbook_bytes: configured_bytes(
                config.performance.processing_workbook_max_mb,
                PROCESSING_WORKBOOK_MAX_BYTES,
            ),
            xml_entry_bytes: configured_bytes(
                config.performance.processing_xml_entry_max_mb,
                PROCESSING_XML_ENTRY_MAX_BYTES,
            ),
            shared_strings_bytes: configured_bytes(
                config.performance.processing_shared_strings_max_mb,
                PROCESSING_SHARED_STRINGS_MAX_BYTES,
            ),
            max_rows: positive_or_default(
                config.performance.processing_max_rows,
                PROCESSING_MAX_ROWS,
            ),
            max_columns: positive_or_default(
                max_columns.unwrap_or(config.sheet_rules.sample_column_scan_limit),
                config.sheet_rules.sample_column_scan_limit.max(1),
            ),
            trailing_empty_row_limit: config.sheet_rules.empty_gap_limit.max(1),
        }
    }
}

fn configured_bytes(size_mb: f64, fallback: u64) -> u64 {
    if size_mb.is_finite() && size_mb > 0.0 {
        (size_mb * 1024.0 * 1024.0) as u64
    } else {
        fallback
    }
}

fn positive_or_default(value: usize, fallback: usize) -> usize {
    if value > 0 { value } else { fallback }
}

fn resource_limit_error(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(ResourceLimitError(message.into()))
}

pub(crate) fn is_resource_limit_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<ResourceLimitError>().is_some())
}

fn ensure_size_within_limit(label: &str, actual: u64, maximum: u64) -> Result<()> {
    if actual > maximum {
        return Err(resource_limit_error(format!(
            "{label} 超过资源限制: {:.1} MB > {:.1} MB",
            actual as f64 / 1024.0 / 1024.0,
            maximum as f64 / 1024.0 / 1024.0,
        )));
    }
    Ok(())
}
pub(crate) fn configured_quick_scan_bytes(config: &Config) -> u64 {
    configured_bytes(
        config.performance.quick_header_scan_max_mb,
        QUICK_HEADER_SCAN_MAX_BYTES,
    )
}

pub(crate) fn configured_shared_strings_bytes(config: &Config) -> u64 {
    configured_bytes(
        config.performance.quick_shared_strings_max_mb,
        QUICK_SHARED_STRINGS_MAX_BYTES,
    )
}

fn validate_processing_workbook(path: &Path, limits: ProcessingLimits) -> Result<()> {
    let file_size = fs::metadata(path)
        .with_context(|| format!("读取文件信息失败: {}", path.display()))?
        .len();
    ensure_size_within_limit("工作簿文件", file_size, limits.workbook_bytes)
}

#[derive(Debug)]
struct XlsxSheetRef {
    name: String,
    path: String,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn read_xlsx_preview_fast(
    path: &Path,
    max_sheets: Option<usize>,
    max_rows: Option<usize>,
    max_columns: Option<usize>,
    max_xml_entry_bytes: u64,
    max_shared_strings_bytes: u64,
    reject_row_overflow: bool,
    trailing_empty_row_limit: Option<usize>,
) -> Result<(usize, WorkbookData)> {
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(suffix.as_str(), "xlsx" | "xlsm") {
        return Err(anyhow!("快速预览只支持 xlsx/xlsm"));
    }

    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let relationships = parse_workbook_relationships(&mut archive, max_xml_entry_bytes)?;
    let (sheet_count, sheet_refs) =
        parse_workbook_sheets(&mut archive, &relationships, max_xml_entry_bytes)?;
    let shared_strings = parse_shared_strings(&mut archive, max_shared_strings_bytes)?;
    let mut sheets = Vec::new();
    for sheet_ref in sheet_refs
        .into_iter()
        .take(max_sheets.unwrap_or(usize::MAX))
    {
        match parse_worksheet_rows(
            &mut archive,
            &sheet_ref.path,
            &shared_strings,
            max_xml_entry_bytes,
            max_rows.unwrap_or(usize::MAX),
            max_columns.unwrap_or(usize::MAX),
            reject_row_overflow,
            trailing_empty_row_limit,
        ) {
            Ok(rows) => sheets.push(SheetData {
                name: sheet_ref.name,
                rows,
            }),
            Err(error) if is_resource_limit_error(&error) => return Err(error),
            Err(_) => {}
        }
    }
    if sheets.is_empty() {
        return Err(anyhow!("没有可读取的工作表"));
    }
    Ok((sheet_count, WorkbookData { sheets }))
}

fn read_zip_entry_limited(
    archive: &mut ZipArchive<File>,
    path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    let mut file = archive.by_name(path)?;
    ensure_size_within_limit(path, file.size(), max_bytes)?;
    let mut buffer = Vec::new();
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut buffer)?;
    ensure_size_within_limit(path, buffer.len() as u64, max_bytes)?;
    Ok(buffer)
}

fn parse_workbook_relationships(
    archive: &mut ZipArchive<File>,
    max_bytes: u64,
) -> Result<HashMap<String, String>> {
    let bytes = read_zip_entry_limited(archive, "xl/_rels/workbook.xml.rels", max_bytes)?;
    let mut reader = XmlReader::from_reader(Cursor::new(bytes));
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut relationships = HashMap::new();
    loop {
        buf.clear();
        match reader.read_event_into(&mut buf)? {
            Event::Empty(event) | Event::Start(event)
                if xml_name(event.name().as_ref()) == b"Relationship" =>
            {
                if let (Some(id), Some(target)) =
                    (xml_attr(&event, b"Id"), xml_attr(&event, b"Target"))
                {
                    relationships.insert(id, normalize_xlsx_target(&target));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(relationships)
}

fn parse_workbook_sheets(
    archive: &mut ZipArchive<File>,
    relationships: &HashMap<String, String>,
    max_bytes: u64,
) -> Result<(usize, Vec<XlsxSheetRef>)> {
    let bytes = read_zip_entry_limited(archive, "xl/workbook.xml", max_bytes)?;
    let mut reader = XmlReader::from_reader(Cursor::new(bytes));
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut sheets = Vec::new();
    let mut sheet_count = 0usize;
    loop {
        buf.clear();
        match reader.read_event_into(&mut buf)? {
            Event::Empty(event) | Event::Start(event)
                if xml_name(event.name().as_ref()) == b"sheet" =>
            {
                sheet_count += 1;
                let state = xml_attr(&event, b"state").unwrap_or_default();
                if matches!(state.as_str(), "hidden" | "veryHidden") {
                    continue;
                }
                let name =
                    xml_attr(&event, b"name").unwrap_or_else(|| format!("Sheet{}", sheet_count));
                let relationship_id = xml_attr(&event, b"r:id").or_else(|| xml_attr(&event, b"id"));
                let path = relationship_id
                    .as_ref()
                    .and_then(|id| relationships.get(id))
                    .cloned()
                    .unwrap_or_else(|| format!("xl/worksheets/sheet{}.xml", sheets.len() + 1));
                sheets.push(XlsxSheetRef { name, path });
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if sheets.is_empty() {
        return Err(anyhow!("工作簿没有 sheet"));
    }
    Ok((sheet_count, sheets))
}

fn parse_shared_strings(archive: &mut ZipArchive<File>, max_bytes: u64) -> Result<Vec<Arc<str>>> {
    let mut file = match archive.by_name("xl/sharedStrings.xml") {
        Ok(file) => file,
        Err(ZipError::FileNotFound) => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    ensure_size_within_limit("sharedStrings.xml", file.size(), max_bytes)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    ensure_size_within_limit("sharedStrings.xml", bytes.len() as u64, max_bytes)?;
    let mut reader = XmlReader::from_reader(Cursor::new(bytes));
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;
    loop {
        buf.clear();
        match reader.read_event_into(&mut buf)? {
            Event::Start(event) if xml_name(event.name().as_ref()) == b"si" => {
                in_item = true;
                current.clear();
            }
            Event::Start(event) if in_item && xml_name(event.name().as_ref()) == b"t" => {
                in_text = true;
            }
            Event::Text(text) if in_text => {
                push_xml_text(&mut current, &text)?;
            }
            Event::GeneralRef(reference) if in_text => {
                current.push_str(&xml_general_ref_text(reference.as_ref()));
            }
            Event::End(event) if xml_name(event.name().as_ref()) == b"t" => {
                in_text = false;
            }
            Event::End(event) if xml_name(event.name().as_ref()) == b"si" => {
                strings.push(Arc::<str>::from(current.as_str()));
                current.clear();
                in_item = false;
                in_text = false;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}

#[allow(clippy::too_many_arguments)]
fn parse_worksheet_rows(
    archive: &mut ZipArchive<File>,
    path: &str,
    shared_strings: &[Arc<str>],
    max_xml_entry_bytes: u64,
    max_rows: usize,
    max_columns: usize,
    reject_row_overflow: bool,
    trailing_empty_row_limit: Option<usize>,
) -> Result<Vec<Vec<CellValue>>> {
    let file = archive.by_name(path)?;
    ensure_size_within_limit(path, file.size(), max_xml_entry_bytes)?;
    let mut reader = XmlReader::from_reader(BufReader::new(
        file.take(max_xml_entry_bytes.saturating_add(1)),
    ));
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut rows = Vec::new();
    let mut current_row_number = 0usize;
    let mut current_row: Vec<CellValue> = Vec::new();
    let mut current_column = 0usize;
    let mut current_cell_type = String::new();
    let mut current_cell_text = String::new();
    let mut in_cell = false;
    let mut in_value = false;
    let mut in_inline_text = false;
    let mut saw_data_row = false;
    let mut trailing_empty_rows = 0usize;
    let mut reached_empty_tail = |row_has_data: bool| {
        if row_has_data {
            saw_data_row = true;
            trailing_empty_rows = 0;
            return false;
        }
        if !saw_data_row {
            return false;
        }
        trailing_empty_rows += 1;
        trailing_empty_row_limit.is_some_and(|limit| trailing_empty_rows >= limit)
    };

    loop {
        buf.clear();
        match reader.read_event_into(&mut buf)? {
            Event::Start(event) if xml_name(event.name().as_ref()) == b"row" => {
                current_row_number = xml_attr(&event, b"r")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(rows.len() + 1);
                current_row.clear();
            }
            Event::Empty(event) if xml_name(event.name().as_ref()) == b"row" => {
                current_row_number = xml_attr(&event, b"r")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(rows.len() + 1);
                if reached_empty_tail(false) {
                    break;
                }
                if current_row_number > max_rows {
                    if reject_row_overflow {
                        return Err(resource_limit_error(format!(
                            "{path} 超过资源限制: 行数 {current_row_number} > {max_rows}"
                        )));
                    }
                    break;
                }
                while rows.len() + 1 < current_row_number && rows.len() < max_rows {
                    rows.push(Vec::new());
                }
                if rows.len() < max_rows {
                    rows.push(Vec::new());
                }
                if rows.len() >= max_rows && !reject_row_overflow {
                    break;
                }
            }
            Event::Start(event) if xml_name(event.name().as_ref()) == b"c" => {
                in_cell = true;
                current_cell_text.clear();
                current_cell_type = xml_attr(&event, b"t").unwrap_or_default();
                current_column = xml_attr(&event, b"r")
                    .and_then(|value| column_index_from_cell_ref(&value))
                    .unwrap_or_else(|| current_row.len() + 1);
            }
            Event::Start(event) if in_cell && xml_name(event.name().as_ref()) == b"v" => {
                in_value = true;
            }
            Event::Start(event) if in_cell && xml_name(event.name().as_ref()) == b"t" => {
                in_inline_text = true;
            }
            Event::Text(text) if in_value || in_inline_text => {
                push_xml_text(&mut current_cell_text, &text)?;
            }
            Event::GeneralRef(reference) if in_value || in_inline_text => {
                current_cell_text.push_str(&xml_general_ref_text(reference.as_ref()));
            }
            Event::End(event) if xml_name(event.name().as_ref()) == b"v" => {
                in_value = false;
            }
            Event::End(event) if xml_name(event.name().as_ref()) == b"t" => {
                in_inline_text = false;
            }
            Event::End(event) if xml_name(event.name().as_ref()) == b"c" => {
                if current_column > 0 && current_column <= max_columns {
                    if current_row.len() < current_column {
                        current_row.resize(current_column, CellValue::Empty);
                    }
                    current_row[current_column - 1] =
                        xlsx_cell_value(&current_cell_type, &current_cell_text, shared_strings);
                }
                in_cell = false;
                in_value = false;
                in_inline_text = false;
            }
            Event::End(event) if xml_name(event.name().as_ref()) == b"row" => {
                let row_has_data = current_row.iter().any(|cell| !cell.is_empty());
                if reached_empty_tail(row_has_data) {
                    break;
                }
                if current_row_number > max_rows {
                    if reject_row_overflow {
                        return Err(resource_limit_error(format!(
                            "{path} 超过资源限制: 行数 {current_row_number} > {max_rows}"
                        )));
                    }
                    break;
                }
                while rows.len() + 1 < current_row_number && rows.len() < max_rows {
                    rows.push(Vec::new());
                }
                if rows.len() < max_rows {
                    rows.push(current_row.clone());
                }
                if rows.len() >= max_rows && !reject_row_overflow {
                    break;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(rows)
}

fn xlsx_cell_value(cell_type: &str, raw: &str, shared_strings: &[Arc<str>]) -> CellValue {
    if raw.is_empty() {
        return CellValue::Empty;
    }
    match cell_type {
        "s" => raw
            .parse::<usize>()
            .ok()
            .and_then(|index| shared_strings.get(index).map(Arc::clone))
            .map(CellValue::String)
            .unwrap_or_else(|| CellValue::string(raw.to_owned())),
        "b" => CellValue::Bool(raw == "1" || raw.eq_ignore_ascii_case("true")),
        _ => CellValue::string(raw.to_owned()),
    }
}

fn normalize_xlsx_target(target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{target}")
    }
}

fn xml_name(name: &[u8]) -> &[u8] {
    name.iter()
        .rposition(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name)
}

fn xml_attr(event: &BytesStart, key: &[u8]) -> Option<String> {
    event.attributes().flatten().find_map(|attr| {
        if xml_name(attr.key.as_ref()) == xml_name(key) {
            Some(String::from_utf8_lossy(attr.value.as_ref()).into_owned())
        } else {
            None
        }
    })
}

fn push_xml_text(buffer: &mut String, text: &BytesText) -> Result<()> {
    let decoded = text.decode()?;
    let unescaped = unescape(&decoded)?;
    buffer.push_str(&unescaped);
    Ok(())
}

fn xml_general_ref_text(reference: &[u8]) -> String {
    let text = String::from_utf8_lossy(reference);
    match text.as_ref() {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        value if value.starts_with("#x") || value.starts_with("#X") => {
            u32::from_str_radix(&value[2..], 16)
                .ok()
                .and_then(char::from_u32)
                .map(|value| value.to_string())
                .unwrap_or_default()
        }
        value if value.starts_with('#') => value[1..]
            .parse::<u32>()
            .ok()
            .and_then(char::from_u32)
            .map(|value| value.to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn column_index_from_cell_ref(reference: &str) -> Option<usize> {
    let mut column = 0usize;
    let mut saw_letter = false;
    for byte in reference.bytes() {
        if byte.is_ascii_alphabetic() {
            saw_letter = true;
            column = column
                .checked_mul(26)?
                .checked_add((byte.to_ascii_uppercase() - b'A' + 1) as usize)?;
        } else if byte.is_ascii_digit() {
            break;
        }
    }
    saw_letter.then_some(column)
}

pub(crate) fn read_workbook(path: &Path) -> Result<WorkbookData> {
    read_workbook_limited(path, None, None, None).map(|(_, workbook)| workbook)
}

pub(crate) fn workbook_sheet_count_limited(path: &Path, max_xml_entry_bytes: u64) -> Result<usize> {
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(suffix.as_str(), "xlsx" | "xlsm") {
        let file = File::open(path)?;
        let mut archive = ZipArchive::new(file)?;
        let relationships = parse_workbook_relationships(&mut archive, max_xml_entry_bytes)?;
        let (sheet_count, _) =
            parse_workbook_sheets(&mut archive, &relationships, max_xml_entry_bytes)?;
        return Ok(sheet_count);
    }

    let workbook =
        open_workbook_auto(path).with_context(|| format!("打开 Excel 失败: {}", path.display()))?;
    Ok(workbook.sheet_names().len())
}

pub(crate) fn read_workbook_for_processing(path: &Path, config: &Config) -> Result<WorkbookData> {
    let limits = ProcessingLimits::from_config(config, None);
    validate_processing_workbook(path, limits)?;
    match read_xlsx_preview_fast(
        path,
        None,
        Some(limits.max_rows),
        Some(limits.max_columns),
        limits.xml_entry_bytes,
        limits.shared_strings_bytes,
        true,
        Some(limits.trailing_empty_row_limit),
    ) {
        Ok((_, workbook)) => Ok(workbook),
        Err(error) if is_resource_limit_error(&error) => Err(error),
        Err(_) => read_workbook_limited(
            path,
            None,
            Some(limits.max_rows.saturating_add(1)),
            Some(limits.max_columns),
        )
        .and_then(|(_, workbook)| {
            ensure_workbook_row_limit(&workbook, limits.max_rows)?;
            Ok(workbook)
        }),
    }
}

pub(crate) fn read_workbook_selected(
    path: &Path,
    sheet_name: &str,
    max_columns: Option<usize>,
    config: &Config,
) -> Result<(usize, WorkbookData)> {
    let limits = ProcessingLimits::from_config(config, max_columns);
    validate_processing_workbook(path, limits)?;
    match read_xlsx_selected_fast(path, sheet_name, limits) {
        Ok(workbook) => Ok(workbook),
        Err(error) if is_resource_limit_error(&error) => Err(error),
        Err(_) => {
            read_workbook_selected_calamine(path, sheet_name, limits.max_rows, limits.max_columns)
        }
    }
}

fn read_xlsx_selected_fast(
    path: &Path,
    sheet_name: &str,
    limits: ProcessingLimits,
) -> Result<(usize, WorkbookData)> {
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(suffix.as_str(), "xlsx" | "xlsm") {
        return Err(anyhow!("快速读取只支持 xlsx/xlsm"));
    }

    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let relationships = parse_workbook_relationships(&mut archive, limits.xml_entry_bytes)?;
    let (sheet_count, sheet_refs) =
        parse_workbook_sheets(&mut archive, &relationships, limits.xml_entry_bytes)?;
    let sheet_ref = sheet_refs
        .into_iter()
        .find(|sheet| sheet.name == sheet_name)
        .ok_or_else(|| anyhow!("没有找到扫描阶段识别的工作表: {sheet_name}"))?;
    let shared_strings = parse_shared_strings(&mut archive, limits.shared_strings_bytes)?;
    let rows = parse_worksheet_rows(
        &mut archive,
        &sheet_ref.path,
        &shared_strings,
        limits.xml_entry_bytes,
        limits.max_rows,
        limits.max_columns,
        true,
        Some(limits.trailing_empty_row_limit),
    )?;
    Ok((
        sheet_count,
        WorkbookData {
            sheets: vec![SheetData {
                name: sheet_ref.name,
                rows,
            }],
        },
    ))
}

fn read_workbook_selected_calamine(
    path: &Path,
    sheet_name: &str,
    max_rows: usize,
    max_columns: usize,
) -> Result<(usize, WorkbookData)> {
    let mut workbook =
        open_workbook_auto(path).with_context(|| format!("打开 Excel 失败: {}", path.display()))?;
    let sheet_count = workbook.sheet_names().len();
    let sheet_names = workbook
        .sheets_metadata()
        .iter()
        .filter(|sheet| matches!(sheet.visible, SheetVisible::Visible))
        .map(|sheet| sheet.name.clone())
        .collect::<Vec<_>>();
    if !sheet_names.iter().any(|name| name == sheet_name) {
        return Err(anyhow!("没有找到扫描阶段识别的工作表: {sheet_name}"));
    }
    let range = workbook
        .worksheet_range(sheet_name)
        .with_context(|| format!("读取工作表失败: {sheet_name}"))?;
    if range.height() > max_rows {
        return Err(resource_limit_error(format!(
            "工作表 {sheet_name} 超过资源限制: 行数 {} > {max_rows}",
            range.height()
        )));
    }
    let rows = range
        .rows()
        .take(max_rows)
        .map(|row| {
            row.iter()
                .take(max_columns)
                .map(cell_from_data)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    Ok((
        sheet_count,
        WorkbookData {
            sheets: vec![SheetData {
                name: sheet_name.to_string(),
                rows,
            }],
        },
    ))
}

pub(crate) fn read_workbook_limited(
    path: &Path,
    max_sheets: Option<usize>,
    max_rows: Option<usize>,
    max_columns: Option<usize>,
) -> Result<(usize, WorkbookData)> {
    let mut workbook =
        open_workbook_auto(path).with_context(|| format!("打开 Excel 失败: {}", path.display()))?;
    let sheet_count = workbook.sheet_names().len();
    let sheet_names = workbook
        .sheets_metadata()
        .iter()
        .filter(|sheet| matches!(sheet.visible, SheetVisible::Visible))
        .map(|sheet| sheet.name.clone())
        .collect::<Vec<_>>();
    let mut sheets = Vec::new();
    for name in sheet_names
        .into_iter()
        .take(max_sheets.unwrap_or(usize::MAX))
    {
        if let Ok(range) = workbook.worksheet_range(&name) {
            let rows = range
                .rows()
                .take(max_rows.unwrap_or(usize::MAX))
                .map(|row| {
                    row.iter()
                        .take(max_columns.unwrap_or(usize::MAX))
                        .map(cell_from_data)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            sheets.push(SheetData { name, rows });
        }
    }
    if sheets.is_empty() {
        return Err(anyhow!("没有可读取的工作表"));
    }
    Ok((sheet_count, WorkbookData { sheets }))
}

fn ensure_workbook_row_limit(workbook: &WorkbookData, max_rows: usize) -> Result<()> {
    if let Some(sheet) = workbook
        .sheets
        .iter()
        .find(|sheet| sheet.rows.len() > max_rows)
    {
        return Err(resource_limit_error(format!(
            "工作表 {} 超过资源限制: 行数 {} > {max_rows}",
            sheet.name,
            sheet.rows.len()
        )));
    }
    Ok(())
}

fn cell_from_data(data: &Data) -> CellValue {
    match data {
        Data::Empty => CellValue::Empty,
        Data::String(value) => CellValue::string(value.clone()),
        Data::Float(value) => CellValue::Float(*value),
        Data::Int(value) => CellValue::Int(*value),
        Data::Bool(value) => CellValue::Bool(*value),
        Data::DateTime(value) => CellValue::string(value.to_string()),
        Data::DateTimeIso(value) => CellValue::string(value.clone()),
        Data::DurationIso(value) => CellValue::string(value.clone()),
        Data::Error(value) => CellValue::string(value.to_string()),
    }
}

#[cfg(test)]
include!("../../../test/backend/processor/reader.test.rs");
