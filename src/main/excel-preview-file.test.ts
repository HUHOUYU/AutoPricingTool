import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EXCEL_PREVIEW_BYTES, readExcelPreviewFile } from "./excel-preview-file";

describe("readExcelPreviewFile", () => {
  let temporaryDirectory = "";

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "auto-pricing-preview-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("reads a supported Excel file with metadata", async () => {
    const filePath = join(temporaryDirectory, "orders.xlsx");
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4]));

    const result = await readExcelPreviewFile(filePath);

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
    expect(result.size).toBe(4);
    expect(result.modifiedAt).toBeGreaterThan(0);
  });

  it("rejects invalid paths and unsupported files", async () => {
    await expect(readExcelPreviewFile("relative.xlsx")).rejects.toThrow("绝对路径");
    await expect(readExcelPreviewFile(join(temporaryDirectory, "orders.csv"))).rejects.toThrow("Excel 文件");
    await expect(readExcelPreviewFile(join(temporaryDirectory, "missing.xlsx"))).rejects.toThrow("不存在");
  });

  it("rejects directories and files larger than the preview limit", async () => {
    const directoryPath = join(temporaryDirectory, "folder.xlsx");
    await mkdir(directoryPath);
    await expect(readExcelPreviewFile(directoryPath)).rejects.toThrow("不是文件");

    const largeFilePath = join(temporaryDirectory, "large.xlsx");
    const handle = await open(largeFilePath, "w");
    await handle.truncate(MAX_EXCEL_PREVIEW_BYTES + 1);
    await handle.close();
    await expect(readExcelPreviewFile(largeFilePath)).rejects.toThrow("120MB");
  });
});
