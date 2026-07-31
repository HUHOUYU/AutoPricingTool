import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMappingDetailActions } from "@/features/pricing/hooks/use-mapping-detail-actions";
import { useProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import type { DesktopAPI, PriceCheckMapping } from "@shared/desktop-api";

const inputPath = "C:\\orders\\a.xlsx";
const originalDesktopAPI = window.desktopAPI;
const mapping: PriceCheckMapping = {
  orderSheet: "Orders",
  orderHeaderRow: 1,
  skuQtyPairs: [],
  pricingSheet: "Prices",
  pricingHeaderRow: 1,
  pricingSkuColumn: 1,
  pricingCountryColumn: 2,
  quantityTierColumns: [],
};

afterEach(() => {
  window.desktopAPI = originalDesktopAPI;
});

describe("useMappingDetailActions", () => {
  it("recalculates a row only for quantity edits and versions the request", () => {
    const recalculatePriceRow = vi.fn(async () => undefined);
    window.desktopAPI = {
      recalculatePriceRow,
    } as unknown as DesktopAPI;
    const { result } = renderHook(() => {
      const session = useProcessorSession();
      return useMappingDetailActions({
        session,
        configPath: "C:\\config.json",
        detailPath: inputPath,
        detailMapping: mapping,
        activeMappingTarget: null,
        detailPreviewSheetName: "Orders",
        setActiveMappingTarget: vi.fn(),
        setDetailPreviewSheetName: vi.fn(),
        commitMapping: vi.fn(),
      });
    });

    act(() => {
      result.current.editDetailWritebackRow({ sourceRow: 3, quantity: 4 }, "quantity");
    });

    expect(recalculatePriceRow).toHaveBeenCalledWith({
      inputPath,
      mapping,
      requestVersion: 1,
      rowEdit: { sourceRow: 3, quantity: 4 },
      cellEdits: [],
      configPath: "C:\\config.json",
    });
  });
});
