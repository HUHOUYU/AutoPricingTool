import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { assertTrustedIpcSender, isTrustedRendererUrl } from "./security";

type RuntimeConfig = {
  recent_input_dir?: string;
  recent_output_dir?: string;
  recent_config_path?: string;
  archive_standard_files?: boolean;
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

const rootDir = resolve(__dirname, "../..");
const resourceRootDir = app.isPackaged ? process.resourcesPath : rootDir;
const writableRootDir = app.isPackaged ? app.getPath("userData") : rootDir;
const portableRootDir =
  app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR ? process.env.PORTABLE_EXECUTABLE_DIR : dirname(process.execPath);
const bundledExtractConfigPath = join(resourceRootDir, "config", "extract_rules.json");
const defaultExtractConfigPath = join(writableRootDir, "config", "extract_rules.json");
const legacyRuntimeConfigPath = join(writableRootDir, "runtime", "app_config.json");
const runtimeLogPath = join(writableRootDir, "runtime", "logs", "app.log");
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
let processor: ChildProcessWithoutNullStreams | null = null;
let processorActivity: "scan" | "start" | "merge" | "price-analyze" | "price-run" | null = null;

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
  return result;
}

function samePath(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function isSupportedExcelPath(path: string): boolean {
  return supportedExcelExtensions.has(extname(path).toLowerCase());
}

const skippedInputDirectoryNames = new Set([".git", "node_modules", "dist-electron", "target", "核价结果"]);

async function collectExcelFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    if (files.length > MAX_INPUT_FILES) return;

    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      if (files.length > MAX_INPUT_FILES) return;
      if (entry.name.startsWith("~$")) continue;
      const candidate = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (skippedInputDirectoryNames.has(entry.name)) continue;
        await visit(candidate);
      } else if (entry.isFile() && isSupportedExcelPath(candidate)) {
        files.push(resolve(candidate));
      }
    }
  }

  await visit(resolve(directory));
  if (files.length > MAX_INPUT_FILES) {
    throw new RangeError(`输入文件夹包含 ${files.length} 个 Excel 文件，最多支持 ${MAX_INPUT_FILES} 个`);
  }
  return files;
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
    await copyFile(bundledExtractConfigPath, defaultExtractConfigPath);
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
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Excel 订单批量核价工具",
    backgroundColor: "#0F1115",
    frame: false,
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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

  return join(rootDir, "processor-rust", "target", "release", executableName);
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
      broadcastProcessorEvent(JSON.parse(line));
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  installContentSecurityPolicy();

  ipcMain.handle("app:get-runtime-config", (event) => {
    requireTrustedIpc(event);
    return readRuntimeConfig();
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
  ipcMain.handle("app:set-runtime-config", (event, payload: unknown) => {
    requireTrustedIpc(event);
    return writeRuntimeConfig(validateRuntimeConfigUpdate(payload));
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
    sendProcessorCommand({ ...(await validatePricePayload(payload)), action: "price-check-analyze" });
  });
  ipcMain.handle("processor:price-check-run", async (event, payload: unknown) => {
    requireTrustedIpc(event);
    processorActivity = "price-run";
    sendProcessorCommand({ ...(await validatePricePayload(payload)), action: "price-check-run" });
  });
  ipcMain.handle("processor:pause", (event) => {
    requireTrustedIpc(event);
    sendProcessorCommand({ action: "pause" });
  });
  ipcMain.handle("processor:resume", (event) => {
    requireTrustedIpc(event);
    sendProcessorCommand({ action: "resume" });
  });
  ipcMain.handle("processor:stop", (event) => {
    requireTrustedIpc(event);
    return stopProcessorProcess();
  });

  ipcMain.handle("dialog:select-directory", async (event, purpose: "input" | "output" = "input") => {
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
    await writeRuntimeConfig({ [configKey]: result.filePaths[0] });
    return result.filePaths[0];
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
    await writeRuntimeConfig({ recent_config_path: result.filePaths[0] });
    return result.filePaths[0];
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
