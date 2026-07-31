import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ExcelFileCollection = {
  files: string[];
  skippedTemporary: number;
  skippedUnsupported: number;
  skippedOutput: number;
};

type CollectExcelFilesOptions = {
  maxFiles: number;
  isSupportedFile: (path: string) => boolean;
};

const SKIPPED_INPUT_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist-electron",
  "target",
  "核价结果",
]);

export async function collectExcelFiles(
  directory: string,
  {
    maxFiles,
    isSupportedFile,
  }: CollectExcelFilesOptions,
): Promise<ExcelFileCollection> {
  const files: string[] = [];
  let skippedTemporary = 0;
  let skippedUnsupported = 0;
  let skippedOutput = 0;
  const resolvedDirectory = resolve(directory);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  for (const entry of entries) {
    if (!entry.isFile()) {
      if (entry.isDirectory() && SKIPPED_INPUT_DIRECTORY_NAMES.has(entry.name)) {
        skippedOutput += 1;
      }
      continue;
    }
    if (entry.name.startsWith("~$")) {
      skippedTemporary += 1;
      continue;
    }
    const candidate = join(resolvedDirectory, entry.name);
    if (!isSupportedFile(candidate)) {
      skippedUnsupported += 1;
      continue;
    }
    files.push(resolve(candidate));
    if (files.length > maxFiles) break;
  }

  if (files.length > maxFiles) {
    throw new RangeError(`输入文件夹包含 ${files.length} 个 Excel 文件，最多支持 ${maxFiles} 个`);
  }
  return {
    files,
    skippedTemporary,
    skippedUnsupported,
    skippedOutput,
  };
}
