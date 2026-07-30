#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserError {
    pub(crate) title: String,
    pub(crate) suggestion: String,
}

pub(crate) fn map_error(context: &str, details: &str) -> UserError {
    let lower = details.to_lowercase();

    if lower.contains("超过资源限制") {
        return UserError {
            title: format!("{context}: Excel 文件超出安全限制"),
            suggestion: "文件过大或内部 XML 解压后体积异常。请确认文件来源可信；确需处理大文件时，可谨慎调高 performance 中对应的处理上限。".to_string(),
        };
    }

    if contains_any(
        &lower,
        &[
            "permission denied",
            "access is denied",
            "拒绝访问",
            "另一个程序正在使用此文件",
            "the process cannot access the file",
            "sharing violation",
            "being used by another process",
        ],
    ) {
        return UserError {
            title: format!("{context}: 文件无法访问"),
            suggestion:
                "文件可能正被 Excel 或其他程序打开，或当前账号没有读写权限。请关闭占用文件后重试。"
                    .to_string(),
        };
    }

    if contains_any(
        &lower,
        &[
            "read-only",
            "readonly",
            "只读",
            "write protected",
            "disk full",
            "磁盘空间不足",
            "no space left",
        ],
    ) {
        return UserError {
            title: format!("{context}: 输出目录无法写入"),
            suggestion:
                "请确认输出目录不是只读位置，并检查磁盘剩余空间。必要时换一个本地输出目录后重试。"
                    .to_string(),
        };
    }

    if contains_any(
        &lower,
        &[
            "no such file",
            "not found",
            "系统找不到指定的文件",
            "cannot find the path",
            "找不到指定的路径",
        ],
    ) {
        return UserError {
            title: format!("{context}: 路径不存在"),
            suggestion: "请选择仍然存在的源文件夹、输出目录或配置文件，然后重新执行。".to_string(),
        };
    }

    if contains_any(
        &lower,
        &[
            "expected value",
            "expected `",
            "invalid type",
            "missing field",
            "unknown field",
            "trailing comma",
            "eof while parsing",
            "解析配置失败",
            "无效正则",
        ],
    ) {
        return UserError {
            title: format!("{context}: 配置文件格式错误"),
            suggestion:
                "配置 JSON 可能存在语法错误或字段类型不正确，请检查 extract_rules.json 后重试。"
                    .to_string(),
        };
    }

    if contains_any(
        &lower,
        &[
            "zip",
            "invalid archive",
            "corrupt",
            "unsupported",
            "invalid data",
            "bad crc",
            "quick-xml",
            "打开 excel 失败",
            "没有可读取的工作表",
        ],
    ) {
        return UserError {
            title: format!("{context}: Excel 文件无法读取"),
            suggestion: "文件可能已损坏、格式不兼容，或不是有效的 Excel 工作簿。请尝试用 Excel 打开并另存为 xlsx 后重试。".to_string(),
        };
    }

    if contains_any(
        &lower,
        &[
            "未提取到订单数据",
            "没有找到满足订单主表条件",
            "表头匹配不足",
        ],
    ) {
        return UserError {
            title: format!("{context}: 未识别到订单数据"),
            suggestion: "当前文件的表头或订单列与配置规则不匹配。请在待确认清单中检查 sheet、表头行和字段映射。".to_string(),
        };
    }

    UserError {
        title: format!("{context}: 处理失败"),
        suggestion: "处理过程遇到异常，请查看详细日志定位具体文件或配置项。".to_string(),
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

#[cfg(test)]
include!("../../../test/backend/processor/error_mapper.test.rs");
