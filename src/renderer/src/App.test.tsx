import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAPI, PriceAnalysisFile, ProcessorEvent } from "../../preload";
import { App } from "./App";

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

describe("AutoPricingTool cyber workstation", () => {
  it("imports a dropped workbook and starts analysis", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

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

    for (const label of ["文件处理", "配置中心", "规则管理", "模板管理", "数据统计"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(screen.getByRole("heading", { name: "正在装修中" })).toBeInTheDocument();
      expect(screen.getByText(label, { selector: ".coming-soon-eyebrow" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "返回工作台" })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.getByRole("button", { name: "工作台" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "文件处理" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "日志中心" }));
    expect(screen.getByRole("dialog", { name: "运行日志" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "文件处理" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭日志抽屉" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "运行日志" })).not.toBeInTheDocument());
  });

  it("paginates a 5000 file workload", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
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

    fireEvent.click(screen.getByRole("button", { name: "选择配置文件" }));
    await waitFor(() => expect(api.selectConfig).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(document.querySelector(".cyber-app")).toHaveClass("is-sidebar-collapsed");
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(document.querySelector(".cyber-app")).not.toHaveClass("is-sidebar-collapsed");
  });

  it("runs pricing after analysis completes", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
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
});
