import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMappingValidationActions } from "@/features/pricing/hooks/use-mapping-validation-actions";
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

describe("useMappingValidationActions", () => {
  it("commits mapping state and sends the debounced validation request", async () => {
    const validatePriceMapping = vi.fn(async () => undefined);
    window.desktopAPI = {
      validatePriceMapping,
    } as unknown as DesktopAPI;
    const { result } = renderHook(() => {
      const session = useProcessorSession();
      return {
        session,
        actions: useMappingValidationActions({ session, configPath: "C:\\config.json" }),
      };
    });

    act(() => {
      result.current.session.writebackEditsRef.current[inputPath] = [{
        sourceRow: 2,
        quantity: 1,
      }];
      result.current.session.cellEditsRef.current[inputPath] = [{
        sheetName: "Orders",
        row: 2,
        column: 1,
        value: "SKU-1",
        numeric: false,
      }];
      result.current.actions.commitMapping(inputPath, mapping);
    });

    expect(result.current.session.mappingsRef.current[inputPath]).toEqual(mapping);
    expect(result.current.session.writebackEditsRef.current[inputPath]).toBeUndefined();
    expect(result.current.session.cellEditsRef.current[inputPath]).toBeUndefined();
    expect(result.current.session.mappingValidations[inputPath]?.status).toBe("stale");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });

    expect(validatePriceMapping).toHaveBeenCalledWith({
      inputPath,
      mapping,
      requestVersion: 1,
      writebackRows: [],
      cellEdits: [],
      configPath: "C:\\config.json",
    });
    expect(result.current.session.mappingValidations[inputPath]?.status).toBe("validating");
  });

  it("revalidates all fallback rows with the original-value strategy", () => {
    const validatePriceMapping = vi.fn(async () => undefined);
    window.desktopAPI = {
      validatePriceMapping,
    } as unknown as DesktopAPI;
    const { result } = renderHook(() => {
      const session = useProcessorSession();
      return {
        session,
        actions: useMappingValidationActions({ session, configPath: "" }),
      };
    });
    act(() => {
      result.current.session.mappingsRef.current[inputPath] = mapping;
      result.current.actions.useOriginalSkuQuantity(inputPath, [
        { sourceRow: 3, quantity: null, quantityError: "SKU关系无法计算" },
        { sourceRow: 4, quantity: null, quantityError: "SKU关系无法计算" },
      ]);
    });

    expect(validatePriceMapping).toHaveBeenCalledWith(expect.objectContaining({
      inputPath,
      mapping,
      requestVersion: 1,
      writebackRows: [
        expect.objectContaining({ sourceRow: 3, usedOriginalSkuQuantity: true }),
        expect.objectContaining({ sourceRow: 4, usedOriginalSkuQuantity: true }),
      ],
    }));
  });
});
