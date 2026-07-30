import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalProcessorExecutable } from "../../../backend/electron/main/processor-path";

describe("processor executable resolution", () => {
  it("uses the debug processor during development", () => {
    expect(resolveLocalProcessorExecutable("workspace", false, "processor.exe")).toBe(
      join("workspace", "backend", "processor", "target", "debug", "processor.exe"),
    );
  });

  it("uses the release processor for packaged builds", () => {
    expect(resolveLocalProcessorExecutable("workspace", true, "processor.exe")).toBe(
      join("workspace", "backend", "processor", "target", "release", "processor.exe"),
    );
  });
});
