import { describe, expect, it } from "vitest";
import type { PriceCheckMapping } from "../../../../backend/electron/preload";
import {
  applyMappingColumn,
  mappingColumnConflict,
  mappingIsComplete,
  normalizeAlternativeOrderColumns,
} from "@/features/pricing/mapping";

function createMapping(): PriceCheckMapping {
  return {
    orderSheet: "订单",
    orderHeaderRow: 1,
    businessOrderNumberColumn: 1,
    countryCodeColumn: 2,
    countryEnglishColumn: 3,
    countryChineseColumn: 4,
    skuQtyPairs: [{
      skuColumn: 6,
      qtyColumn: 5,
      mergedQtyColumn: 7,
      skuHeader: "SKU",
      qtyHeader: "数量",
      mergedQtyHeader: "合并数量",
    }],
    singleShipmentColumn: null,
    orderPriceColumn: 8,
    pricingSheet: "核价",
    pricingHeaderRow: 1,
    pricingSkuColumn: 1,
    pricingCountryColumn: 2,
    quantityTierColumns: [{ quantity: 1, column: 3, header: "1件" }],
  };
}

describe("pricing mapping", () => {
  it("accepts a complete mapping and rejects an invalid column order", () => {
    const mapping = createMapping();
    expect(mappingIsComplete(mapping)).toBe(true);
    expect(mappingIsComplete({
      ...mapping,
      skuQtyPairs: [{ ...mapping.skuQtyPairs[0], qtyColumn: 7 }],
    })).toBe(false);
  });

  it("removes duplicate alternative country columns", () => {
    const mapping = createMapping();
    expect(normalizeAlternativeOrderColumns({
      ...mapping,
      countryEnglishColumn: 2,
      countryChineseColumn: 2,
    })).toMatchObject({
      countryCodeColumn: 2,
      countryEnglishColumn: null,
      countryChineseColumn: null,
    });
  });

  it("updates direct quantity columns together and reports conflicts", () => {
    const mapping = createMapping();
    const directMapping: PriceCheckMapping = {
      ...mapping,
      skuQtyPairs: [{ ...mapping.skuQtyPairs[0], directQuantity: true }],
    };
    const updated = applyMappingColumn(directMapping, "skuQtyPairs.0.qtyColumn", 9, "直接数量");

    expect(updated.skuQtyPairs[0]).toMatchObject({
      qtyColumn: 9,
      mergedQtyColumn: 9,
      qtyHeader: "直接数量",
      mergedQtyHeader: "直接数量",
    });
    expect(mappingColumnConflict(mapping, "countryEnglishColumn", 1)).toBe("订单号");
  });
});
