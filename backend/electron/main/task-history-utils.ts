import { resolve } from "node:path";
import type {
  TaskBatchMetadataUpdate,
  TaskFileResult,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistoryStatus,
  PricingAnomalySample,
  PricingAnomalySummary,
  TaskIssueSummary,
  TaskRunDiagnostics,
} from "../../../shared/task-history";
import { TASK_ISSUE_LABELS } from "../../../shared/task-history";

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
): Pick<
  TaskHistoryRecord,
  "completedFiles" | "awaitingConfirmationFiles" | "failedFiles" | "totalRows" | "matchedRows" | "exceptionRows"
> {
  return {
    completedFiles: files.filter((file) => file.status === "completed").length,
    awaitingConfirmationFiles: files.filter((file) => file.status === "awaiting_confirmation").length,
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeAnomalySample(value: unknown): PricingAnomalySample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const sourceRow = nonNegativeInteger(input.sourceRow);
  if (sourceRow === null) return null;
  return {
    sourceRow,
    reason: typeof input.reason === "string" ? input.reason : "",
    pricingPrice: finiteNumber(input.pricingPrice),
    priceDifference: finiteNumber(input.priceDifference),
    quantity: nonNegativeInteger(input.quantity),
  };
}

function normalizeSamples(value: unknown): PricingAnomalySample[] {
  return Array.isArray(value)
    ? value.map(normalizeAnomalySample).filter((sample): sample is PricingAnomalySample => sample !== null)
    : [];
}

export function normalizePricingAnomalySummary(value: unknown): PricingAnomalySummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return {
    affectedRows: nonNegativeInteger(input.affectedRows) ?? 0,
    priceUnavailableRows: nonNegativeInteger(input.priceUnavailableRows) ?? 0,
    amountDifferenceRows: nonNegativeInteger(input.amountDifferenceRows) ?? 0,
    positiveDifferenceRows: nonNegativeInteger(input.positiveDifferenceRows) ?? 0,
    negativeDifferenceRows: nonNegativeInteger(input.negativeDifferenceRows) ?? 0,
    quantityAnomalyRows: nonNegativeInteger(input.quantityAnomalyRows) ?? 0,
    quantityMismatchRows: nonNegativeInteger(input.quantityMismatchRows) ?? 0,
    quantityCalculationErrorRows: nonNegativeInteger(input.quantityCalculationErrorRows) ?? 0,
    priceUnavailableSamples: normalizeSamples(input.priceUnavailableSamples),
    amountDifferenceSamples: normalizeSamples(input.amountDifferenceSamples),
    quantityMismatchSamples: normalizeSamples(input.quantityMismatchSamples),
    quantityCalculationErrorSamples: normalizeSamples(input.quantityCalculationErrorSamples),
  };
}

function issueSample(sample: PricingAnomalySample): TaskIssueSummary["samples"][number] {
  return {
    sourceRow: sample.sourceRow,
    country: "",
    sku: "",
    quantity: sample.quantity ?? null,
    reason: sample.reason,
  };
}

export function pricingAnomalyIssueSummaries(summary: PricingAnomalySummary | undefined): TaskIssueSummary[] {
  if (!summary || summary.affectedRows <= 0) return [];
  const issues: TaskIssueSummary[] = [];
  if (summary.priceUnavailableRows > 0) {
    issues.push({
      code: "price_unavailable",
      label: TASK_ISSUE_LABELS.price_unavailable,
      count: summary.priceUnavailableRows,
      samples: summary.priceUnavailableSamples.map(issueSample),
    });
  }
  if (summary.amountDifferenceRows > 0) {
    issues.push({
      code: "amount_difference",
      label: TASK_ISSUE_LABELS.amount_difference,
      count: summary.amountDifferenceRows,
      positiveDifferenceRows: summary.positiveDifferenceRows,
      negativeDifferenceRows: summary.negativeDifferenceRows,
      samples: summary.amountDifferenceSamples.map(issueSample),
    });
  }
  if (summary.quantityMismatchRows > 0) {
    issues.push({
      code: "quantity_mismatch",
      label: TASK_ISSUE_LABELS.quantity_mismatch,
      count: summary.quantityMismatchRows,
      samples: summary.quantityMismatchSamples.map(issueSample),
    });
  }
  if (summary.quantityCalculationErrorRows > 0) {
    issues.push({
      code: "quantity_calculation",
      label: TASK_ISSUE_LABELS.quantity_calculation,
      count: summary.quantityCalculationErrorRows,
      samples: summary.quantityCalculationErrorSamples.map(issueSample),
    });
  }
  return issues;
}
