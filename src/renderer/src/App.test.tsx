import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopAPI, PriceAnalysisFile, ProcessorEvent } from "../../preload";
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
    selectDirectory: vi.fn(async () => "C:\\output"),
    selectConfig: vi.fn(async () => "C:\\config-selected.json"),
    listExcelFiles: vi.fn(async () => []),
    getPathForFile: vi.fn((file: File) => "C:\\orders\\" + file.name),
    analyzePriceFiles: vi.fn(async () => undefined),
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

describe("AutoPricingTool cyber workstation", () => {
  beforeEach(() => {
    useUIStore.setState({ activePage: "workbench", activeTab: "pending", theme: "light", sidebarCollapsed: false });
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
    installAPI(api);
    render(<App />);
    openFileProcessing();
    const files = Array.from({ length: 5_000 }, (_, index) => new File(["x"], `file-${index + 1}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    dropFiles(files);

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
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(document.querySelector(".cyber-app")).toHaveClass("is-sidebar-collapsed");
    expect(document.querySelector(".cyber-rail-actions")?.querySelectorAll("button")).toHaveLength(4);
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 Excel" })).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("button", { name: "工作台" })).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("button", { name: "展开侧栏" })).toHaveAttribute("data-state", "closed");
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(document.querySelector(".cyber-app")).not.toHaveClass("is-sidebar-collapsed");
    expect(document.querySelector(".cyber-rail-actions")).not.toBeInTheDocument();
    expect(document.querySelector(".cyber-workbench-actions")).not.toBeInTheDocument();
    openFileProcessing();
    expect(document.querySelector(".cyber-workbench-actions")?.querySelectorAll("button")).toHaveLength(4);
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

    fireEvent.click(screen.getByRole("button", { name: "待确认1" }));
    expect(await screen.findByText("100.0%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(api.runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"], outputDir: "C:\\output" })));
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
