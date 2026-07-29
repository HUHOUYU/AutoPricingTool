use crate::config::Config;
use crate::excel_engine::{CellValue, ProcessorFile};
use crate::extractor::Record;
use crate::reader::read_workbook;
use crate::scanner::{canonical_path_key, file_stem};
use anyhow::{Result, anyhow};
use chrono::Local;
use regex::Regex;
use rust_xlsxwriter::{Format, Workbook, XlsxError};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const FORMAL_DIR: &str = "正式命名";
const SUMMARY_DIR: &str = "汇总";
const PENDING_DIR: &str = "待确认";
const ERROR_DIR: &str = "异常";
const FORMAL_MANIFEST: &str = "正式命名清单.xlsx";
const PENDING_MANIFEST: &str = "待确认清单.xlsx";
const ERROR_MANIFEST: &str = "异常清单.xlsx";
const SUMMARY_INDEX: &str = "汇总索引.xlsx";
const SUMMARY_SHEET: &str = "订单明细";
const MERGED_SUMMARY: &str = "汇总合并.xlsx";

static UNSAFE_FILENAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).expect("unsafe filename regex must compile")
});
#[cfg(test)]
pub(crate) fn write_grouped_summaries(
    output_dir: &Path,
    groups: &std::collections::BTreeMap<String, Vec<Record>>,
    config: &Config,
) -> Result<()> {
    let mut index_rows = Vec::new();
    for (group, records) in groups {
        let mut writer = SummaryWriter::new(output_dir, group, config)?;
        writer.buffer_records(records, config);
        writer.flush(true)?;
        index_rows.push(SummaryIndexRow {
            group: group.clone(),
            path: writer.path().to_path_buf(),
            file_count: records.len(),
            row_count: records.len(),
            status: "完成".to_string(),
        });
    }
    write_summary_index(output_dir, &index_rows)?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct SummaryIndexRow {
    pub(crate) group: String,
    pub(crate) path: PathBuf,
    pub(crate) file_count: usize,
    pub(crate) row_count: usize,
    pub(crate) status: String,
}

#[derive(Debug, Clone)]
pub(crate) struct MergedSummary {
    pub(crate) path: PathBuf,
    pub(crate) file_count: usize,
    pub(crate) row_count: usize,
}

pub(crate) struct SummaryWriter {
    path: PathBuf,
    workbook: Workbook,
    pending_rows: Vec<Vec<CellValue>>,
    pending_file_count: usize,
    pending_row_count: usize,
    next_row: u32,
    column_count: usize,
    flush_files: usize,
    flush_rows: usize,
}

impl SummaryWriter {
    pub(crate) fn new(output_dir: &Path, group: &str, config: &Config) -> Result<Self> {
        let path = unique_output_path(
            &output_dir
                .join(SUMMARY_DIR)
                .join(format!("{}.xlsx", safe_filename(group, "未命名"))),
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name(SUMMARY_SHEET)?;
        let headers = output_headers(config);
        let header_format = Format::new().set_bold().set_background_color("#D9EAF7");
        for (column, header) in headers.iter().enumerate() {
            worksheet.write_string_with_format(0, column as u16, header, &header_format)?;
            worksheet.set_column_width(column as u16, 18)?;
        }
        worksheet.set_freeze_panes(1, 0)?;
        worksheet.autofilter(0, 0, 0, (headers.len() - 1) as u16)?;
        Ok(Self {
            path,
            workbook,
            pending_rows: Vec::new(),
            pending_file_count: 0,
            pending_row_count: 0,
            next_row: 1,
            column_count: headers.len(),
            flush_files: config.output.summary_buffer_file_limit.max(1),
            flush_rows: config.output.summary_buffer_row_limit.max(1),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn buffer_records(&mut self, records: &[Record], config: &Config) -> usize {
        if records.is_empty() {
            return 0;
        }
        let rows = records_to_rows(records, config);
        let row_count = rows.len();
        self.pending_rows.extend(rows);
        self.pending_file_count += 1;
        self.pending_row_count += row_count;
        row_count
    }

    pub(crate) fn flush(&mut self, force: bool) -> Result<usize> {
        if self.pending_rows.is_empty() {
            if force {
                self.workbook.save(&self.path)?;
            }
            return Ok(0);
        }
        if !force
            && self.pending_file_count < self.flush_files
            && self.pending_row_count < self.flush_rows
        {
            return Ok(0);
        }

        let worksheet = self.workbook.worksheet_from_index(0)?;
        for row in &self.pending_rows {
            for (column, value) in row.iter().enumerate() {
                write_cell(worksheet, self.next_row, column as u16, value)?;
            }
            self.next_row += 1;
        }
        if self.next_row > 1 {
            worksheet.autofilter(
                0,
                0,
                self.next_row - 1,
                self.column_count.saturating_sub(1) as u16,
            )?;
        }
        if force {
            self.workbook.save(&self.path)?;
        }
        let flushed_rows = self.pending_rows.len();
        self.pending_rows.clear();
        self.pending_file_count = 0;
        self.pending_row_count = 0;
        Ok(flushed_rows)
    }
}

pub(crate) fn merge_summary_workbooks(output_dir: &Path) -> Result<MergedSummary> {
    ensure_output_structure(output_dir)?;
    let summary_dir = output_dir.join(SUMMARY_DIR);
    let output_path = summary_dir.join(MERGED_SUMMARY);
    let mut sources = fs::read_dir(&summary_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
        })
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return false;
            };
            !name.starts_with("~$") && name != SUMMARY_INDEX && name != MERGED_SUMMARY
        })
        .collect::<Vec<_>>();
    sources.sort_by_key(|path| path.file_name().map(|value| value.to_os_string()));

    let mut headers = Vec::new();
    let mut values = Vec::new();
    let mut file_count = 0;

    for source in &sources {
        let workbook = read_workbook(source)?;
        let Some(sheet) = workbook
            .sheets
            .iter()
            .find(|sheet| sheet.name == SUMMARY_SHEET)
            .or_else(|| workbook.sheets.first())
        else {
            continue;
        };
        if sheet.rows.len() < 2 {
            continue;
        }
        if headers.is_empty() {
            headers = sheet.rows[0]
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let text = value.text();
                    if text.is_empty() {
                        format!("列{}", index + 1)
                    } else {
                        text
                    }
                })
                .collect::<Vec<_>>();
        }
        let row_count_before = values.len();
        values.extend(
            sheet
                .rows
                .iter()
                .skip(1)
                .filter(|row| row.iter().any(|value| !value.is_empty()))
                .cloned(),
        );
        if values.len() > row_count_before {
            file_count += 1;
        }
    }

    if headers.is_empty() || values.is_empty() {
        return Err(anyhow!("没有可合并的汇总文件"));
    }

    let header_refs = headers.iter().map(String::as_str).collect::<Vec<_>>();
    write_table(&output_path, SUMMARY_SHEET, &header_refs, &values)?;
    Ok(MergedSummary {
        path: output_path,
        file_count,
        row_count: values.len(),
    })
}

pub(crate) fn write_summary_index(output_dir: &Path, rows: &[SummaryIndexRow]) -> Result<()> {
    let updated_at = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let index_rows = rows
        .iter()
        .map(|row| {
            vec![
                CellValue::string(row.group.clone()),
                CellValue::string(row.path.to_string_lossy().to_string()),
                CellValue::Int(row.file_count as i64),
                CellValue::Int(row.row_count as i64),
                CellValue::string(row.status.clone()),
                CellValue::string(updated_at.clone()),
            ]
        })
        .collect::<Vec<_>>();
    write_table(
        &output_dir.join(SUMMARY_DIR).join(SUMMARY_INDEX),
        "汇总索引",
        &[
            "分组名",
            "汇总文件路径",
            "文件数",
            "行数",
            "状态",
            "更新时间",
        ],
        &index_rows,
    )
}

fn output_headers(config: &Config) -> Vec<String> {
    let mut headers = vec![
        output_header(config, "order_number", "订单号"),
        output_header(config, "order_date", "订单日期"),
        output_header(config, "file_date", "文件日期"),
        output_header(config, "file_customer", "文件客户信息"),
        output_header(config, "country_code", "国家二字码"),
        output_header(config, "country_en", "收货国家名称"),
        output_header(config, "country_cn", "收货人国家中文"),
    ];
    for index in 1..=config.output.extracted_sku_group_limit {
        headers.push(format!("SKU{index}"));
        headers.push(format!("Qty{index}"));
    }
    headers.extend([
        output_header(config, "price", "销售金额"),
        output_header(config, "financial_check_price", "财务核价列"),
        "文件绝对路径".to_string(),
        "来源文件名".to_string(),
        "来源Sheet".to_string(),
        "来源行号".to_string(),
    ]);
    headers
}

fn output_header(config: &Config, field_name: &str, fallback: &str) -> String {
    config
        .fields
        .get(field_name)
        .and_then(|rule| rule.output_header.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn records_to_rows(records: &[Record], config: &Config) -> Vec<Vec<CellValue>> {
    records
        .iter()
        .map(|record| {
            let mut row = vec![
                record
                    .values
                    .get("order_number")
                    .cloned()
                    .unwrap_or_default(),
                record.values.get("order_date").cloned().unwrap_or_default(),
                record.values.get("file_date").cloned().unwrap_or_default(),
                record
                    .values
                    .get("file_customer")
                    .cloned()
                    .unwrap_or_default(),
                record
                    .values
                    .get("country_code")
                    .cloned()
                    .unwrap_or_default(),
                record.values.get("country_en").cloned().unwrap_or_default(),
                record.values.get("country_cn").cloned().unwrap_or_default(),
            ];
            for index in 0..config.output.extracted_sku_group_limit {
                let (sku, qty) = record
                    .sku_pairs
                    .get(index)
                    .cloned()
                    .unwrap_or((CellValue::Empty, CellValue::Empty));
                row.push(sku);
                row.push(qty);
            }
            row.extend([
                record.values.get("price").cloned().unwrap_or_default(),
                record
                    .values
                    .get("financial_check_price")
                    .cloned()
                    .unwrap_or_default(),
                CellValue::string(record.source_path.clone()),
                CellValue::string(record.source_file.clone()),
                CellValue::string(record.source_sheet.clone()),
                CellValue::Int(record.source_row as i64),
            ]);
            row
        })
        .collect()
}

pub(crate) fn write_scan_manifests(output_dir: &Path, rows: &[ProcessorFile]) -> Result<()> {
    ensure_output_structure(output_dir)?;
    let confirmed = rows
        .iter()
        .filter(|row| row.category == "confirmed")
        .cloned()
        .collect::<Vec<_>>();
    let pending = rows
        .iter()
        .filter(|row| row.category == "pending")
        .cloned()
        .collect::<Vec<_>>();
    let errors = rows
        .iter()
        .filter(|row| row.category == "error")
        .cloned()
        .collect::<Vec<_>>();
    write_processing_manifests(
        output_dir,
        &confirmed,
        &pending,
        &errors,
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
    )
}

pub(crate) fn write_processing_manifests(
    output_dir: &Path,
    formal_rows: &[ProcessorFile],
    pending_rows: &[ProcessorFile],
    error_rows: &[ProcessorFile],
    copied_paths: &HashMap<String, PathBuf>,
    status_by_key: &HashMap<String, String>,
    remark_by_key: &HashMap<String, String>,
) -> Result<()> {
    ensure_output_structure(output_dir)?;
    let formal_values = formal_rows
        .iter()
        .map(|row| {
            let key = canonical_path_key(Path::new(&row.path));
            let target = copied_paths
                .get(&key)
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| planned_formal_path(output_dir, row));
            vec![
                CellValue::string(row.original_name.clone()),
                CellValue::string(row.standard_name.clone()),
                CellValue::string(row.path.clone()),
                CellValue::string(target),
                CellValue::string(
                    status_by_key
                        .get(&key)
                        .cloned()
                        .unwrap_or_else(|| row.status.clone()),
                ),
                row.sheet_count
                    .map(|value| CellValue::Int(value as i64))
                    .unwrap_or_default(),
                CellValue::string(row.size.clone()),
                CellValue::string(
                    remark_by_key
                        .get(&key)
                        .cloned()
                        .unwrap_or_else(|| row.reason.clone()),
                ),
            ]
        })
        .collect::<Vec<_>>();
    write_table(
        &output_dir.join(FORMAL_DIR).join(FORMAL_MANIFEST),
        "正式命名",
        &[
            "原始文件名",
            "标准文件名",
            "源路径",
            "正式文件路径",
            "状态",
            "Sheet数",
            "大小",
            "备注",
        ],
        &formal_values,
    )?;

    let pending_values = pending_rows
        .iter()
        .map(|row| {
            vec![
                CellValue::string(row.original_name.clone()),
                CellValue::string(row.standard_name.clone()),
                CellValue::string(row.path.clone()),
                CellValue::string(row.reason.clone()),
                row.sheet_count
                    .map(|value| CellValue::Int(value as i64))
                    .unwrap_or_default(),
                CellValue::string(row.size.clone()),
            ]
        })
        .collect::<Vec<_>>();
    write_table(
        &output_dir.join(PENDING_DIR).join(PENDING_MANIFEST),
        "待确认",
        &[
            "原始文件名",
            "建议标准名",
            "源路径",
            "待确认原因",
            "Sheet数",
            "大小",
        ],
        &pending_values,
    )?;

    let error_values = error_rows
        .iter()
        .map(|row| {
            vec![
                CellValue::string(row.original_name.clone()),
                CellValue::string(row.standard_name.clone()),
                CellValue::string(row.path.clone()),
                CellValue::string(row.reason.clone()),
                CellValue::string(if row.status == "失败" {
                    "处理"
                } else {
                    "扫描/重命名"
                }),
            ]
        })
        .collect::<Vec<_>>();
    write_table(
        &output_dir.join(ERROR_DIR).join(ERROR_MANIFEST),
        "异常",
        &["原始文件名", "建议标准名", "源路径", "异常原因", "发生阶段"],
        &error_values,
    )?;
    Ok(())
}

fn write_table(
    path: &Path,
    sheet_name: &str,
    headers: &[&str],
    values: &[Vec<CellValue>],
) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.set_name(sheet_name)?;
    let header_format = Format::new().set_bold().set_background_color("#D9EAF7");
    for (column, header) in headers.iter().enumerate() {
        worksheet.write_string_with_format(0, column as u16, *header, &header_format)?;
        worksheet.set_column_width(column as u16, 18)?;
    }
    for (row_index, row) in values.iter().enumerate() {
        for (column, value) in row.iter().enumerate() {
            write_cell(worksheet, (row_index + 1) as u32, column as u16, value)?;
        }
    }
    if !headers.is_empty() {
        worksheet.set_freeze_panes(1, 0)?;
        worksheet.autofilter(0, 0, values.len() as u32, (headers.len() - 1) as u16)?;
    }
    workbook.save(path)?;
    Ok(())
}

fn write_cell(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    column: u16,
    value: &CellValue,
) -> Result<(), XlsxError> {
    match value {
        CellValue::Empty => Ok(()),
        CellValue::String(value) => worksheet
            .write_string(row, column, value.as_ref())
            .map(|_| ()),
        CellValue::Float(value) => worksheet.write_number(row, column, *value).map(|_| ()),
        CellValue::Int(value) => worksheet
            .write_number(row, column, *value as f64)
            .map(|_| ()),
        CellValue::Bool(value) => worksheet.write_boolean(row, column, *value).map(|_| ()),
    }
}

pub(crate) fn ensure_output_structure(output_dir: &Path) -> Result<()> {
    for folder in [SUMMARY_DIR, FORMAL_DIR, PENDING_DIR, ERROR_DIR] {
        fs::create_dir_all(output_dir.join(folder))?;
    }
    Ok(())
}

pub(crate) fn group_name_from_standard_name(standard_name: &str) -> String {
    safe_filename(
        standard_name.split("__").next().unwrap_or("未命名"),
        "未命名",
    )
}

fn safe_filename(value: &str, default: &str) -> String {
    let cleaned = UNSAFE_FILENAME_RE
        .replace_all(value, "_")
        .trim_matches([' ', '.', '_'])
        .to_string();
    if cleaned.is_empty() {
        default.to_string()
    } else {
        cleaned
    }
}

pub(crate) fn planned_formal_path(output_dir: &Path, row: &ProcessorFile) -> String {
    let source = Path::new(&row.path);
    output_dir
        .join(FORMAL_DIR)
        .join(format!(
            "{}{}",
            safe_filename(
                file_stem(Path::new(&row.standard_name)).as_str(),
                &file_stem(source)
            ),
            source
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{value}"))
                .unwrap_or_default()
        ))
        .to_string_lossy()
        .to_string()
}

pub(crate) fn copy_standard_file(
    source_path: &Path,
    output_dir: &Path,
    standard_name: &str,
) -> Result<PathBuf> {
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let target_name = format!(
        "{}{}",
        safe_filename(
            &file_stem(Path::new(standard_name)),
            &file_stem(source_path)
        ),
        extension
    );
    let target = unique_output_path(&output_dir.join(FORMAL_DIR).join(target_name));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source_path, &target)?;
    Ok(target)
}

fn unique_output_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    for index in 2..10000 {
        let candidate = path.with_file_name(format!(
            "{}_{}{}",
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("output"),
            index,
            path.extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{value}"))
                .unwrap_or_default()
        ));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reader::read_workbook;
    use std::collections::BTreeMap;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be available")
            .as_nanos();
        env::temp_dir().join(format!("table_handle_line_{name}_{stamp}"))
    }

    #[test]
    fn writes_scan_manifests_as_readable_xlsx_fixtures() -> Result<()> {
        let output_dir = fixture_dir("manifests");
        let rows = vec![ProcessorFile {
            id: 1,
            path: "C:/orders/Brand.xlsx".to_string(),
            original_name: "Brand.xlsx".to_string(),
            standard_name: "Brand__2026.06.02__batch.xlsx".to_string(),
            status: "已确认".to_string(),
            category: "confirmed".to_string(),
            reason: String::new(),
            sheet_count: Some(1),
            size: "12 KB".to_string(),
            sheet_name: Some("订单".to_string()),
            header_row: Some(1),
            column_hints: None,
        }];

        write_scan_manifests(&output_dir, &rows)?;

        let manifest_path = output_dir.join(FORMAL_DIR).join(FORMAL_MANIFEST);
        assert!(manifest_path.exists());
        let workbook = read_workbook(&manifest_path)?;
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "原始文件名");
        assert_eq!(workbook.sheets[0].rows[1][0].text(), "Brand.xlsx");
        assert_eq!(
            workbook.sheets[0].rows[1][1].text(),
            "Brand__2026.06.02__batch.xlsx"
        );

        fs::remove_dir_all(output_dir).ok();
        Ok(())
    }

    #[test]
    fn writes_grouped_summary_from_extracted_records() -> Result<()> {
        let output_dir = fixture_dir("summary");
        let config = Config::default();
        let mut record = Record {
            source_path: "C:/orders/Brand.xlsx".to_string(),
            source_file: "Brand.xlsx".to_string(),
            source_sheet: "订单".to_string(),
            source_row: 2,
            ..Default::default()
        };
        record
            .values
            .insert("order_number".to_string(), CellValue::string("A-001"));
        record
            .values
            .insert("price".to_string(), CellValue::Float(12.5));
        record
            .values
            .insert("file_customer".to_string(), CellValue::string("Brand"));
        record
            .sku_pairs
            .push((CellValue::string("SKU-1"), CellValue::Int(2)));
        let groups = BTreeMap::from([("Brand".to_string(), vec![record])]);

        write_grouped_summaries(&output_dir, &groups, &config)?;

        let summary_path = output_dir.join(SUMMARY_DIR).join("Brand.xlsx");
        assert!(summary_path.exists());
        let workbook = read_workbook(&summary_path)?;
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "订单号");
        assert_eq!(workbook.sheets[0].rows[0][2].text(), "文件日期");
        assert_eq!(workbook.sheets[0].rows[0][3].text(), "文件客户信息");
        assert_eq!(workbook.sheets[0].rows[0][4].text(), "国家二字码");
        assert_eq!(workbook.sheets[0].rows[1][0].text(), "A-001");
        assert_eq!(workbook.sheets[0].rows[1][3].text(), "Brand");
        assert_eq!(workbook.sheets[0].rows[1][7].text(), "SKU-1");

        fs::remove_dir_all(output_dir).ok();
        Ok(())
    }

    #[test]
    fn merges_grouped_summary_workbooks() -> Result<()> {
        let output_dir = fixture_dir("merge_summary");
        let summary_dir = output_dir.join(SUMMARY_DIR);
        write_table(
            &summary_dir.join("BrandA.xlsx"),
            SUMMARY_SHEET,
            &["订单号", "销售金额"],
            &[
                vec![CellValue::string("A-001"), CellValue::Float(10.5)],
                vec![CellValue::string("A-002"), CellValue::Int(20)],
            ],
        )?;
        write_table(
            &summary_dir.join("BrandB.xlsx"),
            SUMMARY_SHEET,
            &["订单号", "销售金额"],
            &[vec![CellValue::string("B-001"), CellValue::Int(30)]],
        )?;
        write_table(
            &summary_dir.join(SUMMARY_INDEX),
            "汇总索引",
            &["分组名"],
            &[vec![CellValue::string("BrandA")]],
        )?;
        write_table(
            &summary_dir.join(MERGED_SUMMARY),
            SUMMARY_SHEET,
            &["订单号"],
            &[vec![CellValue::string("OLD")]],
        )?;

        let merged = merge_summary_workbooks(&output_dir)?;

        assert_eq!(merged.file_count, 2);
        assert_eq!(merged.row_count, 3);
        assert_eq!(merged.path, summary_dir.join(MERGED_SUMMARY));
        let workbook = read_workbook(&merged.path)?;
        assert_eq!(workbook.sheets[0].rows[0][0].text(), "订单号");
        assert_eq!(workbook.sheets[0].rows[1][0].text(), "A-001");
        assert_eq!(workbook.sheets[0].rows[2][0].text(), "A-002");
        assert_eq!(workbook.sheets[0].rows[3][0].text(), "B-001");

        fs::remove_dir_all(output_dir).ok();
        Ok(())
    }
}
