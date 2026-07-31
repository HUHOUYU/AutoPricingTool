import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProcessingAutoRun } from "@/features/workbench/hooks/use-processing-auto-run";
import { useProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import type { PriceAnalysisFile } from "@shared/desktop-api";

const inputPath = "C:\\orders\\a.xlsx";

describe("useProcessingAutoRun", () => {
  it("runs only eligible requested files after analysis completion", async () => {
    const runPricing = vi.fn(async () => undefined);
    const { result } = renderHook(() => {
      const session = useProcessorSession();
      useProcessingAutoRun({ session, files: [inputPath], runPricing });
      return session;
    });
    const analysis = {
      inputPath,
      fileName: "a.xlsx",
      orderSheetCandidates: [],
      pricingSheetCandidates: [],
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
    } as PriceAnalysisFile;

    act(() => {
      result.current.analysesRef.current[inputPath] = analysis;
      result.current.autoRunRequestedRef.current = true;
      result.current.autoRunTargetPathsRef.current = [inputPath];
      result.current.setAnalysisCompletedToken(1);
    });

    await waitFor(() => {
      expect(runPricing).toHaveBeenCalledWith([inputPath], "automatic");
    });
    expect(result.current.autoRunRequestedRef.current).toBe(false);
    expect(result.current.autoRunTargetPathsRef.current).toEqual([]);
  });
});
