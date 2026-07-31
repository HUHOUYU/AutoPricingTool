import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppPreferences,
  AppPreferencesUpdate,
  AppState,
  AppStateUpdate,
  ConfigDocument,
  ConfigValidationResult,
  DesktopAPI,
  DirectoryScanResult,
  ExcelPreviewFileData,
  HeaderTemplateFieldMapping,
  HeaderTemplateRecord,
  PriceCheckMapping,
  PriceCheckRunPayload,
  PricePreviewCellEdit,
  ProcessingCapacity,
  ProcessorEvent,
  RuntimeLogRow,
  TaskAnalyticsQuery,
  TaskAnalyticsSummary,
  TaskBatchFinishRequest,
  TaskBatchFinishResult,
  TaskBatchMetadataUpdate,
  TaskHistoryDetail,
  TaskHistoryExportRequest,
  TaskHistoryPage,
  TaskHistoryQuery,
  TaskHistorySummary,
  WindowPreferences,
} from "../../../shared/desktop-api";

const desktopAPI: DesktopAPI = {
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  getWindowPreferences: (): Promise<WindowPreferences> => ipcRenderer.invoke("window:get-preferences"),
  setRememberWindowSize: (rememberSize: boolean): Promise<WindowPreferences> => ipcRenderer.invoke("window:set-remember-size", rememberSize),
  getAppPreferences: (): Promise<AppPreferences> => ipcRenderer.invoke("app:get-preferences"),
  setAppPreferences: (preferences: AppPreferencesUpdate): Promise<AppPreferences> =>
    ipcRenderer.invoke("app:set-preferences", preferences),
  getAppState: (): Promise<AppState> => ipcRenderer.invoke("app:get-state"),
  setAppState: (state: AppStateUpdate): Promise<AppState> => ipcRenderer.invoke("app:set-state", state),
  getDefaultPriceOutputDir: (): Promise<string> => ipcRenderer.invoke("app:get-default-price-output-dir"),
  getProcessingCapacity: (): Promise<ProcessingCapacity> => ipcRenderer.invoke("app:get-processing-capacity"),
  getConfigDocument: (path?: string): Promise<ConfigDocument> => ipcRenderer.invoke("config:get-document", path),
  validateConfigDocument: (content: string): Promise<ConfigValidationResult> => ipcRenderer.invoke("config:validate-document", content),
  saveConfigDocument: (payload: { path: string; content: string; expectedModifiedAt: number }): Promise<ConfigDocument> => ipcRenderer.invoke("config:save-document", payload),
  saveConfigDocumentAs: (content: string): Promise<ConfigDocument | null> => ipcRenderer.invoke("config:save-document-as", content),
  restoreDefaultConfig: (): Promise<ConfigDocument> => ipcRenderer.invoke("config:restore-default"),
  getTaskHistorySummary: (): Promise<TaskHistorySummary> => ipcRenderer.invoke("history:get-summary"),
  listTaskHistory: (query: TaskHistoryQuery): Promise<TaskHistoryPage> => ipcRenderer.invoke("history:list", query),
  getTaskHistoryDetail: (batchId: string): Promise<TaskHistoryDetail | null> => ipcRenderer.invoke("history:get-detail", batchId),
  getTaskAnalytics: (query: TaskAnalyticsQuery): Promise<TaskAnalyticsSummary> => ipcRenderer.invoke("history:get-analytics", query),
  exportTaskHistory: (request: TaskHistoryExportRequest): Promise<string | null> => ipcRenderer.invoke("history:export", request),
  listHeaderTemplates: (): Promise<HeaderTemplateRecord[]> => ipcRenderer.invoke("templates:list"),
  createHeaderTemplate: (): Promise<HeaderTemplateRecord | null> => ipcRenderer.invoke("templates:create"),
  updateHeaderTemplateMappings: (payload: { id: string; mappings: HeaderTemplateFieldMapping[] }): Promise<HeaderTemplateRecord> =>
    ipcRenderer.invoke("templates:update-mappings", payload),
  deleteHeaderTemplate: (id: string): Promise<void> => ipcRenderer.invoke("templates:delete", id),
  appendRuntimeLogs: (rows: RuntimeLogRow[]): Promise<void> => ipcRenderer.invoke("app:append-runtime-logs", rows),
  exportRuntimeLog: (): Promise<string | null> => ipcRenderer.invoke("app:export-runtime-log"),
  openPath: (filePath: string): Promise<string> => ipcRenderer.invoke("app:open-path", filePath),
  selectDirectory: (purpose?: "input" | "output", persist = true): Promise<string | null> => ipcRenderer.invoke("dialog:select-directory", purpose, persist),
  selectExcelFiles: (): Promise<string[] | null> => ipcRenderer.invoke("dialog:select-excel-files"),
  selectConfig: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-config"),
  listExcelFiles: (directory: string): Promise<DirectoryScanResult> => ipcRenderer.invoke("app:list-excel-files", directory),
  readExcelPreviewFile: (filePath: string): Promise<ExcelPreviewFileData> => ipcRenderer.invoke("app:read-excel-preview-file", filePath),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  analyzePriceFiles: (payload: { files: string[]; configPath?: string }): Promise<void> =>
    ipcRenderer.invoke("processor:price-check-analyze", payload),
  validatePriceMapping: (payload: { inputPath: string; mapping: PriceCheckMapping; requestVersion: number; cellEdits?: PricePreviewCellEdit[]; configPath?: string }): Promise<void> =>
    ipcRenderer.invoke("processor:price-check-validate", payload),
  recalculatePriceRow: (payload: { inputPath: string; mapping: PriceCheckMapping; requestVersion: number; rowEdit: { sourceRow: number; quantity: number | null }; cellEdits?: PricePreviewCellEdit[]; configPath?: string }): Promise<void> =>
    ipcRenderer.invoke("processor:price-check-validate", payload),
  runPriceCheck: (payload: PriceCheckRunPayload): Promise<{ batchId: string }> =>
    ipcRenderer.invoke("processor:price-check-run", payload),
  updateTaskBatchMetadata: (payload: TaskBatchMetadataUpdate): Promise<TaskHistoryDetail> =>
    ipcRenderer.invoke("history:update-metadata", payload),
  finishTaskBatch: (request: TaskBatchFinishRequest): Promise<TaskBatchFinishResult> =>
    ipcRenderer.invoke("history:finish-batch", request),
  pauseProcessing: (): Promise<void> => ipcRenderer.invoke("processor:pause"),
  resumeProcessing: (): Promise<void> => ipcRenderer.invoke("processor:resume"),
  stopProcessing: (): Promise<void> => ipcRenderer.invoke("processor:stop"),
  onProcessorEvent: (callback: (event: ProcessorEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProcessorEvent): void => callback(payload);
    ipcRenderer.on("processor:event", listener);
    return () => ipcRenderer.removeListener("processor:event", listener);
  },
};

contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
