import { describe, expect, it } from "vitest";
import { summarizeWritebackAlerts } from "@/features/pricing/writeback-status";

describe("writeback status", () => {
  it("summarizes all final pricing anomalies by unique row", () => {
    const summary = summarizeWritebackAlerts([
      { sourceRow: 2, pricingPrice: 12, priceDifference: 1.5, quantity: 1 },
      { sourceRow: 3, pricingPrice: 8, priceDifference: -2, quantity: 1, quantityMismatch: true },
      { sourceRow: 4, pricingPrice: 9, priceDifference: 0, quantity: 1, quantityMismatch: true, quantityError: "SKU关系无法计算" },
      { sourceRow: 5, pricingPrice: null, priceDifference: null, quantity: null },
    ]);

    expect(summary).toMatchObject({
      priceUnavailableRows: 1,
      positiveDifferenceRows: 1,
      negativeDifferenceRows: 1,
      quantityMismatchRows: 2,
      quantityCalculationErrorRows: 1,
      affectedRows: 4,
    });
    expect(summary.message).toBe(
      "发现 4 行核价结果异常：核价价格异常 1 行、金额差为正 1 行、金额差为负 1 行、数量不一致 2 行、数量计算失败 1 行。请修正“核价[财务]、金额差、数量”后重新核价；仅确认字段映射不会清除这些异常。",
    );
    expect(summary.signature).toBe("5|2:1.5|3:-2|3,4|4");
  });

  it("does not create an alert for zero or missing writeback values", () => {
    expect(summarizeWritebackAlerts([
      { sourceRow: 2, priceDifference: 0, quantity: 1 },
      { sourceRow: 3, priceDifference: null, quantity: null },
    ])).toMatchObject({
      affectedRows: 0,
      message: "",
      signature: "||||",
    });
  });
});
