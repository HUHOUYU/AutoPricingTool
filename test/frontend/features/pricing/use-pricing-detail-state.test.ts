import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  PriceAnalysisFile,
  PriceMappingValidation,
  PricePreviewWritebackRow,
} from "@shared/desktop-api";
import { usePricingDetailState } from "@/features/pricing/hooks/use-pricing-detail-state";

const detailPath = "C:\\batch\\order.xlsx";

function createAnalysis(): PriceAnalysisFile {
  return {
    inputPath: detailPath,
    fileName: "order.xlsx",
    orderSheetCandidates: [{ sheetName: "订单", headerRow: 1, score: 95, notes: [] }],
    pricingSheetCandidates: [{ sheetName: "核价", headerRow: 2, score: 90, notes: [] }],
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
  };
}

function createValidation(writebackRows: PricePreviewWritebackRow[]): PriceMappingValidation {
  return {
    inputPath: detailPath,
    requestVersion: 1,
    evaluatedRows: 1,
    matchedRows: 1,
    coverage: 1,
    writebackRows,
    errors: [],
    warnings: [],
  };
}

describe("usePricingDetailState", () => {
  it("builds preview candidates and selects the first available sheet", async () => {
    const { result } = renderHook(() => usePricingDetailState({
      analyses: { [detailPath]: createAnalysis() },
      detailPath,
      mappings: {},
      mappingValidations: {},
      matchedOrderRowsBySheet: {},
      results: {},
      writebackEdits: {},
    }));

    expect(result.current.previewCandidates.map((candidate) => candidate.name)).toEqual(["订单", "核价"]);
    await waitFor(() => expect(result.current.previewSheetName).toBe("订单"));
    await waitFor(() => expect(result.current.contentReady).toBe(true));
  });

  it("overlays manual writeback edits on validated rows", async () => {
    const baseRow: PricePreviewWritebackRow = {
      sourceRow: 8,
      quantity: 1,
      pricingPrice: 10,
    };
    const editedRow: PricePreviewWritebackRow = {
      ...baseRow,
      quantity: 2,
      pricingPrice: 18,
    };
    const { result } = renderHook(() => usePricingDetailState({
      analyses: { [detailPath]: createAnalysis() },
      detailPath,
      mappings: {},
      mappingValidations: {
        [detailPath]: { status: "ready", result: createValidation([baseRow]) },
      },
      matchedOrderRowsBySheet: {},
      results: {},
      writebackEdits: { [detailPath]: [editedRow] },
    }));

    await waitFor(() => expect(result.current.contentReady).toBe(true));
    expect(result.current.writebackRows).toEqual([editedRow]);

    act(() => result.current.openUnmatchedDetails("未匹配", 8));
    expect(result.current.issueDetailsRequest).toEqual({
      kind: "unmatched",
      sourceRow: 8,
      summary: "未匹配",
    });
  });
});
