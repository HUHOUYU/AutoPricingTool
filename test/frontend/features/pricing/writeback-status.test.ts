import { describe, expect, it } from "vitest";
import { summarizeWritebackAlerts } from "@/features/pricing/writeback-status";

describe("writeback status", () => {
  it("summarizes non-zero differences and quantity mismatches by unique row", () => {
    const summary = summarizeWritebackAlerts([
      { sourceRow: 2, pricingPrice: 12, priceDifference: 1.5, quantity: 1 },
      { sourceRow: 3, pricingPrice: 8, priceDifference: -2, quantity: 1, quantityMismatch: true },
      { sourceRow: 4, pricingPrice: 9, priceDifference: 0, quantity: 1, quantityMismatch: true },
      { sourceRow: 5, pricingPrice: 10, priceDifference: null, quantity: null },
    ]);

    expect(summary).toMatchObject({
      positiveDifferenceRows: 1,
      negativeDifferenceRows: 1,
      quantityMismatchRows: 2,
      affectedRows: 3,
    });
    expect(summary.message).toBe(
      "发现 3 行写回结果需要关注：金额差为正 1 行、金额差为负 1 行、数量不一致 2 行。请检查“核价[财务]、金额差、数量”后再确认处理。",
    );
    expect(summary.signature).toBe("2:1.5|3:-2|3,4");
  });

  it("does not create an alert for zero or missing writeback values", () => {
    expect(summarizeWritebackAlerts([
      { sourceRow: 2, priceDifference: 0, quantity: 1 },
      { sourceRow: 3, priceDifference: null, quantity: null },
    ])).toMatchObject({
      affectedRows: 0,
      message: "",
      signature: "||",
    });
  });
});
