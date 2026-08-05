import { describe, expect, it } from "vitest";
import { validateConfigContent } from "../../../backend/electron/main/config-validation";

describe("validateConfigContent", () => {
  it("accepts an empty configuration object", () => {
    expect(validateConfigContent("{}", 7)).toEqual({ valid: true, issues: [] });
  });

  it("validates the order core header range shape", () => {
    expect(validateConfigContent(JSON.stringify({
      pricing: { order_core_header_range: ["Name", "Total Price"] },
    }), 7)).toEqual({ valid: true, issues: [] });

    expect(validateConfigContent(JSON.stringify({
      pricing: { order_core_header_range: ["Name", "Total Price", "SKU"] },
    }), 7)).toMatchObject({
      valid: false,
      issues: [{ path: "pricing.order_core_header_range", message: "最多只能配置两个表头" }],
    });

    expect(validateConfigContent(JSON.stringify({
      pricing: { order_core_header_range: [""] },
    }), 7)).toMatchObject({
      valid: false,
      issues: [{ path: "pricing.order_core_header_range[0]", message: "必须是非空字符串" }],
    });
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
