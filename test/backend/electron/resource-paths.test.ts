import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledDefaultConfigPath } from "../../../backend/electron/main/resource-paths";

describe("resolveBundledDefaultConfigPath", () => {
  it("uses the repository resources directory during development", () => {
    const projectRoot = join("C:", "workspace", "AutoPricingTool");

    expect(resolveBundledDefaultConfigPath(projectRoot, false)).toBe(
      join(projectRoot, "resources", "defaults", "extract_rules.json"),
    );
  });

  it("uses the packaged resources root in production", () => {
    const resourcesRoot = join("C:", "Program Files", "AutoPricingTool", "resources");

    expect(resolveBundledDefaultConfigPath(resourcesRoot, true)).toBe(
      join(resourcesRoot, "defaults", "extract_rules.json"),
    );
  });
});
