import { describe, expect, it } from "vitest";
import type { PriceAnalysisFile } from "../../../../backend/electron/preload";
import { isAnalysisError, pickBestResultTab, statusForFile, tabForStatus } from "@/features/workbench/status";

function createAnalysis(status: "eligible" | "confirm" | "error" = "eligible"): PriceAnalysisFile {
  const candidate = { sheetName: "Sheet1", headerRow: 1, score: 1, notes: [] };
  return {
    inputPath: "C:\\input.xlsx",
    fileName: "input.xlsx",
    orderSheetCandidates: [candidate],
    pricingSheetCandidates: [candidate],
    coverage: 1,
    requiresConfirmation: status === "confirm",
    automationDecision: {
      status,
      reasons: [],
      evaluatedRows: 1,
      matchedRows: 1,
      coverage: 1,
    },
    issues: [],
  };
}

describe("workbench status", () => {
  it("maps processing statuses to tabs", () => {
    expect(tabForStatus("running")).toBe("pending");
    expect(tabForStatus("ready")).toBe("confirm");
    expect(tabForStatus("warning")).toBe("error");
    expect(tabForStatus("success")).toBe("success");
  });

  it("selects the highest-priority non-empty result tab", () => {
    expect(pickBestResultTab({ pending: 4, confirm: 2, error: 3, success: 1 })).toBe("confirm");
    expect(pickBestResultTab({ pending: 0, confirm: 0, error: 3, success: 1 })).toBe("error");
    expect(pickBestResultTab({ pending: 0, confirm: 0, error: 0, success: 0 })).toBeNull();
  });

  it("distinguishes analysis, running, warning, and confirmed results", () => {
    const analysis = createAnalysis("confirm");
    expect(statusForFile(analysis.inputPath, analysis, undefined, "", false, false)).toBe("ready");
    expect(statusForFile(analysis.inputPath, undefined, undefined, analysis.inputPath, true, false)).toBe("running");
    expect(statusForFile(analysis.inputPath, analysis, {
      path: analysis.inputPath,
      status: "completed",
      exceptionRows: 1,
      completedAt: "2026-07-30T00:00:00Z",
    }, "", false, false)).toBe("warning");
    expect(statusForFile(analysis.inputPath, analysis, {
      path: analysis.inputPath,
      status: "completed",
      exceptionRows: 1,
      completedAt: "2026-07-30T00:00:00Z",
    }, "", false, true)).toBe("success");
  });

  it("treats missing candidates and read failures as analysis errors", () => {
    expect(isAnalysisError({ ...createAnalysis(), orderSheetCandidates: [] })).toBe(true);
    expect(isAnalysisError({ ...createAnalysis(), issues: ["读取失败：文件损坏"] })).toBe(true);
  });
});
