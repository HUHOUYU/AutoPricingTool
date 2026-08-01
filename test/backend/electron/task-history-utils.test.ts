import { describe, expect, it } from "vitest";
import {
  normalizePricingAnomalySummary,
  pricingAnomalyIssueSummaries,
} from "../../../backend/electron/main/task-history-utils";

describe("pricing anomaly history helpers", () => {
  it("normalizes final anomaly summaries and preserves their issue categories", () => {
    const summary = normalizePricingAnomalySummary({
      affectedRows: 3,
      priceUnavailableRows: 1,
      amountDifferenceRows: 1,
      positiveDifferenceRows: 0,
      negativeDifferenceRows: 1,
      quantityAnomalyRows: 1,
      quantityMismatchRows: 1,
      quantityCalculationErrorRows: 0,
      priceUnavailableSamples: [{ sourceRow: 2, reason: "核价行未匹配" }],
      amountDifferenceSamples: [{ sourceRow: 3, reason: "金额差为负 -1", priceDifference: -1 }],
      quantityMismatchSamples: [{ sourceRow: 4, reason: "数量不一致", quantity: 0 }],
      quantityCalculationErrorSamples: [],
    });

    expect(summary).toMatchObject({
      affectedRows: 3,
      negativeDifferenceRows: 1,
      quantityMismatchRows: 1,
    });
    expect(pricingAnomalyIssueSummaries(summary)).toEqual([
      expect.objectContaining({ code: "price_unavailable", count: 1 }),
      expect.objectContaining({
        code: "amount_difference",
        count: 1,
        positiveDifferenceRows: 0,
        negativeDifferenceRows: 1,
      }),
      expect.objectContaining({ code: "quantity_mismatch", count: 1 }),
    ]);
  });

  it("filters invalid counters instead of storing negative or fractional values", () => {
    const summary = normalizePricingAnomalySummary({
      affectedRows: -1,
      amountDifferenceRows: 1.5,
      quantityAnomalyRows: 2,
    });

    expect(summary).toMatchObject({
      affectedRows: 0,
      amountDifferenceRows: 0,
      quantityAnomalyRows: 2,
    });
  });
});
