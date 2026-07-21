import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

const supportedExcelPreviewExtensions = new Set([".xlsx", ".xlsm", ".xlsb", ".xls"]);

export const MAX_EXCEL_PREVIEW_BYTES = 120 * 1024 * 1024;

export type ExcelPreviewFileData = {
  bytes: Uint8Array;
  size: number;
  modifiedAt: number;
};

export async function readExcelPreviewFile(filePath: unknown): Promise<ExcelPreviewFileData> {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new TypeError("预览路径无效，必须是绝对路径");
  }

  const resolvedPath = resolve(filePath);
  if (!supportedExcelPreviewExtensions.has(extname(resolvedPath).toLowerCase())) {
    throw new TypeError("预览文件必须是受支持的 Excel 文件");
  }

  let fileInfo;
  try {
    fileInfo = await stat(resolvedPath);
  } catch {
    throw new Error("Excel 文件不存在或无法访问");
  }

  if (!fileInfo.isFile()) {
    throw new TypeError("预览路径不是文件");
  }
  if (fileInfo.size > MAX_EXCEL_PREVIEW_BYTES) {
    throw new RangeError("Excel 文件超过 120MB，无法在应用内预览，请打开原始文件查看");
  }

  const fileBuffer = await readFile(resolvedPath);
  return {
    bytes: new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength),
    size: fileInfo.size,
    modifiedAt: fileInfo.mtimeMs,
  };
}
