import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  TaskAnalyticsQuery,
  TaskAnalyticsSummary,
  TaskBatchFinishRequest,
  TaskBatchFinishResult,
  TaskBatchMetadataUpdate,
  TaskHistoryDetail,
  TaskHistoryExportRequest,
  TaskHistoryPage,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistorySummary,
  TaskRunDiagnostics,
} from "../shared/task-history";

export type {
  TaskAnalyticsQuery,
  TaskAnalyticsSummary,
  TaskBatchFinishRequest,
  TaskBatchFinishResult,
  TaskBatchMetadataUpdate,
  TaskExecutionType,
  TaskEventLevel,
  TaskFileResult,
  TaskHistoryDetail,
  TaskHistoryEvent,
  TaskHistoryExportRequest,
  TaskHistoryPage,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistoryStatus,
  TaskHistorySummary,
  TaskIssueCode,
  TaskIssueSample,
  TaskIssueSummary,
  TaskRunDiagnostics,
} from "../shared/task-history";

export type RuntimeConfig = {
  recent_input_dir?: string;
  recent_output_dir?: string;
  recent_config_path?: string;
  archive_standard_files?: boolean;
  auto_reveal_manual_result?: boolean;
  continuous_issue_review_enabled?: boolean;
};

export type WindowPreferences = {
  rememberSize: boolean;
  width?: number;
  height?: number;
};

export type DirectoryScanResult = {
  files: string[];
  skippedTemporary: number;
  skippedUnsupported: number;
  skippedOutput: number;
};

export type ExcelPreviewFileData = {
  bytes: Uint8Array;
  size: number;
  modifiedAt: number;
};

export type ConfigValidationIssue = { path: string; message: string };
export type ConfigValidationResult = { valid: boolean; issues: ConfigValidationIssue[] };
export type ConfigDocument = { path: string; content: string; modifiedAt: number; isDefault: boolean };
export type ProcessingCapacity = { detectedThreads: number; maxWorkers: number };
export type HeaderTemplateFieldMapping = {
  fieldKey: string;
  label: string;
  sheetName: string;
  headerRow: number;
  column: number;
  header: string;
};

export type HeaderTemplateRecord = {
  id: string;
  createdAt: string;
  createdBy: string;
  fileName: string;
  filePath: string;
  mappings: HeaderTemplateFieldMapping[];
};

export type PriceCheckMapping = {
  orderSheet: string;
  orderHeaderRow: number;
  businessOrderNumberColumn?: number | null;
  countryCodeColumn?: number | null;
  countryEnglishColumn?: number | null;
  countryChineseColumn?: number | null;
  skuQtyPairs: Array<{
    skuColumn: number;
    qtyColumn: number;
    mergedQtyColumn: number;
    skuHeader: string;
    qtyHeader: string;
    mergedQtyHeader: string;
  }>;
  singleShipmentColumn?: number | null;
  singleShipmentFields?: SingleShipmentMatchingStatus["fields"];
  orderPriceColumn?: number | null;
  pricingSheet: string;
  pricingHeaderRow: number;
  pricingQuantityHeaderRow?: number | null;
  pricingSkuColumn: number;
  pricingCountryColumn: number;
  quantityTierColumns: Array<{
    quantity: number;
    column: number;
    header: string;
  }>;
};

export type SingleShipmentMatchField =
  | "recipient_name"
  | "phone"
  | "postal_code"
  | "address"
  | "email";

export type SingleShipmentMatchingStatus = {
  enabled: boolean;
  ready: boolean;
  fields: Array<{
    field: SingleShipmentMatchField;
    columns: number[];
    headers: string[];
  }>;
  reason: string;
};

export type PriceAnalysisCandidate = {
  sheetName: string;
  headerRow: number;
  score: number;
  businessOrderNumberColumn?: number | null;
  countryCodeColumn?: number | null;
  countryEnglishColumn?: number | null;
  countryChineseColumn?: number | null;
  skuQtyPairs?: PriceCheckMapping["skuQtyPairs"];
  singleShipmentColumn?: number | null;
  singleShipmentFields?: SingleShipmentMatchingStatus["fields"];
  priceColumn?: number | null;
  validOrderRows?: number;
  validPriceRows?: number;
  countryCoverage?: number;
  usablePriceCells?: number;
  quantityHeaderRow?: number | null;
  skuColumn?: number | null;
  countryColumn?: number | null;
  tierColumns?: PriceCheckMapping["quantityTierColumns"];
  notes: string[];
};

export type PriceAnalysisFile = {
  inputPath: string;
  fileName: string;
  orderSheetCandidates: PriceAnalysisCandidate[];
  pricingSheetCandidates: PriceAnalysisCandidate[];
  suggestedMapping?: PriceCheckMapping | null;
  coverage: number;
  matchedOrderRows?: number[];
  writebackRows?: PricePreviewWritebackRow[];
  unmatchedRows?: PriceUnmatchedIssue[];
  singleShipmentMatching?: SingleShipmentMatchingStatus;
  requiresConfirmation: boolean;
  automationDecision: {
    status: "eligible" | "confirm" | "error";
    reasons: string[];
    evaluatedRows: number;
    matchedRows: number;
    coverage: number;
    runnerUpCoverage?: number | null;
    candidateScore?: number | null;
    runnerUpScore?: number | null;
    scoreKind?: "field" | "sheet" | null;
    scoreGap?: number | null;
  };
  issues: string[];
};

export type PriceMappingValidation = {
  inputPath: string;
  requestVersion: number;
  evaluatedRows: number;
  matchedRows: number;
  coverage: number;
  matchedOrderRows?: number[];
  writebackRows?: PricePreviewWritebackRow[];
  unmatchedRows?: PriceUnmatchedIssue[];
  singleShipmentMatching?: SingleShipmentMatchingStatus | null;
  errors: string[];
  warnings: string[];
};

export type PriceUnmatchedIssue = {
  sourceRow: number;
  skuColumn: number;
  sku: string;
  country: string;
  quantity: number;
  reason: string;
};

export type PricePreviewWritebackRow = {
  sourceRow: number;
  pricingPrice?: number | null;
  priceDifference?: number | null;
  quantity: number | null;
  quantityError?: string | null;
  quantityIssueContext?: {
    previousSkuColumn: number;
    previousSku: string;
    mainSkuColumn: number;
    mainSku: string;
  } | null;
};

export type PricePreviewCellEdit = {
  sheetName: string;
  row: number;
  column: number;
  value: string;
  numeric: boolean;
};

export type ProcessorEvent =
  | { type: "ready" }
  | { type: "price-analysis"; file: PriceAnalysisFile }
  | { type: "price-mapping-required"; file: PriceAnalysisFile }
  | ({ type: "price-validation" } & PriceMappingValidation)
  | {
      type: "price-row-validation";
      inputPath: string;
      requestVersion: number;
      sourceRow: number;
      row: PricePreviewWritebackRow | null;
      error?: string | null;
    }
  | { type: "price-progress"; phase: "analyze" | "run" | "rows"; current: number; total: number; path: string }
  | {
      type: "price-file-result";
      path: string;
      status: "completed" | "failed";
      outputPath?: string;
      totalRows?: number;
      matchedRows?: number;
      exceptionRows?: number;
      coverage?: number;
      message?: string;
    }
  | {
      type: "price-done";
      mode: "analysis" | "run";
      stopped: boolean;
      files: Array<Record<string, unknown>>;
      failures?: Array<Record<string, unknown>>;
    }
  | { type: "state"; state: string; code?: number | null }
  | { type: "log"; level?: "info" | "success" | "warning" | "error"; message: string; detail?: boolean }
  | { type: "error"; message: string; userMessage?: string; suggestion?: string; details?: string };

export type RuntimeLogRow = {
  time: string;
  level: string;
  message: string;
};

export type PriceCheckRunPayload = {
  files: string[];
  outputDir: string;
  configPath?: string;
  diagnostics?: TaskRunDiagnostics[];
  batchId?: string;
  batchName?: string;
  batchNote?: string;
  batchFiles?: string[];
  executionType?: import("../shared/task-history").TaskExecutionType;
  remainingFiles?: number;
  mappings: Array<{
    inputPath: string;
    mapping: PriceCheckMapping;
    writebackRows?: PricePreviewWritebackRow[];
    cellEdits?: PricePreviewCellEdit[];
  }>;
};

const desktopAPI = {
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  getWindowPreferences: (): Promise<WindowPreferences> => ipcRenderer.invoke("window:get-preferences"),
  setRememberWindowSize: (rememberSize: boolean): Promise<WindowPreferences> => ipcRenderer.invoke("window:set-remember-size", rememberSize),
  getRuntimeConfig: (): Promise<RuntimeConfig> => ipcRenderer.invoke("app:get-runtime-config"),
  getDefaultPriceOutputDir: (): Promise<string> => ipcRenderer.invoke("app:get-default-price-output-dir"),
  getProcessingCapacity: (): Promise<ProcessingCapacity> => ipcRenderer.invoke("app:get-processing-capacity"),
  setRuntimeConfig: (config: RuntimeConfig): Promise<RuntimeConfig> => ipcRenderer.invoke("app:set-runtime-config", config),
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

export type DesktopAPI = typeof desktopAPI;
