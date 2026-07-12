import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    orderSheetCandidates: [
      {
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
      },
    ],
    pricingSheetCandidates: [
      {
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
      },
    ],
    suggestedMapping: mapping,
    coverage: 1,
    requiresConfirmation: false,
    issues: [],
  };
}

function createDesktopAPI(): DesktopAPI & { emit: (event: ProcessorEvent) => void } {
  let listener: ((event: ProcessorEvent) => void) | null = null;
  const api: DesktopAPI & { emit: (event: ProcessorEvent) => void } = {
    getRuntimeConfig: vi.fn(async () => ({ recent_output_dir: "C:\\output", recent_config_path: "C:\\config.json" })),
    setRuntimeConfig: vi.fn(async (config) => config),
    appendRuntimeLogs: vi.fn(async () => undefined),
    exportRuntimeLog: vi.fn(async () => null),
    openPath: vi.fn(async () => ""),
    selectDirectory: vi.fn(async (purpose?: "input" | "output") => (purpose === "input" ? "C:\\folder" : "C:\\output")),
    selectConfig: vi.fn(async () => "C:\\config-selected.json"),
    listExcelFiles: vi.fn(async () => ["C:\\folder\\one.xlsx", "C:\\folder\\two.xlsx"]),
    getPathForFile: vi.fn((file: File) => "C:\\orders\\" + file.name),
    analyzePriceFiles: vi.fn(async () => undefined),
    runPriceCheck: vi.fn(async () => undefined),
    pauseProcessing: vi.fn(async () => undefined),
    resumeProcessing: vi.fn(async () => undefined),
    stopProcessing: vi.fn(async () => undefined),
    onProcessorEvent: vi.fn((callback: (event: ProcessorEvent) => void) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
    emit: (event) => listener?.(event),
  };
  return api;
}

function installAPI(api: DesktopAPI): void {
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: api });
}

describe("AutoPricingTool workflow", () => {
  it("accepts dropped Excel files, keeps only the drop zone action, and starts scanning", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    const file = new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.drop(document.querySelector(".drop-zone")!, { dataTransfer: { files: [file] } });

    expect(await screen.findByText("order.xlsx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择 Excel 文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择文件夹并自动核价" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "扫描" }));
    await waitFor(() => expect(api.analyzePriceFiles).toHaveBeenCalledWith(expect.objectContaining({ files: ["C:\\orders\\order.xlsx"] })));
    fireEvent.click(document.querySelector(".file-name-button")!);
    await waitFor(() => expect(api.openPath).toHaveBeenCalledWith("C:\\orders"));
  });

  it("selects a target folder and scans it from the left control rail", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "目标文件夹" }));
    await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledWith("input"));
    fireEvent.click(screen.getByRole("button", { name: "扫描" }));

    await waitFor(() => {
      expect(api.listExcelFiles).toHaveBeenCalledWith("C:\\folder");
      expect(api.analyzePriceFiles).toHaveBeenCalledWith(
        expect.objectContaining({ files: ["C:\\folder\\one.xlsx", "C:\\folder\\two.xlsx"] }),
      );
    });
    expect(api.runPriceCheck).not.toHaveBeenCalled();
    expect(await screen.findByText("one.xlsx")).toBeInTheDocument();
    expect(await screen.findByText("two.xlsx")).toBeInTheDocument();
  });

  it("renders one progress dot for every file up to the 5000-file limit", async () => {
    const api = createDesktopAPI();
    api.listExcelFiles = vi.fn(async () => Array.from({ length: 5_000 }, (_, index) => `C:\\folder\\file-${index + 1}.xlsx`));
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "目标文件夹" }));
    await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledWith("input"));
    fireEvent.click(screen.getByRole("button", { name: "扫描" }));

    expect(await screen.findByText("5000 个文件，当前显示 5000 个，已选 0 个")).toBeInTheDocument();
    expect(document.querySelectorAll(".progress-dot")).toHaveLength(5_000);
  }, 15_000);

  it("selects a config file and opens the current config file", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "选择配置文件" }));
    await waitFor(() => expect(api.selectConfig).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "当前配置文件" }));
    await waitFor(() => expect(api.openPath).toHaveBeenCalledWith("C:\\config-selected.json"));
  });

  it("shows a mapping and sends it to the pricing runner", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    const file = new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.drop(document.querySelector(".drop-zone")!, { dataTransfer: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "扫描" }));
    api.emit({ type: "price-analysis", file: createAnalysis("C:\\orders\\order.xlsx") });
    api.emit({ type: "price-done", mode: "analysis", stopped: false, files: [] });

    fireEvent.click(screen.getByRole("button", { name: /待确认/ }));
    expect(await screen.findByText("覆盖率 100.0%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "处理" }));
    await waitFor(() =>
      expect(api.runPriceCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          files: ["C:\\orders\\order.xlsx"],
          outputDir: "C:\\output",
          mappings: [expect.objectContaining({ inputPath: "C:\\orders\\order.xlsx" })],
        }),
      ),
    );
  });

  it("exposes exactly four tabs and resets the current task without deleting files", async () => {
    const api = createDesktopAPI();
    installAPI(api);
    render(<App />);
    const file = new File(["xlsx"], "order.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.drop(document.querySelector(".drop-zone")!, { dataTransfer: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "扫描" }));
    expect(screen.getAllByRole("button").filter((button) => ["待分析", "待确认", "异常", "完成"].some((label) => button.textContent?.includes(label)))).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "分析文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行核价" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    await waitFor(() => expect(api.stopProcessing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("order.xlsx")).not.toBeInTheDocument());
  });
});
