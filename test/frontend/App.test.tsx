import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import type { DesktopAPI, PriceAnalysisFile, ProcessorEvent } from "@shared/desktop-api";
import type { ExcelPreviewWorkerRequest, ExcelPreviewWorkerResponse } from "@/lib/excel-preview";
import { App } from "@/App";
import { useUIStore } from "@/stores/ui-store";

function createAnalysis(path: string): PriceAnalysisFile {
  const mapping = {
    orderSheet: "订单",
    orderHeaderRow: 1,
    businessOrderNumberColumn: 1,
    countryCodeColumn: 4,
    countryEnglishColumn: 5,
    countryChineseColumn: 6,
    skuQtyPairs: [{
      skuColumn: 8,
      qtyColumn: 7,
      mergedQtyColumn: 9,
      skuHeader: "SKU",
      qtyHeader: "Qty",
      mergedQtyHeader: "Merged Qty",
    }],
    singleShipmentColumn: 11,
    singleShipmentFields: [
      { field: "recipient_name" as const, columns: [11], headers: ["Name"] },
      { field: "phone" as const, columns: [12], headers: ["Phone"] },
      { field: "postal_code" as const, columns: [13], headers: ["Code"] },
    ],
    orderPriceColumn: 10,
    pricingSheet: "核价",
    pricingHeaderRow: 1,
    pricingQuantityHeaderRow: null,
    pricingSkuColumn: 1,
    pricingCountryColumn: 2,
    quantityTierColumns: [{ quantity: 1, column: 3, header: "1" }],
  };
  return {
    inputPath: path,
    fileName: "order.xlsx",
    orderSheetCandidates: [{
      sheetName: "订单",
      headerRow: 1,
      score: 90,
      businessOrderNumberColumn: 1,
      countryCodeColumn: 4,
      countryEnglishColumn: 5,
      countryChineseColumn: 6,
      skuQtyPairs: mapping.skuQtyPairs,
      singleShipmentColumn: 11,
      singleShipmentFields: mapping.singleShipmentFields,
      priceColumn: 10,
      validOrderRows: 2,
      countryCoverage: 1,
      notes: [],
    }],
    pricingSheetCandidates: [{
      sheetName: "核价",
      headerRow: 1,
      score: 90,
      skuColumn: 1,
      countryColumn: 2,
      tierColumns: mapping.quantityTierColumns,
      validPriceRows: 2,
      usablePriceCells: 2,
      notes: [],
    }],
    suggestedMapping: mapping,
    coverage: 1,
    matchedOrderRows: [2],
    writebackRows: [{ sourceRow: 2, pricingPrice: 9.5, priceDifference: 0, quantity: 1 }],
    singleShipmentMatching: {
      enabled: true,
      ready: true,
      fields: [
        { field: "recipient_name", columns: [11], headers: ["Name"] },
        { field: "phone", columns: [12], headers: ["Phone"] },
        { field: "postal_code", columns: [13], headers: ["Code"] },
      ],
      reason: "联合字段完整；仅证据充分的单主 SKU 订单使用单独发货价格",
    },
    requiresConfirmation: false,
    automationDecision: {
      status: "eligible",
      reasons: [],
      evaluatedRows: 20,
      matchedRows: 20,
      coverage: 1,
      runnerUpCoverage: null,
      scoreGap: null,
    },
    issues: [],
  };
}

function createDesktopAPI(): DesktopAPI & { emit: (event: ProcessorEvent) => void } {
  let listener: ((event: ProcessorEvent) => void) | null = null;
  const api: DesktopAPI & { emit: (event: ProcessorEvent) => void } = {
    minimizeWindow: vi.fn(async () => undefined),
    toggleMaximizeWindow: vi.fn(async () => undefined),
    closeWindow: vi.fn(async () => undefined),
    getWindowPreferences: vi.fn(async () => ({ rememberSize: false })),
    setRememberWindowSize: vi.fn(async (rememberSize) => ({ rememberSize, width: 1650, height: 1120 })),
    getAppPreferences: vi.fn(async () => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: false,
      continuousIssueReviewEnabled: false,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
    })),
    setAppPreferences: vi.fn(async (preferences) => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: false,
      continuousIssueReviewEnabled: false,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
      ...preferences,
    })),
    getAppState: vi.fn(async () => ({
      schemaVersion: 1 as const,
      activeBusinessConfigPath: "C:\\config.json",
      recentInputDirectory: "",
      recentOutputDirectory: "C:\\output",
    })),
    setAppState: vi.fn(async (state) => ({
      schemaVersion: 1 as const,
      activeBusinessConfigPath: "C:\\config.json",
      recentInputDirectory: "",
      recentOutputDirectory: "C:\\output",
      ...state,
    })),
    getDefaultPriceOutputDir: vi.fn(async () => "C:\\Program\\核价结果"),
    getProcessingCapacity: vi.fn(async () => ({ detectedThreads: 8, maxWorkers: 7 })),
    getConfigDocument: vi.fn(async () => ({ path: "C:\\config.json", content: "{}\n", modifiedAt: 1, isDefault: false })),
    validateConfigDocument: vi.fn(async () => ({ valid: true, issues: [] })),
    saveConfigDocument: vi.fn(async ({ path, content }) => ({ path, content, modifiedAt: 2, isDefault: false })),
    saveConfigDocumentAs: vi.fn(async (content) => ({ path: "C:\\saved.json", content, modifiedAt: 2, isDefault: false })),
    restoreDefaultConfig: vi.fn(async () => ({ path: "C:\\config.json", content: "{}\n", modifiedAt: 3, isDefault: false })),
    getTaskHistorySummary: vi.fn(async () => ({ today: { files: 0, tasks: 0, matchRate: 0, exceptions: 0 }, trend: [], recent: [] })),
    listTaskHistory: vi.fn(async (query) => ({ items: [], total: 0, page: query.page ?? 1, pageSize: query.pageSize ?? 30 })),
    getTaskHistoryDetail: vi.fn(async () => null),
    getTaskAnalytics: vi.fn(async () => ({
      totals: { batches: 0, files: 0, rows: 0, matchedRows: 0, matchRate: null, exceptions: 0, averageDurationMs: null },
      trend: [],
      statuses: [],
      issues: [],
      records: [],
    })),
    exportTaskHistory: vi.fn(async () => null),
    listHeaderTemplates: vi.fn(async () => []),
    createHeaderTemplate: vi.fn(async () => null),
    updateHeaderTemplateMappings: vi.fn(async ({ id, mappings }) => ({ id, createdAt: "2026-07-21T08:00:00.000Z", createdBy: "tester", fileName: "template.xlsx", filePath: "C:\\templates\\template.xlsx", mappings })),
    deleteHeaderTemplate: vi.fn(async () => undefined),
    appendRuntimeLogs: vi.fn(async () => undefined),
    exportRuntimeLog: vi.fn(async () => null),
    openPath: vi.fn(async () => ""),
    selectDirectory: vi.fn(async (purpose) => purpose === "input" ? "C:\\input-selected" : "C:\\output-selected"),
    selectExcelFiles: vi.fn(async () => null),
    selectConfig: vi.fn(async () => "C:\\config-selected.json"),
    listExcelFiles: vi.fn(async () => ({ files: [], skippedTemporary: 0, skippedUnsupported: 0, skippedOutput: 0 })),
    readExcelPreviewFile: vi.fn(async () => ({ bytes: new Uint8Array(), size: 0, modifiedAt: 0 })),
    getPathForFile: vi.fn((file: File) => "C:\\orders\\" + file.name),
    analyzePriceFiles: vi.fn(async () => undefined),
    validatePriceMapping: vi.fn(async () => undefined),
    recalculatePriceRow: vi.fn(async () => undefined),
    runPriceCheck: vi.fn(async () => ({ batchId: "test-batch" })),
    updateTaskBatchMetadata: vi.fn(async () => {
      throw new Error("测试未配置批次元数据");
    }),
    finishTaskBatch: vi.fn(async () => {
      throw new Error("测试未配置批次结束");
    }),
    pauseProcessing: vi.fn(async () => undefined),
    resumeProcessing: vi.fn(async () => undefined),
    stopProcessing: vi.fn(async () => undefined),
    onProcessorEvent: vi.fn((callback: (event: ProcessorEvent) => void) => {
      listener = callback;
      return () => { listener = null; };
    }),
    emit: (event) => listener?.(event),
  };
  return api;
}

function installAPI(api: DesktopAPI): void {
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: api });
}

function dropFiles(files: File[]): void {
  const target = document.querySelector(".cyber-upload-banner") ?? document.querySelector(".cyber-dropzone");
  fireEvent.drop(target!, { dataTransfer: { files, types: ["Files"] } });
}

function openFileProcessing(): void {
  fireEvent.click(screen.getByRole("button", { name: "文件处理" }));
}

class FakeExcelPreviewWorker {
  static instances: FakeExcelPreviewWorker[] = [];
  static orderRows: string[][] | null = null;
  static pricingRows: string[][] | null = null;

  onmessage: ((event: MessageEvent<ExcelPreviewWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  request: ExcelPreviewWorkerRequest | null = null;
  terminate = vi.fn();

  constructor() {
    FakeExcelPreviewWorker.instances.push(this);
  }

  postMessage(request: ExcelPreviewWorkerRequest): void {
    this.request = request;
    const response: ExcelPreviewWorkerResponse = {
      requestId: request.requestId,
      ok: true,
      workbook: {
        sheets: request.candidates.map((candidate) => {
          const rows = candidate.roles.includes("order")
            ? FakeExcelPreviewWorker.orderRows ?? [["订单号", "平台订单号", "备用SKU", "国家", "英文国家", "中文国家", "物流", "SKU", "数量", "价格"], [candidate.name + "-数据", "P-1", "OLD-1", "US", "United States", "美国", "", "GOOD-1", "1", "9.5"]]
            : candidate.name === "核价" && FakeExcelPreviewWorker.pricingRows
              ? FakeExcelPreviewWorker.pricingRows
              : [["SKU", "Country", "1", "2", "3"], [candidate.name === "核价" ? "GOOD-1" : candidate.name + "-数据", "United States", "9.5", "9", "8.5"]];
          const columnCount = Math.max(0, ...rows.map((row) => row.length));
          return {
            name: candidate.name,
            roles: candidate.roles,
            rows,
            startRow: 0,
            startColumn: 0,
            rowCount: rows.length,
            columnCount,
            displayedRowCount: rows.length,
            displayedColumnCount: columnCount,
            truncatedRows: false,
            truncatedColumns: false,
          };
        }),
      },
    };
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ExcelPreviewWorkerResponse>));
  }
}

describe("AutoPricingTool cyber workstation", () => {
  beforeEach(() => {
    useUIStore.setState({ activePage: "workbench", activeTab: "pending", theme: "light", sidebarCollapsed: false });
    FakeExcelPreviewWorker.instances = [];
    FakeExcelPreviewWorker.orderRows = null;
    FakeExcelPreviewWorker.pricingRows = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { scrollIntoView?: HTMLElement["scrollIntoView"] }).scrollIntoView;
  });

  it("places toast notifications in the top-left corner", async () => {
    installAPI(createDesktopAPI());
    render(<App />);
    act(() => toast.success("位置测试"));

    await waitFor(() => {
      const toaster = document.querySelector("[data-sonner-toaster]");
      expect(toaster).toHaveAttribute("data-x-position", "left");
      expect(toaster).toHaveAttribute("data-y-position", "top");
    });
    toast.dismiss();
  });

  it("imports a dropped workbook and starts analysis", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();

    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(api.analyzePriceFiles).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"] })));
    fireEvent.click(screen.getByRole("button", { name: "order.xlsx" }));
    await waitFor(() => expect(api.openPath).toHaveBeenCalledWith("C:\\orders"));
  });

  it("resizes data columns only when rows are available", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    expect(screen.queryByRole("separator", { name: "调整 原始文件名 列宽" })).not.toBeInTheDocument();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();

    const resizer = screen.getByRole("separator", { name: "调整 原始文件名 列宽" });
    const header = resizer.closest("th")!;
    const initialWidth = Number.parseFloat(header.style.width);
    expect(initialWidth).toBe(240);
    expect(screen.getByRole("separator", { name: "调整 导入方式 列宽" })).toHaveAttribute("aria-valuenow", "220");
    expect(screen.getByRole("separator", { name: "调整 处理阶段 列宽" })).toHaveAttribute("aria-valuenow", "240");
    expect(screen.getByRole("separator", { name: "调整 导入时间 列宽" })).toHaveAttribute("aria-valuenow", "300");
    fireEvent.mouseDown(resizer, { clientX: 320 });
    fireEvent.mouseMove(document, { clientX: 390 });
    fireEvent.mouseUp(document);
    expect(Number.parseFloat(header.style.width)).toBeGreaterThan(initialWidth);
    const table = header.closest("table")!;
    expect(table.querySelectorAll("col")[2]).toHaveStyle({ width: header.style.width });

    expect(screen.queryByRole("separator", { name: "调整 操作 列宽" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "调整 序号 列宽" })).not.toBeInTheDocument();
    expect(table.style.getPropertyValue("--cyber-table-width")).toMatch(/px$/);
  });

  it("pins file table columns by pin order and restores their original order", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    const { container } = render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "pinned.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("pinned.xlsx")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "冻结 导入方式 列" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结 原始文件名 列" }));
    const table = container.querySelector(".cyber-file-table")!;
    let headers = Array.from(table.querySelectorAll("thead th"));
    expect(headers[0]).toHaveTextContent("导入方式");
    expect(headers[1]).toHaveTextContent("原始文件名");
    expect(headers[0]).toHaveStyle({ left: "0px", position: "sticky" });
    expect(headers[1]).toHaveStyle({ left: "220px", position: "sticky" });

    const importModeResizer = screen.getByRole("separator", { name: "调整 导入方式 列宽" });
    fireEvent.mouseDown(importModeResizer, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 340 });
    fireEvent.mouseUp(document);
    await waitFor(() => expect(headers[1]).toHaveStyle({ left: "260px" }));

    fireEvent.click(screen.getByRole("button", { name: "取消冻结 导入方式 列" }));
    headers = Array.from(table.querySelectorAll("thead th"));
    expect(headers[0]).toHaveTextContent("原始文件名");
    expect(headers[1]).toHaveClass("checkbox-column");
    fireEvent.click(screen.getByRole("button", { name: "取消冻结 原始文件名 列" }));
    headers = Array.from(table.querySelectorAll("thead th"));
    expect(headers[0]).toHaveClass("checkbox-column");
    expect(headers[1]).toHaveTextContent("序号");
    expect(headers[2]).toHaveTextContent("原始文件名");
    expect(headers[3]).toHaveTextContent("导入方式");
  });

  it("switches between validated single-file and folder import modes", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    const { container } = render(<App />);
    openFileProcessing();

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(fileInput).toHaveAttribute("multiple");
    expect(screen.queryByLabelText("自动处理流程")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("快捷操作")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("文件状态统计")).not.toBeInTheDocument();
    expect(screen.queryByText("原始 Excel 不会被覆盖")).not.toBeInTheDocument();
    const importSwitch = screen.getByRole("switch", { name: "导入模式：单文件" });
    expect(importSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(document.querySelector(".cyber-dropzone")!);
    expect(api.selectExcelFiles).not.toHaveBeenCalled();
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    await waitFor(() => expect(api.selectExcelFiles).toHaveBeenCalledTimes(1));

    dropFiles([
      new File(["xlsx"], "one.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      new File(["xlsx"], "two.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    ]);
    expect(await screen.findByText("已导入 2 个文件")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    });
    expect(screen.getByRole("switch", { name: "导入模式：文件夹" })).toHaveAttribute("aria-checked", "true");

    dropFiles([new File(["xlsx"], "loose.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("文件夹模式只接受 1 个完整文件夹")).toBeInTheDocument();
    const folderFiles = [
      new File(["xlsx"], "a.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      new File(["text"], "notes.txt", { type: "text/plain" }),
    ];
    Object.defineProperty(folderFiles[0], "path", { value: "/batch/a.xlsx" });
    Object.defineProperty(folderFiles[1], "path", { value: "/batch/notes.txt" });
    dropFiles(folderFiles);
    expect(await screen.findByText("a.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续添加" }));
    await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledWith("input"));
  });

  it("imports multiple workbooks selected through the native file dialog", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.selectExcelFiles).mockResolvedValue([
      "C:\\orders\\2ZAH order 02-JUN.xlsx",
      "C:\\orders\\3ZAH order 02-JUN.xlsx",
    ]);
    installAPI(api);
    render(<App />);
    openFileProcessing();

    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    expect(await screen.findByText("2ZAH order 02-JUN.xlsx")).toBeInTheDocument();
    expect(screen.getByText("3ZAH order 02-JUN.xlsx")).toBeInTheDocument();
    expect(screen.getByText("已导入 2 个文件")).toBeInTheDocument();
  });

  it("reports a missing disk path separately from an unsupported extension", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.getPathForFile).mockReturnValue("");
    installAPI(api);
    render(<App />);
    openFileProcessing();

    dropFiles([new File(["xlsx"], "2ZAH order 02-JUN.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("无法读取文件路径，请双击选择文件重试")).toBeInTheDocument();
  });

  it("keeps the native disk-backed File when a drop also exposes a file-system handle", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    const nativeFile = new File(["xlsx"], "2ZAH order 02-JUN.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    fireEvent.drop(document.querySelector(".cyber-dropzone")!, {
      dataTransfer: {
        files: [nativeFile],
        items: [{ kind: "file", getAsFileSystemHandle: vi.fn(async () => ({ getFile: async () => new File(["copy"], nativeFile.name) })) }],
        types: ["Files"],
      },
    });

    expect(await screen.findByText(nativeFile.name)).toBeInTheDocument();
    expect(api.getPathForFile).toHaveBeenCalledWith(nativeFile);
  });

  it("hides unavailable task actions in the empty state", () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();

    expect(screen.queryByRole("button", { name: "开始处理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重置本批" })).not.toBeInTheDocument();
  });

  it("collapses the upload area, appends files, and locks importing after processing starts", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    const { container } = render(<App />);
    openFileProcessing();

    expect(container.querySelector(".cyber-workspace")).toHaveClass("has-empty-batch");
    expect(container.querySelector(".cyber-upload-panel")).toHaveClass("is-expanded");
    dropFiles([new File(["xlsx"], "first.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("已导入 1 个文件")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".cyber-upload-panel.is-compact")).toBeInTheDocument());
    expect(container.querySelector(".cyber-workspace")).toHaveClass("has-ready-batch");
    expect(screen.getByRole("button", { name: "开始处理" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重置本批" })).toBeEnabled();
    expect(screen.getByLabelText("文件状态统计").querySelectorAll("button")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "待核价0" })).toBeInTheDocument();

    dropFiles([new File(["xlsx"], "second.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("已导入 2 个文件")).toBeInTheDocument();
    dropFiles([new File(["xlsx"], "second.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("已跳过 1 个重复文件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    expect(await screen.findByLabelText("批次处理进度")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".cyber-upload-panel")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "继续添加" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停任务" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止任务" })).toBeEnabled();
    await act(async () => api.emit({ type: "price-progress", phase: "analyze", current: 1, total: 2, path: "C:\\orders\\first.xlsx" }));
    expect(screen.getByRole("progressbar", { name: "正在分析文件 50%" })).toHaveAttribute("aria-valuenow", "50");
    expect(container.querySelector(".cyber-batch-file")).toHaveTextContent("1/2 个文件 · first.xlsx");
  });

  it("archives an unfinished batch before returning to the empty import view", async () => {
    const api = createDesktopAPI();
    api.finishTaskBatch = vi.fn(async () => ({
      record: {
        id: "stopped-batch",
        name: "completed.xlsx",
        startedAt: "2026-07-29T01:00:00.000Z",
        completedAt: "2026-07-29T01:01:00.000Z",
        status: "stopped" as const,
        totalFiles: 1,
        completedFiles: 0,
        failedFiles: 0,
        totalRows: 0,
        matchedRows: 0,
        exceptionRows: 0,
        outputRoot: "C:\\output",
        outputDir: "C:\\output\\completed.xlsx",
        detailAvailable: true,
      },
      archivedCount: 1,
      unprocessedDir: "C:\\output\\completed.xlsx\\未处理",
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "completed.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("completed.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await act(async () => api.emit({ type: "price-done", mode: "analysis", stopped: true, files: [] }));

    expect(screen.getByLabelText("批次处理进度")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "继续添加" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "暂停任务" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续未完成" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "结束本批并处理下一批" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByText("completed.xlsx")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "结束本批并处理下一批" }));
    const nextDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(nextDialog).getByRole("button", { name: "结束并归档" }));
    await waitFor(() => expect(api.finishTaskBatch).toHaveBeenCalledWith(expect.objectContaining({
      files: ["C:\\orders\\completed.xlsx"],
      outputRoot: "C:\\output",
    })));
    expect(await screen.findByText("拖拽一个或多个 Excel 文件到此处")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("批次处理进度")).not.toBeInTheDocument());
    expect(api.selectExcelFiles).not.toHaveBeenCalled();
  });

  it("centers the empty state independently from the table columns", () => {
    const api = createDesktopAPI();
    installAPI(api);
    const { container } = render(<App />);
    openFileProcessing();

    const scroll = container.querySelector(".cyber-table-scroll");
    expect(scroll).toHaveClass("is-empty");
    expect(scroll?.querySelector("thead .checkbox-column")).toHaveStyle({ width: "38px" });
    expect(scroll?.querySelector("thead .checkbox-column > button")).toHaveClass("size-4");
    expect(scroll?.querySelector(".cyber-empty-overlay")).toBeInTheDocument();
    expect(scroll?.querySelector("tbody .cyber-empty")).not.toBeInTheDocument();
  });

  it("resets the current batch while preserving the active configuration", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "before-reset.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("before-reset.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重置本批" }));
    const resetDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(resetDialog).getByRole("button", { name: "重置本批" }));
    await waitFor(() => expect(screen.queryByText("before-reset.xlsx")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "文件列表 （0）" })).toBeInTheDocument();
    expect(api.setAppState).not.toHaveBeenCalled();

    dropFiles([new File(["xlsx"], "after-reset.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("after-reset.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(api.analyzePriceFiles).toHaveBeenCalledWith(expect.objectContaining({ configPath: "C:\\config.json" })));
  });

  it("removes the redundant view label and keeps a status-sized action column last", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    const { container } = render(<App />);
    openFileProcessing();
    expect(screen.queryByText("列表视图")).not.toBeInTheDocument();
    dropFiles([new File(["xlsx"], "row.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("row.xlsx")).toBeInTheDocument();
    const table = container.querySelector(".cyber-file-table");
    expect(table).toHaveClass("is-pending");
    expect(table?.querySelector("thead th:last-child")).toHaveClass("action-column");
    expect(table?.querySelector("tbody tr:not(.cyber-detail) td:last-child")).toHaveClass("action-column");
  });

  it("controls the frameless Electron window", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化或还原" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => {
      expect(api.minimizeWindow).toHaveBeenCalledTimes(1);
      expect(api.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
      expect(api.closeWindow).toHaveBeenCalledTimes(1);
    });
  });

  it("navigates implemented pages and keeps only rule management as a placeholder", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "文件处理" }));
    expect(screen.getByRole("heading", { name: "文件处理" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const configPage = screen.getByRole("region", { name: "配置中心" });
    expect(within(configPage).queryByRole("heading", { name: "配置中心" })).not.toBeInTheDocument();
    expect(within(configPage).getByRole("button", { name: "保存" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "模板管理" }));
    const templatePage = screen.getByRole("region", { name: "模板管理" });
    expect(within(templatePage).queryByRole("heading", { name: "模板管理" })).not.toBeInTheDocument();
    expect(within(templatePage).getByRole("button", { name: "新建模板" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "创建时间" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "创建人" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "模板文件" })).toBeInTheDocument();
    await waitFor(() => expect(api.listHeaderTemplates).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "规则管理" }));
    expect(screen.getByRole("heading", { name: "正在装修中" })).toBeInTheDocument();
    expect(screen.getByText("规则管理", { selector: ".coming-soon-eyebrow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回工作台" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.getByRole("button", { name: "工作台" })).toHaveAttribute("aria-current", "page");
    const dashboard = screen.getByRole("region", { name: "工作台" });
    expect(within(dashboard).queryByRole("heading", { name: "工作台" })).not.toBeInTheDocument();
    expect(within(dashboard).getByRole("button", { name: "新建处理" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "日志中心" }));
    expect(await screen.findByRole("region", { name: "日志中心" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "运行日志" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "数据统计" }));
    expect(await screen.findByRole("region", { name: "数据统计" })).toBeInTheDocument();
  });

  it("paginates a 5000 file workload", async () => {
    const api = createDesktopAPI();
    api.listExcelFiles = vi.fn(async () => ({
      files: Array.from({ length: 5_000 }, (_, index) => `C:\\input-selected\\file-${index + 1}.xlsx`),
      skippedTemporary: 0,
      skippedUnsupported: 0,
      skippedOutput: 0,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);

    expect(await screen.findByRole("heading", { name: "文件列表 （5000）" })).toBeInTheDocument();
    expect(screen.getByText("file-1.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("file-51.xlsx")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("file-51.xlsx")).toBeInTheDocument();
  }, 20_000);

  it("selects configuration and toggles the sidebar", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[1]);
    expect(await screen.findByRole("region", { name: "配置中心" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    await waitFor(() => expect(api.selectConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("textbox", { name: "当前配置文件" })).toHaveValue("C:\\config.json");
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(document.querySelector(".cyber-app")).toHaveClass("is-sidebar-collapsed");
    expect(document.querySelector(".cyber-rail-actions")).not.toBeInTheDocument();
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "扫描配置中的输入目录" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "工作台" })).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("button", { name: "展开侧栏" })).toHaveAttribute("data-state", "closed");
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(document.querySelector(".cyber-app")).not.toHaveClass("is-sidebar-collapsed");
    expect(document.querySelector(".cyber-rail-actions")).not.toBeInTheDocument();
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
    openFileProcessing();
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "扫描配置中的输入目录" })).not.toBeInTheDocument();
    dropFiles([new File(["xlsx"], "sidebar.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("sidebar.xlsx")).toBeInTheDocument();
    expect(document.querySelector(".cyber-workbench-actions")?.querySelectorAll("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(document.querySelector(".cyber-rail-actions")?.querySelectorAll("button")).toHaveLength(2);
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
  });

  it("loads and toggles the remembered window size immediately", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[1]);
    const windowSizeSwitch = await screen.findByRole("switch", { name: "记住窗口大小" });
    await waitFor(() => expect(windowSizeSwitch).toBeEnabled());
    expect(windowSizeSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(windowSizeSwitch);

    await waitFor(() => {
      expect(api.setRememberWindowSize).toHaveBeenCalledWith(true);
      expect(windowSizeSwitch).toHaveAttribute("aria-checked", "true");
    });
    expect(api.saveConfigDocument).not.toHaveBeenCalled();
  });

  it("selects runtime directories without saving them immediately", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[1]);
    expect(await screen.findByRole("region", { name: "配置中心" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择输入目录" }));
    await waitFor(() => {
      expect(api.selectDirectory).toHaveBeenCalledWith("input");
      expect(screen.getByRole("textbox", { name: "输入目录" })).toHaveValue("C:\\input-selected");
    });

    fireEvent.click(screen.getByRole("button", { name: "选择输出目录" }));
    await waitFor(() => {
      expect(api.selectDirectory).toHaveBeenCalledWith("output");
      expect(screen.getByRole("textbox", { name: "输出目录" })).toHaveValue("C:\\output-selected");
    });
    expect(api.saveConfigDocument).not.toHaveBeenCalled();
  });

  it("runs pricing after analysis completes", async () => {
    const api = createDesktopAPI();
    api.getAppPreferences = vi.fn(async () => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: true,
      continuousIssueReviewEnabled: false,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await act(async () => {
      api.emit({ type: "price-analysis", file: createAnalysis("C:\\orders\\order.xlsx") });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"], outputDir: "C:\\output" })));
    expect(screen.queryByRole("dialog", { name: "文件处理详情" })).not.toBeInTheDocument();
    await act(async () => {
      api.emit({ type: "price-progress", phase: "run", current: 1, total: 1, path: "C:\\orders\\order.xlsx" });
      api.emit({ type: "price-progress", phase: "rows", current: 1, total: 14, path: "C:\\orders\\order.xlsx" });
      api.emit({ type: "price-file-result", path: "C:\\orders\\order.xlsx", status: "completed", totalRows: 14, matchedRows: 14, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ totalRows: 14, matchedRows: 14, exceptionRows: 0 }] });
    });
    expect(screen.queryByRole("dialog", { name: "文件处理详情" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "本批已完成 100%" })).toHaveAttribute("aria-valuenow", "100");
    // 批次结束后自动切到有结果的 Tab（本例全部成功）
    expect(useUIStore.getState().activeTab).toBe("success");
    expect(screen.getByText(/1\/1 个文件/)).toBeInTheDocument();
    expect(screen.queryByText(/1\/14 个文件/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "处理下一批" }));
    expect(await screen.findByText("拖拽一个或多个 Excel 文件到此处")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTitle("C:\\orders\\order.xlsx")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.selectExcelFiles).not.toHaveBeenCalled();
    expect(api.finishTaskBatch).not.toHaveBeenCalled();

    dropFiles([new File(["xlsx"], "second.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("second.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await act(async () => {
      api.emit({ type: "price-analysis", file: createAnalysis("C:\\orders\\second.xlsx") });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ files: ["C:\\orders\\second.xlsx"], outputDir: "C:\\output" }),
    ));
  });

  it("automatically opens the detail drawer for one true confirmation file", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "confirm.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("confirm.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    const analysis = createAnalysis("C:\\orders\\confirm.xlsx");
    analysis.requiresConfirmation = true;
    analysis.automationDecision = {
      ...analysis.automationDecision,
      status: "confirm",
      reasons: ["需要确认映射"],
    };

    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });

    const detailDialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(within(detailDialog).getByText("confirm.xlsx")).toBeInTheDocument();
    expect(api.runPriceCheck).not.toHaveBeenCalled();
  });

  it("asks for and persists an output directory before importing a dropped workbook", async () => {
    const api = createDesktopAPI();
    api.getAppState = vi.fn(async () => ({
      schemaVersion: 1 as const,
      activeBusinessConfigPath: "C:\\config.json",
      recentInputDirectory: "",
      recentOutputDirectory: "",
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    await waitFor(() => expect(api.getAppState).toHaveBeenCalled());
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledWith("output", true));
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await act(async () => {
      api.emit({ type: "price-analysis", file: createAnalysis("C:\\orders\\order.xlsx") });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({ outputDir: "C:\\output-selected" })));
    expect(api.getDefaultPriceOutputDir).not.toHaveBeenCalled();
  });

  it("does not import a dropped folder when output directory selection is canceled", async () => {
    const api = createDesktopAPI();
    api.getAppState = vi.fn(async () => ({
      schemaVersion: 1 as const,
      activeBusinessConfigPath: "C:\\config.json",
      recentInputDirectory: "",
      recentOutputDirectory: "",
    }));
    vi.mocked(api.selectDirectory).mockResolvedValue(null);
    installAPI(api);
    render(<App />);
    openFileProcessing();
    await waitFor(() => expect(api.getAppState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    const folderFiles = [new File(["xlsx"], "folder-order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })];
    Object.defineProperty(folderFiles[0], "path", { value: "/batch/folder-order.xlsx" });
    dropFiles(folderFiles);
    await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledWith("output", true));
    expect(screen.queryByText("folder-order.xlsx")).not.toBeInTheDocument();
    expect(screen.getByText("请选择输出文件夹后再导入")).toBeInTheDocument();
  });

  it("imports only the files returned by the selected folder", async () => {
    const api = createDesktopAPI();
    api.listExcelFiles = vi.fn(async () => ({
      files: ["C:\\input-selected\\a.xlsx", "C:\\input-selected\\b.xls"],
      skippedTemporary: 1,
      skippedUnsupported: 2,
      skippedOutput: 1,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    await waitFor(() => expect(api.listExcelFiles).toHaveBeenCalledWith("C:\\input-selected"));
    expect(await screen.findByText("a.xlsx")).toBeInTheDocument();
    expect(screen.getByText("b.xls")).toBeInTheDocument();
    expect(screen.getByText("已导入 2 个文件")).toBeInTheDocument();
  });

  it("keeps risky files for confirmation and continues only the confirmed file", async () => {
    const api = createDesktopAPI();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    api.getAppPreferences = vi.fn(async () => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: true,
      continuousIssueReviewEnabled: false,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
    }));
    api.listExcelFiles = vi.fn(async () => ({
      files: ["C:\\orders\\order.xlsx", "C:\\orders\\other.xlsx"],
      skippedTemporary: 0,
      skippedUnsupported: 0,
      skippedOutput: 0,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    expect(screen.getByText("other.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.requiresConfirmation = true;
    analysis.automationDecision = {
      ...analysis.automationDecision,
      status: "confirm",
      coverage: 0.97,
      matchedRows: 97,
      evaluatedRows: 100,
      reasons: ["试算覆盖率低于 98.0%"],
    };
    const otherAnalysis = createAnalysis("C:\\orders\\other.xlsx");
    otherAnalysis.requiresConfirmation = true;
    otherAnalysis.automationDecision = { ...analysis.automationDecision };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-analysis", file: otherAnalysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "待确认2" })).toBeInTheDocument());
    expect(api.runPriceCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "待确认2" }));
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    fireEvent.click((await screen.findAllByRole("button", { name: "详情" }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.runPriceCheck).mock.calls[0][0].files).toEqual(["C:\\orders\\order.xlsx"]);
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\order.xlsx", status: "completed", totalRows: 14, matchedRows: 14, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ totalRows: 14, matchedRows: 14, exceptionRows: 0 }] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "完成1" })).toHaveClass("is-active"));
    await waitFor(() => expect(screen.getByText("order.xlsx").closest("tr")).toHaveClass("is-result-revealed"));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });

    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.runPriceCheck).mock.calls[1][0].files).toEqual(["C:\\orders\\other.xlsx"]);
    expect(vi.mocked(api.runPriceCheck).mock.calls[0][0]).toEqual(expect.objectContaining({
      executionType: "manual",
      batchFiles: ["C:\\orders\\order.xlsx", "C:\\orders\\other.xlsx"],
    }));
    expect(vi.mocked(api.runPriceCheck).mock.calls[0][0]).not.toHaveProperty("batchId");
    expect(vi.mocked(api.runPriceCheck).mock.calls[1][0]).toEqual(expect.objectContaining({
      batchId: "test-batch",
      executionType: "manual",
      batchFiles: ["C:\\orders\\order.xlsx", "C:\\orders\\other.xlsx"],
    }));
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\other.xlsx", status: "completed", totalRows: 8, matchedRows: 8, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ totalRows: 8, matchedRows: 8, exceptionRows: 0 }] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "完成2" })).toHaveClass("is-active"));
  });

  it("continuously opens confirmation files before falling back to abnormal files", async () => {
    const api = createDesktopAPI();
    api.getAppPreferences = vi.fn(async () => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: true,
      continuousIssueReviewEnabled: true,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
    }));
    api.listExcelFiles = vi.fn(async () => ({
      files: [
        "C:\\orders\\first.xlsx",
        "C:\\orders\\second.xlsx",
        "C:\\orders\\abnormal.xlsx",
      ],
      skippedTemporary: 0,
      skippedUnsupported: 0,
      skippedOutput: 0,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    expect(await screen.findByText("first.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));

    const firstAnalysis = createAnalysis("C:\\orders\\first.xlsx");
    firstAnalysis.fileName = "first.xlsx";
    firstAnalysis.requiresConfirmation = true;
    firstAnalysis.automationDecision = { ...firstAnalysis.automationDecision, status: "confirm", reasons: ["需要确认"] };
    const secondAnalysis = createAnalysis("C:\\orders\\second.xlsx");
    secondAnalysis.fileName = "second.xlsx";
    secondAnalysis.requiresConfirmation = true;
    secondAnalysis.automationDecision = { ...secondAnalysis.automationDecision, status: "confirm", reasons: ["需要确认"] };
    const abnormalAnalysis = createAnalysis("C:\\orders\\abnormal.xlsx");
    abnormalAnalysis.fileName = "abnormal.xlsx";
    abnormalAnalysis.requiresConfirmation = true;
    abnormalAnalysis.automationDecision = { ...abnormalAnalysis.automationDecision, status: "error", reasons: ["分析异常"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: firstAnalysis });
      api.emit({ type: "price-analysis", file: secondAnalysis });
      api.emit({ type: "price-analysis", file: abnormalAnalysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });

    fireEvent.click(screen.getByRole("button", { name: "待确认2" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "详情" }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledTimes(1));
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\first.xlsx", status: "completed", totalRows: 20, matchedRows: 20, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ path: "C:\\orders\\first.xlsx", totalRows: 20, matchedRows: 20, exceptionRows: 0 }] });
    });

    let detailDialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(within(detailDialog).getByText("second.xlsx")).toBeInTheDocument();
    fireEvent.click(await within(detailDialog).findByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledTimes(2));
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\second.xlsx", status: "completed", totalRows: 20, matchedRows: 20, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ path: "C:\\orders\\second.xlsx", totalRows: 20, matchedRows: 20, exceptionRows: 0 }] });
    });

    detailDialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(within(detailDialog).getByText("abnormal.xlsx")).toBeInTheDocument();
    expect(within(detailDialog).getByRole("button", { name: "重新分析此文件" })).toBeInTheDocument();
    expect(useUIStore.getState().activeTab).toBe("error");
  });

  it("stops continuous review on the current file when manual pricing fails", async () => {
    const api = createDesktopAPI();
    api.getAppPreferences = vi.fn(async () => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: false,
      continuousIssueReviewEnabled: true,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
    }));
    api.listExcelFiles = vi.fn(async () => ({
      files: ["C:\\orders\\failed.xlsx", "C:\\orders\\next.xlsx"],
      skippedTemporary: 0,
      skippedUnsupported: 0,
      skippedOutput: 0,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    expect(await screen.findByText("failed.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));

    const failedAnalysis = createAnalysis("C:\\orders\\failed.xlsx");
    failedAnalysis.fileName = "failed.xlsx";
    failedAnalysis.requiresConfirmation = true;
    failedAnalysis.automationDecision = { ...failedAnalysis.automationDecision, status: "confirm", reasons: ["需要确认"] };
    const nextAnalysis = createAnalysis("C:\\orders\\next.xlsx");
    nextAnalysis.fileName = "next.xlsx";
    nextAnalysis.requiresConfirmation = true;
    nextAnalysis.automationDecision = { ...nextAnalysis.automationDecision, status: "confirm", reasons: ["需要确认"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: failedAnalysis });
      api.emit({ type: "price-analysis", file: nextAnalysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });

    fireEvent.click(screen.getByRole("button", { name: "待确认2" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "详情" }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "确认并处理此文件" }));
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\failed.xlsx", status: "failed", message: "核价失败" });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [] });
    });

    const detailDialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(within(detailDialog).getByText("failed.xlsx")).toBeInTheDocument();
    expect(within(detailDialog).queryByText("next.xlsx")).not.toBeInTheDocument();
    expect(useUIStore.getState().activeTab).toBe("error");
  });

  it("reopens the current abnormal file when manual reanalysis remains unresolved", async () => {
    const api = createDesktopAPI();
    api.getAppPreferences = vi.fn(async () => ({
      schemaVersion: 1 as const,
      archiveStandardFiles: false,
      autoRevealManualResult: false,
      continuousIssueReviewEnabled: true,
      overwriteSourceFiles: false,
      rememberWindowSize: false,
    }));
    api.listExcelFiles = vi.fn(async () => ({
      files: ["C:\\orders\\current-error.xlsx", "C:\\orders\\next-error.xlsx"],
      skippedTemporary: 0,
      skippedUnsupported: 0,
      skippedOutput: 0,
    }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    expect(await screen.findByText("current-error.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));

    const currentAnalysis = createAnalysis("C:\\orders\\current-error.xlsx");
    currentAnalysis.fileName = "current-error.xlsx";
    currentAnalysis.requiresConfirmation = true;
    currentAnalysis.automationDecision = { ...currentAnalysis.automationDecision, status: "error", reasons: ["分析异常"] };
    const nextAnalysis = createAnalysis("C:\\orders\\next-error.xlsx");
    nextAnalysis.fileName = "next-error.xlsx";
    nextAnalysis.requiresConfirmation = true;
    nextAnalysis.automationDecision = { ...nextAnalysis.automationDecision, status: "error", reasons: ["分析异常"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: currentAnalysis });
      api.emit({ type: "price-analysis", file: nextAnalysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });

    fireEvent.click(screen.getByRole("button", { name: "异常2" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "详情" }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "重新分析此文件" }));
    await act(async () => {
      api.emit({ type: "price-analysis", file: currentAnalysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });

    const detailDialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(within(detailDialog).getByText("current-error.xlsx")).toBeInTheDocument();
    expect(within(detailDialog).queryByText("next-error.xlsx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "异常2" })).toBeInTheDocument();
    expect(useUIStore.getState().activeTab).toBe("error");
  });

  it("keeps the confirmation tab active after a manual file result by default", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "manual.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("manual.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    const analysis = createAnalysis("C:\\orders\\manual.xlsx");
    analysis.fileName = "manual.xlsx";
    analysis.requiresConfirmation = true;
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["需要确认映射"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledTimes(1));
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\manual.xlsx", status: "completed", outputPath: "C:\\output\\manual-priced.xlsx", totalRows: 7, matchedRows: 5, exceptionRows: 2 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ path: "C:\\orders\\manual.xlsx", totalRows: 7, matchedRows: 5, exceptionRows: 2 }] });
    });
    await waitFor(() => expect(useUIStore.getState().activeTab).toBe("confirm"));
    expect(screen.getByRole("button", { name: "完成1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "异常0" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成1" }));
    expect(await screen.findByRole("button", { name: "打开" })).toBeInTheDocument();
  });

  it("shows automation reasons in the file detail drawer", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockRejectedValue(new Error("Excel 文件超过 120MB"));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.requiresConfirmation = true;
    analysis.automationDecision = {
      ...analysis.automationDecision,
      status: "confirm",
      reasons: [
        "候选差距不足",
        "同一 Sheet 组合下，字段列候选差距不足：最优 [SKU F（SKU） / 数量 G（产品总数）]；次优 [SKU D（SKU） / 数量 E（产品总数）]",
      ],
      candidateScore: 188.7,
      runnerUpScore: 181.2,
      scoreKind: "field",
    };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    expect(await screen.findByRole("dialog", { name: "文件处理详情" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在准备文件详情" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("候选差距不足")).toHaveLength(2));
    expect(screen.getByText("同一 Sheet 组合下，字段列候选差距不足")).toBeInTheDocument();
    expect(screen.getByText("最优").closest(".decision-candidate")).toHaveClass("is-best");
    expect(screen.getByText("次选").closest(".decision-candidate")).toHaveClass("is-alternate");
    expect(screen.getByText("字段 188.7 分")).toBeInTheDocument();
    expect(screen.getByText("字段 181.2 分")).toBeInTheDocument();
    expect(screen.getAllByText("SKU F（SKU）", { selector: ".decision-mapping-token.is-sku" })).toHaveLength(1);
    expect(screen.getByText("数量 E（产品总数）", { selector: ".decision-mapping-token.is-quantity" })).toBeInTheDocument();
    expect(await screen.findByText("无法预览工作簿")).toBeInTheDocument();
    expect(screen.getByText("文件超过 120MB，无法在应用内预览，请打开原始文件查看")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开原始文件" }));
    await waitFor(() => expect(api.openPath).toHaveBeenCalledWith("C:\\orders\\order.xlsx"));
  });

  it("previews candidate sheets and resizes the detail drawer", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    FakeExcelPreviewWorker.orderRows = [
      ["订单号", "平台订单号", "备用SKU", "国家", "英文国家", "中文国家", "物流", "SKU", "数量", "价格", "Name", "Address"],
      ["订单-数据", "P-1", "OLD-1", "US", "United States", "美国", "", "OTHER-1", "1", "9.5", "Buyer", "Street"],
      ...Array.from({ length: 15 }, (_, index) => [
        `ROW-${index + 3}`, `P-${index + 2}`, "OLD-1", "US", "United States", "美国", "", "OTHER-1", "1", "9.5", "Buyer", "Street",
      ]),
      ["TARGET-ROW", "P-18", "OLD-1", "US", "United States", "美国", "", "GOOD-1*2", "1", "9.5", "Buyer", "Street"],
    ];
    FakeExcelPreviewWorker.pricingRows = [
      ["SKU", "Country", "1", "2", "3"],
      ["GOOD-1", "United States-hold", "12", "11", "10"],
      ["GOOD-1", "United States", "9.5", "9", "8.5"],
    ];
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3, modifiedAt: 1 });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.requiresConfirmation = true;
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["需要确认映射"] };
    analysis.writebackRows = [
      { sourceRow: 2, pricingPrice: 9.5, priceDifference: 0, quantity: 1 },
      {
        sourceRow: 17,
        pricingPrice: null,
        priceDifference: null,
        quantity: null,
        quantityError: "SKU关系无法计算",
      },
      { sourceRow: 18, pricingPrice: 9, priceDifference: -0.5, quantity: 2 },
    ];
    analysis.unmatchedRows = [{
      sourceRow: 18,
      skuColumn: 8,
      sku: "GOOD-1*2",
      country: "US",
      quantity: 2,
      reason: "数量档位不存在：核价表没有数量 2 对应的档位",
    }];
    analysis.suggestedMapping!.quantityTierColumns.push({ quantity: 2, column: 4, header: "2" });
    analysis.pricingSheetCandidates[0].tierColumns = analysis.suggestedMapping!.quantityTierColumns;
    analysis.pricingSheetCandidates.push({ ...analysis.pricingSheetCandidates[0], sheetName: "报价二", score: 80 });
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(screen.getByRole("status", { name: "正在准备文件详情" })).toBeInTheDocument();
    await screen.findByLabelText("字段映射编辑器");
    expect(screen.queryByLabelText("处理时间线")).not.toBeInTheDocument();
    const drawerContent = dialog.querySelector(".issue-drawer-content");
    expect(drawerContent?.firstElementChild).toHaveClass("excel-preview-panel");
    expect(drawerContent?.lastElementChild).toHaveClass("issue-detail-column");
    const mappingEditor = screen.getByLabelText("字段映射编辑器");
    expect(mappingEditor.firstElementChild).toHaveClass("mapping-editor-scroll");
    expect(mappingEditor.lastElementChild).toHaveClass("mapping-editor-footer");
    const separator = screen.getByRole("separator", { name: "调整详情抽屉宽度" });
    const initialWidth = Number.parseFloat(dialog.style.width);
    expect(initialWidth).toBe(Math.min(Math.round(window.innerWidth * 0.9), window.innerWidth - 72));
    const originalViewportWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalViewportWidth + 200 });
    fireEvent(window, new Event("resize"));
    expect(Number.parseFloat(dialog.style.width)).toBe(Math.round((originalViewportWidth + 200) * 0.9));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalViewportWidth });
    fireEvent(window, new Event("resize"));
    expect(Number.parseFloat(dialog.style.width)).toBe(initialWidth);
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(Number.parseFloat(dialog.style.width)).toBe(initialWidth + 24);
    fireEvent.pointerDown(separator, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 495 });
    expect(Number.parseFloat(dialog.style.width)).toBe(initialWidth + 29);
    fireEvent.pointerUp(window);

    const contentSeparator = screen.getByRole("separator", { name: "调整预览与字段映射宽度" });
    expect(contentSeparator).toHaveAttribute("aria-valuenow", "360");
    fireEvent.keyDown(contentSeparator, { key: "ArrowLeft" });
    expect(contentSeparator).toHaveAttribute("aria-valuenow", "376");
    fireEvent.pointerDown(contentSeparator, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 490 });
    expect(contentSeparator).toHaveAttribute("aria-valuenow", "386");
    fireEvent.pointerUp(window);

    expect(await screen.findByText("订单-数据")).toBeInTheDocument();
    // 打开详情默认截断预览，不立刻 loadAll
    expect(FakeExcelPreviewWorker.instances[0].request).toEqual(expect.objectContaining({
      loadAll: false,
    }));
    expect(FakeExcelPreviewWorker.instances[0].request?.candidates.map((candidate) => candidate.name)).toEqual(["订单", "核价", "报价二"]);
    expect(screen.getByText("订单 90.0 分")).toBeInTheDocument();
    expect(screen.getByText("核价 90.0 分")).toBeInTheDocument();
    expect(screen.getByText("核价 80.0 分")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载全部数据" })).toHaveTextContent("加载全部");
    const unmatchedSwitch = screen.getByRole("switch", { name: "未匹配定位" });
    expect(unmatchedSwitch).toHaveAttribute("aria-checked", "false");
    expect(unmatchedSwitch).toHaveAttribute("aria-keyshortcuts", "Control+E ArrowUp ArrowDown Enter");
    fireEvent.keyDown(document, { key: "e", ctrlKey: true });
    expect(unmatchedSwitch).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(unmatchedSwitch).toHaveFocus());
    // 开启未匹配定位时触发一次 loadAll（订单+核价完整数据）
    await waitFor(() => expect(FakeExcelPreviewWorker.instances[0].request).toEqual(expect.objectContaining({
      loadAll: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({ name: "订单" }),
        expect.objectContaining({ name: "核价" }),
      ]),
    })));
    expect(FakeExcelPreviewWorker.instances).toHaveLength(1);
    expect(FakeExcelPreviewWorker.instances[0].request?.candidates.map((candidate) => candidate.name)).not.toContain("报价二");
    expect(await screen.findByText("已加载全部")).toBeInTheDocument();
    const pricingTab = screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }).closest("button")!;
    fireEvent.click(pricingTab);
    pricingTab.focus();
    expect(pricingTab).toHaveFocus();
    const orderTab = screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }).closest("button")!;
    fireEvent.click(orderTab);
    orderTab.focus();
    await waitFor(() => expect(unmatchedSwitch).toHaveFocus());
    fireEvent.keyDown(unmatchedSwitch, { key: "ArrowDown" });
    await waitFor(() => expect(dialog.querySelector(".excel-preview-row-number.is-unmatched-target")).toHaveTextContent("17"));
    fireEvent.keyDown(unmatchedSwitch, { key: "Enter" });
    const quantityIssueDialog = await screen.findByRole("dialog", { name: "数量计算问题" });
    const selectedQuantityIssueRow = quantityIssueDialog.querySelector('tr[data-source-row="17"]');
    expect(selectedQuantityIssueRow).toHaveClass("is-selected-issue");
    expect(within(quantityIssueDialog).getByText("第 17 行")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "数量计算问题" })).not.toBeInTheDocument());
    fireEvent.keyDown(unmatchedSwitch, { key: "ArrowDown" });
    await waitFor(() => expect(dialog.querySelector(".excel-preview-row-number.is-unmatched-target")).toHaveTextContent("18"));
    fireEvent.keyDown(unmatchedSwitch, { key: "Enter" });
    const unmatchedIssueDialog = await screen.findByRole("dialog", { name: "价格未匹配详情" });
    const selectedIssueRow = unmatchedIssueDialog.querySelector('tr[data-source-row="18"]');
    expect(selectedIssueRow).toHaveClass("is-selected-issue");
    expect(selectedIssueRow).toHaveAttribute("aria-current", "true");
    expect(within(unmatchedIssueDialog).getByText("第 18 行")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "价格未匹配详情" })).not.toBeInTheDocument());
    expect(unmatchedSwitch).toHaveFocus();
    expect(dialog.querySelector(".excel-preview-row-number.is-unmatched-target")).toHaveTextContent("18");
    fireEvent.click(unmatchedSwitch);
    expect(unmatchedSwitch).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(dialog.querySelector(".excel-preview-row-number.is-unmatched-target")).not.toBeInTheDocument());
    fireEvent.keyDown(unmatchedSwitch, { key: "ArrowDown" });
    expect(dialog.querySelector(".excel-preview-row-number.is-unmatched-target")).not.toBeInTheDocument();
    expect(screen.getAllByText("核价[财务]").length).toBeGreaterThan(0);
    const initialPreviewDataRow = Array.from(dialog.querySelectorAll(".excel-preview-rows .excel-preview-row"))
      .find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "2");
    expect(initialPreviewDataRow?.querySelectorAll(".is-writeback-column")).toHaveLength(3);
    expect(initialPreviewDataRow).toHaveTextContent("9");
    const initialPreviewRowNumber = initialPreviewDataRow?.querySelector(".excel-preview-row-number") as HTMLElement;
    fireEvent.click(initialPreviewRowNumber);
    expect(initialPreviewRowNumber).toHaveFocus();
    expect(initialPreviewDataRow).toHaveClass("is-selected-row");
    fireEvent.blur(initialPreviewRowNumber);
    expect(initialPreviewDataRow).not.toHaveClass("is-selected-row");
    const previewHeaderCells = Array.from(dialog.querySelectorAll(".excel-preview-frozen-header > span:not(.excel-preview-row-number)"))
      .map((cell) => cell.textContent);
    expect(previewHeaderCells.slice(9)).toEqual(["价格", "核价[财务]", "金额差", "数量", "Name", "Address"]);
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const previewSearch = screen.getByRole("searchbox", { name: "搜索表格数据" });
    await waitFor(() => expect(previewSearch).toHaveFocus());
    expect(previewSearch).toHaveAttribute("size", "18");
    fireEvent.change(previewSearch, { target: { value: "GOOD-1, US | United States | 美国" } });
    expect(previewSearch).toHaveAttribute("size", "32");
    fireEvent.change(previewSearch, { target: { value: "订单号 | 订单-数据" } });
    await waitFor(() => expect(screen.getByText("1/2")).toBeInTheDocument());
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("订单号");
    const previewScroll = dialog.querySelector(".excel-preview-scroll") as HTMLDivElement;
    const previewFrame = previewScroll.closest(".excel-preview-table-frame") as HTMLDivElement;
    const previewActions = dialog.querySelector(".excel-preview-scroll-actions") as HTMLDivElement;
    expect(previewFrame).not.toContainElement(previewActions);
    expect(dialog.querySelector(".excel-preview-legend-hints")).toContainElement(previewActions);
    const previewScrollTo = vi.fn();
    Object.defineProperty(previewScroll, "scrollHeight", { configurable: true, value: 2400 });
    Object.defineProperty(previewScroll, "scrollTo", { configurable: true, value: previewScrollTo });
    fireEvent.click(screen.getByRole("button", { name: "滚动详情表格到表尾" }));
    expect(previewScrollTo).toHaveBeenLastCalledWith({ top: 2400, behavior: "smooth" });
    fireEvent.click(screen.getByRole("button", { name: "滚动详情表格到表头" }));
    expect(previewScrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
    previewScroll.scrollTop = 123;
    previewScroll.scrollLeft = 57;
    fireEvent.scroll(previewScroll);
    fireEvent.pointerDown(contentSeparator, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 505 });
    fireEvent.pointerUp(window);
    expect(previewScroll.scrollTop).toBe(123);
    expect(previewScroll.scrollLeft).toBe(57);
    fireEvent.keyDown(previewSearch, { key: "Enter" });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("订单-数据");
    fireEvent.keyDown(previewSearch, { key: "ArrowDown" });
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("订单号");
    fireEvent.keyDown(previewSearch, { key: "ArrowUp" });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("订单-数据");
    fireEvent.keyDown(previewSearch, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("searchbox", { name: "搜索表格数据" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const jointSearch = screen.getByRole("searchbox", { name: "搜索表格数据" });
    fireEvent.change(jointSearch, { target: { value: "订单-数据, P-1" } });
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(dialog.querySelectorAll(".excel-preview-row.is-search-matched-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    // 已加载全部后按钮禁用，点击不重复触发
    const loadAllButton = screen.getByRole("button", { name: "加载全部数据" });
    expect(loadAllButton).toBeDisabled();
    expect(loadAllButton).toHaveTextContent("已加载全部");
    fireEvent.click(loadAllButton);
    expect(FakeExcelPreviewWorker.instances).toHaveLength(1);
    // 再次开启未匹配定位：已 loadAll 则不额外请求
    fireEvent.click(screen.getByRole("switch", { name: "未匹配定位" }));
    expect(screen.getByRole("switch", { name: "未匹配定位" })).toHaveAttribute("aria-checked", "true");
    expect(FakeExcelPreviewWorker.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("switch", { name: "未匹配定位" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结 C 列" }));
    fireEvent.click(screen.getByRole("button", { name: "冻结 A 列" }));
    const previewColumnOrder = (): Array<string | null> => Array.from(document.querySelectorAll(".excel-preview-header > [data-column-label]")).map((element) => element.getAttribute("data-column-label"));
    expect(previewColumnOrder().slice(0, 4)).toEqual(["C", "A", "B", "D"]);
    let pinnedAHeader = document.querySelector('.excel-preview-header > [data-column-label="A"]');
    expect(document.querySelector('.excel-preview-header > [data-column-label="C"]')).toHaveStyle({ left: "52px" });
    expect(pinnedAHeader).toHaveStyle({ left: "172px" });
    const orderColumnResizer = screen.getByRole("separator", { name: "调整 C 列宽" });
    expect(orderColumnResizer).toHaveAttribute("aria-valuenow", "120");
    fireEvent.pointerDown(orderColumnResizer, { button: 0, clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 372 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(screen.getByRole("separator", { name: "调整 C 列宽" })).toHaveAttribute("aria-valuenow", "192"));
    pinnedAHeader = document.querySelector('.excel-preview-header > [data-column-label="A"]');
    expect(pinnedAHeader).toHaveStyle({ left: "244px" });
    fireEvent.click(screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }));
    expect((await screen.findAllByText("GOOD-1")).length).toBeGreaterThan(0);
    expect(screen.getByRole("separator", { name: "调整 A 列宽" })).toHaveAttribute("aria-valuenow", "120");
    fireEvent.click(screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }));
    expect(await screen.findByText("订单-数据")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整 C 列宽" })).toHaveAttribute("aria-valuenow", "192");
    expect(previewColumnOrder().slice(0, 4)).toEqual(["C", "A", "B", "D"]);
    fireEvent.click(screen.getByRole("button", { name: "取消冻结 C 列" }));
    expect(previewColumnOrder().slice(0, 4)).toEqual(["A", "B", "C", "D"]);
    const orderDataRowNumber = Array.from(dialog.querySelectorAll(".excel-preview-rows .excel-preview-row-number")).find((element) => element.textContent === "18");
    expect(orderDataRowNumber).toBeDefined();
    fireEvent.doubleClick(orderDataRowNumber!);
    const automaticSearch = await screen.findByRole("searchbox", { name: "搜索表格数据" });
    expect(automaticSearch).toHaveValue("GOOD-1, US | United States | 美国");
    expect(screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }).closest("button")).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("GOOD-1")).length).toBeGreaterThan(0);
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(dialog.querySelector(".excel-preview-row.is-search-matched-row")).toHaveTextContent("GOOD-1");
    expect(dialog.querySelector(".excel-preview-row.is-search-matched-row")).not.toHaveTextContent("hold");
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("9");
    const returnedPreviewScroll = dialog.querySelector(".excel-preview-scroll") as HTMLDivElement;
    returnedPreviewScroll.scrollTop = 0;
    fireEvent.click(screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }));
    const expectedReturnScrollTop = Math.max(0, 17 * 30 - returnedPreviewScroll.clientHeight / 2);
    await waitFor(() => expect(returnedPreviewScroll.scrollTop).toBe(expectedReturnScrollTop));
    expect(returnedPreviewScroll.scrollTop).toBeGreaterThan(0);
    expect(screen.queryByRole("searchbox", { name: "搜索表格数据" })).not.toBeInTheDocument();
    expect(screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }).closest("button")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const returnedOrderSearch = screen.getByRole("searchbox", { name: "搜索表格数据" });
    expect(returnedOrderSearch).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    const pricingSheetSelect = screen.getByRole("combobox", { name: "核价 Sheet" });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    fireEvent.click(pricingSheetSelect);
    fireEvent.click(await screen.findByRole("option", { name: "报价二 · 80.0 分" }));
    expect(screen.getByText("报价二", { selector: ".excel-preview-tabs button strong" }).closest("button")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("报价二-数据")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭文件详情" }));
    await waitFor(() => expect(FakeExcelPreviewWorker.instances[0].terminate).toHaveBeenCalledTimes(1));
  }, 15_000);

  it("edits only the three financial columns and recalculates a quantity change by row", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    FakeExcelPreviewWorker.orderRows = [
      ["订单号", "平台订单号", "备用SKU", "国家", "英文国家", "中文国家", "Qty", "SKU", "合并数量", "价格"],
      ["ORDER-1", "P-1", "OLD-1", "US", "United States", "美国", "1", "GOOD-1", "1", "9.5"],
      ["ORDER-2", "P-2", "OLD-2", "US", "United States", "美国", "1", "GOOD-2", "1", "9"],
      ["", "", "", "", "", "", "", "", "", "147.67"],
    ];
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3, modifiedAt: 1 });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();

    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.writebackRows = [
      { sourceRow: 2, pricingPrice: 9.5, priceDifference: 0, quantity: 1 },
      { sourceRow: 3, pricingPrice: 8, priceDifference: -1, quantity: 1 },
    ];
    analysis.requiresConfirmation = true;
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["需要确认映射"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog", { name: "文件处理详情" });
    expect(await screen.findByText("ORDER-1")).toBeInTheDocument();

    const dataRow = Array.from(dialog.querySelectorAll(".excel-preview-rows .excel-preview-row"))
      .find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "2");
    expect(dialog.querySelectorAll(".excel-preview-frozen-header .is-writeback-column.is-header-cell")).toHaveLength(3);
    const pricingCell = dataRow?.querySelectorAll(".is-writeback-column")[0];
    fireEvent.pointerDown(pricingCell as HTMLElement);
    expect(pricingCell).toHaveClass("is-selected-cell");
    expect(screen.queryByRole("textbox", { name: "编辑第 2 行核价[财务]" })).not.toBeInTheDocument();
    const validationCallsBeforeWritebackEdit = vi.mocked(api.validatePriceMapping).mock.calls.length;
    fireEvent.doubleClick(pricingCell as HTMLElement);
    const editor = screen.getByRole("textbox", { name: "编辑第 2 行核价[财务]" }) as HTMLInputElement;
    expect([editor.selectionStart, editor.selectionEnd]).not.toEqual([0, editor.value.length]);
    fireEvent.change(editor, { target: { value: "12.5" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(dataRow?.querySelectorAll(".is-writeback-column")[0]).toHaveTextContent("12.5"));
    expect(dataRow?.querySelectorAll(".is-writeback-column")[1]).toHaveTextContent("3");
    expect(api.validatePriceMapping).toHaveBeenCalledTimes(validationCallsBeforeWritebackEdit);
    const totalRow = dialog.querySelector(".excel-preview-total-row");
    expect(totalRow?.querySelector(".excel-preview-row-number")).toHaveTextContent("4");
    expect(totalRow).toHaveTextContent("147.67");
    expect(totalRow).not.toHaveTextContent("合计");
    expect(totalRow?.querySelectorAll(".is-writeback-column")).toHaveLength(3);
    expect(dialog.querySelectorAll(".excel-preview-rows .excel-preview-row")).toHaveLength(4);
    const frozenHeader = screen.getByLabelText("冻结表头，第 1 行");
    const orderNumberHeaderCell = Array.from(frozenHeader.querySelectorAll(":scope > span"))
      .find((cell) => cell.textContent === "订单号");
    const orderPriceHeaderCell = Array.from(frozenHeader.querySelectorAll(":scope > span"))
      .find((cell) => cell.textContent === "价格");
    expect(orderNumberHeaderCell).not.toHaveClass("is-editable-source");
    expect(orderPriceHeaderCell).not.toHaveClass("is-editable-source");
    expect(frozenHeader.querySelectorAll(".is-editable-source")).toHaveLength(0);
    const orderPriceCell = Array.from(dataRow?.querySelectorAll(":scope > span") ?? [])
      .find((cell) => cell.textContent === "9.5");
    expect(orderPriceCell).not.toHaveClass("is-editable-source");
    fireEvent.doubleClick(orderPriceCell as HTMLElement);
    expect(screen.queryByRole("textbox", { name: "编辑订单第 2 行第 10 列" })).not.toBeInTheDocument();
    const skuHeaderCell = Array.from(frozenHeader.querySelectorAll(":scope > span"))
      .find((cell) => cell.textContent === "SKU");
    expect(skuHeaderCell).not.toHaveClass("is-editable-source");
    fireEvent.doubleClick(skuHeaderCell as HTMLElement);
    expect(screen.queryByRole("textbox", { name: "编辑订单第 1 行第 8 列" })).not.toBeInTheDocument();
    const skuCell = screen.getByText("GOOD-1", { selector: ".excel-preview-row > span" });
    fireEvent.pointerDown(skuCell);
    expect(skuCell).not.toHaveClass("is-selected-cell");
    expect(screen.queryByRole("textbox", { name: "编辑订单第 2 行第 8 列" })).not.toBeInTheDocument();
    fireEvent.doubleClick(skuCell);
    expect(screen.queryByRole("textbox", { name: "编辑订单第 2 行第 8 列" })).not.toBeInTheDocument();

    const differenceCell = dataRow?.querySelectorAll(".is-writeback-column")[1];
    fireEvent.doubleClick(differenceCell as HTMLElement);
    const differenceEditor = screen.getByRole("textbox", { name: "编辑第 2 行金额差" });
    fireEvent.change(differenceEditor, { target: { value: "1.5" } });
    fireEvent.keyDown(differenceEditor, { key: "Enter" });
    await waitFor(() => expect(dataRow?.querySelectorAll(".is-writeback-column")[0]).toHaveTextContent("11"));
    expect(dataRow?.querySelectorAll(".is-writeback-column")[1]).toHaveTextContent("1.5");

    const quantityCell = dataRow?.querySelectorAll(".is-writeback-column")[2];
    fireEvent.doubleClick(quantityCell as HTMLElement);
    const quantityEditor = screen.getByRole("textbox", { name: "编辑第 2 行数量" });
    fireEvent.change(quantityEditor, { target: { value: "2" } });
    fireEvent.keyDown(quantityEditor, { key: "Enter" });
    await waitFor(() => expect(api.recalculatePriceRow).toHaveBeenCalledTimes(1));
    expect(api.validatePriceMapping).toHaveBeenCalledTimes(validationCallsBeforeWritebackEdit);
    const rowRequest = vi.mocked(api.recalculatePriceRow).mock.calls[0][0];
    expect(rowRequest).toMatchObject({
      inputPath: "C:\\orders\\order.xlsx",
      rowEdit: { sourceRow: 2, quantity: 2 },
      cellEdits: [],
    });
    await act(async () => {
      api.emit({
        type: "price-row-validation",
        inputPath: rowRequest.inputPath,
        requestVersion: rowRequest.requestVersion,
        sourceRow: 2,
        row: { sourceRow: 2, pricingPrice: 13, priceDifference: 3.5, quantity: 2 },
        error: null,
      });
    });
    await waitFor(() => expect(dataRow?.querySelectorAll(".is-writeback-column")[0]).toHaveTextContent("13"));
    expect(dataRow?.querySelectorAll(".is-writeback-column")[1]).toHaveTextContent("3.5");
    expect(dataRow?.querySelectorAll(".is-writeback-column")[2]).toHaveTextContent("2");
    const untouchedRow = Array.from(dialog.querySelectorAll(".excel-preview-rows .excel-preview-row"))
      .find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "3");
    expect(untouchedRow?.querySelectorAll(".is-writeback-column")[0]).toHaveTextContent("8");
    expect(untouchedRow?.querySelectorAll(".is-writeback-column")[1]).toHaveTextContent("-1");
    expect(untouchedRow?.querySelectorAll(".is-writeback-column")[2]).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({
      mappings: [expect.objectContaining({
        inputPath: "C:\\orders\\order.xlsx",
        writebackRows: [
          { sourceRow: 2, pricingPrice: 13, priceDifference: 3.5, quantity: 2 },
        ],
        cellEdits: [],
      })],
    })));
  });

  it("highlights mapped SKU columns and revalidates manual field changes", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    FakeExcelPreviewWorker.orderRows = [
      ["订单号", "平台订单号", "备用SKU", "国家", "英文国家", "中文国家", "Qty", "SKU", "合并数量", "价格", "Name", "Phone", "Code"],
      ["订单-数据", "P-1", "OLD-1", "US", "United States", "美国", "1", "GOOD-1", "1", "9.5", "Alice", "123456", "10001"],
    ];
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3, modifiedAt: 1 });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.writebackRows = [
      { sourceRow: 37, pricingPrice: null, priceDifference: null, quantity: null, quantityError: "SKU关系无法计算" },
    ];
    analysis.requiresConfirmation = true;
    analysis.automationDecision = {
      ...analysis.automationDecision,
      status: "confirm",
      reasons: ["需要确认映射", "1 行数量无法计算，需要确认"],
    };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("订单-数据");
    const initialQuantityDetailsButton = screen.getByRole("button", { name: "查看数量异常详情" });
    fireEvent.click(initialQuantityDetailsButton);
    const initialIssueDialog = screen.getByRole("dialog", { name: "数量计算问题" });
    expect(within(initialIssueDialog).getByText("第 37 行")).toBeInTheDocument();
    expect(within(initialIssueDialog).getByText("SKU关系无法计算")).toBeInTheDocument();
    fireEvent.click(within(initialIssueDialog).getByRole("button", { name: "关闭问题详情" }));
    expect(screen.queryByRole("dialog", { name: "数量计算问题" })).not.toBeInTheDocument();

    expect(screen.queryByLabelText("平台订单号")).not.toBeInTheDocument();
    const orderNumberSelect = screen.getByLabelText("订单号");
    await waitFor(() => expect((orderNumberSelect as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(orderNumberSelect, { target: { value: "2" } });
    await waitFor(() => expect(vi.mocked(api.validatePriceMapping).mock.calls.some(([payload]) => (
      payload.mapping.businessOrderNumberColumn === 2
    ))).toBe(true));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".excel-preview-header .is-sku-qty-column").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".excel-preview-header .is-price-column").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("冻结表头，第 1 行")).toHaveTextContent("订单号");
    expect(screen.getByLabelText("字段颜色说明")).toHaveTextContent("SKU/数量 1价格字段常规匹配字段");
    expect(screen.queryByLabelText("预览状态")).not.toBeInTheDocument();
    expect(screen.queryByText(/已显示全部数据范围/)).not.toBeInTheDocument();
    expect(document.querySelector(".cyber-footer")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("原始数量 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("SKU 1")).toBeInTheDocument();
    expect(screen.getByLabelText("数量 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("单独发货判断", { selector: "summary span" }));
    expect(screen.getByText("配置已开启")).toBeInTheDocument();
    expect(screen.getByText("N · Name", { selector: ".single-shipment-status b" })).toBeInTheDocument();
    expect(screen.getByText("O · Phone", { selector: ".single-shipment-status b" })).toBeInTheDocument();
    expect(screen.getByText("P · Code", { selector: ".single-shipment-status b" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("收件人姓名")).toHaveValue("11"));
    expect(screen.getByLabelText("电话")).toHaveValue("12");
    expect(screen.getByLabelText("邮编")).toHaveValue("13");
    expect(screen.getByRole("button", { name: "选择收件人姓名，当前N · Name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择电话，当前O · Phone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择邮编，当前P · Code" })).toBeInTheDocument();
    ["Name", "Phone", "Code"].forEach((header) => {
      expect(screen.getByText(header, { selector: ".excel-preview-frozen-header .is-mapped-column" })).toBeInTheDocument();
    });
    const confirm = screen.getByRole("button", { name: "确认并处理此文件" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(api.validatePriceMapping).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(api.validatePriceMapping).mock.calls.some(([payload]) => (
      payload.mapping.businessOrderNumberColumn === 2
      && payload.mapping.skuQtyPairs[0].qtyColumn === 7
      && payload.mapping.skuQtyPairs[0].skuColumn === 8
      && payload.mapping.skuQtyPairs[0].mergedQtyColumn === 9
    ))).toBe(true));
    const request = vi.mocked(api.validatePriceMapping).mock.calls.filter(([payload]) => (
      payload.mapping.businessOrderNumberColumn === 2
      && payload.mapping.skuQtyPairs[0].qtyColumn === 7
      && payload.mapping.skuQtyPairs[0].skuColumn === 8
      && payload.mapping.skuQtyPairs[0].mergedQtyColumn === 9
    )).at(-1)![0];
    expect(request.mapping.skuQtyPairs[0]).toMatchObject({ qtyColumn: 7, skuColumn: 8, mergedQtyColumn: 9 });

    await act(async () => api.emit({
      type: "price-validation",
      inputPath: request.inputPath,
      requestVersion: request.requestVersion,
      evaluatedRows: 1,
      matchedRows: 1,
      coverage: 1,
      matchedOrderRows: [2],
      writebackRows: [{
        sourceRow: 2,
        pricingPrice: 12.5,
        priceDifference: 3,
        quantity: 2,
        usedOriginalSkuQuantity: true,
      }],
      errors: [],
      warnings: [],
    }));
    expect(await screen.findByText(/试算 1\/1 行/)).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).toHaveTextContent("2");
    expect(screen.getAllByText("核价[财务]").length).toBeGreaterThan(0);
    expect(screen.getAllByText("金额差").length).toBeGreaterThan(0);
    expect(screen.getAllByText("数量").length).toBeGreaterThan(0);
    const previewDataRow = Array.from(document.querySelectorAll(".excel-preview-rows .excel-preview-row"))
      .find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "2");
    expect(previewDataRow).toHaveTextContent("12.5");
    expect(previewDataRow).toHaveTextContent("3");
    expect(previewDataRow).toHaveTextContent("2");
    expect(previewDataRow?.querySelectorAll(".is-writeback-column")).toHaveLength(3);
    expect(previewDataRow?.querySelectorAll(".is-writeback-column")[2]).toHaveClass("is-mismatched-quantity");
    expect(previewDataRow?.querySelectorAll(".is-original-sku-quantity")).toHaveLength(3);
    await act(async () => api.emit({
      type: "price-validation",
      inputPath: request.inputPath,
      requestVersion: request.requestVersion,
      evaluatedRows: 1,
      matchedRows: 1,
      coverage: 1,
      matchedOrderRows: [2],
      writebackRows: [
        { sourceRow: 2, pricingPrice: 12.5, priceDifference: 3, quantity: 2 },
        {
          sourceRow: 37,
          pricingPrice: null,
          priceDifference: null,
          quantity: null,
          quantityError: "SKU关系无法计算: 前一SKU TC3348-L-4 与主要SKU TC334806 无共同组件",
          quantityIssueContext: {
            previousSkuColumn: 10,
            previousSku: "TC3348-L-4",
            mainSkuColumn: 12,
            mainSku: "TC334806",
          },
        },
      ],
      errors: [],
      warnings: ["1 行数量无法计算，需要确认"],
    }));
    expect(screen.getAllByText("1 行数量无法计算，需要确认")).toHaveLength(1);
    const quantityDetailsButton = await screen.findByRole("button", { name: "查看数量异常详情" });
    expect(quantityDetailsButton).toHaveTextContent("详情");
    fireEvent.click(quantityDetailsButton);
    const issueDialog = screen.getByRole("dialog", { name: "数量计算问题" });
    expect(issueDialog).toHaveTextContent("1 个具体问题");
    expect(within(issueDialog).getByRole("table", { name: "数量问题明细" })).toBeInTheDocument();
    expect(within(issueDialog).getByText("第 37 行")).toBeInTheDocument();
    expect(within(issueDialog).getByText("J 列")).toBeInTheDocument();
    expect(within(issueDialog).getByText("TC3348-L-4")).toBeInTheDocument();
    expect(within(issueDialog).getByText("L 列")).toBeInTheDocument();
    expect(within(issueDialog).getByText("TC334806")).toBeInTheDocument();
    expect(within(issueDialog).getByText("两个 SKU 没有共同组件，无法换算数量")).toBeInTheDocument();
    expect(issueDialog.querySelector(".issue-details-dialog-sku-value.is-previous")).toHaveAttribute(
      "aria-label",
      "次要 SKU J 列 TC3348-L-4",
    );
    expect(issueDialog.querySelector(".issue-details-dialog-sku-value.is-main")).toHaveAttribute(
      "aria-label",
      "主要 SKU L 列 TC334806",
    );
    expect(document.querySelector(".issue-status-quantity-details")).not.toBeInTheDocument();
    fireEvent.click(within(issueDialog).getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("dialog", { name: "数量计算问题" })).not.toBeInTheDocument();

    await act(async () => api.emit({
      type: "price-validation",
      inputPath: request.inputPath,
      requestVersion: request.requestVersion,
      evaluatedRows: 2,
      matchedRows: 1,
      coverage: 0.5,
      matchedOrderRows: [2],
      writebackRows: [{ sourceRow: 2, pricingPrice: 12.5, priceDifference: 3, quantity: 2 }],
      unmatchedRows: [{
        sourceRow: 37,
        skuColumn: 12,
        sku: "TC2500348",
        country: "US",
        quantity: 4,
        reason: "数量无对应档位：核价表没有数量 4 对应的档位",
      }],
      errors: [],
      warnings: ["试算覆盖率低于 100.0%"],
    }));
    const unmatchedDetailsButton = await screen.findByRole("button", { name: "查看未匹配详情" });
    fireEvent.click(unmatchedDetailsButton);
    const unmatchedDialog = screen.getByRole("dialog", { name: "价格未匹配详情" });
    expect(within(unmatchedDialog).getByText("第 37 行")).toBeInTheDocument();
    expect(within(unmatchedDialog).getByText("TC2500348")).toBeInTheDocument();
    expect(within(unmatchedDialog).getByText("数量无对应档位").closest("span")).toHaveClass("is-danger");
    expect(within(unmatchedDialog).getByText("US").closest("span")).toHaveClass("is-warning");
    expect(within(unmatchedDialog).getByText("4", { selector: ".issue-details-dialog-reason-markers strong" }).closest("span")).toHaveClass("is-info");
    expect(unmatchedDialog).toHaveTextContent("核价表没有数量 4 对应的档位");
    expect(within(unmatchedDialog).getByText("4", { selector: "mark" })).toHaveClass("is-info");
    fireEvent.click(within(unmatchedDialog).getByRole("button", { name: "知道了" }));

    const callsBeforeManualValidation = vi.mocked(api.validatePriceMapping).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重新试算" }));
    await waitFor(() => expect(api.validatePriceMapping).toHaveBeenCalledTimes(callsBeforeManualValidation + 1));
    const manualRequest = vi.mocked(api.validatePriceMapping).mock.calls.at(-1)![0];
    expect(manualRequest.requestVersion).toBeGreaterThan(request.requestVersion);
    expect(screen.getByRole("button", { name: "正在试算" })).toBeDisabled();
    await act(async () => api.emit({ type: "price-validation", inputPath: manualRequest.inputPath, requestVersion: manualRequest.requestVersion, evaluatedRows: 0, matchedRows: 0, coverage: 0, matchedOrderRows: [], errors: ["订单字段映射中存在重复列"], warnings: [] }));
    expect(await screen.findByText("订单字段映射中存在重复列")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新试算" })).toBeEnabled();
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).toHaveTextContent("2");
    await act(async () => api.emit({ type: "price-validation", inputPath: request.inputPath, requestVersion: 0, evaluatedRows: 1, matchedRows: 0, coverage: 0, errors: [], warnings: ["过期结果"] }));
    expect(screen.queryByText("过期结果")).not.toBeInTheDocument();
    const skuSelect = screen.getByLabelText("SKU 1");
    fireEvent.change(skuSelect, { target: { value: "3" } });
    await waitFor(() => expect(vi.mocked(api.validatePriceMapping).mock.calls.some(([payload]) => (
      payload.mapping.skuQtyPairs[0].skuColumn === 3
    ))).toBe(true));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).not.toBeInTheDocument();
    const staleWritebackCells = document.querySelectorAll(".excel-preview-rows .is-writeback-column:not(.is-header-cell)");
    expect(staleWritebackCells).toHaveLength(3);
    staleWritebackCells.forEach((cell) => expect(cell).toHaveTextContent(""));
  }, 15_000);

  it("allows every configured single-shipment field column to be changed manually", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      size: 3,
      modifiedAt: 1,
    });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx")]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.requiresConfirmation = true;
    analysis.automationDecision = {
      ...analysis.automationDecision,
      status: "confirm",
      reasons: ["需要确认映射"],
    };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("订单-数据");
    fireEvent.click(screen.getByText("单独发货判断", { selector: "summary span" }));

    const phoneSelect = await screen.findByLabelText("电话");
    fireEvent.change(phoneSelect, { target: { value: "2" } });

    await waitFor(() => expect(vi.mocked(api.validatePriceMapping).mock.calls.some(([payload]) => (
      payload.mapping.singleShipmentFields?.find((field) => field.field === "phone")?.columns[0] === 2
    ))).toBe(true));
  });

  it("hides single-shipment fields and their mapped-column colors when matching is disabled", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    FakeExcelPreviewWorker.orderRows = [
      ["订单号", "平台订单号", "备用SKU", "国家", "英文国家", "中文国家", "Qty", "SKU", "合并数量", "价格", "Name", "Phone", "Code"],
      ["订单-数据", "P-1", "OLD-1", "US", "United States", "美国", "1", "GOOD-1", "1", "9.5", "Alice", "123456", "10001"],
    ];
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3, modifiedAt: 1 });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx")]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.singleShipmentMatching = {
      enabled: false,
      ready: false,
      fields: analysis.singleShipmentMatching?.fields ?? [],
      reason: "配置未开启，使用通用价格",
    };
    analysis.requiresConfirmation = true;
    analysis.automationDecision = {
      ...analysis.automationDecision,
      status: "confirm",
      reasons: ["需要确认映射"],
    };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("订单-数据");

    expect(screen.queryByText("单独发货判断", { selector: "summary span" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("收件人姓名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("电话")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("邮编")).not.toBeInTheDocument();
    ["Name", "Phone", "Code"].forEach((header) => {
      expect(screen.getByText(header, { selector: ".excel-preview-frozen-header span" })).not.toHaveClass("is-mapped-column");
    });
  });

  it("uses one shade for each SKU and quantity pair and different shades between pairs", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3, modifiedAt: 1 });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    const pairs = [
      { skuColumn: 3, qtyColumn: 2, mergedQtyColumn: 4, skuHeader: "SKU 2", qtyHeader: "Qty 2", mergedQtyHeader: "Merged Qty 2" },
      { skuColumn: 8, qtyColumn: 7, mergedQtyColumn: 9, skuHeader: "SKU 1", qtyHeader: "Qty 1", mergedQtyHeader: "Merged Qty 1" },
    ];
    analysis.suggestedMapping!.skuQtyPairs = pairs;
    analysis.orderSheetCandidates[0].skuQtyPairs = pairs;
    analysis.requiresConfirmation = true;
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["需要确认映射"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("订单-数据");

    const column = (label: string): HTMLElement => document.querySelector(`.excel-preview-header > [data-column-label="${label}"]`)!;
    const shade = (label: string): string => column(label).style.getPropertyValue("--sku-pair-strength");
    expect(column("H")).toHaveClass("is-sku-qty-column");
    expect(column("I")).toHaveClass("is-sku-qty-column");
    expect(column("C")).toHaveClass("is-sku-qty-column");
    expect(column("D")).toHaveClass("is-sku-qty-column");
    expect(column("B")).not.toHaveClass("is-sku-qty-column");
    expect(column("G")).not.toHaveClass("is-sku-qty-column");
    expect(shade("H")).toBe(shade("I"));
    expect(shade("C")).toBe(shade("D"));
    expect(shade("B")).toBe("");
    expect(shade("G")).toBe("");
    expect(shade("H")).not.toBe(shade("C"));
    expect(Number.parseInt(shade("H"), 10)).toBeGreaterThan(Number.parseInt(shade("C"), 10));
    const skuBodyCell = screen.getByText("GOOD-1", { selector: ".excel-preview-row > span" });
    expect(skuBodyCell).not.toHaveClass("is-sku-qty-column");
    expect(skuBodyCell.style.getPropertyValue("--sku-pair-strength")).toBe("");
    expect(screen.getByLabelText("字段颜色说明")).toHaveTextContent("SKU/数量 1SKU/数量 2");
  });

  it("highlights only contiguous duplicate order numbers", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
    FakeExcelPreviewWorker.orderRows = [
      ["订单号", "平台订单号", "SKU 2", "国家", "英文国家", "中文国家", "数量", "SKU 1", "合并数量", "价格"],
      ["ORDER-1", "P-1", "SKU-X", "US", "United States", "美国", "1", "SKU-A", "2", "9.5"],
      ["ORDER-1", "P-2", "SKU-X", "US", "United States", "美国", "1", "SKU-A", "1", "9.5"],
      ["ORDER-2", "P-3", "SKU-X", "US", "United States", "美国", "1", "SKU-B", "1", "9.5"],
      ["ORDER-1", "P-4", "SKU-X", "US", "United States", "美国", "1", "SKU-A", "1", "9.5"],
    ];
    const api = createDesktopAPI();
    vi.mocked(api.readExcelPreviewFile).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3, modifiedAt: 1 });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    const skuPairs = [
      { skuColumn: 3, qtyColumn: 2, mergedQtyColumn: 4, skuHeader: "SKU 2", qtyHeader: "平台订单号", mergedQtyHeader: "国家" },
      { skuColumn: 8, qtyColumn: 7, mergedQtyColumn: 9, skuHeader: "SKU 1", qtyHeader: "数量", mergedQtyHeader: "合并数量" },
    ];
    analysis.suggestedMapping!.skuQtyPairs = skuPairs;
    analysis.orderSheetCandidates[0].skuQtyPairs = skuPairs;
    analysis.writebackRows = [
      { sourceRow: 2, pricingPrice: 10, priceDifference: 1.5, quantity: 2 },
      { sourceRow: 3, pricingPrice: 8, priceDifference: -2, quantity: 0 },
      {
        sourceRow: 4,
        pricingPrice: 9.5,
        priceDifference: 0,
        quantity: null,
        quantityError: "SKU关系无法计算",
      },
    ];
    analysis.requiresConfirmation = true;
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["需要确认映射"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("ORDER-2");

    const duplicateOrderCells = document.querySelectorAll(".excel-preview-row > .is-duplicate-order");
    expect(duplicateOrderCells).toHaveLength(2);
    duplicateOrderCells.forEach((cell) => {
      expect(cell).toHaveTextContent("ORDER-1");
      expect(cell).toHaveClass("is-mapped-column");
    });
    const repeatedOrderCells = screen.getAllByText("ORDER-1", { selector: ".excel-preview-row > span" });
    expect(repeatedOrderCells).toHaveLength(3);
    expect(repeatedOrderCells.filter((cell) => cell.classList.contains("is-duplicate-order"))).toHaveLength(2);
    expect(repeatedOrderCells.filter((cell) => !cell.classList.contains("is-duplicate-order"))).toHaveLength(1);
    expect(document.querySelector(".excel-preview-row > .is-duplicate-sku")).not.toBeInTheDocument();
    expect(document.querySelector(".excel-preview-row > .is-sku-qty-column:not(.is-header-cell)")).not.toBeInTheDocument();
    expect(document.querySelector(".excel-preview-row.is-same-order-group")).not.toBeInTheDocument();
    expect(screen.getByText("ORDER-2", { selector: ".excel-preview-row > span" })).not.toHaveClass("is-duplicate-order");
    const positiveDifferenceCell = screen.getByText("1.5", { selector: ".is-positive-difference" });
    expect(positiveDifferenceCell).toBeInTheDocument();
    expect(screen.getByText("-2", { selector: ".is-negative-difference" })).toBeInTheDocument();
    screen.getAllByText("0", { selector: ".is-writeback-column" }).forEach((cell) => {
      expect(cell).not.toHaveClass("is-positive-difference", "is-negative-difference");
    });
    const previewRows = Array.from(document.querySelectorAll(".excel-preview-rows .excel-preview-row"));
    const matchingQuantityRow = previewRows.find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "2");
    const mismatchedQuantityRow = previewRows.find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "3");
    const invalidQuantityRow = previewRows.find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "4");
    const blankWritebackRow = previewRows.find((row) => row.querySelector(".excel-preview-row-number")?.textContent === "5");
    expect(matchingQuantityRow?.querySelectorAll(".is-writeback-column")[2]).not.toHaveClass("is-mismatched-quantity");
    const mismatchedQuantityCell = mismatchedQuantityRow?.querySelectorAll(".is-writeback-column")[2];
    expect(mismatchedQuantityCell).toHaveClass("is-mismatched-quantity");
    matchingQuantityRow?.querySelectorAll(".is-writeback-column").forEach((cell) => {
      expect(cell).toHaveClass("has-writeback-value");
    });
    const invalidQuantityCell = invalidQuantityRow?.querySelectorAll(".is-writeback-column")[2];
    expect(invalidQuantityCell).toBeEmptyDOMElement();
    expect(invalidQuantityCell).toHaveAttribute("title", "SKU关系无法计算");
    expect(invalidQuantityCell).not.toHaveClass("has-writeback-value");
    blankWritebackRow?.querySelectorAll(".is-writeback-column").forEach((cell) => {
      expect(cell).not.toHaveClass("has-writeback-value");
    });
  });

  it("classifies generated results with issue rows as exceptions", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    await act(async () => {
      api.emit({ type: "price-analysis", file: createAnalysis("C:\\orders\\order.xlsx") });
      api.emit({
        type: "price-file-result",
        path: "C:\\orders\\order.xlsx",
        status: "completed",
        outputPath: "C:\\output\\order-priced.xlsx",
        totalRows: 20,
        matchedRows: 18,
        exceptionRows: 2,
        coverage: 0.9,
        message: "2 行未匹配",
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "异常1" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "异常1" }));
    expect(await screen.findByText("2 行存在异常")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.queryByRole("button", { name: "打开结果文件" })).not.toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "重新分析此文件" });
    fireEvent.click(retry);
    await waitFor(() => expect(api.analyzePriceFiles).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"] })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "文件处理详情" })).not.toBeInTheDocument());
  });

  it("moves a manually confirmed exception file to completed", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    const analysis = createAnalysis("C:\\orders\\order.xlsx");
    analysis.requiresConfirmation = true;
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["存在异常，需人工确认"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({
        type: "price-file-result",
        path: "C:\\orders\\order.xlsx",
        status: "completed",
        outputPath: "C:\\output\\order-priced.xlsx",
        totalRows: 20,
        matchedRows: 18,
        exceptionRows: 2,
        coverage: 0.9,
        message: "2 行未匹配",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "异常1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认并处理此文件" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"] })));

    await act(async () => {
      api.emit({
        type: "price-file-result",
        path: "C:\\orders\\order.xlsx",
        status: "completed",
        outputPath: "C:\\output\\order-priced.xlsx",
        totalRows: 20,
        matchedRows: 18,
        exceptionRows: 2,
        coverage: 0.9,
        message: "已人工确认，保留 2 行异常",
      });
      api.emit({
        type: "price-done",
        mode: "run",
        stopped: false,
        files: [{ path: "C:\\orders\\order.xlsx", totalRows: 20, matchedRows: 18, exceptionRows: 2 }],
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "完成1" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "异常0" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成1" }));
    expect(await screen.findByRole("button", { name: "打开" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(await screen.findByRole("button", { name: "打开结果文件" })).toBeInTheDocument();
  });

  it("pauses, resumes, stops, and exposes five status tabs", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停任务" }));
    await waitFor(() => expect(api.pauseProcessing).toHaveBeenCalledTimes(1));
    await act(async () => api.emit({ type: "state", state: "paused" }));
    fireEvent.click(screen.getByRole("button", { name: "继续任务" }));
    await waitFor(() => expect(api.resumeProcessing).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(api.stopProcessing).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll(".cyber-tabs button")).toHaveLength(5);
  });

  it("keeps the current batch while switching between dashboard and file processing", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "persistent.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("persistent.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "工作台" }));
    expect(screen.getByText("1 个文件待处理")).toBeInTheDocument();
    openFileProcessing();
    expect(screen.getByText("persistent.xlsx")).toBeInTheDocument();
  });

  it("renders persisted dashboard metrics and configuration health", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.getTaskHistorySummary).mockResolvedValue({
      today: { files: 12, tasks: 3, matchRate: 0.965, exceptions: 4 },
      trend: [{ date: "2026-07-16", files: 12, matchedRows: 965, totalRows: 1000, exceptions: 4 }],
      recent: [],
    });
    installAPI(api);
    render(<App />);
    expect(screen.getByRole("region", { name: "工作台" })).toBeInTheDocument();
    expect(screen.queryByText("查看核价进展、配置健康状态与最近任务")).not.toBeInTheDocument();
    for (const heading of ["处理趋势", "配置健康状态", "最近任务", "配置与输出"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.queryByText("业务总览")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "继续工作" })).not.toBeInTheDocument();
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
    expect(await screen.findByText("配置可用")).toBeInTheDocument();
    expect(screen.getByText("规则文件已加载并通过校验")).toBeInTheDocument();
    expect(screen.queryByText("C:\\config.json")).not.toBeInTheDocument();
  });

  it("renders dashboard empty metrics", () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("renders the framed trend state when returned date buckets contain no files", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.getTaskHistorySummary).mockResolvedValue({
      today: { files: 5, tasks: 1, matchRate: 0.9, exceptions: 0 },
      trend: [
        { date: "2026-07-20", files: 0, matchedRows: 0, totalRows: 0, exceptions: 0 },
        { date: "2026-07-21", files: 0, matchedRows: 0, totalRows: 0, exceptions: 0 },
      ],
      recent: [],
    });
    installAPI(api);
    const { container } = render(<App />);

    expect(await screen.findByText("5")).toBeInTheDocument();
    expect(screen.getByText("暂无处理数据")).toBeInTheDocument();
    expect(container.querySelector(".dashboard-trend-empty")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "最近七天处理趋势" })).not.toBeInTheDocument();
  });

  it("opens log center and analytics as independent navigation pages", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "日志中心" }));
    expect(await screen.findByRole("region", { name: "日志中心" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "运行日志" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "数据统计" }));
    expect(await screen.findByRole("region", { name: "数据统计" })).toBeInTheDocument();
    expect(screen.queryByText("正在装修中")).not.toBeInTheDocument();
  });

  it("maps required template headers by clicking preview cells", async () => {
    const api = createDesktopAPI();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["订单号", "国家二字码", "SKU", "数量"]]), "Order");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["SKU", "Country", "1", "2", "3"]]), "Pricing");
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    api.getConfigDocument = vi.fn(async () => ({
      path: "C:\\config.json",
      content: JSON.stringify({ fields: {} }),
      modifiedAt: 1,
      isDefault: false,
    }));
    api.listHeaderTemplates = vi.fn(async () => [{
      id: "template-1",
      createdAt: "2026-07-21T08:00:00.000Z",
      createdBy: "tester",
      fileName: "headers.xlsx",
      filePath: "C:\\templates\\headers.xlsx",
      mappings: [],
    }]);
    api.readExcelPreviewFile = vi.fn(async () => ({ bytes, size: bytes.length, modifiedAt: 1 }));
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "模板管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    expect(await screen.findByRole("dialog", { name: "headers.xlsx" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "订单字段" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "核价字段" })).toBeInTheDocument();

    const templateDialog = screen.getByRole("dialog", { name: "headers.xlsx" });
    const drawerResizer = screen.getByRole("separator", { name: "调整模板详情抽屉宽度" });
    expect(templateDialog).toHaveStyle({ width: "952px" });
    fireEvent.pointerDown(drawerResizer, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 140 });
    expect(templateDialog).toHaveStyle({ width: "912px" });
    fireEvent.pointerUp(window);

    const fieldsResizer = screen.getByRole("separator", { name: "调整预览与必填字段宽度" });
    const detailBody = templateDialog.querySelector(".template-detail-body");
    expect(detailBody).toHaveStyle({ gridTemplateColumns: "minmax(360px, 1fr) 12px 330px" });
    fireEvent.pointerDown(fieldsResizer, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 460 });
    expect(detailBody).toHaveStyle({ gridTemplateColumns: "minmax(360px, 1fr) 12px 370px" });
    fireEvent.pointerUp(window);

    fireEvent.click(await screen.findByRole("button", { name: "订单号" }));
    fireEvent.click(screen.getByRole("button", { name: "国家二字码" }));
    fireEvent.click(screen.getByRole("button", { name: "SKU" }));
    fireEvent.click(screen.getByRole("button", { name: "数量" }));
    fireEvent.click(screen.getByRole("button", { name: "Pricing" }));
    fireEvent.click(screen.getByRole("button", { name: "SKU" }));
    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(screen.getByRole("button", { name: "移除价格档位 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除价格档位 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除价格档位 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存字段映射" }));

    await waitFor(() => expect(api.updateHeaderTemplateMappings).toHaveBeenCalledWith({
      id: "template-1",
      mappings: [
        expect.objectContaining({ fieldKey: "order_number", sheetName: "Order", column: 1, header: "订单号" }),
        expect.objectContaining({ fieldKey: "country_code", sheetName: "Order", column: 2, header: "国家二字码" }),
        expect.objectContaining({ fieldKey: "sku_detail", sheetName: "Order", column: 3, header: "SKU" }),
        expect.objectContaining({ fieldKey: "qty_detail", sheetName: "Order", column: 4, header: "数量" }),
        expect.objectContaining({ fieldKey: "pricing_sku", sheetName: "Pricing", column: 1, header: "SKU" }),
        expect.objectContaining({ fieldKey: "pricing_country", sheetName: "Pricing", column: 2, header: "Country" }),
        expect.objectContaining({ fieldKey: "price", sheetName: "Pricing", column: 3, header: "1" }),
        expect.objectContaining({ fieldKey: "price", sheetName: "Pricing", column: 4, header: "2" }),
        expect.objectContaining({ fieldKey: "price", sheetName: "Pricing", column: 5, header: "3" }),
      ],
    }));

    fireEvent.click(screen.getByRole("button", { name: "关闭模板详情" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByRole("alertdialog", { name: "删除这个模板？" })).toHaveTextContent("此操作无法撤销");
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteHeaderTemplate).toHaveBeenCalledWith("template-1"));
    expect(screen.queryByText("headers.xlsx")).not.toBeInTheDocument();
  }, 15_000);

  it("keeps app preferences separate while synchronizing business fields with JSON", async () => {
    const api = createDesktopAPI();
    const content = JSON.stringify({ performance: { processing_workers: 0 }, pricing: {}, extension_field: { keep: true } }, null, 2) + "\n";
    vi.mocked(api.getConfigDocument).mockResolvedValue({ path: "C:\\config.json", content, modifiedAt: 10, isDefault: false });
    installAPI(api);
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const workers = await screen.findByRole("spinbutton", { name: "处理线程数" });
    expect(screen.queryByText("数量策略")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "数量乘以单价" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "零价格视为有效" })).not.toBeInTheDocument();
    expect(await screen.findByText("最大线程数：8")).toBeInTheDocument();
    expect(workers).toHaveAttribute("max", "7");
    fireEvent.change(workers, { target: { value: "99" } });
    expect((screen.getByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement).value).toContain('"processing_workers": 7');
    fireEvent.change(workers, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "模板匹配优先" }));
    const revealSwitch = screen.getByRole("switch", { name: "手动处理后定位结果" });
    expect(revealSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(revealSwitch);
    await waitFor(() => expect(revealSwitch).toHaveAttribute("aria-checked", "true"));
    const continuousReviewSwitch = screen.getByRole("switch", { name: "连续处理问题文件" });
    expect(continuousReviewSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(continuousReviewSwitch);
    await waitFor(() => expect(continuousReviewSwitch).toHaveAttribute("aria-checked", "true"));
    const overwriteSourceSwitch = screen.getByRole("switch", { name: "源文件覆盖" });
    expect(overwriteSourceSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(overwriteSourceSwitch);
    await waitFor(() => expect(overwriteSourceSwitch).toHaveAttribute("aria-checked", "true"));
    const singleShipmentSwitch = screen.getByRole("switch", { name: "启用单独发货价格匹配" });
    const recipientNameField = screen.getByRole("checkbox", { name: "收件人姓名" });
    const phoneField = screen.getByRole("checkbox", { name: "电话" });
    const postalCodeField = screen.getByRole("checkbox", { name: "邮编" });
    expect(singleShipmentSwitch).toHaveAttribute("aria-checked", "false");
    expect(recipientNameField).toBeChecked();
    expect(recipientNameField).toBeDisabled();
    fireEvent.click(singleShipmentSwitch);
    expect(singleShipmentSwitch).toHaveAttribute("aria-checked", "true");
    expect(recipientNameField).toBeEnabled();
    fireEvent.click(postalCodeField);
    expect(recipientNameField).toBeDisabled();
    expect(phoneField).toBeDisabled();
    const source = screen.getByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement;
    expect(source.value).toContain('"extension_field"');
    expect(source.value).toContain('"processing_workers": 4');
    expect(source.value).toContain('"template_match_priority": true');
    expect(source.value).not.toContain('"runtime"');
    expect(api.setAppPreferences).toHaveBeenCalledWith({ autoRevealManualResult: true });
    expect(api.setAppPreferences).toHaveBeenCalledWith({ continuousIssueReviewEnabled: true });
    expect(api.setAppPreferences).toHaveBeenCalledWith({ overwriteSourceFiles: true });
    expect(source.value).toContain('"single_shipment_matching_enabled": true');
    expect(source.value).toContain('"single_shipment_match_fields"');
    expect(source.value).not.toContain('"postal_code"');
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveConfigDocument).toHaveBeenCalledWith(expect.objectContaining({
      path: "C:\\config.json",
      expectedModifiedAt: 10,
      content: expect.stringContaining('"extension_field"'),
    })));
  });

  it("re-analyzes imported files after saving pricing configuration", async () => {
    const api = createDesktopAPI();
    const content = JSON.stringify({
      pricing: {
        single_shipment_matching_enabled: false,
        single_shipment_match_fields: ["recipient_name", "phone", "postal_code"],
      },
    }, null, 2) + "\n";
    vi.mocked(api.getConfigDocument).mockResolvedValue({
      path: "C:\\config.json",
      content,
      modifiedAt: 10,
      isDefault: false,
    });
    installAPI(api);
    render(<App />);
    openFileProcessing();
    dropFiles([new File(["xlsx"], "linked.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })]);
    expect(await screen.findByText("linked.xlsx")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const singleShipmentSwitch = await screen.findByRole("switch", {
      name: "启用单独发货价格匹配",
    });
    fireEvent.click(singleShipmentSwitch);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.analyzePriceFiles).toHaveBeenCalledWith({
      files: ["C:\\orders\\linked.xlsx"],
      configPath: "C:\\config.json",
    }));
  });

  it("formats valid JSON source without changing its data", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.getConfigDocument).mockResolvedValue({ path: "C:\\config.json", content: "{}\n", modifiedAt: 10, isDefault: false });
    installAPI(api);
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const source = await screen.findByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: '{"extension_field":{"keep":true}}' } });
    fireEvent.click(screen.getByRole("button", { name: "格式化" }));
    expect(source.value).toBe('{\n  "extension_field": {\n    "keep": true\n  }\n}\n');
    expect(screen.getByText("5 行")).toBeInTheDocument();
  });
});
