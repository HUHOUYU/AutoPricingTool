import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopAPI, PriceAnalysisFile, ProcessorEvent } from "../../preload";
import type { ExcelPreviewWorkerRequest, ExcelPreviewWorkerResponse } from "./lib/excel-preview";
import { App } from "./App";
import { useUIStore } from "./stores/ui-store";

function createAnalysis(path: string): PriceAnalysisFile {
  const mapping = {
    orderSheet: "订单",
    orderHeaderRow: 1,
    businessOrderNumberColumn: 1,
    platformOrderNumberColumn: 2,
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
      platformOrderNumberColumn: 2,
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
    getRuntimeConfig: vi.fn(async () => ({ recent_output_dir: "C:\\output", recent_config_path: "C:\\config.json" })),
    getDefaultPriceOutputDir: vi.fn(async () => "C:\\Program\\核价结果"),
    setRuntimeConfig: vi.fn(async (config) => config),
    getConfigDocument: vi.fn(async () => ({ path: "C:\\config.json", content: "{}\n", modifiedAt: 1, isDefault: false })),
    validateConfigDocument: vi.fn(async () => ({ valid: true, issues: [] })),
    saveConfigDocument: vi.fn(async ({ path, content }) => ({ path, content, modifiedAt: 2, isDefault: false })),
    saveConfigDocumentAs: vi.fn(async (content) => ({ path: "C:\\saved.json", content, modifiedAt: 2, isDefault: false })),
    restoreDefaultConfig: vi.fn(async () => ({ path: "C:\\config.json", content: "{}\n", modifiedAt: 3, isDefault: false })),
    getTaskHistorySummary: vi.fn(async () => ({ today: { files: 0, tasks: 0, matchRate: 0, exceptions: 0 }, trend: [], recent: [] })),
    appendRuntimeLogs: vi.fn(async () => undefined),
    exportRuntimeLog: vi.fn(async () => null),
    openPath: vi.fn(async () => ""),
    selectDirectory: vi.fn(async (purpose) => purpose === "input" ? "C:\\input-selected" : "C:\\output-selected"),
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
  fireEvent.drop(document.querySelector(".cyber-dropzone")!, { dataTransfer: { files, types: ["Files"] } });
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
            : [["SKU", "Country", "1", "2", "3"], [candidate.name + "-数据", "US", "9.5", "9", "8.5"]],
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

  afterEach(() => vi.unstubAllGlobals());

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

  it("resizes data and action columns by dragging visible header handles", () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();

    const resizer = screen.getByRole("separator", { name: "调整 原始文件名 列宽" });
    const header = resizer.closest("th")!;
    const initialWidth = Number.parseFloat(header.style.width);
    fireEvent.mouseDown(resizer, { clientX: 320 });
    fireEvent.mouseMove(document, { clientX: 390 });
    fireEvent.mouseUp(document);
    expect(Number.parseFloat(header.style.width)).toBeGreaterThan(initialWidth);
    const table = header.closest("table")!;
    expect(table.querySelectorAll("col")[2]).toHaveStyle({ width: header.style.width });

    const actionResizer = screen.getByRole("separator", { name: "调整 操作 列宽" });
    const actionHeader = actionResizer.closest("th")!;
    const initialActionWidth = Number.parseFloat(actionHeader.style.width);
    fireEvent.mouseDown(actionResizer, { clientX: 900 });
    fireEvent.mouseMove(document, { clientX: 940 });
    fireEvent.mouseUp(document);
    expect(Number.parseFloat(actionHeader.style.width)).toBeGreaterThan(initialActionWidth);
    expect(table.querySelector("col:last-child")).toHaveStyle({ width: actionHeader.style.width });
    expect(table.style.getPropertyValue("--cyber-table-width")).toMatch(/px$/);
  });

  it("switches between validated single-file and folder import modes", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    const { container } = render(<App />);
    openFileProcessing();

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(screen.getByLabelText("自动处理流程").parentElement?.tagName).toBe("HEADER");
    expect(screen.queryByText("原始 Excel 不会被覆盖")).not.toBeInTheDocument();
    const importSwitch = screen.getByRole("switch", { name: "导入模式：单文件" });
    expect(importSwitch).toHaveAttribute("aria-checked", "false");
    const inputClick = vi.spyOn(fileInput!, "click");
    fireEvent.click(document.querySelector(".cyber-dropzone")!);
    expect(inputClick).toHaveBeenCalledTimes(1);

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

    fireEvent.click(document.querySelector(".cyber-dropzone")!);
    await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledWith("input"));
  });

  it("responds to unavailable task actions", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    openFileProcessing();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停任务" }));
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(await screen.findByText("请先导入 Excel 文件")).toBeInTheDocument();
    expect(await screen.findByText("当前没有运行中的任务")).toBeInTheDocument();
    expect(await screen.findByText("当前没有可停止的任务")).toBeInTheDocument();
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

    for (const label of ["规则管理", "模板管理", "数据统计"]) {
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
    fireEvent.click(document.querySelector(".cyber-dropzone")!);

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
    expect(document.querySelector(".cyber-workbench-actions")?.querySelectorAll("button")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "扫描配置中的输入目录" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(document.querySelector(".cyber-rail-actions")?.querySelectorAll("button")).toHaveLength(4);
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
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
  });

  it("uses the application sibling result folder when no output directory is selected", async () => {
    const api = createDesktopAPI();
    api.getRuntimeConfig = vi.fn(async () => ({ recent_config_path: "C:\\config.json" }));
    installAPI(api);
    render(<App />);
    openFileProcessing();
    await waitFor(() => expect(api.getRuntimeConfig).toHaveBeenCalled());
    dropFiles([new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })]);
    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await act(async () => {
      api.emit({ type: "price-analysis", file: createAnalysis("C:\\orders\\order.xlsx") });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({ outputDir: "C:\\Program\\核价结果" })));
    expect(api.setRuntimeConfig).not.toHaveBeenCalled();
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
    fireEvent.click(document.querySelector(".cyber-dropzone")!);
    await waitFor(() => expect(api.listExcelFiles).toHaveBeenCalledWith("C:\\input-selected"));
    expect(await screen.findByText("a.xlsx")).toBeInTheDocument();
    expect(screen.getByText("b.xls")).toBeInTheDocument();
    expect(screen.getByText("2 个文件")).toBeInTheDocument();
  });

  it("keeps risky files for confirmation and continues only the confirmed file", async () => {
    const api = createDesktopAPI();
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
    fireEvent.click(document.querySelector(".cyber-dropzone")!);
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
    analysis.automationDecision = { ...analysis.automationDecision, status: "confirm", reasons: ["候选差距不足"] };
    await act(async () => {
      api.emit({ type: "price-analysis", file: analysis });
      api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情" }));
    expect(await screen.findByRole("dialog", { name: "文件处理详情" })).toBeInTheDocument();
    expect(screen.getAllByText("候选差距不足")).toHaveLength(2);
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
    const drawerContent = dialog.querySelector(".issue-drawer-content");
    expect(drawerContent?.firstElementChild).toHaveClass("excel-preview-panel");
    expect(drawerContent?.lastElementChild).toHaveClass("issue-detail-column");
    const separator = screen.getByRole("separator", { name: "调整详情抽屉宽度" });
    const initialWidth = Number.parseFloat(dialog.style.width);
    expect(initialWidth).toBe(Math.min(Math.round(window.innerWidth * 0.9), window.innerWidth - 72));
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(Number.parseFloat(dialog.style.width)).toBe(initialWidth + 24);
    fireEvent.pointerDown(separator, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 495 });
    expect(Number.parseFloat(dialog.style.width)).toBe(initialWidth + 29);

    expect(await screen.findByText("订单-数据")).toBeInTheDocument();
    expect(FakeExcelPreviewWorker.instances[0].request?.candidates.map((candidate) => candidate.name)).toEqual(["订单", "核价", "报价二"]);
    fireEvent.click(screen.getByText("核价", { selector: ".excel-preview-tabs button strong" }));
    expect(await screen.findByText("核价-数据")).toBeInTheDocument();
    const pricingSheetSelect = screen.getAllByLabelText("核价 Sheet").find((element) => element.tagName === "SELECT");
    expect(pricingSheetSelect).toBeDefined();
    fireEvent.change(pricingSheetSelect!, { target: { value: "报价二" } });
    expect(screen.getByText("报价二", { selector: ".excel-preview-tabs button strong" }).closest("button")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("报价二-数据")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭文件详情" }));
    await waitFor(() => expect(FakeExcelPreviewWorker.instances[0].terminate).toHaveBeenCalledTimes(1));
  });

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

    expect(document.querySelectorAll(".excel-preview-header .is-sku-column").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".excel-preview-header .is-price-column").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("冻结表头，第 1 行")).toHaveTextContent("订单号");
    expect(screen.getByLabelText("字段颜色说明")).toHaveTextContent("SKU 字段价格字段常规匹配字段");
    expect(screen.queryByText(/已显示全部数据范围/)).not.toBeInTheDocument();
    expect(document.querySelector(".cyber-footer")).not.toBeInTheDocument();
    const skuSelect = screen.getByLabelText("SKU 1");
    await waitFor(() => expect((skuSelect as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: /选择SKU 1/ }));
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

    await act(async () => api.emit({ type: "price-validation", inputPath: request.inputPath, requestVersion: request.requestVersion, evaluatedRows: 1, matchedRows: 1, coverage: 1, errors: [], warnings: [] }));
    expect(await screen.findByText(/试算 1\/1 行/)).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    await act(async () => api.emit({ type: "price-validation", inputPath: request.inputPath, requestVersion: 0, evaluatedRows: 1, matchedRows: 0, coverage: 0, errors: [], warnings: ["过期结果"] }));
    expect(screen.queryByText("过期结果")).not.toBeInTheDocument();
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
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
    expect(await screen.findByText("配置可用")).toBeInTheDocument();
  });

  it("synchronizes grouped config fields with JSON while preserving unknown fields", async () => {
    const api = createDesktopAPI();
    const content = JSON.stringify({ performance: { processing_workers: 0 }, runtime: {}, pricing: {}, extension_field: { keep: true } }, null, 2) + "\n";
    vi.mocked(api.getConfigDocument).mockResolvedValue({ path: "C:\\config.json", content, modifiedAt: 10, isDefault: false });
    installAPI(api);
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "配置中心" })[0]);
    const workers = await screen.findByRole("spinbutton", { name: "处理线程数" });
    fireEvent.change(workers, { target: { value: "4" } });
    const source = screen.getByRole("textbox", { name: "JSON 源码" }) as HTMLTextAreaElement;
    expect(source.value).toContain('"extension_field"');
    expect(source.value).toContain('"processing_workers": 4');
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveConfigDocument).toHaveBeenCalledWith(expect.objectContaining({
      path: "C:\\config.json",
      expectedModifiedAt: 10,
      content: expect.stringContaining('"extension_field"'),
    })));
  });
});
