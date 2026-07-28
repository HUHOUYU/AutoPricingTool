import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { availableParallelism, userInfo } from "node:os";
import { assertTrustedIpcSender, isTrustedRendererUrl } from "./security";
import { readExcelPreviewFile } from "./excel-preview-file";
import { resolveLocalProcessorExecutable } from "./processor-path";
import { TaskHistoryStore, TASK_HISTORY_SCHEMA_VERSION } from "./task-history-store";
import type {
  TaskAnalyticsQuery,
  TaskFileResult,
  TaskHistoryEvent,
  TaskHistoryExportRequest,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistoryStatus,
  TaskIssueSummary,
  TaskRunDiagnostics,
} from "../shared/task-history";
import { TASK_ISSUE_LABELS } from "../shared/task-history";
import {
  initialWindowSize,
  MIN_WINDOW_SIZE,
  normalizeWindowPreferences,
  setRememberedWindowSize,
  type WindowPreferences,
  type WindowSize,
} from "./window-preferences";

type RuntimeConfig = {
  recent_input_dir?: string;
  recent_output_dir?: string;
  recent_config_path?: string;
  archive_standard_files?: boolean;
  auto_reveal_manual_result?: boolean;
};

type ExportFileRowsPayload = {
  categoryLabel: string;
  rows: Array<Record<string, unknown>>;
};

type RuntimeLogRow = {
  time: string;
  level: string;
  message: string;
};

type ConfigValidationIssue = {
  path: string;
  message: string;
};

type ConfigDocument = {
  path: string;
  content: string;
  modifiedAt: number;
  isDefault: boolean;
};

type HeaderTemplateFieldMapping = {
  fieldKey: string;
  label: string;
  sheetName: string;
  headerRow: number;
  column: number;
  header: string;
};

type HeaderTemplateRecord = {
  id: string;
  createdAt: string;
  createdBy: string;
  fileName: string;
  filePath: string;
  mappings: HeaderTemplateFieldMapping[];
};

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
const PRICING_TABLE_FIELD_KEYS = new Set(["sku", "country", "fixed_price"]);
const UNSUPPORTED_PRICING_FIELDS = [
  "sku_qty_pair_selection",
  "quantity_policy",
  "multiply_quantity_by_price",
  "zero_price_is_valid",
  "unavailable_price_tokens",
  "output_sheets",
] as const;

const rootDir = resolve(__dirname, "../..");
const resourceRootDir = app.isPackaged ? process.resourcesPath : rootDir;
const writableRootDir = app.isPackaged ? app.getPath("userData") : rootDir;
const portableRootDir =
  app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR ? process.env.PORTABLE_EXECUTABLE_DIR : dirname(process.execPath);
const bundledDefaultConfigPath = join(resourceRootDir, "defaults", "extract_rules.json");
const defaultExtractConfigPath = join(writableRootDir, "config", "extract_rules.json");
const legacyRuntimeConfigPath = join(writableRootDir, "runtime", "app_config.json");
const runtimeLogPath = join(writableRootDir, "runtime", "logs", "app.log");
const taskHistoryPath = join(writableRootDir, "runtime", "task-history.jsonl");
const taskHistoryDetailsDir = join(writableRootDir, "runtime", "task-details");
const taskHistoryStore = new TaskHistoryStore(taskHistoryPath, taskHistoryDetailsDir);
const templateStoreDir = join(app.getPath("userData"), "templates");
const templateStorePath = join(templateStoreDir, "templates.json");
const windowPreferencesPath = join(app.getPath("userData"), "window-preferences.json");
const appIconPath = join(resourceRootDir, "resources", "app-icon.ico");
const rendererHtmlPath = join(__dirname, "../renderer/index.html");
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const trustedRendererLocation = {
  rendererHtmlPath,
  devServerUrl,
};
const productionContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");
const outputArtifactDirs = ["汇总", "正式命名", "待确认", "异常"];
const supportedExcelExtensions = new Set([".xlsx", ".xlsm", ".xlsb", ".xls"]);
const MAX_INPUT_FILES = 5_000;
const TASK_PROGRESS_PERSIST_FILE_INTERVAL = 10;
const defaultWindowBackgroundColor = "#EEF3F8";
const windowResizeSaveDelayMs = 300;
const detectedProcessingThreads = availableParallelism();
const maxConfiguredProcessingWorkers = Math.max(0, detectedProcessingThreads - 1);
let processor: ChildProcessWithoutNullStreams | null = null;
let processorActivity: "scan" | "start" | "merge" | "price-analyze" | "price-validate" | "price-run" | null = null;
let activeTask: TaskHistoryRecord | null = null;
let activeTaskEventSequence = 0;
let activeTaskLastPersistedFiles = 0;
const activeTaskFiles = new Map<string, TaskFileResult>();
let windowPreferences: WindowPreferences = { rememberSize: false };
let windowPreferencesWriteQueue: Promise<void> = Promise.resolve();

type ProcessorCommand = Record<string, unknown> & {
  action: string;
};

function requireTrustedIpc(event: Electron.IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event, trustedRendererLocation);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function validateRuntimeConfigUpdate(value: unknown): RuntimeConfig {
  const input = requireRecord(value, "运行配置");
  const result: RuntimeConfig = {};
  for (const key of ["recent_input_dir", "recent_output_dir", "recent_config_path"] as const) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length > 32_767) {
      throw new TypeError(`运行配置字段 ${key} 必须是有效路径字符串`);
    }
    result[key] = candidate;
  }
  if (input.archive_standard_files !== undefined) {
    if (typeof input.archive_standard_files !== "boolean") {
      throw new TypeError("运行配置字段 archive_standard_files 必须是布尔值");
    }
    result.archive_standard_files = input.archive_standard_files;
  }
  if (input.auto_reveal_manual_result !== undefined) {
    if (typeof input.auto_reveal_manual_result !== "boolean") {
      throw new TypeError("运行配置字段 auto_reveal_manual_result 必须是布尔值");
    }
    result.auto_reveal_manual_result = input.auto_reveal_manual_result;
  }
  return result;
}

function samePath(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

async function readWindowPreferences(): Promise<WindowPreferences> {
  try {
    return normalizeWindowPreferences(JSON.parse(await readFile(windowPreferencesPath, "utf8")) as unknown);
  } catch {
    return { rememberSize: false };
  }
}

async function writeWindowPreferences(preferences: WindowPreferences): Promise<void> {
  const content = `${JSON.stringify(preferences, null, 2)}\n`;
  windowPreferencesWriteQueue = windowPreferencesWriteQueue.catch(() => undefined).then(async () => {
    await mkdir(dirname(windowPreferencesPath), { recursive: true });
    const temporaryPath = `${windowPreferencesPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, windowPreferencesPath);
  });
  return windowPreferencesWriteQueue;
}

function isSupportedExcelPath(path: string): boolean {
  return supportedExcelExtensions.has(extname(path).toLowerCase());
}

const skippedInputDirectoryNames = new Set([".git", "node_modules", "dist-electron", "target", "核价结果"]);

async function collectExcelFiles(directory: string): Promise<{ files: string[]; skippedTemporary: number; skippedUnsupported: number; skippedOutput: number }> {
  const files: string[] = [];
  let skippedTemporary = 0;
  let skippedUnsupported = 0;
  let skippedOutput = 0;
  const resolvedDirectory = resolve(directory);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  for (const entry of entries) {
    if (!entry.isFile()) {
      if (entry.isDirectory() && skippedInputDirectoryNames.has(entry.name)) skippedOutput += 1;
      continue;
    }
    if (entry.name.startsWith("~$")) {
      skippedTemporary += 1;
      continue;
    }
    const candidate = join(resolvedDirectory, entry.name);
    if (!isSupportedExcelPath(candidate)) {
      skippedUnsupported += 1;
      continue;
    }
    files.push(resolve(candidate));
    if (files.length > MAX_INPUT_FILES) break;
  }
  if (files.length > MAX_INPUT_FILES) {
    throw new RangeError(`输入文件夹包含 ${files.length} 个 Excel 文件，最多支持 ${MAX_INPUT_FILES} 个`);
  }
  return { files, skippedTemporary, skippedUnsupported, skippedOutput };
}

async function validatePricePayload(value: unknown): Promise<Record<string, unknown>> {
  const input = requireRecord(value, "核价参数");
  const files = input.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_INPUT_FILES) {
    throw new TypeError(`核价参数 files 必须是 1-${MAX_INPUT_FILES} 个文件路径`);
  }
  const normalizedFiles: string[] = [];
  for (const item of files) {
    if (typeof item !== "string" || !isAbsolute(item) || !isSupportedExcelPath(item) || !(await pathExists(item))) {
      throw new TypeError("核价输入文件无效: " + String(item));
    }
    normalizedFiles.push(resolve(item));
  }
  const outputDir = input.outputDir;
  if (outputDir !== undefined && (typeof outputDir !== "string" || !isAbsolute(outputDir) || outputDir.length > 32_767)) {
    throw new TypeError("核价输出目录必须是绝对路径");
  }
  return {
    ...input,
    files: normalizedFiles,
    ...(typeof outputDir === "string" ? { outputDir: resolve(outputDir) } : {}),
  };
}

function validatePriceRowEditPayload(value: unknown): { sourceRow: number; quantity: number | null } {
  const input = requireRecord(value, "单行核价参数");
  if (!Number.isSafeInteger(input.sourceRow) || Number(input.sourceRow) < 1) {
    throw new TypeError("单行核价 sourceRow 必须是大于 0 的整数");
  }
  if (input.quantity !== null && (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 0)) {
    throw new TypeError("单行核价 quantity 必须是非负整数或 null");
  }
  return {
    sourceRow: Number(input.sourceRow),
    quantity: input.quantity === null ? null : Number(input.quantity),
  };
}

function normalizeRuntimeLogRows(value: unknown): RuntimeLogRow[] {
  if (!Array.isArray(value)) {
    throw new TypeError("日志参数必须是数组");
  }
  if (value.length > 5_000) {
    throw new RangeError("单次日志批量写入不能超过 5000 行");
  }
  return value.map((item) => {
    const row = requireRecord(item, "日志行");
    if (typeof row.time !== "string" || typeof row.level !== "string" || typeof row.message !== "string") {
      throw new TypeError("日志行必须包含字符串类型的 time、level 和 message");
    }
    return {
      time: row.time.slice(0, 64).replace(/[\r\n]+/g, " "),
      level: row.level.slice(0, 32).replace(/[\r\n]+/g, " "),
      message: row.message.slice(0, 100_000).replace(/\r?\n/g, "\\n"),
    };
  });
}

function installContentSecurityPolicy(): void {
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived({ urls: ["file://*/*"] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [productionContentSecurityPolicy],
      },
    });
  });
}

async function ensureWritableConfig(): Promise<void> {
  await mkdir(dirname(defaultExtractConfigPath), { recursive: true });
  try {
    await access(defaultExtractConfigPath);
  } catch {
    await copyFile(bundledDefaultConfigPath, defaultExtractConfigPath);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readHeaderTemplates(): Promise<HeaderTemplateRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(templateStorePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is HeaderTemplateRecord => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<HeaderTemplateRecord>;
      return typeof record.id === "string"
        && typeof record.createdAt === "string"
        && typeof record.createdBy === "string"
        && typeof record.fileName === "string"
        && typeof record.filePath === "string"
        && Array.isArray(record.mappings);
    });
  } catch {
    return [];
  }
}

async function writeHeaderTemplates(records: HeaderTemplateRecord[]): Promise<void> {
  await mkdir(templateStoreDir, { recursive: true });
  await writeFile(templateStorePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function parseHeaderTemplateMappings(value: unknown): HeaderTemplateFieldMapping[] {
  if (!Array.isArray(value)) throw new TypeError("模板字段映射必须是数组");
  return value.map((item) => {
    const mapping = requireRecord(item, "模板字段映射");
    if (typeof mapping.fieldKey !== "string" || !mapping.fieldKey.trim()
      || typeof mapping.label !== "string" || !mapping.label.trim()
      || typeof mapping.sheetName !== "string" || !mapping.sheetName.trim()
      || !Number.isInteger(mapping.headerRow) || Number(mapping.headerRow) < 1
      || !Number.isInteger(mapping.column) || Number(mapping.column) < 1
      || typeof mapping.header !== "string") {
      throw new TypeError("模板字段映射格式无效");
    }
    return {
      fieldKey: mapping.fieldKey.trim(),
      label: mapping.label.trim(),
      sheetName: mapping.sheetName.trim(),
      headerRow: Number(mapping.headerRow),
      column: Number(mapping.column),
      header: mapping.header.trim(),
    };
  });
}

function parseConfigContent(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 格式无效";
    throw new SyntaxError(message);
  }
  return requireRecord(parsed, "配置文件根节点");
}

function validateConfigContent(content: string): { valid: boolean; issues: ConfigValidationIssue[] } {
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

  const objectSections = ["sheet_rules", "sheet_selection", "performance", "automation", "pricing", "pricing_fields", "runtime", "fields", "output"];
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
    for (const key of ["processing_workbook_max_mb", "processing_xml_entry_max_mb", "processing_shared_strings_max_mb", "processing_max_rows"] as const) {
      const value = performance[key];
      if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) {
        issues.push({ path: `performance.${key}`, message: "必须是大于 0 的整数" });
      }
    }
    if (performance.processing_workers !== undefined) {
      if (!Number.isInteger(performance.processing_workers) || Number(performance.processing_workers) < 0) {
        issues.push({ path: "performance.processing_workers", message: "必须是大于或等于 0 的整数" });
      } else if (Number(performance.processing_workers) > maxConfiguredProcessingWorkers) {
        issues.push({ path: "performance.processing_workers", message: `不能超过 ${maxConfiguredProcessingWorkers}（当前机器最大线程数减 1）` });
      }
    }
  }

  const automation = config.automation as Record<string, unknown> | undefined;
  if (automation) {
    if (automation.auto_run !== undefined && typeof automation.auto_run !== "boolean") {
      issues.push({ path: "automation.auto_run", message: "必须是布尔值" });
    }
    if (automation.template_match_priority !== undefined && typeof automation.template_match_priority !== "boolean") {
      issues.push({ path: "automation.template_match_priority", message: "必须是布尔值" });
    }
    for (const key of ["coverage_threshold", "candidate_coverage_gap"] as const) {
      const value = automation[key];
      if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) {
        issues.push({ path: `automation.${key}`, message: "必须是 0 到 1 之间的数字" });
      }
    }
    if (automation.min_trial_rows !== undefined && (!Number.isInteger(automation.min_trial_rows) || Number(automation.min_trial_rows) < 1)) {
      issues.push({ path: "automation.min_trial_rows", message: "必须是大于 0 的整数" });
    }
    if (automation.candidate_score_gap !== undefined && (typeof automation.candidate_score_gap !== "number" || automation.candidate_score_gap < 0)) {
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
        validMatchFields = configuredMatchFields.filter((value): value is string => typeof value === "string" && SINGLE_SHIPMENT_MATCH_FIELDS.has(value));
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
    if (pricing.single_shipment_matching_enabled === true
      && new Set(validMatchFields).size < 2) {
      issues.push({
        path: "pricing.single_shipment_match_fields",
        message: "启用单独发货匹配时至少选择两个不同字段",
      });
    }
  }
  const runtime = config.runtime as Record<string, unknown> | undefined;
  if (runtime) {
    for (const key of ["recent_input_dir", "recent_output_dir", "recent_config_path"] as const) {
      const value = runtime[key];
      if (value !== undefined && typeof value !== "string") {
        issues.push({ path: `runtime.${key}`, message: "必须是字符串" });
      }
    }
    if (runtime.archive_standard_files !== undefined && typeof runtime.archive_standard_files !== "boolean") {
      issues.push({ path: "runtime.archive_standard_files", message: "必须是布尔值" });
    }
    if (runtime.auto_reveal_manual_result !== undefined && typeof runtime.auto_reveal_manual_result !== "boolean") {
      issues.push({ path: "runtime.auto_reveal_manual_result", message: "必须是布尔值" });
    }
  }
  return { valid: issues.length === 0, issues };
}

async function readConfigDocument(candidatePath?: string): Promise<ConfigDocument> {
  const configPath = await resolveActiveConfigPath(candidatePath);
  const [content, fileStat] = await Promise.all([readFile(configPath, "utf8"), stat(configPath)]);
  return {
    path: configPath,
    content,
    modifiedAt: fileStat.mtimeMs,
    isDefault: samePath(configPath, defaultExtractConfigPath),
  };
}

async function atomicWriteConfig(configPath: string, content: string): Promise<ConfigDocument> {
  const validation = validateConfigContent(content);
  if (!validation.valid) {
    throw new Error(`配置校验失败：${validation.issues[0]?.path} ${validation.issues[0]?.message}`);
  }
  const normalizedContent = `${JSON.stringify(parseConfigContent(content), null, 2)}\n`;
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  if (await pathExists(configPath)) {
    await copyFile(configPath, `${configPath}.bak`);
  }
  await writeFile(temporaryPath, normalizedContent, "utf8");
  await rename(temporaryPath, configPath);
  return readConfigDocument(configPath);
}

async function saveConfigDocument(payload: unknown): Promise<ConfigDocument> {
  const input = requireRecord(payload, "配置保存参数");
  if (typeof input.path !== "string" || !isAbsolute(input.path) || typeof input.content !== "string") {
    throw new TypeError("配置保存参数无效");
  }
  if (typeof input.expectedModifiedAt === "number" && (await pathExists(input.path))) {
    const currentStat = await stat(input.path);
    if (Math.abs(currentStat.mtimeMs - input.expectedModifiedAt) > 1) {
      throw new Error("配置文件已被外部修改，请重新加载后再保存");
    }
  }
  const document = await atomicWriteConfig(resolve(input.path), input.content);
  await writeDefaultConfigPointer(document.path);
  return readConfigDocument(document.path);
}

async function saveConfigDocumentAs(content: string): Promise<ConfigDocument | null> {
  const validation = validateConfigContent(content);
  if (!validation.valid) {
    throw new Error(`配置校验失败：${validation.issues[0]?.path} ${validation.issues[0]?.message}`);
  }
  const runtime = await readRuntimeConfig();
  const result = await dialog.showSaveDialog({
    defaultPath: runtime.recent_config_path ?? defaultExtractConfigPath,
    filters: [{ name: "JSON 配置", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const document = await atomicWriteConfig(resolve(result.filePath), content);
  await writeDefaultConfigPointer(document.path);
  return readConfigDocument(document.path);
}

async function restoreDefaultConfig(): Promise<ConfigDocument> {
  const current = await readConfigDocument();
  const bundledContent = await readFile(bundledDefaultConfigPath, "utf8");
  const bundled = parseConfigContent(bundledContent);
  bundled.runtime = {
    ...runtimeFromConfig(bundled),
    ...runtimeFromConfig(parseConfigContent(current.content)),
    recent_config_path: current.path,
  };
  return atomicWriteConfig(current.path, JSON.stringify(bundled));
}

const persistTaskRecord = (record: TaskHistoryRecord): Promise<void> => taskHistoryStore.persistTaskRecord(record);
const markInterruptedTasks = (): Promise<void> => taskHistoryStore.markInterruptedTasks();
const getTaskHistorySummary = () => taskHistoryStore.getTaskHistorySummary();

async function readConfigFile(configPath: string): Promise<Record<string, unknown>> {
  const text = await readFile(configPath, "utf8");
  return requireRecord(JSON.parse(text) as unknown, "配置文件根节点");
}

function runtimeFromConfig(config: Record<string, unknown>): RuntimeConfig {
  const runtime = config.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    return {};
  }
  const input = runtime as Record<string, unknown>;
  return {
    ...(typeof input.recent_input_dir === "string" ? { recent_input_dir: input.recent_input_dir } : {}),
    ...(typeof input.recent_output_dir === "string" ? { recent_output_dir: input.recent_output_dir } : {}),
    ...(typeof input.recent_config_path === "string" ? { recent_config_path: input.recent_config_path } : {}),
    ...(typeof input.archive_standard_files === "boolean"
      ? { archive_standard_files: input.archive_standard_files }
      : {}),
    ...(typeof input.auto_reveal_manual_result === "boolean"
      ? { auto_reveal_manual_result: input.auto_reveal_manual_result }
      : {}),
  };
}

async function readRuntimeFromConfig(configPath: string): Promise<RuntimeConfig> {
  try {
    return runtimeFromConfig(await readConfigFile(configPath));
  } catch {
    return {};
  }
}

async function resolveActiveConfigPath(candidatePath?: string): Promise<string> {
  await ensureWritableConfig();
  if (candidatePath && (await pathExists(candidatePath))) {
    return candidatePath;
  }

  const defaultRuntime = await readRuntimeFromConfig(defaultExtractConfigPath);
  if (defaultRuntime.recent_config_path && (await pathExists(defaultRuntime.recent_config_path))) {
    return defaultRuntime.recent_config_path;
  }

  return defaultExtractConfigPath;
}

async function writeRuntimeToConfig(configPath: string, runtime: RuntimeConfig): Promise<void> {
  const parsed = await readConfigFile(configPath);
  parsed.runtime = runtime;
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function writeDefaultConfigPointer(configPath: string): Promise<void> {
  if (configPath === defaultExtractConfigPath) {
    return;
  }
  try {
    const parsed = await readConfigFile(defaultExtractConfigPath);
    parsed.runtime = {
      ...runtimeFromConfig(parsed),
      recent_config_path: configPath,
    };
    await writeFile(defaultExtractConfigPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  } catch {
    // 选择的配置文件仍是权威入口；默认配置指针写入失败不影响本次运行。
  }
}

async function readRuntimeConfig(): Promise<RuntimeConfig> {
  const defaults: RuntimeConfig = {
    recent_input_dir: "",
    recent_output_dir: "",
    recent_config_path: defaultExtractConfigPath,
    archive_standard_files: false,
    auto_reveal_manual_result: false,
  };

  try {
    await ensureWritableConfig();
    const defaultRuntime = await readRuntimeFromConfig(defaultExtractConfigPath);
    const activeConfigPath = await resolveActiveConfigPath(defaultRuntime.recent_config_path);
    const activeRuntime = await readRuntimeFromConfig(activeConfigPath);
    return {
      ...defaults,
      ...defaultRuntime,
      ...activeRuntime,
      recent_config_path: activeConfigPath,
    };
  } catch {
    // 兼容旧版本：如果提取配置读取失败，就尝试读取旧的运行配置文件。
  }

  try {
    const text = await readFile(legacyRuntimeConfigPath, "utf8");
    const legacyRuntime = JSON.parse(text) as RuntimeConfig;
    const activeConfigPath = await resolveActiveConfigPath(legacyRuntime.recent_config_path);
    return { ...defaults, ...legacyRuntime, recent_config_path: activeConfigPath };
  } catch {
    return defaults;
  }
}

async function writeRuntimeConfig(nextConfig: RuntimeConfig): Promise<RuntimeConfig> {
  const currentConfig = await readRuntimeConfig();
  const activeConfigPath = await resolveActiveConfigPath(nextConfig.recent_config_path ?? currentConfig.recent_config_path);
  const mergedConfig: RuntimeConfig = {
    ...currentConfig,
    ...nextConfig,
    recent_config_path: activeConfigPath,
  };
  await writeRuntimeToConfig(activeConfigPath, mergedConfig);
  await writeDefaultConfigPointer(activeConfigPath);
  return mergedConfig;
}

async function appendRuntimeLogs(rows: RuntimeLogRow[]): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }
  await mkdir(dirname(runtimeLogPath), { recursive: true });
  const content = rows.map((row) => `[${row.time}] [${row.level}] ${row.message}`).join("\n");
  await appendFile(runtimeLogPath, `${content}\n`, "utf8");
}

async function appendRuntimeLog(row: RuntimeLogRow): Promise<void> {
  await appendRuntimeLogs([row]);
}

async function exportRuntimeLog(): Promise<string | null> {
  await mkdir(dirname(runtimeLogPath), { recursive: true });
  try {
    await readFile(runtimeLogPath, "utf8");
  } catch {
    await writeFile(runtimeLogPath, "", "utf8");
  }

  const result = await dialog.showSaveDialog({
    defaultPath: `excel-order-log-${new Date().toISOString().slice(0, 10)}.log`,
    filters: [
      { name: "日志文件", extensions: ["log", "txt"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  await copyFile(runtimeLogPath, result.filePath);
  return result.filePath;
}

function validateTaskHistoryQuery(value: unknown): TaskHistoryQuery {
  if (value === undefined) return {};
  const input = requireRecord(value, "历史查询参数");
  const statuses = Array.isArray(input.statuses)
    ? input.statuses.filter((status): status is TaskHistoryStatus =>
        status === "running"
        || status === "completed"
        || status === "failed"
        || status === "stopped"
        || status === "interrupted")
    : undefined;
  return {
    ...(typeof input.from === "string" ? { from: input.from.slice(0, 10) } : {}),
    ...(typeof input.to === "string" ? { to: input.to.slice(0, 10) } : {}),
    ...(statuses ? { statuses } : {}),
    ...(typeof input.search === "string" ? { search: input.search.slice(0, 512) } : {}),
    ...(Number.isSafeInteger(input.page) ? { page: Number(input.page) } : {}),
    ...(Number.isSafeInteger(input.pageSize) ? { pageSize: Number(input.pageSize) } : {}),
  };
}

function validateBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("批次 ID 无效");
  }
  return value;
}

async function exportTaskHistory(value: unknown): Promise<string | null> {
  const input = requireRecord(value, "历史导出参数") as Partial<TaskHistoryExportRequest>;
  if (input.format === "json") {
    const batchId = validateBatchId(input.batchId);
    const content = await taskHistoryStore.exportBatchJson(batchId);
    if (content === null) throw new Error("批次不存在");
    const result = await dialog.showSaveDialog({
      defaultPath: `pricing-batch-${batchId}.json`,
      filters: [{ name: "JSON 文件", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, content, "utf8");
    return result.filePath;
  }
  if (input.format === "csv") {
    const query = validateTaskHistoryQuery(input.query);
    const content = await taskHistoryStore.exportHistoryCsv(query);
    const result = await dialog.showSaveDialog({
      defaultPath: `pricing-batches-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: "CSV 文件", extensions: ["csv"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, `\uFEFF${content}`, "utf8");
    return result.filePath;
  }
  throw new TypeError("不支持的历史导出格式");
}

async function clearOutputArtifacts(event: Electron.IpcMainInvokeEvent, outputDir: string): Promise<string[]> {
  requireTrustedIpc(event);
  if (!outputDir || typeof outputDir !== "string") {
    return [];
  }

  const resolvedOutputDir = resolve(outputDir);
  const runtimeConfig = await readRuntimeConfig();
  if (!runtimeConfig.recent_output_dir || !samePath(runtimeConfig.recent_output_dir, resolvedOutputDir)) {
    throw new Error("拒绝清理未由用户选择的输出目录");
  }
  const removedDirs: string[] = [];
  for (const dirName of outputArtifactDirs) {
    const targetDir = resolve(resolvedOutputDir, dirName);
    if (dirname(targetDir) !== resolvedOutputDir) {
      throw new Error(`拒绝清理输出目录外的路径: ${targetDir}`);
    }
    await rm(targetDir, { recursive: true, force: true });
    removedDirs.push(targetDir);
  }
  return removedDirs;
}

async function exportFileRows(event: Electron.IpcMainInvokeEvent, payload: ExportFileRowsPayload): Promise<string | null> {
  requireTrustedIpc(event);
  const input = requireRecord(payload, "导出参数");
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (rows.length > 100_000) {
    throw new RangeError("单次导出文件不能超过 100000 个");
  }
  const config = await readRuntimeConfig();
  const result = await dialog.showOpenDialog({
    defaultPath: config.recent_output_dir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const destinationDir = result.filePaths[0];
  for (const item of rows) {
    const row = requireRecord(item, "导出文件行");
    const sourcePath = typeof row.path === "string" ? row.path : "";
    if (
      !sourcePath ||
      !isAbsolute(sourcePath) ||
      !isSupportedExcelPath(sourcePath) ||
      !(await pathExists(sourcePath))
    ) {
      continue;
    }
    const sourceName = basename(sourcePath) || safeFileName(typeof row.originalName === "string" ? row.originalName : "导出文件.xlsx");
    if (resolve(sourcePath) === resolve(join(destinationDir, sourceName))) {
      continue;
    }
    const destinationPath = await nextAvailableCopyPath(destinationDir, sourceName);
    await copyFile(sourcePath, destinationPath);
  }
  await writeRuntimeConfig({ recent_output_dir: destinationDir });
  return destinationDir;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim().replace(/[. ]+$/g, "");
  return cleaned || "导出文件.xlsx";
}

async function nextAvailableCopyPath(directory: string, fileName: string): Promise<string> {
  const cleanedName = safeFileName(fileName);
  const extension = extname(cleanedName);
  const stem = extension ? cleanedName.slice(0, -extension.length) : cleanedName;
  let candidate = join(directory, cleanedName);
  let copyIndex = 2;
  while (await pathExists(candidate)) {
    candidate = join(directory, `${stem} (${copyIndex})${extension}`);
    copyIndex += 1;
  }
  return candidate;
}

function createWindow(): void {
  const initialSize = initialWindowSize(windowPreferences);
  const mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: "Excel 订单批量核价工具",
    backgroundColor: defaultWindowBackgroundColor,
    show: false,
    frame: false,
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let resizeSaveTimer: NodeJS.Timeout | undefined;
  let pendingWindowSize: WindowSize | undefined;
  mainWindow.on("resize", () => {
    if (!windowPreferences.rememberSize || mainWindow.isMaximized() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    const [width, height] = mainWindow.getSize();
    pendingWindowSize = { width, height };
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      if (!pendingWindowSize) return;
      windowPreferences = setRememberedWindowSize(windowPreferences, true, pendingWindowSize);
      pendingWindowSize = undefined;
      void writeWindowPreferences(windowPreferences).catch(() => undefined);
    }, windowResizeSaveDelayMs);
  });
  mainWindow.on("closed", () => {
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    if (windowPreferences.rememberSize && pendingWindowSize) {
      windowPreferences = setRememberedWindowSize(windowPreferences, true, pendingWindowSize);
      void writeWindowPreferences(windowPreferences).catch(() => undefined);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, trustedRendererLocation)) {
      event.preventDefault();
    }
  });
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(rendererHtmlPath);
  }
}

function broadcastProcessorEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("processor:event", event);
  }
}

function appendActiveTaskEvent(
  level: TaskHistoryEvent["level"],
  phase: TaskHistoryEvent["phase"],
  message: string,
  filePath?: string,
): void {
  if (!activeTask) return;
  activeTaskEventSequence += 1;
  const event: TaskHistoryEvent = {
    id: `${activeTask.id}-${activeTaskEventSequence}`,
    sequence: activeTaskEventSequence,
    time: new Date().toISOString(),
    level,
    phase,
    message,
    ...(filePath ? { filePath } : {}),
  };
  void taskHistoryStore.appendEvent(activeTask.id, event);
}

function saveActiveTaskFile(file: TaskFileResult): void {
  if (!activeTask) return;
  activeTaskFiles.set(file.path, file);
  void taskHistoryStore.appendFileResult(activeTask.id, file);
}

function completeActiveTask(status: TaskHistoryStatus, message: string): void {
  if (!activeTask) return;
  const completedAt = new Date().toISOString();
  for (const file of activeTaskFiles.values()) {
    if (file.status !== "queued" && file.status !== "running") continue;
    saveActiveTaskFile({
      ...file,
      status: "stopped",
      completedAt,
      durationMs: file.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(file.startedAt)) : undefined,
    });
  }
  appendActiveTaskEvent(
    status === "completed" ? "success" : status === "stopped" ? "warning" : "error",
    "batch",
    message,
  );
  const completed: TaskHistoryRecord = {
    ...activeTask,
    status,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(activeTask.startedAt)),
  };
  activeTask = null;
  activeTaskFiles.clear();
  activeTaskEventSequence = 0;
  activeTaskLastPersistedFiles = 0;
  void persistTaskRecord(completed);
}

function normalizeTaskDiagnostics(value: unknown): Map<string, TaskIssueSummary[]> {
  const result = new Map<string, TaskIssueSummary[]>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const diagnostic = item as Partial<TaskRunDiagnostics>;
    if (typeof diagnostic.inputPath !== "string" || !Array.isArray(diagnostic.issueSummaries)) continue;
    result.set(resolve(diagnostic.inputPath), diagnostic.issueSummaries);
  }
  return result;
}

function trackProcessorEvent(event: unknown): void {
  if (!activeTask || !event || typeof event !== "object" || Array.isArray(event)) return;
  const payload = event as Record<string, unknown>;
  if (payload.type === "price-progress" && typeof payload.path === "string" && payload.path) {
    const path = resolve(payload.path);
    const file = activeTaskFiles.get(path);
    if (file?.status === "queued") {
      const startedAt = new Date().toISOString();
      saveActiveTaskFile({ ...file, status: "running", startedAt });
      appendActiveTaskEvent("info", "file", `开始处理 ${file.fileName}`, path);
    }
  }
  if (payload.type === "log" && typeof payload.message === "string") {
    const level = payload.level === "success" || payload.level === "warning" || payload.level === "error"
      ? payload.level
      : "info";
    appendActiveTaskEvent(level, "processor", payload.message);
  }
  if (payload.type === "error" && typeof payload.message === "string") {
    appendActiveTaskEvent("error", "processor", payload.message);
  }
  if (payload.type === "price-file-result") {
    const path = typeof payload.path === "string" ? resolve(payload.path) : "";
    const currentFile = activeTaskFiles.get(path);
    const totalRows = typeof payload.totalRows === "number" ? payload.totalRows : 0;
    const matchedRows = typeof payload.matchedRows === "number" ? payload.matchedRows : 0;
    const exceptionRows = typeof payload.exceptionRows === "number" ? payload.exceptionRows : 0;
    const completedAt = new Date().toISOString();
    if (currentFile) {
      const startedAt = currentFile.startedAt ?? activeTask.startedAt;
      const status = payload.status === "completed" ? "completed" : "failed";
      const issueSummaries = status === "failed"
        ? [
            ...currentFile.issueSummaries,
            {
              code: "file_processing" as const,
              label: TASK_ISSUE_LABELS.file_processing,
              count: 1,
              samples: [{
                sourceRow: 0,
                country: "",
                sku: "",
                quantity: null,
                reason: String(payload.message ?? "文件处理失败"),
              }],
            },
          ]
        : currentFile.issueSummaries;
      saveActiveTaskFile({
        ...currentFile,
        status,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        totalRows,
        matchedRows,
        exceptionRows,
        issueSummaries,
        ...(typeof payload.coverage === "number" ? { coverage: payload.coverage } : {}),
        ...(typeof payload.outputPath === "string" ? { outputPath: payload.outputPath } : {}),
        ...(typeof payload.message === "string" ? { message: payload.message } : {}),
      });
      appendActiveTaskEvent(
        status === "completed" ? (exceptionRows > 0 ? "warning" : "success") : "error",
        "file",
        status === "completed"
          ? `${currentFile.fileName} 处理完成：匹配 ${matchedRows}/${totalRows} 行，异常 ${exceptionRows} 行`
          : `${currentFile.fileName} 处理失败：${String(payload.message ?? "未知错误")}`,
        path,
      );
    }
    activeTask = {
      ...activeTask,
      completedFiles: activeTask.completedFiles + (payload.status === "completed" ? 1 : 0),
      failedFiles: activeTask.failedFiles + (payload.status === "failed" ? 1 : 0),
      totalRows: activeTask.totalRows + totalRows,
      matchedRows: activeTask.matchedRows + matchedRows,
      exceptionRows: activeTask.exceptionRows + exceptionRows,
    };
    const processedFiles = activeTask.completedFiles + activeTask.failedFiles;
    if (
      processedFiles === activeTask.totalFiles
      || processedFiles - activeTaskLastPersistedFiles >= TASK_PROGRESS_PERSIST_FILE_INTERVAL
    ) {
      activeTaskLastPersistedFiles = processedFiles;
      void persistTaskRecord(activeTask);
    }
  }
  if (payload.type === "price-done" && payload.mode === "run") {
    const status = payload.stopped ? "stopped" : activeTask.failedFiles > 0 ? "failed" : "completed";
    completeActiveTask(
      status,
      status === "completed"
        ? "批次处理完成"
        : status === "stopped"
          ? "批次已停止"
          : `批次完成，但有 ${activeTask.failedFiles} 个文件失败`,
    );
  }
}

function getProcessorExecutable(): string {
  const executableName = process.platform === "win32" ? "auto-pricing-tool-processor.exe" : "auto-pricing-tool-processor";
  const configuredProcessorPath = app.isPackaged ? undefined : process.env.AUTO_PRICING_PROCESSOR;
  if (configuredProcessorPath && existsSync(configuredProcessorPath)) {
    return configuredProcessorPath;
  }

  const packagedProcessorPaths = [
    join(portableRootDir, "processor", executableName),
    join(resourceRootDir, "processor", executableName),
  ];
  for (const processorPath of packagedProcessorPaths) {
    if (app.isPackaged && existsSync(processorPath)) {
      return processorPath;
    }
  }

  return resolveLocalProcessorExecutable(rootDir, app.isPackaged, executableName);
}

function ensureProcessor(): ChildProcessWithoutNullStreams {
  if (processor && !processor.killed) {
    return processor;
  }

  const child = spawn(getProcessorExecutable(), [], {
    cwd: resourceRootDir,
    env: {
      ...process.env,
    },
  });
  processor = child;

  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const event = JSON.parse(line) as unknown;
      trackProcessorEvent(event);
      broadcastProcessorEvent(event);
    } catch {
      broadcastProcessorEvent({ type: "log", level: "info", message: line });
    }
  });

  createInterface({ input: child.stderr }).on("line", (line) => {
    broadcastProcessorEvent({ type: "log", level: "error", message: line });
  });

  child.on("exit", (code) => {
    broadcastProcessorEvent({ type: "state", state: "exited", code });
    if (processor === child) {
      processor = null;
      processorActivity = null;
    }
  });
  child.on("error", (error) => {
    broadcastProcessorEvent({ type: "error", message: `Rust 处理器启动失败: ${error.message}` });
    if (processor === child) {
      processor = null;
      processorActivity = null;
    }
  });

  return child;
}

function sendProcessorCommand(command: ProcessorCommand): void {
  const child = ensureProcessor();
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function stopProcessorProcess(): Promise<void> {
  const child = processor;
  const stoppedActivity = processorActivity;
  if (!child || child.killed) {
    broadcastProcessorEvent({ type: "state", state: "idle" });
    return Promise.resolve();
  }

  return new Promise((resolveStop) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      processor = null;
      processorActivity = null;
      if (stoppedActivity === "start") {
        broadcastProcessorEvent({ type: "done", stopped: true, summaryPath: null, outputFiles: [], failures: [] });
      } else if (stoppedActivity === "price-run") {
        broadcastProcessorEvent({ type: "price-done", mode: "run", stopped: true, files: [], failures: [] });
        completeActiveTask("stopped", "批次已由用户停止");
      } else if (stoppedActivity === "price-analyze") {
        broadcastProcessorEvent({ type: "price-done", mode: "analysis", stopped: true, files: [] });
      }
      resolveStop();
    };
    child.once("exit", finish);
    child.once("error", finish);
    if (!child.kill()) {
      finish();
    }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  installContentSecurityPolicy();
  await markInterruptedTasks();
  windowPreferences = await readWindowPreferences();

  ipcMain.handle("app:get-runtime-config", (event) => {
    requireTrustedIpc(event);
    return readRuntimeConfig();
  });
  ipcMain.handle("app:get-default-price-output-dir", (event) => {
    requireTrustedIpc(event);
    return join(dirname(app.getPath("exe")), "核价结果");
  });
  ipcMain.handle("app:get-processing-capacity", (event) => {
    requireTrustedIpc(event);
    return { detectedThreads: detectedProcessingThreads, maxWorkers: maxConfiguredProcessingWorkers };
  });
  ipcMain.handle("window:minimize", (event) => {
    requireTrustedIpc(event);
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    requireTrustedIpc(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle("window:close", (event) => {
    requireTrustedIpc(event);
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("window:get-preferences", (event) => {
    requireTrustedIpc(event);
    return windowPreferences;
  });
  ipcMain.handle("window:set-remember-size", async (event, rememberSize: unknown) => {
    requireTrustedIpc(event);
    if (typeof rememberSize !== "boolean") throw new TypeError("记住窗口大小选项必须是布尔值");
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const fallbackSize = initialWindowSize(windowPreferences);
    const [width, height] = targetWindow?.getSize() ?? [fallbackSize.width, fallbackSize.height];
    windowPreferences = setRememberedWindowSize(windowPreferences, rememberSize, { width, height });
    await writeWindowPreferences(windowPreferences);
    return windowPreferences;
  });
  ipcMain.handle("app:set-runtime-config", (event, payload: unknown) => {
    requireTrustedIpc(event);
    return writeRuntimeConfig(validateRuntimeConfigUpdate(payload));
  });
  ipcMain.handle("config:get-document", (event, candidatePath?: unknown) => {
    requireTrustedIpc(event);
    if (candidatePath !== undefined && typeof candidatePath !== "string") {
      throw new TypeError("配置路径必须是字符串");
    }
    return readConfigDocument(candidatePath);
  });
  ipcMain.handle("config:validate-document", (event, content: unknown) => {
    requireTrustedIpc(event);
    if (typeof content !== "string") throw new TypeError("配置内容必须是字符串");
    return validateConfigContent(content);
  });
  ipcMain.handle("config:save-document", (event, payload: unknown) => {
    requireTrustedIpc(event);
    return saveConfigDocument(payload);
  });
  ipcMain.handle("config:save-document-as", (event, content: unknown) => {
    requireTrustedIpc(event);
    if (typeof content !== "string") throw new TypeError("配置内容必须是字符串");
    return saveConfigDocumentAs(content);
  });
  ipcMain.handle("config:restore-default", (event) => {
    requireTrustedIpc(event);
    return restoreDefaultConfig();
  });
  ipcMain.handle("history:get-summary", (event) => {
    requireTrustedIpc(event);
    return getTaskHistorySummary();
  });
  ipcMain.handle("history:list", (event, query: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryStore.listTaskHistory(validateTaskHistoryQuery(query));
  });
  ipcMain.handle("history:get-detail", (event, batchId: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryStore.getTaskHistoryDetail(validateBatchId(batchId));
  });
  ipcMain.handle("history:get-analytics", (event, query: unknown) => {
    requireTrustedIpc(event);
    const validated = validateTaskHistoryQuery(query);
    const analyticsQuery: TaskAnalyticsQuery = { from: validated.from, to: validated.to };
    return taskHistoryStore.getTaskAnalytics(analyticsQuery);
  });
  ipcMain.handle("history:export", (event, request: unknown) => {
    requireTrustedIpc(event);
    return exportTaskHistory(request);
  });
  ipcMain.handle("templates:list", (event) => {
    requireTrustedIpc(event);
    return readHeaderTemplates();
  });
  ipcMain.handle("templates:create", async (event) => {
    requireTrustedIpc(event);
    const result = await dialog.showOpenDialog({
      filters: [
        { name: "Excel 模板", extensions: ["xlsx", "xls", "xlsm", "xlsb"] },
      ],
      properties: ["openFile"],
    });
    const sourcePath = result.filePaths[0];
    if (result.canceled || !sourcePath) return null;
    if (!isSupportedExcelPath(sourcePath)) throw new TypeError("请选择受支持的 Excel 模板文件");
    await mkdir(templateStoreDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const storedName = `${id}${extname(sourcePath).toLowerCase()}`;
    const storedPath = join(templateStoreDir, storedName);
    await copyFile(sourcePath, storedPath);
    const record: HeaderTemplateRecord = {
      id,
      createdAt: new Date().toISOString(),
      createdBy: userInfo().username || "当前用户",
      fileName: basename(sourcePath),
      filePath: storedPath,
      mappings: [],
    };
    const records = await readHeaderTemplates();
    records.unshift(record);
    await writeHeaderTemplates(records);
    return record;
  });
  ipcMain.handle("templates:update-mappings", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    const input = requireRecord(payload, "模板映射参数");
    if (typeof input.id !== "string" || !input.id.trim()) throw new TypeError("缺少模板 ID");
    const mappings = parseHeaderTemplateMappings(input.mappings);
    const records = await readHeaderTemplates();
    const index = records.findIndex((record) => record.id === input.id);
    if (index < 0) throw new Error("模板不存在或已被删除");
    records[index] = { ...records[index], mappings };
    await writeHeaderTemplates(records);
    return records[index];
  });
  ipcMain.handle("templates:delete", async (event, id: unknown) => {
    requireTrustedIpc(event);
    if (typeof id !== "string" || !id.trim()) throw new TypeError("缺少模板 ID");
    const records = await readHeaderTemplates();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return;
    const [record] = records.splice(index, 1);
    await writeHeaderTemplates(records);
    if (samePath(dirname(record.filePath), templateStoreDir)) await rm(record.filePath, { force: true });
  });
  ipcMain.handle("app:append-runtime-log", (event, payload: RuntimeLogRow) => {
    requireTrustedIpc(event);
    const [row] = normalizeRuntimeLogRows([payload]);
    return appendRuntimeLog(row);
  });
  ipcMain.handle("app:append-runtime-logs", (event, payload: RuntimeLogRow[]) => {
    requireTrustedIpc(event);
    return appendRuntimeLogs(normalizeRuntimeLogRows(payload));
  });
  ipcMain.handle("app:export-runtime-log", (event) => {
    requireTrustedIpc(event);
    return exportRuntimeLog();
  });
  ipcMain.handle("app:export-file-rows", exportFileRows);
  ipcMain.handle("app:clear-output-artifacts", clearOutputArtifacts);
  ipcMain.handle("app:open-path", async (_event, filePath: string) => {
    requireTrustedIpc(_event);
    if (
      typeof filePath !== "string" ||
      !isAbsolute(filePath) ||
      !(await pathExists(filePath))
    ) {
      return "路径不存在或不是有效的绝对路径";
    }
    return shell.openPath(resolve(filePath));
  });
  ipcMain.handle("app:list-excel-files", async (event, directory: unknown) => {
    requireTrustedIpc(event);
    if (typeof directory !== "string" || !isAbsolute(directory) || !(await pathExists(directory))) {
      throw new TypeError("输入目录无效，必须是存在的绝对路径");
    }
    const directoryInfo = await stat(directory);
    if (!directoryInfo.isDirectory()) {
      throw new TypeError("输入路径不是文件夹");
    }
    return collectExcelFiles(directory);
  });
  ipcMain.handle("app:read-excel-preview-file", (event, filePath: unknown) => {
    requireTrustedIpc(event);
    return readExcelPreviewFile(filePath);
  });
  ipcMain.handle("processor:scan", (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorActivity = "scan";
    sendProcessorCommand({ ...requireRecord(payload, "扫描参数"), action: "scan" });
  });
  ipcMain.handle("processor:start", (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorActivity = "start";
    sendProcessorCommand({ ...requireRecord(payload, "处理参数"), action: "start" });
  });
  ipcMain.handle("processor:merge-summaries", (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorActivity = "merge";
    sendProcessorCommand({ ...requireRecord(payload, "合并参数"), action: "merge-summaries" });
  });
  ipcMain.handle("processor:price-check-analyze", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorActivity = "price-analyze";
    sendProcessorCommand({ ...(await validatePricePayload(payload)), headerTemplates: await readHeaderTemplates(), action: "price-check-analyze" });
  });
  ipcMain.handle("processor:price-check-run", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    const validated = await validatePricePayload(payload);
    const files = validated.files as string[];
    const startedAt = new Date().toISOString();
    const diagnostics = normalizeTaskDiagnostics(validated.diagnostics);
    activeTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      schemaVersion: TASK_HISTORY_SCHEMA_VERSION,
      startedAt,
      status: "running",
      totalFiles: files.length,
      completedFiles: 0,
      failedFiles: 0,
      totalRows: 0,
      matchedRows: 0,
      exceptionRows: 0,
      fileNames: files.map((path) => basename(path)),
      detailAvailable: true,
      ...(typeof validated.outputDir === "string" ? { outputDir: validated.outputDir } : {}),
    };
    activeTaskEventSequence = 0;
    activeTaskLastPersistedFiles = 0;
    activeTaskFiles.clear();
    await persistTaskRecord(activeTask);
    appendActiveTaskEvent("info", "batch", `批次开始，共 ${files.length} 个文件`);
    for (const path of files) {
      const file: TaskFileResult = {
        path,
        fileName: basename(path),
        status: "queued",
        totalRows: 0,
        matchedRows: 0,
        exceptionRows: diagnostics.get(path)?.reduce((sum, issue) => sum + issue.count, 0) ?? 0,
        issueSummaries: diagnostics.get(path) ?? [],
      };
      saveActiveTaskFile(file);
    }
    processorActivity = "price-run";
    try {
      sendProcessorCommand({ ...validated, headerTemplates: await readHeaderTemplates(), action: "price-check-run" });
    } catch (error) {
      completeActiveTask("failed", `批次提交失败：${String(error)}`);
      throw error;
    }
  });
  ipcMain.handle("processor:price-check-validate", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    const input = requireRecord(payload, "字段映射试算参数");
    const validated = await validatePricePayload({ ...input, files: [input.inputPath] });
    processorActivity = "price-validate";
    sendProcessorCommand({
      ...input,
      inputPath: (validated.files as string[])[0],
      ...(input.rowEdit === undefined ? {} : { rowEdit: validatePriceRowEditPayload(input.rowEdit) }),
      action: "price-check-validate",
    });
  });
  ipcMain.handle("processor:pause", (event) => {
    requireTrustedIpc(event);
    appendActiveTaskEvent("warning", "batch", "用户暂停批次");
    sendProcessorCommand({ action: "pause" });
  });
  ipcMain.handle("processor:resume", (event) => {
    requireTrustedIpc(event);
    appendActiveTaskEvent("info", "batch", "用户继续批次");
    sendProcessorCommand({ action: "resume" });
  });
  ipcMain.handle("processor:stop", (event) => {
    requireTrustedIpc(event);
    appendActiveTaskEvent("warning", "batch", "用户请求停止批次");
    return stopProcessorProcess();
  });

  ipcMain.handle("dialog:select-directory", async (event, purpose: "input" | "output" = "input", persist = true) => {
    requireTrustedIpc(event);
    const config = await readRuntimeConfig();
    const configKey = purpose === "output" ? "recent_output_dir" : "recent_input_dir";
    const result = await dialog.showOpenDialog({
      defaultPath: config[configKey],
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    if (persist) {
      await writeRuntimeConfig({ [configKey]: result.filePaths[0] });
    }
    return result.filePaths[0];
  });
  ipcMain.handle("dialog:select-excel-files", async (event) => {
    requireTrustedIpc(event);
    const config = await readRuntimeConfig();
    const result = await dialog.showOpenDialog({
      defaultPath: config.recent_input_dir,
      filters: [{ name: "Excel 文件", extensions: ["xlsx", "xls", "xlsm", "xlsb"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    await writeRuntimeConfig({ recent_input_dir: dirname(result.filePaths[0]) });
    return result.filePaths;
  });

  ipcMain.handle("dialog:select-config", async (event) => {
    requireTrustedIpc(event);
    const config = await readRuntimeConfig();
    const result = await dialog.showOpenDialog({
      defaultPath: config.recent_config_path,
      filters: [
        { name: "JSON 配置", extensions: ["json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const selectedDocument = await readConfigDocument(result.filePaths[0]);
    const validation = validateConfigContent(selectedDocument.content);
    if (!validation.valid) {
      throw new Error(`配置校验失败：${validation.issues[0]?.path} ${validation.issues[0]?.message}`);
    }
    await writeDefaultConfigPointer(selectedDocument.path);
    return selectedDocument.path;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (processor && !processor.killed) {
    processor.stdin.write(`${JSON.stringify({ action: "shutdown" })}\n`);
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
