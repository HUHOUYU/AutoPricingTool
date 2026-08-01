import { describe, expect, it } from "vitest";
import {
  adjacentIssueRow,
  classifyIssueNavigationRows,
  selectedIssueNavigationRows,
} from "@/features/pricing/issue-navigation";

describe("pricing issue navigation", () => {
  it("classifies price-unavailable, difference, and quantity issue rows", () => {
    const rows = classifyIssueNavigationRows([
      { sourceRow: 2, pricingPrice: 10, priceDifference: 0, quantity: 1 },
      { sourceRow: 3, pricingPrice: null, priceDifference: -2, quantity: 1, quantityMismatch: true },
      { sourceRow: 4, pricingPrice: 12, priceDifference: 1.5, quantity: null, quantityError: "SKU关系无法计算" },
      { sourceRow: 5, pricingPrice: null, priceDifference: null, quantity: null },
    ]);

    expect(rows).toEqual({
      unmatched: [3, 5],
      difference: [3, 4],
      quantity: [3, 4],
    });
    expect(selectedIssueNavigationRows(rows, ["unmatched", "difference"])).toEqual([3, 4, 5]);
  });

  it("does not keep a manually priced row in the price-unavailable filter", () => {
    expect(classifyIssueNavigationRows([
      { sourceRow: 6, pricingPrice: 15, priceDifference: 0, quantity: 1 },
    ])).toMatchObject({ unmatched: [] });
  });

  it("wraps navigation in both directions", () => {
    expect(adjacentIssueRow([3, 8], null, 1)).toBe(3);
    expect(adjacentIssueRow([3, 8], 8, 1)).toBe(3);
    expect(adjacentIssueRow([3, 8], 3, -1)).toBe(8);
    expect(adjacentIssueRow([], null, 1)).toBeNull();
  });
});
