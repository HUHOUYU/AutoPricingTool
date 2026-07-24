import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import type { DesktopAPI, PriceAnalysisFile, ProcessorEvent } from "../../preload";
import type { ExcelPreviewWorkerRequest, ExcelPreviewWorkerResponse } from "./lib/excel-preview";
import { App } from "./App";
import { useUIStore } from "./stores/ui-store";

function createAnalysis(path: string): PriceAnalysisFile {
  const mapping = {
    orderSheet: "订单",
    orderHeaderRow: 1,
    businessOrderNumberColumn: 1,
    countryCodeColumn: 4,
    countryEnglishColumn: 5,
    countryChineseColumn: 6,
    skuQtyPairs: [{ skuColumn: 8, qtyColumn: 9, skuHeader: "SKU", qtyHeader: "Qty" }],
    shippingMethodColumn: 7,
    orderPriceColumn: 10,
    pricingSheet: "核价",
    pricingHeaderRow: 1,
    pricingQuantityHeaderRow: null,
    pricingSkuColumn: 1,
    pricingCountryColumn: 2,
    pricingShippingMethodColumn: null,
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
      shippingMethodColumn: 7,
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
      shippingMethodColumn: null,
      tierColumns: mapping.quantityTierColumns,
      validPriceRows: 2,
      usablePriceCells: 2,
      notes: [],
    }],
    suggestedMapping: mapping,
    coverage: 1,
    matchedOrderRows: [2],
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
    getRuntimeConfig: vi.fn(async () => ({ recent_output_dir: "C:\\output", recent_config_path: "C:\\config.json" })),
    getDefaultPriceOutputDir: vi.fn(async () => "C:\\Program\\核价结果"),
    getProcessingCapacity: vi.fn(async () => ({ detectedThreads: 8, maxWorkers: 7 })),
    setRuntimeConfig: vi.fn(async (config) => config),
    getConfigDocument: vi.fn(async () => ({ path: "C:\\config.json", content: "{}\n", modifiedAt: 1, isDefault: false })),
    validateConfigDocument: vi.fn(async () => ({ valid: true, issues: [] })),
    saveConfigDocument: vi.fn(async ({ path, content }) => ({ path, content, modifiedAt: 2, isDefault: false })),
    saveConfigDocumentAs: vi.fn(async (content) => ({ path: "C:\\saved.json", content, modifiedAt: 2, isDefault: false })),
    restoreDefaultConfig: vi.fn(async () => ({ path: "C:\\config.json", content: "{}\n", modifiedAt: 3, isDefault: false })),
    getTaskHistorySummary: vi.fn(async () => ({ today: { files: 0, tasks: 0, matchRate: 0, exceptions: 0 }, trend: [], recent: [] })),
    listHeaderTemplates: vi.fn(async () => []),
    createHeaderTemplate: vi.fn(async () => null),
    updateHeaderTemplateMappings: vi.fn(async ({ id, mappings }) => ({ id, createdAt: "2026-07-21T08:00:00.000Z", createdBy: "tester", fileName: "template.xlsx", filePath: "C:\\templates\\template.xlsx", mappings })),
    deleteHeaderTemplate: vi.fn(async () => undefined),
    appendRuntimeLogs: vi.fn(async () => undefined),
    exportRuntimeLog: vi.fn(async () => null),
    openPath: vi.fn(async () => ""),
    selectDirectory: vi.fn(async (purpose) => purpose === "input" ? "C:\\input-selected" : "C:\\output-selected"),
    selectExcelFile: vi.fn(async () => null),
    selectConfig: vi.fn(async () => "C:\\config-selected.json"),
    listExcelFiles: vi.fn(async () => ({ files: [], skippedTemporary: 0, skippedUnsupported: 0, skippedOutput: 0 })),
    readExcelPreviewFile: vi.fn(async () => ({ bytes: new Uint8Array(), size: 0, modifiedAt: 0 })),
    getPathForFile: vi.fn((file: File) => "C:\\orders\\" + file.name),
    analyzePriceFiles: vi.fn(async () => undefined),
    validatePriceMapping: vi.fn(async () => undefined),
    runPriceCheck: vi.fn(async () => undefined),
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
        sheets: request.candidates.map((candidate) => ({
          name: candidate.name,
          roles: candidate.roles,
          rows: candidate.roles.includes("order")
            ? [["订单号", "平台订单号", "备用SKU", "国家", "英文国家", "中文国家", "物流", "SKU", "数量", "价格"], [candidate.name + "-数据", "P-1", "OLD-1", "US", "United States", "美国", "", "GOOD-1", "1", "9.5"]]
            : [["SKU", "Country", "1", "2", "3"], [candidate.name === "核价" ? "GOOD-1" : candidate.name + "-数据", "United States", "9.5", "9", "8.5"]],
          startRow: 0,
          startColumn: 0,
          rowCount: 2,
          columnCount: candidate.roles.includes("order") ? 10 : 5,
          displayedRowCount: 2,
          displayedColumnCount: candidate.roles.includes("order") ? 10 : 5,
          truncatedRows: false,
          truncatedColumns: false,
        })),
      },
    };
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ExcelPreviewWorkerResponse>));
  }
}

describe("AutoPricingTool cyber workstation", () => {
  beforeEach(() => {
    useUIStore.setState({ activePage: "workbench", activeTab: "pending", theme: "light", sidebarCollapsed: false });
    FakeExcelPreviewWorker.instances = [];
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
    expect(headers[1]).toHaveStyle({ left: "180px", position: "sticky" });

    const importModeResizer = screen.getByRole("separator", { name: "调整 导入方式 列宽" });
    fireEvent.mouseDown(importModeResizer, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 340 });
    fireEvent.mouseUp(document);
    await waitFor(() => expect(headers[1]).toHaveStyle({ left: "220px" }));

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
    expect(screen.queryByLabelText("自动处理流程")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("快捷操作")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("文件状态统计")).not.toBeInTheDocument();
    expect(screen.queryByText("原始 Excel 不会被覆盖")).not.toBeInTheDocument();
    const importSwitch = screen.getByRole("switch", { name: "导入模式：单文件" });
    expect(importSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(document.querySelector(".cyber-dropzone")!);
    expect(api.selectExcelFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    await waitFor(() => expect(api.selectExcelFile).toHaveBeenCalledTimes(1));

    dropFiles([
      new File(["xlsx"], "one.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      new File(["xlsx"], "two.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    ]);
    expect(await screen.findByText("单文件模式一次只能导入 1 个 Excel 文件")).toBeInTheDocument();

    await act(async () => { fireEvent.click(importSwitch); });
    expect(screen.getByRole("switch", { name: "导入模式：文件夹" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("拖拽文件夹到此处")).toBeInTheDocument();

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

  it("imports a workbook selected through the native file dialog", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.selectExcelFile).mockResolvedValue("C:\\orders\\2ZAH order 02-JUN.xlsx");
    installAPI(api);
    render(<App />);
    openFileProcessing();

    fireEvent.doubleClick(document.querySelector(".cyber-dropzone")!);
    expect(await screen.findByText("2ZAH order 02-JUN.xlsx")).toBeInTheDocument();
    expect(screen.getByText("已导入 1 个文件")).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "重置任务" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "重置任务" })).toBeEnabled();
    expect(screen.getByLabelText("文件状态统计").querySelectorAll("button")).toHaveLength(4);

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

  it("keeps a completed batch locked until reset", async () => {
    const api = createDesktopAPI();
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
    expect(screen.getByRole("button", { name: "重置任务" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重置任务" }));
    await waitFor(() => expect(screen.getByText("拖拽单个 Excel 文件到此处")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByLabelText("批次处理进度")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("文件状态统计")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "重置任务" }));
    await waitFor(() => expect(screen.queryByText("before-reset.xlsx")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "文件列表 （0）" })).toBeInTheDocument();
    expect(api.setRuntimeConfig).not.toHaveBeenCalled();

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

  it("navigates placeholder pages and opens logs in a drawer", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "文件处理" }));
    expect(screen.getByRole("heading", { name: "文件处理" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    expect(screen.getByRole("heading", { name: "配置中心" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "模板管理" }));
    expect(screen.getByRole("heading", { name: "模板管理" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "创建时间" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "创建人" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "模板文件" })).toBeInTheDocument();
    await waitFor(() => expect(api.listHeaderTemplates).toHaveBeenCalledTimes(1));

    for (const label of ["规则管理", "数据统计"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(screen.getByRole("heading", { name: "正在装修中" })).toBeInTheDocument();
      expect(screen.getByText(label, { selector: ".coming-soon-eyebrow" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "返回工作台" })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.getByRole("button", { name: "工作台" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "日志中心" }));
    expect(screen.getByRole("dialog", { name: "运行日志" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭日志抽屉" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "运行日志" })).not.toBeInTheDocument());
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
    expect(await screen.findByRole("heading", { name: "配置中心" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "配置中心" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择输入目录" }));
    await waitFor(() => {
      expect(api.selectDirectory).toHaveBeenCalledWith("input", false);
      expect(screen.getByRole("textbox", { name: "输入目录" })).toHaveValue("C:\\input-selected");
    });

    fireEvent.click(screen.getByRole("button", { name: "选择输出目录" }));
    await waitFor(() => {
      expect(api.selectDirectory).toHaveBeenCalledWith("output", false);
      expect(screen.getByRole("textbox", { name: "输出目录" })).toHaveValue("C:\\output-selected");
    });
    expect(api.saveConfigDocument).not.toHaveBeenCalled();
  });

  it("runs pricing after analysis completes", async () => {
    const api = createDesktopAPI();
    api.getRuntimeConfig = vi.fn(async () => ({ recent_output_dir: "C:\\output", recent_config_path: "C:\\config.json", auto_reveal_manual_result: true }));
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
    await act(async () => {
      api.emit({ type: "price-progress", phase: "run", current: 1, total: 1, path: "C:\\orders\\order.xlsx" });
      api.emit({ type: "price-progress", phase: "rows", current: 1, total: 14, path: "C:\\orders\\order.xlsx" });
      api.emit({ type: "price-file-result", path: "C:\\orders\\order.xlsx", status: "completed", totalRows: 14, matchedRows: 14, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ totalRows: 14, matchedRows: 14, exceptionRows: 0 }] });
    });
    expect(screen.getByRole("progressbar", { name: "批次处理完成 100%" })).toHaveAttribute("aria-valuenow", "100");
    expect(useUIStore.getState().activeTab).toBe("pending");
    expect(screen.getByText(/1\/1 个文件/)).toBeInTheDocument();
    expect(screen.queryByText(/1\/14 个文件/)).not.toBeInTheDocument();
  });

  it("asks for and persists an output directory before importing a dropped workbook", async () => {
    const api = createDesktopAPI();
    api.getRuntimeConfig = vi.fn(async () => ({ recent_config_path: "C:\\config.json" }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    await waitFor(() => expect(api.getRuntimeConfig).toHaveBeenCalled());
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
    api.getRuntimeConfig = vi.fn(async () => ({ recent_config_path: "C:\\config.json" }));
    vi.mocked(api.selectDirectory).mockResolvedValue(null);
    installAPI(api);
    render(<App />);
    openFileProcessing();
    await waitFor(() => expect(api.getRuntimeConfig).toHaveBeenCalled());
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
    api.getRuntimeConfig = vi.fn(async () => ({ recent_output_dir: "C:\\output", recent_config_path: "C:\\config.json", auto_reveal_manual_result: true }));
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
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\other.xlsx", status: "completed", totalRows: 8, matchedRows: 8, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ totalRows: 8, matchedRows: 8, exceptionRows: 0 }] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "完成2" })).toHaveClass("is-active"));
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
    await act(async () => {
      api.emit({ type: "price-file-result", path: "C:\\orders\\manual.xlsx", status: "completed", totalRows: 7, matchedRows: 7, exceptionRows: 0 });
      api.emit({ type: "price-done", mode: "run", stopped: false, files: [{ totalRows: 7, matchedRows: 7, exceptionRows: 0 }] });
    });
    await waitFor(() => expect(useUIStore.getState().activeTab).toBe("confirm"));
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
    expect(screen.getAllByText("候选差距不足")).toHaveLength(2);
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
    analysis.pricingSheetCandidates.push({ ...analysis.pricingSheetCandidates[0], sheetName: "报价二", score: 80 });
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));

    const dialog = await screen.findByRole("dialog", { name: "文件处理详情" });
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
    expect(FakeExcelPreviewWorker.instances[0].request?.candidates.map((candidate) => candidate.name)).toEqual(["订单", "核价", "报价二"]);
    expect(screen.getByText("订单 90.0 分")).toBeInTheDocument();
    expect(screen.getByText("核价 90.0 分")).toBeInTheDocument();
    expect(screen.getByText("核价 80.0 分")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const previewSearch = screen.getByRole("searchbox", { name: "搜索表格数据" });
    await waitFor(() => expect(previewSearch).toHaveFocus());
    expect(previewSearch).toHaveAttribute("size", "18");
    fireEvent.change(previewSearch, { target: { value: "GOOD-1, US | United States | 美国" } });
    expect(previewSearch).toHaveAttribute("size", "32");
    fireEvent.change(previewSearch, { target: { value: "订单" } });
    await waitFor(() => expect(screen.getByText("1/2")).toBeInTheDocument());
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("订单号");
    const previewScroll = dialog.querySelector(".excel-preview-scroll") as HTMLDivElement;
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
    fireEvent.change(jointSearch, { target: { value: "订单, P-1" } });
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(dialog.querySelectorAll(".excel-preview-row.is-search-matched-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "加载全部数据" }));
    await waitFor(() => expect(FakeExcelPreviewWorker.instances).toHaveLength(2));
    expect(FakeExcelPreviewWorker.instances[1].request).toEqual(expect.objectContaining({
      loadAll: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({ name: "订单" }),
        expect.objectContaining({ name: "核价" }),
      ]),
    }));
    expect(FakeExcelPreviewWorker.instances[1].request?.candidates.map((candidate) => candidate.name)).not.toContain("报价二");
    expect(await screen.findByText("已加载全部")).toBeInTheDocument();
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
    expect(await screen.findByText("GOOD-1")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整 A 列宽" })).toHaveAttribute("aria-valuenow", "120");
    fireEvent.click(screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }));
    expect(await screen.findByText("订单-数据")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整 C 列宽" })).toHaveAttribute("aria-valuenow", "192");
    expect(previewColumnOrder().slice(0, 4)).toEqual(["C", "A", "B", "D"]);
    fireEvent.click(screen.getByRole("button", { name: "取消冻结 C 列" }));
    expect(previewColumnOrder().slice(0, 4)).toEqual(["A", "B", "C", "D"]);
    const orderDataRowNumber = Array.from(dialog.querySelectorAll(".excel-preview-rows .excel-preview-row-number")).find((element) => element.textContent === "2");
    expect(orderDataRowNumber).toBeDefined();
    fireEvent.doubleClick(orderDataRowNumber!);
    const automaticSearch = await screen.findByRole("searchbox", { name: "搜索表格数据" });
    expect(automaticSearch).toHaveValue("GOOD-1, US | United States | 美国");
    expect(screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }).closest("button")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("GOOD-1")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(dialog.querySelector(".excel-preview-row.is-search-matched-row")).toHaveTextContent("GOOD-1");
    expect(dialog.querySelector(".excel-preview-rows .is-search-match")).toHaveTextContent("9.5");
    fireEvent.keyDown(automaticSearch, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("searchbox", { name: "搜索表格数据" })).not.toBeInTheDocument();
    const pricingSheetSelect = screen.getAllByLabelText("核价 Sheet").find((element) => element.tagName === "SELECT");
    expect(pricingSheetSelect).toBeDefined();
    fireEvent.change(pricingSheetSelect!, { target: { value: "报价二" } });
    expect(screen.getByText("报价二", { selector: ".excel-preview-tabs button strong" }).closest("button")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("报价二-数据")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭文件详情" }));
    await waitFor(() => expect(FakeExcelPreviewWorker.instances[0].terminate).toHaveBeenCalledTimes(1));
  }, 15_000);

  it("highlights mapped SKU columns and revalidates manual field changes", async () => {
    vi.stubGlobal("Worker", FakeExcelPreviewWorker);
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
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("订单-数据");

    expect(screen.queryByLabelText("平台订单号")).not.toBeInTheDocument();
    const orderNumberSelect = screen.getByLabelText("订单号");
    await waitFor(() => expect((orderNumberSelect as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(orderNumberSelect, { target: { value: "2" } });
    await waitFor(() => expect(vi.mocked(api.validatePriceMapping).mock.calls.some(([payload]) => (
      payload.mapping.businessOrderNumberColumn === 2
    ))).toBe(true));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).toHaveTextContent("2");
    fireEvent.click(screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("订单", { selector: ".excel-preview-tabs button strong" }));
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).toHaveTextContent("2");
    expect(document.querySelectorAll(".excel-preview-header .is-sku-qty-column").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".excel-preview-header .is-price-column").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("冻结表头，第 1 行")).toHaveTextContent("订单号");
    expect(screen.getByLabelText("字段颜色说明")).toHaveTextContent("SKU/数量 1价格字段常规匹配字段");
    expect(screen.queryByText(/已显示全部数据范围/)).not.toBeInTheDocument();
    expect(document.querySelector(".cyber-footer")).not.toBeInTheDocument();
    const skuSelect = screen.getByLabelText("SKU 1");
    await waitFor(() => expect((skuSelect as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByText("SKU 1", { selector: ".mapping-field > span" }));
    await waitFor(() => expect(skuSelect.closest(".mapping-field")).toHaveClass("is-active"));
    expect(screen.getByText("正在选择“SKU 1”")).toBeInTheDocument();
    expect(screen.getByText("点击目标列中的任意单元格")).toBeInTheDocument();
    const skuDataCell = screen.getByText("OLD-1", { selector: ".excel-preview-row > span" });
    fireEvent.mouseEnter(skuDataCell);
    expect(document.querySelectorAll(".is-hover-column").length).toBeGreaterThan(1);
    fireEvent.click(skuDataCell);
    expect(screen.getByText("正在选择“数量 1”")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("正在选择“数量 1”")).not.toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "确认并处理此文件" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(api.validatePriceMapping).toHaveBeenCalled());
    let request = vi.mocked(api.validatePriceMapping).mock.calls.at(-1)![0];
    if (request.mapping.skuQtyPairs[0].skuColumn !== 3) {
      await act(async () => api.emit({ type: "price-validation", inputPath: request.inputPath, requestVersion: request.requestVersion, evaluatedRows: 1, matchedRows: 0, coverage: 0, errors: [], warnings: [] }));
      await waitFor(() => expect(vi.mocked(api.validatePriceMapping).mock.calls.some(([payload]) => payload.mapping.skuQtyPairs[0].skuColumn === 3)).toBe(true));
      request = vi.mocked(api.validatePriceMapping).mock.calls.filter(([payload]) => payload.mapping.skuQtyPairs[0].skuColumn === 3).at(-1)![0];
    }
    expect(request.mapping.skuQtyPairs[0].skuColumn).toBe(3);

    await act(async () => api.emit({ type: "price-validation", inputPath: request.inputPath, requestVersion: request.requestVersion, evaluatedRows: 1, matchedRows: 1, coverage: 1, matchedOrderRows: [2], errors: [], warnings: [] }));
    expect(await screen.findByText(/试算 1\/1 行/)).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    expect(document.querySelector(".excel-preview-row-number.is-matched-row")).toHaveTextContent("2");
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
  }, 10_000);

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
      { skuColumn: 8, qtyColumn: 9, skuHeader: "SKU 1", qtyHeader: "Qty 1" },
      { skuColumn: 3, qtyColumn: 10, skuHeader: "SKU 2", qtyHeader: "Qty 2" },
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
    expect(column("J")).toHaveClass("is-sku-qty-column");
    expect(shade("H")).toBe(shade("I"));
    expect(shade("C")).toBe(shade("J"));
    expect(shade("H")).not.toBe(shade("C"));
    expect(screen.getByLabelText("字段颜色说明")).toHaveTextContent("SKU/数量 1SKU/数量 2");
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
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const retry = await screen.findByRole("button", { name: "重新分析此文件" });
    fireEvent.click(retry);
    await waitFor(() => expect(api.analyzePriceFiles).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"] })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "文件处理详情" })).not.toBeInTheDocument());
  });

  it("pauses, resumes, stops, and exposes four status tabs", async () => {
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
    expect(document.querySelectorAll(".cyber-tabs button")).toHaveLength(4);
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
    expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument();
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

  it("synchronizes grouped config fields with JSON while preserving unknown fields", async () => {
    const api = createDesktopAPI();
    const content = JSON.stringify({ performance: { processing_workers: 0 }, runtime: {}, pricing: {}, extension_field: { keep: true } }, null, 2) + "\n";
    vi.mocked(api.getConfigDocument).mockResolvedValue({ path: "C:\\config.json", content, modifiedAt: 10, isDefault: false });
    installAPI(api);
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const workers = await screen.findByRole("spinbutton", { name: "处理线程数" });
    expect(await screen.findByText("最大线程数：8")).toBeInTheDocument();
    expect(workers).toHaveAttribute("max", "7");
    fireEvent.change(workers, { target: { value: "99" } });
    expect((screen.getByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement).value).toContain('"processing_workers": 7');
    fireEvent.change(workers, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "模板匹配优先" }));
    const revealSwitch = screen.getByRole("switch", { name: "手动处理后定位结果" });
    expect(revealSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(revealSwitch);
    expect(revealSwitch).toHaveAttribute("aria-checked", "true");
    const source = screen.getByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement;
    expect(source.value).toContain('"extension_field"');
    expect(source.value).toContain('"processing_workers": 4');
    expect(source.value).toContain('"template_match_priority": true');
    expect(source.value).toContain('"auto_reveal_manual_result": true');
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveConfigDocument).toHaveBeenCalledWith(expect.objectContaining({
      path: "C:\\config.json",
      expectedModifiedAt: 10,
      content: expect.stringContaining('"extension_field"'),
    })));
  });

  it("formats valid JSON source without changing its data", async () => {
    const api = createDesktopAPI();
    vi.mocked(api.getConfigDocument).mockResolvedValue({ path: "C:\\config.json", content: "{}\n", modifiedAt: 10, isDefault: false });
    installAPI(api);
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const source = await screen.findByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: '{"runtime":{},"extension_field":{"keep":true}}' } });
    fireEvent.click(screen.getByRole("button", { name: "格式化" }));
    expect(source.value).toBe('{\n  "runtime": {},\n  "extension_field": {\n    "keep": true\n  }\n}\n');
    expect(screen.getByText("7 行")).toBeInTheDocument();
  });
});
