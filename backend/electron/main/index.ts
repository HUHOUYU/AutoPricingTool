import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } from "electron";
import { existsSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { availableParallelism, userInfo } from "node:os";
import { assertTrustedIpcSender } from "./security";
import { readExcelPreviewFile } from "./excel-preview-file";
import { resolveLocalProcessorExecutable } from "./processor-path";
import { TaskHistoryStore, TASK_HISTORY_SCHEMA_VERSION } from "./task-history-store";
import { createBatchOutputDirectory } from "./batch-output";
import type {
  TaskExecutionType,
} from "../../../shared/task-history";
import type {
  AppPreferences,
  AppPreferencesUpdate,
  AppState,
  AppStateUpdate,
} from "../../../shared/app-settings";
import { DEFAULT_APP_PREFERENCES, defaultAppState } from "../../../shared/app-settings";
import {
  AppSettingsStore,
  validateAppPreferencesUpdate,
  validateAppStateUpdate,
} from "./app-settings-store";
import { resolveBundledDefaultConfigPath } from "./resource-paths";
import { createConfigDocumentService } from "./config-document-service";
import { HeaderTemplateStore } from "./header-template-store";
import { samePath } from "./path-utils";
import { collectExcelFiles } from "./excel-file-collector";
import {
  type WindowPreferences,
} from "./window-preferences";
import { createWindowManager } from "./window-manager";
import { createProcessorSession } from "./processor-session";
import { createTaskHistoryService } from "./task-history-service";
import { createActiveTaskTracker } from "./active-task-tracker";
import {
  batchName as sanitizeBatchName,
  batchNote as sanitizeBatchNote,
  defaultBatchName,
  normalizeTaskDiagnostics,
  validateBatchId,
} from "./task-history-utils";

type ExportFileRowsPayload = {
  categoryLabel: string;
  rows: Array<Record<string, unknown>>;
};

type RuntimeLogRow = {
  time: string;
  level: string;
  message: string;
};

const rootDir = resolve(__dirname, "../..");
const resourceRootDir = app.isPackaged ? process.resourcesPath : rootDir;
const writableRootDir = app.isPackaged ? app.getPath("userData") : rootDir;
const portableRootDir =
  app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR ? process.env.PORTABLE_EXECUTABLE_DIR : dirname(process.execPath);
const bundledDefaultConfigPath = resolveBundledDefaultConfigPath(resourceRootDir, app.isPackaged);
const defaultExtractConfigPath = join(writableRootDir, "config", "extract_rules.json");
const runtimeLogPath = join(writableRootDir, "runtime", "logs", "app.log");
const taskHistoryPath = join(writableRootDir, "runtime", "task-history.jsonl");
const taskHistoryDetailsDir = join(writableRootDir, "runtime", "task-details");
const taskHistoryStore = new TaskHistoryStore(taskHistoryPath, taskHistoryDetailsDir);
const templateStoreDir = join(app.getPath("userData"), "templates");
const templateStorePath = join(templateStoreDir, "templates.json");
const preferencesPath = join(app.getPath("userData"), "preferences.json");
const statePath = join(app.getPath("userData"), "state.json");
const appSettingsStore = new AppSettingsStore(preferencesPath, statePath, defaultExtractConfigPath);
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
const headerTemplateStore = new HeaderTemplateStore({
  directory: templateStoreDir,
  indexPath: templateStorePath,
  isSupportedFile: (path) => isSupportedExcelPath(path),
});
const MAX_INPUT_FILES = 5_000;
const TASK_PROGRESS_PERSIST_FILE_INTERVAL = 10;
const defaultWindowBackgroundColor = "#EEF3F8";
const windowResizeSaveDelayMs = 300;
const detectedProcessingThreads = availableParallelism();
const maxConfiguredProcessingWorkers = Math.max(0, detectedProcessingThreads - 1);
let appPreferences: AppPreferences = { ...DEFAULT_APP_PREFERENCES };
let appState: AppState = defaultAppState(defaultExtractConfigPath);
const activeTaskTracker = createActiveTaskTracker({
  store: taskHistoryStore,
  progressPersistFileInterval: TASK_PROGRESS_PERSIST_FILE_INTERVAL,
});
const taskHistoryService = createTaskHistoryService({
  store: taskHistoryStore,
  maxInputFiles: MAX_INPUT_FILES,
  isActiveBatch: activeTaskTracker.isActiveBatch,
  onActiveRecordUpdated: activeTaskTracker.updateRecord,
  selectSavePath: async (defaultPath, filters) => {
    const result = await dialog.showSaveDialog({ defaultPath, filters });
    return result.canceled || !result.filePath ? null : result.filePath;
  },
});
const configDocuments = createConfigDocumentService({
  bundledDefaultConfigPath,
  defaultConfigPath: defaultExtractConfigPath,
  getActiveConfigPath: () => appState.activeBusinessConfigPath,
  maxProcessingWorkers: maxConfiguredProcessingWorkers,
  selectSavePath: async (defaultPath) => {
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  setActiveConfigPath: async (path) => {
    appState = await appSettingsStore.updateState({ activeBusinessConfigPath: path });
  },
});
const {
  ensureWritableConfig,
  readDocument: readConfigDocument,
  resolveActiveConfigPath,
  restoreDefault: restoreDefaultConfig,
  saveDocument: saveConfigDocument,
  saveDocumentAs: saveConfigDocumentAs,
  validate: validateConfigContent,
} = configDocuments;
const windowManager = createWindowManager({
  appIconPath,
  backgroundColor: defaultWindowBackgroundColor,
  getPreferences: currentWindowPreferences,
  isRememberSizeEnabled: () => appPreferences.rememberWindowSize,
  onRememberSizeChange: async (rememberSize, next) => {
    [appPreferences, appState] = await Promise.all([
      appSettingsStore.updatePreferences({ rememberWindowSize: rememberSize }),
      appSettingsStore.updateState({
        ...(next.width !== undefined ? { windowWidth: next.width } : {}),
        ...(next.height !== undefined ? { windowHeight: next.height } : {}),
      }),
    ]);
  },
  persistWindowSize: async ({ width, height }) => {
    appState = await appSettingsStore.updateState({ windowWidth: width, windowHeight: height });
  },
  preloadPath: join(__dirname, "../preload/index.js"),
  resizeSaveDelayMs: windowResizeSaveDelayMs,
  trustedRendererLocation,
});
const processorSession = createProcessorSession({
  broadcastEvent: broadcastProcessorEvent,
  cwd: resourceRootDir,
  getExecutablePath: getProcessorExecutable,
  onRunStopped: () => activeTaskTracker.complete("stopped", "批次已由用户停止"),
  onStructuredEvent: activeTaskTracker.trackProcessorEvent,
});

function requireTrustedIpc(event: Electron.IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event, trustedRendererLocation);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function currentWindowPreferences(): WindowPreferences {
  return {
    rememberSize: appPreferences.rememberWindowSize,
    ...(appState.windowWidth !== undefined ? { width: appState.windowWidth } : {}),
    ...(appState.windowHeight !== undefined ? { height: appState.windowHeight } : {}),
  };
}

function isSupportedExcelPath(path: string): boolean {
  return supportedExcelExtensions.has(extname(path).toLowerCase());
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
  if (input.configPath !== undefined && (typeof input.configPath !== "string" || !isAbsolute(input.configPath))) {
    throw new TypeError("业务配置必须是绝对路径");
  }
  const configDocument = await readConfigDocument(
    typeof input.configPath === "string" ? input.configPath : undefined,
  );
  const configValidation = validateConfigContent(configDocument.content);
  if (!configValidation.valid) {
    throw new Error(
      `配置校验失败：${configValidation.issues[0]?.path} ${configValidation.issues[0]?.message}`,
    );
  }
  return {
    ...input,
    files: normalizedFiles,
    configPath: configDocument.path,
    ...(typeof outputDir === "string" ? { outputDir: resolve(outputDir) } : {}),
  };
}

function validatePriceRowEditPayload(value: unknown): {
  sourceRow: number;
  quantity: number | null;
  useOriginalSkuQuantity?: boolean;
} {
  const input = requireRecord(value, "单行核价参数");
  if (!Number.isSafeInteger(input.sourceRow) || Number(input.sourceRow) < 1) {
    throw new TypeError("单行核价 sourceRow 必须是大于 0 的整数");
  }
  if (input.quantity !== null && (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 0)) {
    throw new TypeError("单行核价 quantity 必须是非负整数或 null");
  }
  if (
    input.useOriginalSkuQuantity !== undefined
    && typeof input.useOriginalSkuQuantity !== "boolean"
  ) {
    throw new TypeError("单行核价 useOriginalSkuQuantity 必须是布尔值");
  }
  return {
    sourceRow: Number(input.sourceRow),
    quantity: input.quantity === null ? null : Number(input.quantity),
    ...(input.useOriginalSkuQuantity === true ? { useOriginalSkuQuantity: true } : {}),
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const markInterruptedTasks = (): Promise<void> => taskHistoryStore.markInterruptedTasks();

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

async function clearOutputArtifacts(event: Electron.IpcMainInvokeEvent, outputDir: string): Promise<string[]> {
  requireTrustedIpc(event);
  if (!outputDir || typeof outputDir !== "string") {
    return [];
  }

  const resolvedOutputDir = resolve(outputDir);
  if (!appState.recentOutputDirectory || !samePath(appState.recentOutputDirectory, resolvedOutputDir)) {
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
  const result = await dialog.showOpenDialog({
    defaultPath: appState.recentOutputDirectory,
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
  appState = await appSettingsStore.updateState({ recentOutputDirectory: destinationDir });
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

function broadcastProcessorEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("processor:event", event);
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  installContentSecurityPolicy();
  await markInterruptedTasks();
  [appPreferences, appState] = await Promise.all([
    appSettingsStore.readPreferences(),
    appSettingsStore.readState(),
  ]);

  ipcMain.handle("app:get-preferences", (event) => {
    requireTrustedIpc(event);
    return appPreferences;
  });
  ipcMain.handle("app:set-preferences", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    appPreferences = await appSettingsStore.updatePreferences(validateAppPreferencesUpdate(payload));
    return appPreferences;
  });
  ipcMain.handle("app:get-state", (event) => {
    requireTrustedIpc(event);
    return appState;
  });
  ipcMain.handle("app:set-state", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    appState = await appSettingsStore.updateState(validateAppStateUpdate(payload));
    return appState;
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
    windowManager.minimize(event.sender);
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    requireTrustedIpc(event);
    windowManager.toggleMaximize(event.sender);
  });
  ipcMain.handle("window:close", (event) => {
    requireTrustedIpc(event);
    windowManager.close(event.sender);
  });
  ipcMain.handle("window:get-preferences", (event) => {
    requireTrustedIpc(event);
    return windowManager.getPreferences();
  });
  ipcMain.handle("window:set-remember-size", async (event, rememberSize: unknown) => {
    requireTrustedIpc(event);
    if (typeof rememberSize !== "boolean") throw new TypeError("记住窗口大小选项必须是布尔值");
    return windowManager.setRememberSize(event.sender, rememberSize);
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
    return taskHistoryService.getSummary();
  });
  ipcMain.handle("history:list", (event, query: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryService.list(query);
  });
  ipcMain.handle("history:get-detail", (event, batchId: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryService.getDetail(batchId);
  });
  ipcMain.handle("history:update-metadata", (event, payload: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryService.updateMetadata(payload);
  });
  ipcMain.handle("history:finish-batch", (event, payload: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryService.finishBatch(payload);
  });
  ipcMain.handle("history:get-analytics", (event, query: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryService.getAnalytics(query);
  });
  ipcMain.handle("history:export", (event, request: unknown) => {
    requireTrustedIpc(event);
    return taskHistoryService.exportHistory(request);
  });
  ipcMain.handle("templates:list", (event) => {
    requireTrustedIpc(event);
    return headerTemplateStore.list();
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
    return headerTemplateStore.createFromFile(sourcePath, userInfo().username || "当前用户");
  });
  ipcMain.handle("templates:update-mappings", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    const input = requireRecord(payload, "模板映射参数");
    return headerTemplateStore.updateMappings(input.id, input.mappings);
  });
  ipcMain.handle("templates:delete", async (event, id: unknown) => {
    requireTrustedIpc(event);
    await headerTemplateStore.delete(id);
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
    return collectExcelFiles(directory, {
      maxFiles: MAX_INPUT_FILES,
      isSupportedFile: isSupportedExcelPath,
    });
  });
  ipcMain.handle("app:read-excel-preview-file", (event, filePath: unknown) => {
    requireTrustedIpc(event);
    return readExcelPreviewFile(filePath);
  });
  ipcMain.handle("processor:scan", (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorSession.send({ ...requireRecord(payload, "扫描参数"), action: "scan" }, "scan");
  });
  ipcMain.handle("processor:start", (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorSession.send({
      ...requireRecord(payload, "处理参数"),
      archiveStandardFiles: appPreferences.archiveStandardFiles,
      action: "start",
    }, "start");
  });
  ipcMain.handle("processor:merge-summaries", (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorSession.send({ ...requireRecord(payload, "合并参数"), action: "merge-summaries" }, "merge");
  });
  ipcMain.handle("processor:price-check-analyze", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorSession.send({
      ...(await validatePricePayload(payload)),
      headerTemplates: await headerTemplateStore.list(),
      action: "price-check-analyze",
    }, "price-analyze");
  });
  ipcMain.handle("processor:price-check-run", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    const validated = await validatePricePayload(payload);
    const files = validated.files as string[];
    const requestedBatchId = validated.batchId === undefined ? null : validateBatchId(validated.batchId);
    const existingDetail = requestedBatchId ? await taskHistoryStore.getTaskHistoryDetail(requestedBatchId) : null;
    if (requestedBatchId && !existingDetail) throw new Error("指定批次不存在");
    const batchId = requestedBatchId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = existingDetail?.record.startedAt ?? new Date().toISOString();
    const diagnostics = normalizeTaskDiagnostics(validated.diagnostics);
    const executionType: TaskExecutionType = validated.executionType === "manual" || validated.executionType === "retry"
      ? validated.executionType
      : "automatic";
    const requestedBatchFiles = Array.isArray(validated.batchFiles) ? validated.batchFiles : files;
    const batchFiles = [...new Set(requestedBatchFiles.map((path) => {
      if (typeof path !== "string" || !isAbsolute(path) || !isSupportedExcelPath(path)) {
        throw new TypeError("业务批次包含无效文件路径");
      }
      return resolve(path);
    }))];
    const existingFiles = existingDetail?.files ?? [];
    const allBatchFiles = [...new Set([
      ...existingFiles.map((file) => file.path),
      ...batchFiles,
      ...files,
    ])];
    const previousRecord = existingDetail?.record;
    const batchName = previousRecord?.name
      || sanitizeBatchName(validated.batchName)
      || defaultBatchName(allBatchFiles.map((path) => basename(path)), batchId);
    const requestedOutputRoot = typeof validated.outputDir === "string" ? validated.outputDir : undefined;
    const outputRoot = previousRecord?.outputRoot ?? requestedOutputRoot;
    const batchOutputDir = previousRecord?.outputRoot && previousRecord.outputDir
      ? previousRecord.outputDir
      : outputRoot
        ? await createBatchOutputDirectory(outputRoot, batchName, batchId)
        : undefined;
    const {
      completedAt: _previousCompletedAt,
      durationMs: _previousDurationMs,
      ...previousRecordWithoutCompletion
    } = previousRecord ?? {};
    await activeTaskTracker.startRun({
      record: {
        ...previousRecordWithoutCompletion,
        id: batchId,
        name: batchName,
        note: validated.batchNote === undefined
          ? previousRecord?.note
          : sanitizeBatchNote(validated.batchNote),
        schemaVersion: TASK_HISTORY_SCHEMA_VERSION,
        startedAt,
        status: "running",
        totalFiles: allBatchFiles.length,
        completedFiles: previousRecord?.completedFiles ?? 0,
        failedFiles: previousRecord?.failedFiles ?? 0,
        totalRows: previousRecord?.totalRows ?? 0,
        matchedRows: previousRecord?.matchedRows ?? 0,
        exceptionRows: previousRecord?.exceptionRows ?? 0,
        fileNames: allBatchFiles.map((path) => basename(path)),
        detailAvailable: true,
        ...(outputRoot ? { outputRoot } : {}),
        ...(batchOutputDir ? { outputDir: batchOutputDir } : {}),
      },
      existingFiles,
      allFiles: allBatchFiles,
      runFiles: files,
      remainingFiles: Number.isSafeInteger(validated.remainingFiles)
        ? Math.max(0, Number(validated.remainingFiles))
        : Math.max(0, allBatchFiles.length - files.length),
      executionType,
      diagnostics,
      eventSequence: existingDetail?.events.at(-1)?.sequence ?? 0,
      isContinuation: Boolean(existingDetail),
    });
    try {
      processorSession.send({
        ...validated,
        ...(batchOutputDir ? { outputDir: batchOutputDir } : {}),
        overwriteSourceFiles: appPreferences.overwriteSourceFiles,
        headerTemplates: await headerTemplateStore.list(),
        action: "price-check-run",
      }, "price-run");
    } catch (error) {
      activeTaskTracker.complete("failed", `批次提交失败：${String(error)}`);
      throw error;
    }
    return { batchId };
  });
  ipcMain.handle("processor:price-check-validate", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    const input = requireRecord(payload, "字段映射试算参数");
    const validated = await validatePricePayload({ ...input, files: [input.inputPath] });
    processorSession.send({
      ...input,
      inputPath: (validated.files as string[])[0],
      ...(input.rowEdit === undefined ? {} : { rowEdit: validatePriceRowEditPayload(input.rowEdit) }),
      action: "price-check-validate",
    }, "price-validate");
  });
  ipcMain.handle("processor:pause", (event) => {
    requireTrustedIpc(event);
    activeTaskTracker.appendEvent("warning", "batch", "用户暂停批次");
    processorSession.send({ action: "pause" });
  });
  ipcMain.handle("processor:resume", (event) => {
    requireTrustedIpc(event);
    activeTaskTracker.appendEvent("info", "batch", "用户继续批次");
    processorSession.send({ action: "resume" });
  });
  ipcMain.handle("processor:stop", (event) => {
    requireTrustedIpc(event);
    activeTaskTracker.appendEvent("warning", "batch", "用户请求停止批次");
    return processorSession.stop();
  });

  ipcMain.handle("dialog:select-directory", async (event, purpose: "input" | "output" = "input", persist = true) => {
    requireTrustedIpc(event);
    const configKey = purpose === "output" ? "recentOutputDirectory" : "recentInputDirectory";
    const result = await dialog.showOpenDialog({
      defaultPath: appState[configKey],
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    if (persist) {
      appState = await appSettingsStore.updateState({ [configKey]: result.filePaths[0] });
    }
    return result.filePaths[0];
  });
  ipcMain.handle("dialog:select-excel-files", async (event) => {
    requireTrustedIpc(event);
    const result = await dialog.showOpenDialog({
      defaultPath: appState.recentInputDirectory,
      filters: [{ name: "Excel 文件", extensions: ["xlsx", "xls", "xlsm", "xlsb"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    appState = await appSettingsStore.updateState({ recentInputDirectory: dirname(result.filePaths[0]) });
    return result.filePaths;
  });

  ipcMain.handle("dialog:select-config", async (event) => {
    requireTrustedIpc(event);
    const result = await dialog.showOpenDialog({
      defaultPath: appState.activeBusinessConfigPath,
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
    appState = await appSettingsStore.updateState({ activeBusinessConfigPath: selectedDocument.path });
    return selectedDocument.path;
  });

  windowManager.createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  processorSession.shutdown();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
