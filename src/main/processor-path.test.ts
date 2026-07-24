import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalProcessorExecutable } from "./processor-path";

describe("processor executable resolution", () => {
  it("uses the debug processor during development", () => {
    expect(resolveLocalProcessorExecutable("workspace", false, "processor.exe")).toBe(
      join("workspace", "processor-rust", "target", "debug", "processor.exe"),
    );
  });

  it("uses the release processor for packaged builds", () => {
    expect(resolveLocalProcessorExecutable("workspace", true, "processor.exe")).toBe(
      join("workspace", "processor-rust", "target", "release", "processor.exe"),
    );
  });
});
