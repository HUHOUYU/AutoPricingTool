import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { collectExcelFiles } from "../../../backend/electron/main/excel-file-collector";

const temporaryDirectories: string[] = [];
const isSupportedFile = (path: string): boolean =>
  [".xlsx", ".xlsm", ".xlsb", ".xls"].includes(extname(path).toLowerCase());

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "auto-pricing-input-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("collectExcelFiles", () => {
  it("collects supported top-level files and reports skipped inputs", async () => {
    const directory = await createDirectory();
    await Promise.all([
      writeFile(join(directory, "b.xlsx"), ""),
      writeFile(join(directory, "a.xls"), ""),
      writeFile(join(directory, "~$draft.xlsx"), ""),
      writeFile(join(directory, "notes.txt"), ""),
      mkdir(join(directory, ".git")),
      mkdir(join(directory, "核价结果")),
      mkdir(join(directory, "nested")),
    ]);
    await writeFile(join(directory, "nested", "ignored.xlsx"), "");

    const result = await collectExcelFiles(directory, {
      maxFiles: 5_000,
      isSupportedFile,
    });

    expect(result.files.map((path) => path.split(/[\\/]/).pop())).toEqual(["a.xls", "b.xlsx"]);
    expect(result).toMatchObject({
      skippedTemporary: 1,
      skippedUnsupported: 1,
      skippedOutput: 2,
    });
  });

  it("rejects a directory once supported files exceed the configured limit", async () => {
    const directory = await createDirectory();
    await Promise.all([
      writeFile(join(directory, "a.xlsx"), ""),
      writeFile(join(directory, "b.xlsx"), ""),
    ]);

    await expect(collectExcelFiles(directory, {
      maxFiles: 1,
      isSupportedFile,
    })).rejects.toThrow("包含 2 个 Excel 文件，最多支持 1 个");
  });
});
