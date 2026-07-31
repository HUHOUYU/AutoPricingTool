import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProcessingCommands } from "@/features/workbench/hooks/use-processing-commands";
import { useProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import type {
  DesktopAPI,
  PriceAnalysisFile,
  PriceCheckMapping,
} from "@shared/desktop-api";

const inputPath = "C:\\orders\\a.xlsx";
const originalDesktopAPI = window.desktopAPI;

afterEach(() => {
  window.desktopAPI = originalDesktopAPI;
});

function renderProcessingCommands() {
  return renderHook(() => {
    const session = useProcessorSession();
    const commands = useProcessingCommands({
      session,
      actionFiles: [inputPath],
      files: [inputPath],
      configPath: "C:\\config.json",
      outputDirectory: "",
      batchName: "测试批次",
      batchNote: "",
      ensureOutputDirectory: async () => "C:\\output",
      appendLog: vi.fn(),
      setActiveTab: vi.fn(),
      onClearAnalysisView: vi.fn(),
    });
    return { session, ...commands };
  });
}

describe("useProcessingCommands", () => {
  it("starts analysis through the session and forwards the active config", async () => {
    const analyzePriceFiles = vi.fn(async () => undefined);
    window.desktopAPI = {
      analyzePriceFiles,
    } as unknown as DesktopAPI;
    const { result } = renderProcessingCommands();

    await act(async () => {
      await result.current.analyzeFiles();
    });

    expect(analyzePriceFiles).toHaveBeenCalledWith({
      files: [inputPath],
      configPath: "C:\\config.json",
    });
    expect(result.current.session.batchStarted).toBe(true);
    expect(result.current.session.isAnalyzing).toBe(true);
  });

  it("runs an eligible analyzed file and stores the returned batch id", async () => {
    const runPriceCheck = vi.fn(async () => ({ batchId: "batch-1" }));
    window.desktopAPI = {
      runPriceCheck,
    } as unknown as DesktopAPI;
    const { result } = renderProcessingCommands();
    const analysis = {
      inputPath,
      fileName: "a.xlsx",
      orderSheetCandidates: [{ sheetName: "Orders", headerRow: 1, score: 1, notes: [] }],
      pricingSheetCandidates: [{ sheetName: "Prices", headerRow: 1, score: 1, notes: [] }],
      coverage: 1,
      requiresConfirmation: false,
      automationDecision: {
        status: "eligible",
        reasons: [],
        evaluatedRows: 1,
        matchedRows: 1,
        coverage: 1,
      },
      issues: [],
      unmatchedRows: [],
    } as PriceAnalysisFile;

    act(() => {
      result.current.session.analysesRef.current[inputPath] = analysis;
      result.current.session.mappingsRef.current[inputPath] = {} as PriceCheckMapping;
    });
    await act(async () => {
      await result.current.runPricing();
    });

    expect(runPriceCheck).toHaveBeenCalledWith(expect.objectContaining({
      files: [inputPath],
      outputDir: "C:\\output",
      batchName: "测试批次",
      executionType: "automatic",
    }));
    expect(result.current.session.batchId).toBe("batch-1");
    expect(result.current.session.isRunning).toBe(true);
  });
});
