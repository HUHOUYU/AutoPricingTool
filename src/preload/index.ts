import { contextBridge, ipcRenderer, webUtils } from "electron";

export type RuntimeConfig = {
  recent_input_dir?: string;
  recent_output_dir?: string;
  recent_config_path?: string;
};

export type PriceCheckMapping = {
  orderSheet: string;
  orderHeaderRow: number;
  businessOrderNumberColumn?: number | null;
  platformOrderNumberColumn?: number | null;
  countryCodeColumn?: number | null;
  countryEnglishColumn?: number | null;
  countryChineseColumn?: number | null;
  skuQtyPairs: Array<{
    skuColumn: number;
    qtyColumn: number;
    skuHeader: string;
    qtyHeader: string;
  }>;
  shippingMethodColumn?: number | null;
  orderPriceColumn?: number | null;
  pricingSheet: string;
  pricingHeaderRow: number;
  pricingQuantityHeaderRow?: number | null;
  pricingSkuColumn: number;
  pricingCountryColumn: number;
  pricingShippingMethodColumn?: number | null;
  quantityTierColumns: Array<{
    quantity: number;
    column: number;
    header: string;
  }>;
};

export type PriceAnalysisCandidate = {
  sheetName: string;
  headerRow: number;
  score: number;
  businessOrderNumberColumn?: number | null;
  platformOrderNumberColumn?: number | null;
  countryCodeColumn?: number | null;
  countryEnglishColumn?: number | null;
  countryChineseColumn?: number | null;
  skuQtyPairs?: PriceCheckMapping["skuQtyPairs"];
  shippingMethodColumn?: number | null;
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
  requiresConfirmation: boolean;
  issues: string[];
};

export type ProcessorEvent =
  | { type: "ready" }
  | { type: "price-analysis"; file: PriceAnalysisFile }
  | { type: "price-mapping-required"; file: PriceAnalysisFile }
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
  mappings: Array<{ inputPath: string; mapping: PriceCheckMapping }>;
};

const desktopAPI = {
  getRuntimeConfig: (): Promise<RuntimeConfig> => ipcRenderer.invoke("app:get-runtime-config"),
  setRuntimeConfig: (config: RuntimeConfig): Promise<RuntimeConfig> => ipcRenderer.invoke("app:set-runtime-config", config),
  appendRuntimeLogs: (rows: RuntimeLogRow[]): Promise<void> => ipcRenderer.invoke("app:append-runtime-logs", rows),
  exportRuntimeLog: (): Promise<string | null> => ipcRenderer.invoke("app:export-runtime-log"),
  openPath: (filePath: string): Promise<string> => ipcRenderer.invoke("app:open-path", filePath),
  selectDirectory: (purpose?: "input" | "output"): Promise<string | null> => ipcRenderer.invoke("dialog:select-directory", purpose),
  selectConfig: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-config"),
  listExcelFiles: (directory: string): Promise<string[]> => ipcRenderer.invoke("app:list-excel-files", directory),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  analyzePriceFiles: (payload: { files: string[]; configPath?: string }): Promise<void> =>
    ipcRenderer.invoke("processor:price-check-analyze", payload),
  runPriceCheck: (payload: PriceCheckRunPayload): Promise<void> =>
    ipcRenderer.invoke("processor:price-check-run", payload),
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
