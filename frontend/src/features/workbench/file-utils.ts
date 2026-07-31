import type { DropEvent } from "react-dropzone";
import type { DesktopAPI } from "@shared/desktop-api";
import type { ImportMode } from "./types";

export function getDesktopAPI(): DesktopAPI | null {
  return window.desktopAPI ?? null;
}

export function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

export function isExcelPath(path: string): boolean {
  return /\.(xlsx|xlsm|xlsb|xls)$/i.test(path);
}

export function isExcelFile(file: File): boolean {
  return isExcelPath(file.name);
}

export function getNativeFilesFromEvent(event: DropEvent): Promise<File[]> {
  if ("dataTransfer" in event && event.dataTransfer?.files) {
    return Promise.resolve(Array.from(event.dataTransfer.files));
  }
  if ("target" in event && event.target && "files" in event.target) {
    const files = (event.target as HTMLInputElement).files;
    return Promise.resolve(files ? Array.from(files) : []);
  }
  return Promise.resolve([]);
}

export function droppedFolderName(file: File): string | null {
  const relativePath = file.webkitRelativePath || (file as File & { path?: string }).path || "";
  const parts = relativePath.replace(/^[\\/]+/, "").split(/[\\/]/).filter((part) => Boolean(part) && part !== ".");
  return parts.length > 1 ? parts[0] : null;
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function defaultDraftBatchName(paths: string[], mode: ImportMode): string {
  if (paths.length === 0) return "";
  if (mode === "folder") return fileNameFromPath(parentDirectory(paths[0])) || "文件夹批次";
  if (paths.length === 1) return fileNameFromPath(paths[0]);
  return `${fileNameFromPath(paths[0])} 等 ${paths.length} 个文件`;
}

export function formatCoverage(value: number | undefined): string {
  return String(((value ?? 0) * 100).toFixed(1)) + "%";
}

export function columnLabel(value: number | null | undefined): string {
  return value ? "第 " + value + " 列" : "未识别";
}
