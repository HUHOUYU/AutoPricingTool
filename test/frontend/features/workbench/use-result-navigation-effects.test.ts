import { describe, expect, it } from "vitest";
import { resolveManualReviewTarget } from "@/features/workbench/hooks/use-result-navigation-effects";

describe("resolveManualReviewTarget", () => {
  it("moves a completed review to the next file in the preferred tab", () => {
    const files = ["a.xlsx", "b.xlsx", "c.xlsx"];
    const result = resolveManualReviewTarget({
      resolution: {
        path: files[0],
        preferredTab: "confirm",
        outcome: "completed",
      },
      files,
      fileStatusByPath: {
        [files[0]]: "success",
        [files[1]]: "ready",
        [files[2]]: "error",
      },
    });

    expect(result).toEqual({ path: files[1], tab: "confirm" });
  });

  it("keeps failed processing on the current file and error tab", () => {
    const result = resolveManualReviewTarget({
      resolution: {
        path: "a.xlsx",
        preferredTab: "confirm",
        outcome: "failed",
      },
      files: ["a.xlsx"],
      fileStatusByPath: { "a.xlsx": "ready" },
    });

    expect(result).toEqual({ path: "a.xlsx", tab: "error" });
  });
});
