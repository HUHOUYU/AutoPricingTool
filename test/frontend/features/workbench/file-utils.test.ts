import { describe, expect, it } from "vitest";
import {
  columnLabel,
  defaultDraftBatchName,
  fileNameFromPath,
  formatCoverage,
  isExcelPath,
  parentDirectory,
} from "@/features/workbench/file-utils";

describe("workbench file utilities", () => {
  it("handles Windows and POSIX paths", () => {
    expect(parentDirectory("C:\\batch\\order.xlsx")).toBe("C:\\batch");
    expect(fileNameFromPath("/batch/order.xlsx")).toBe("order.xlsx");
  });

  it("recognizes supported Excel extensions case-insensitively", () => {
    expect(isExcelPath("ORDER.XLSX")).toBe(true);
    expect(isExcelPath("order.xlsb")).toBe(true);
    expect(isExcelPath("order.csv")).toBe(false);
  });

  it("creates stable draft names and display labels", () => {
    const paths = ["C:\\batch\\a.xlsx", "C:\\batch\\b.xlsx"];
    expect(defaultDraftBatchName(paths, "folder")).toBe("batch");
    expect(defaultDraftBatchName(paths, "file")).toBe("a.xlsx 等 2 个文件");
    expect(formatCoverage(0.875)).toBe("87.5%");
    expect(columnLabel(3)).toBe("第 3 列");
    expect(columnLabel(null)).toBe("未识别");
  });
});
