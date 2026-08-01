export type TaskHistoryStatus = "running" | "awaiting_confirmation" | "completed" | "failed" | "stopped" | "interrupted";

export type TaskFileStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export type TaskEventLevel = "info" | "success" | "warning" | "error";

export type TaskExecutionType = "automatic" | "manual" | "retry";

export type TaskIssueCode =
  | "quantity_calculation"
  | "country_route"
  | "sku"
  | "quantity_tier"
  | "price_unavailable"
  | "file_processing"
  | "other";

export type TaskIssueSample = {
  sourceRow: number;
  country: string;
  sku: string;
  quantity: number | null;
  reason: string;
};

export type TaskIssueSummary = {
  code: TaskIssueCode;
  label: string;
  count: number;
  samples: TaskIssueSample[];
};

export type TaskFileResult = {
  path: string;
  fileName: string;
  status: TaskFileStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outputPath?: string;
  archivedPath?: string;
  totalRows: number;
  matchedRows: number;
  exceptionRows: number;
  coverage?: number;
  message?: string;
  executionType?: TaskExecutionType;
  issueSummaries: TaskIssueSummary[];
};

export type TaskHistoryEvent = {
  id: string;
  sequence: number;
  time: string;
  level: TaskEventLevel;
  phase: "batch" | "file" | "processor";
  message: string;
  filePath?: string;
};

export type TaskHistoryRecord = {
  id: string;
  name?: string;
  note?: string;
  schemaVersion?: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: TaskHistoryStatus;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalRows: number;
  matchedRows: number;
  exceptionRows: number;
  outputRoot?: string;
  outputDir?: string;
  fileNames?: string[];
  detailAvailable?: boolean;
};

export type TaskHistorySummary = {
  today: { files: number; tasks: number; matchRate: number; exceptions: number };
  trend: Array<{ date: string; files: number; matchedRows: number; totalRows: number; exceptions: number }>;
  recent: TaskHistoryRecord[];
};

export type TaskHistoryQuery = {
  from?: string;
  to?: string;
  statuses?: TaskHistoryStatus[];
  search?: string;
  page?: number;
  pageSize?: number;
};

export type TaskHistoryPage = {
  items: TaskHistoryRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type TaskHistoryDetail = {
  record: TaskHistoryRecord;
  files: TaskFileResult[];
  events: TaskHistoryEvent[];
  issueSummaries: TaskIssueSummary[];
  legacy: boolean;
};

export type TaskAnalyticsQuery = {
  from?: string;
  to?: string;
  search?: string;
};

export type TaskAnalyticsSummary = {
  totals: {
    batches: number;
    files: number;
    rows: number;
    matchedRows: number;
    matchRate: number | null;
    exceptions: number;
    averageDurationMs: number | null;
  };
  trend: Array<{
    date: string;
    batches: number;
    files: number;
    totalRows: number;
    matchedRows: number;
    matchRate: number | null;
    exceptions: number;
  }>;
  statuses: Array<{ status: TaskHistoryStatus; count: number }>;
  issues: Array<{ code: TaskIssueCode; label: string; count: number }>;
  records: TaskHistoryRecord[];
};

export type TaskHistoryExportRequest =
  | { format: "json"; batchId: string }
  | { format: "csv"; query: TaskHistoryQuery };

export type TaskRunDiagnostics = {
  inputPath: string;
  issueSummaries: TaskIssueSummary[];
};

export type TaskBatchMetadataUpdate = {
  batchId: string;
  name?: string;
  note?: string;
};

export type TaskBatchFinishRequest = {
  batchId?: string;
  name: string;
  note?: string;
  files: string[];
  outputRoot: string;
  diagnostics?: TaskRunDiagnostics[];
};

export type TaskBatchFinishResult = {
  record: TaskHistoryRecord;
  archivedCount: number;
  unprocessedDir?: string;
};

export type TaskBatchDiscardResult = {
  batchId: string;
  deletedOutputDirectory?: string;
};

export const TASK_ISSUE_LABELS: Record<TaskIssueCode, string> = {
  quantity_calculation: "数量计算",
  country_route: "国家路由",
  sku: "SKU",
  quantity_tier: "数量档位",
  price_unavailable: "价格不可用或重复",
  file_processing: "文件处理失败",
  other: "其他",
};

export function classifyTaskIssue(reason: string): TaskIssueCode {
  const normalized = reason.toLocaleLowerCase();
  if (normalized.includes("数量无法计算") || normalized.includes("数量计算") || normalized.includes("sku关系")) {
    return "quantity_calculation";
  }
  if (normalized.includes("国家路由") || normalized.includes("国家值")) {
    return "country_route";
  }
  if (normalized.includes("数量档位") || normalized.includes("档位不存在")) {
    return "quantity_tier";
  }
  if (
    normalized.includes("价格不可用")
    || normalized.includes("价格重复")
    || normalized.includes("对应多个价格")
    || normalized.includes("no ship")
  ) {
    return "price_unavailable";
  }
  if (normalized.includes("sku")) return "sku";
  if (normalized.includes("读取失败") || normalized.includes("处理失败") || normalized.includes("写入失败")) {
    return "file_processing";
  }
  return "other";
}
