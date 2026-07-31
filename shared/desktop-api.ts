import type {
  AppPreferences,
  AppPreferencesUpdate,
  AppState,
  AppStateUpdate,
} from "./app-settings";
import type {
  TaskAnalyticsQuery,
  TaskAnalyticsSummary,
  TaskBatchFinishRequest,
  TaskBatchFinishResult,
  TaskBatchMetadataUpdate,
  TaskExecutionType,
  TaskHistoryDetail,
  TaskHistoryExportRequest,
  TaskHistoryPage,
  TaskHistoryQuery,
  TaskHistorySummary,
  TaskRunDiagnostics,
} from "./task-history";

export type {
  AppPreferences,
  AppPreferencesUpdate,
  AppState,
  AppStateUpdate,
} from "./app-settings";

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
} from "./task-history";

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
    directQuantity?: boolean;
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
  usedOriginalSkuQuantity?: boolean;
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
  executionType?: TaskExecutionType;
  remainingFiles?: number;
  mappings: Array<{
    inputPath: string;
    mapping: PriceCheckMapping;
    writebackRows?: PricePreviewWritebackRow[];
    cellEdits?: PricePreviewCellEdit[];
  }>;
};

export type DesktopAPI = {
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  getWindowPreferences: () => Promise<WindowPreferences>;
  setRememberWindowSize: (rememberSize: boolean) => Promise<WindowPreferences>;
  getAppPreferences: () => Promise<AppPreferences>;
  setAppPreferences: (preferences: AppPreferencesUpdate) => Promise<AppPreferences>;
  getAppState: () => Promise<AppState>;
  setAppState: (state: AppStateUpdate) => Promise<AppState>;
  getDefaultPriceOutputDir: () => Promise<string>;
  getProcessingCapacity: () => Promise<ProcessingCapacity>;
  getConfigDocument: (path?: string) => Promise<ConfigDocument>;
  validateConfigDocument: (content: string) => Promise<ConfigValidationResult>;
  saveConfigDocument: (payload: { path: string; content: string; expectedModifiedAt: number }) => Promise<ConfigDocument>;
  saveConfigDocumentAs: (content: string) => Promise<ConfigDocument | null>;
  restoreDefaultConfig: () => Promise<ConfigDocument>;
  getTaskHistorySummary: () => Promise<TaskHistorySummary>;
  listTaskHistory: (query: TaskHistoryQuery) => Promise<TaskHistoryPage>;
  getTaskHistoryDetail: (batchId: string) => Promise<TaskHistoryDetail | null>;
  getTaskAnalytics: (query: TaskAnalyticsQuery) => Promise<TaskAnalyticsSummary>;
  exportTaskHistory: (request: TaskHistoryExportRequest) => Promise<string | null>;
  listHeaderTemplates: () => Promise<HeaderTemplateRecord[]>;
  createHeaderTemplate: () => Promise<HeaderTemplateRecord | null>;
  updateHeaderTemplateMappings: (payload: {
    id: string;
    mappings: HeaderTemplateFieldMapping[];
  }) => Promise<HeaderTemplateRecord>;
  deleteHeaderTemplate: (id: string) => Promise<void>;
  appendRuntimeLogs: (rows: RuntimeLogRow[]) => Promise<void>;
  exportRuntimeLog: () => Promise<string | null>;
  openPath: (filePath: string) => Promise<string>;
  selectDirectory: (purpose?: "input" | "output", persist?: boolean) => Promise<string | null>;
  selectExcelFiles: () => Promise<string[] | null>;
  selectConfig: () => Promise<string | null>;
  listExcelFiles: (directory: string) => Promise<DirectoryScanResult>;
  readExcelPreviewFile: (filePath: string) => Promise<ExcelPreviewFileData>;
  getPathForFile: (file: File) => string;
  analyzePriceFiles: (payload: { files: string[]; configPath?: string }) => Promise<void>;
  validatePriceMapping: (payload: {
    inputPath: string;
    mapping: PriceCheckMapping;
    requestVersion: number;
    writebackRows?: PricePreviewWritebackRow[];
    cellEdits?: PricePreviewCellEdit[];
    configPath?: string;
  }) => Promise<void>;
  recalculatePriceRow: (payload: {
    inputPath: string;
    mapping: PriceCheckMapping;
    requestVersion: number;
    rowEdit: {
      sourceRow: number;
      quantity: number | null;
      useOriginalSkuQuantity?: boolean;
    };
    cellEdits?: PricePreviewCellEdit[];
    configPath?: string;
  }) => Promise<void>;
  runPriceCheck: (payload: PriceCheckRunPayload) => Promise<{ batchId: string }>;
  updateTaskBatchMetadata: (payload: TaskBatchMetadataUpdate) => Promise<TaskHistoryDetail>;
  finishTaskBatch: (request: TaskBatchFinishRequest) => Promise<TaskBatchFinishResult>;
  pauseProcessing: () => Promise<void>;
  resumeProcessing: () => Promise<void>;
  stopProcessing: () => Promise<void>;
  onProcessorEvent: (callback: (event: ProcessorEvent) => void) => () => void;
};
