import { resolve } from "node:path";
import type {
  TaskBatchMetadataUpdate,
  TaskFileResult,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistoryStatus,
  TaskIssueSummary,
  TaskRunDiagnostics,
} from "../../../shared/task-history";

const TASK_BATCH_NAME_MAX_LENGTH = 120;
const TASK_BATCH_NOTE_MAX_LENGTH = 1_000;
const TASK_HISTORY_SEARCH_MAX_LENGTH = 512;
const VALID_TASK_STATUSES = new Set<TaskHistoryStatus>([
  "running",
  "awaiting_confirmation",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function validateTaskHistoryQuery(value: unknown): TaskHistoryQuery {
  if (value === undefined) return {};
  const input = requireRecord(value, "历史查询参数");
  const statuses = Array.isArray(input.statuses)
    ? input.statuses.filter((status): status is TaskHistoryStatus =>
        typeof status === "string" && VALID_TASK_STATUSES.has(status as TaskHistoryStatus))
    : undefined;
  return {
    ...(typeof input.from === "string" ? { from: input.from.slice(0, 10) } : {}),
    ...(typeof input.to === "string" ? { to: input.to.slice(0, 10) } : {}),
    ...(statuses ? { statuses } : {}),
    ...(typeof input.search === "string" ? { search: input.search.slice(0, TASK_HISTORY_SEARCH_MAX_LENGTH) } : {}),
    ...(Number.isSafeInteger(input.page) ? { page: Number(input.page) } : {}),
    ...(Number.isSafeInteger(input.pageSize) ? { pageSize: Number(input.pageSize) } : {}),
  };
}

export function sanitizeBatchText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().replace(/[\r\n]+/g, " ").slice(0, maxLength) : "";
}

export function defaultBatchName(fileNames: string[] | undefined, batchId: string): string {
  const names = fileNames ?? [];
  if (names.length === 0) return `批次 ${batchId.slice(-8)}`;
  if (names.length === 1) return names[0]!;
  return `${names[0]} 等 ${names.length} 个文件`;
}

export function validateBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("批次 ID 无效");
  }
  return value;
}

export function validateTaskBatchMetadataUpdate(value: unknown): TaskBatchMetadataUpdate {
  const input = requireRecord(value, "批次元数据");
  return {
    batchId: validateBatchId(input.batchId),
    ...(input.name !== undefined ? { name: sanitizeBatchText(input.name, TASK_BATCH_NAME_MAX_LENGTH) } : {}),
    ...(input.note !== undefined ? { note: sanitizeBatchText(input.note, TASK_BATCH_NOTE_MAX_LENGTH) } : {}),
  };
}

export function batchName(value: unknown): string {
  return sanitizeBatchText(value, TASK_BATCH_NAME_MAX_LENGTH);
}

export function batchNote(value: unknown): string {
  return sanitizeBatchText(value, TASK_BATCH_NOTE_MAX_LENGTH);
}

export function aggregateTaskFiles(
  files: TaskFileResult[],
): Pick<TaskHistoryRecord, "completedFiles" | "failedFiles" | "totalRows" | "matchedRows" | "exceptionRows"> {
  return {
    completedFiles: files.filter((file) => file.status === "completed").length,
    failedFiles: files.filter((file) => file.status === "failed").length,
    totalRows: files.reduce((sum, file) => sum + file.totalRows, 0),
    matchedRows: files.reduce((sum, file) => sum + file.matchedRows, 0),
    exceptionRows: files.reduce((sum, file) => sum + file.exceptionRows, 0),
  };
}

export function normalizeTaskDiagnostics(value: unknown): Map<string, TaskIssueSummary[]> {
  const result = new Map<string, TaskIssueSummary[]>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const diagnostic = item as Partial<TaskRunDiagnostics>;
    if (typeof diagnostic.inputPath !== "string" || !Array.isArray(diagnostic.issueSummaries)) continue;
    result.set(resolve(diagnostic.inputPath), diagnostic.issueSummaries);
  }
  return result;
}
