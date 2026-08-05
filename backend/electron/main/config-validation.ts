const SINGLE_SHIPMENT_MATCH_FIELDS = new Set([
  "recipient_name",
  "phone",
  "postal_code",
  "address",
  "email",
]);
const DEFAULT_SINGLE_SHIPMENT_MATCH_FIELDS = ["recipient_name", "phone", "postal_code"];
const PRICING_ORDER_FIELD_KEYS = new Set([
  "order_number",
  "country_code",
  "country_english",
  "country_chinese",
  "sku",
  "product_name",
  "quantity",
  "price",
  ...SINGLE_SHIPMENT_MATCH_FIELDS,
]);
const PRICING_TABLE_FIELD_KEYS = new Set(["sku", "country", "quantity_one_price", "fixed_price"]);
const UNSUPPORTED_PRICING_FIELDS = [
  "sku_qty_pair_selection",
  "quantity_policy",
  "multiply_quantity_by_price",
  "zero_price_is_valid",
  "unavailable_price_tokens",
  "output_sheets",
] as const;

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function parseConfigContent(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 格式无效";
    throw new SyntaxError(message);
  }
  return requireRecord(parsed, "配置文件根节点");
}

export function validateConfigContent(
  content: string,
  maxProcessingWorkers: number,
): { valid: boolean; issues: ConfigValidationIssue[] } {
  const issues: ConfigValidationIssue[] = [];
  let config: Record<string, unknown>;
  try {
    config = parseConfigContent(content);
  } catch (error) {
    return {
      valid: false,
      issues: [{ path: "$", message: error instanceof Error ? error.message : "JSON 格式无效" }],
    };
  }

  const objectSections = [
    "sheet_rules",
    "sheet_selection",
    "performance",
    "automation",
    "pricing",
    "pricing_fields",
    "runtime",
    "fields",
    "output",
  ];
  for (const key of objectSections) {
    const value = config[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      issues.push({ path: key, message: "必须是对象" });
    }
  }

  const pricingFields = config.pricing_fields as Record<string, unknown> | undefined;
  if (pricingFields) {
    for (const section of ["order", "pricing"] as const) {
      const fields = pricingFields[section];
      if (fields !== undefined && (!fields || typeof fields !== "object" || Array.isArray(fields))) {
        issues.push({ path: `pricing_fields.${section}`, message: "必须是对象" });
        continue;
      }
      const allowedKeys = section === "order" ? PRICING_ORDER_FIELD_KEYS : PRICING_TABLE_FIELD_KEYS;
      for (const key of Object.keys((fields ?? {}) as Record<string, unknown>)) {
        if (!allowedKeys.has(key)) {
          issues.push({
            path: `pricing_fields.${section}.${key}`,
            message: "当前处理器不读取该字段",
          });
        }
      }
    }
  }

  const performance = config.performance as Record<string, unknown> | undefined;
  if (performance) {
    const positiveIntegerKeys = [
      "processing_workbook_max_mb",
      "processing_xml_entry_max_mb",
      "processing_shared_strings_max_mb",
      "processing_max_rows",
    ] as const;
    for (const key of positiveIntegerKeys) {
      const value = performance[key];
      if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) {
        issues.push({ path: `performance.${key}`, message: "必须是大于 0 的整数" });
      }
    }
    if (performance.processing_workers !== undefined) {
      if (!Number.isInteger(performance.processing_workers) || Number(performance.processing_workers) < 0) {
        issues.push({ path: "performance.processing_workers", message: "必须是大于或等于 0 的整数" });
      } else if (Number(performance.processing_workers) > maxProcessingWorkers) {
        issues.push({
          path: "performance.processing_workers",
          message: `不能超过 ${maxProcessingWorkers}（当前机器最大线程数减 1）`,
        });
      }
    }
  }

  const automation = config.automation as Record<string, unknown> | undefined;
  if (automation) {
    if (automation.auto_run !== undefined && typeof automation.auto_run !== "boolean") {
      issues.push({ path: "automation.auto_run", message: "必须是布尔值" });
    }
    if (automation.template_match_priority !== undefined
      && typeof automation.template_match_priority !== "boolean") {
      issues.push({ path: "automation.template_match_priority", message: "必须是布尔值" });
    }
    for (const key of ["coverage_threshold", "candidate_coverage_gap"] as const) {
      const value = automation[key];
      if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) {
        issues.push({ path: `automation.${key}`, message: "必须是 0 到 1 之间的数字" });
      }
    }
    if (automation.min_trial_rows !== undefined
      && (!Number.isInteger(automation.min_trial_rows) || Number(automation.min_trial_rows) < 1)) {
      issues.push({ path: "automation.min_trial_rows", message: "必须是大于 0 的整数" });
    }
    if (automation.candidate_score_gap !== undefined
      && (typeof automation.candidate_score_gap !== "number" || automation.candidate_score_gap < 0)) {
      issues.push({ path: "automation.candidate_score_gap", message: "必须是大于或等于 0 的数字" });
    }
  }

  const pricing = config.pricing as Record<string, unknown> | undefined;
  if (pricing) {
    for (const key of UNSUPPORTED_PRICING_FIELDS) {
      if (Object.hasOwn(pricing, key)) {
        issues.push({
          path: `pricing.${key}`,
          message: "当前处理器不读取该字段，请删除后使用现行固定规则",
        });
      }
    }
    if (pricing.country_identity !== undefined) {
      const countryIdentity = pricing.country_identity;
      const allowedCountryIdentities = new Set(["iso2", "english", "chinese"]);
      if (!Array.isArray(countryIdentity)) {
        issues.push({ path: "pricing.country_identity", message: "必须是数组" });
      } else if (countryIdentity.length === 0) {
        issues.push({ path: "pricing.country_identity", message: "至少需要保留一个国家身份字段" });
      } else {
        countryIdentity.forEach((value, index) => {
          if (typeof value !== "string" || !allowedCountryIdentities.has(value)) {
            issues.push({
              path: `pricing.country_identity[${index}]`,
              message: "仅支持 iso2、english、chinese",
            });
          }
        });
      }
    }
    if (pricing.order_core_header_range !== undefined) {
      const range = pricing.order_core_header_range;
      if (!Array.isArray(range)) {
        issues.push({ path: "pricing.order_core_header_range", message: "必须是数组" });
      } else if (range.length > 2) {
        issues.push({ path: "pricing.order_core_header_range", message: "最多只能配置两个表头" });
      } else {
        range.forEach((value, index) => {
          if (typeof value !== "string" || !value.trim()) {
            issues.push({
              path: `pricing.order_core_header_range[${index}]`,
              message: "必须是非空字符串",
            });
          }
        });
      }
    }
    if (pricing.single_shipment_matching_enabled !== undefined
      && typeof pricing.single_shipment_matching_enabled !== "boolean") {
      issues.push({ path: "pricing.single_shipment_matching_enabled", message: "必须是布尔值" });
    }
    const configuredMatchFields = pricing.single_shipment_match_fields;
    let validMatchFields = DEFAULT_SINGLE_SHIPMENT_MATCH_FIELDS;
    if (configuredMatchFields !== undefined) {
      if (!Array.isArray(configuredMatchFields)) {
        issues.push({ path: "pricing.single_shipment_match_fields", message: "必须是数组" });
        validMatchFields = [];
      } else {
        validMatchFields = configuredMatchFields.filter((value): value is string =>
          typeof value === "string" && SINGLE_SHIPMENT_MATCH_FIELDS.has(value));
        configuredMatchFields.forEach((value, index) => {
          if (typeof value !== "string" || !SINGLE_SHIPMENT_MATCH_FIELDS.has(value)) {
            issues.push({
              path: `pricing.single_shipment_match_fields[${index}]`,
              message: "仅支持 recipient_name、phone、postal_code、address、email",
            });
          }
        });
      }
    }
    if (pricing.single_shipment_matching_enabled === true && new Set(validMatchFields).size < 2) {
      issues.push({
        path: "pricing.single_shipment_match_fields",
        message: "启用单独发货匹配时至少选择两个不同字段",
      });
    }
  }
  if (Object.hasOwn(config, "runtime")) {
    issues.push({
      path: "runtime",
      message: "运行路径和界面偏好不属于业务规则，请在配置中心左侧设置",
    });
  }
  return { valid: issues.length === 0, issues };
}
