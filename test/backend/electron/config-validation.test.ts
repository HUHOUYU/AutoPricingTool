import { describe, expect, it } from "vitest";
import { validateConfigContent } from "../../../backend/electron/main/config-validation";

describe("validateConfigContent", () => {
  it("accepts an empty configuration object", () => {
    expect(validateConfigContent("{}", 7)).toEqual({ valid: true, issues: [] });
  });

  it("rejects unsupported pricing settings and renderer runtime state", () => {
    const result = validateConfigContent(JSON.stringify({
      pricing: { output_sheets: [] },
      runtime: { recent_input_dir: "C:\\local" },
    }), 7);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "pricing.output_sheets" }),
      expect.objectContaining({ path: "runtime" }),
    ]));
  });

  it("limits processing workers to the current machine capacity", () => {
    const result = validateConfigContent(JSON.stringify({
      performance: { processing_workers: 8 },
    }), 7);

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      path: "performance.processing_workers",
      message: expect.stringContaining("不能超过 7"),
    });
  });
});
