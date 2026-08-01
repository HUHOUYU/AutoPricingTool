import { describe, expect, it } from "vitest";
import { unmatchedIssueDetails } from "@/features/pricing/issues";

describe("pricing issue details", () => {
  it("marks the unavailable price reason as dangerous", () => {
    const [detail] = unmatchedIssueDetails([{
      sourceRow: 1098,
      skuColumn: 11,
      sku: "TC2500348",
      country: "BS / BAHAMAS / 巴哈马",
      quantity: 4,
      reason: "价格不可用：核价 Sheet Sheet2 中国家路由由 BAHAMAS、SKU TC2500348、数量 4 的价格不可用: no ship",
    }]);

    expect(detail.messageHighlights).toContainEqual({
      value: "no ship",
      tone: "danger",
    });
  });
});
