import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  TaskAnalyticsQuery,
  TaskAnalyticsSummary,
  TaskFileResult,
  TaskHistoryDetail,
  TaskHistoryEvent,
  TaskHistoryPage,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistoryStatus,
  TaskHistorySummary,
  TaskIssueSummary,
} from "../../../shared/task-history";
import { TASK_ISSUE_LABELS } from "../../../shared/task-history";

export const TASK_HISTORY_RETENTION_DAYS = 365;
export const TASK_HISTORY_MAX_BATCHES = 1_000;
export const TASK_HISTORY_DEFAULT_PAGE_SIZE = 30;
export const TASK_HISTORY_MAX_PAGE_SIZE = 100;
export const TASK_HISTORY_SCHEMA_VERSION = 5;

type TaskDetailEntry =
  | { kind: "event"; event: TaskHistoryEvent }
  | { kind: "file"; file: TaskFileResult };

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function finishedStatus(status: TaskHistoryStatus): boolean {
  return status !== "running" && status !== "awaiting_confirmation";
}

function matchesSearch(record: TaskHistoryRecord, search: string): boolean {
  if (!search) return true;
  return record.id.toLocaleLowerCase().includes(search)
    || record.name?.toLocaleLowerCase().includes(search)
    || record.note?.toLocaleLowerCase().includes(search)
    || record.outputDir?.toLocaleLowerCase().includes(search)
    || record.fileNames?.some((name) => name.toLocaleLowerCase().includes(search))
    || false;
}

function withinRange(record: TaskHistoryRecord, from?: string, to?: string): boolean {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  if (from) {
    const fromTime = Date.parse(`${from}T00:00:00`);
    if (Number.isFinite(fromTime) && startedAt < fromTime) return false;
  }
  if (to) {
    const toTime = Date.parse(`${to}T23:59:59.999`);
    if (Number.isFinite(toTime) && startedAt > toTime) return false;
  }
  return true;
}

function mergeIssueSummaries(files: TaskFileResult[]): TaskIssueSummary[] {
  const summaries = new Map<string, TaskIssueSummary>();
  for (const file of files) {
    for (const issue of file.issueSummaries) {
      const current = summaries.get(issue.code);
      if (current) {
        current.count += issue.count;
        current.samples.push(...issue.samples);
      } else {
        summaries.set(issue.code, {
          code: issue.code,
          label: issue.label || TASK_ISSUE_LABELS[issue.code],
          count: issue.count,
          samples: [...issue.samples],
        });
      }
    }
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count);
}

function normalizeRecord(record: TaskHistoryRecord): TaskHistoryRecord {
  const completedAt = record.completedAt;
  const derivedDuration = completedAt
    ? Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt))
    : undefined;
  return {
    ...record,
    ...(record.durationMs === undefined && Number.isFinite(derivedDuration) ? { durationMs: derivedDuration } : {}),
    detailAvailable: record.detailAvailable === true,
  };
}

function escapeCsv(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class TaskHistoryStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly historyPath: string,
    private readonly detailsDir: string,
  ) {}

  detailPath(batchId: string): string {
    return join(this.detailsDir, `${batchId}.jsonl`);
  }

  async readTaskHistory(): Promise<TaskHistoryRecord[]> {
    let content = "";
    try {
      content = await readFile(this.historyPath, "utf8");
    } catch {
      return [];
    }
    const latest = new Map<string, TaskHistoryRecord>();
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as TaskHistoryRecord;
        if (record && typeof record.id === "string") latest.set(record.id, normalizeRecord(record));
      } catch {
        // 截断的最后一行不会影响此前有效记录。
      }
    }
    return [...latest.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  persistTaskRecord(record: TaskHistoryRecord): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.historyPath), { recursive: true });
      await appendFile(this.historyPath, `${JSON.stringify(record)}\n`, "utf8");
      const cutoff = Date.now() - TASK_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
      const retained = (await this.readTaskHistory())
        .filter((item) => Date.parse(item.startedAt) >= cutoff)
        .slice(0, TASK_HISTORY_MAX_BATCHES);
      await writeFile(
        this.historyPath,
        retained.slice().reverse().map((item) => JSON.stringify(item)).join("\n") + (retained.length ? "\n" : ""),
        "utf8",
      );
      await this.cleanupDetailFiles(new Set(retained.map((item) => item.id)));
    });
  }

  deleteTaskHistory(batchId: string): Promise<void> {
    return this.enqueue(async () => {
      const retained = (await this.readTaskHistory()).filter((record) => record.id !== batchId);
      await mkdir(dirname(this.historyPath), { recursive: true });
      await writeFile(
        this.historyPath,
        retained.slice().reverse().map((record) => JSON.stringify(record)).join("\n") + (retained.length ? "\n" : ""),
        "utf8",
      );
      await rm(this.detailPath(batchId), { force: true });
    });
  }

  appendEvent(batchId: string, event: TaskHistoryEvent): Promise<void> {
    return this.appendDetailEntry(batchId, { kind: "event", event });
  }

  appendFileResult(batchId: string, file: TaskFileResult): Promise<void> {
    return this.appendDetailEntry(batchId, { kind: "file", file });
  }

  async getTaskHistoryDetail(batchId: string): Promise<TaskHistoryDetail | null> {
    const record = (await this.readTaskHistory()).find((item) => item.id === batchId);
    if (!record) return null;
    return this.buildTaskHistoryDetail(record);
  }

  private async buildTaskHistoryDetail(record: TaskHistoryRecord): Promise<TaskHistoryDetail> {
    const entries = await this.readDetailEntries(record.id);
    const files = new Map<string, TaskFileResult>();
    const events: TaskHistoryEvent[] = [];
    for (const entry of entries) {
      if (entry.kind === "file") files.set(entry.file.path, entry.file);
      else events.push(entry.event);
    }
    const latestFiles = [...files.values()].sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN"));
    events.sort((left, right) => left.sequence - right.sequence || left.time.localeCompare(right.time));
    const liveRecord = record.status === "running" && latestFiles.length > 0 ? {
      ...record,
      completedFiles: latestFiles.filter((file) => file.status === "completed").length,
      failedFiles: latestFiles.filter((file) => file.status === "failed").length,
      totalRows: latestFiles.reduce((sum, file) => sum + file.totalRows, 0),
      matchedRows: latestFiles.reduce((sum, file) => sum + file.matchedRows, 0),
      exceptionRows: latestFiles.reduce((sum, file) => sum + file.exceptionRows, 0),
    } : record;
    return {
      record: liveRecord,
      files: latestFiles,
      events,
      issueSummaries: mergeIssueSummaries(latestFiles),
      legacy: entries.length === 0,
    };
  }

  async listTaskHistory(query: TaskHistoryQuery = {}): Promise<TaskHistoryPage> {
    const page = Number.isSafeInteger(query.page) && Number(query.page) > 0 ? Number(query.page) : 1;
    const requestedPageSize = Number.isSafeInteger(query.pageSize) ? Number(query.pageSize) : TASK_HISTORY_DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(TASK_HISTORY_MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const statuses = new Set(query.statuses ?? []);
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const filtered = (await this.readTaskHistory()).filter((record) => {
      if (!withinRange(record, query.from, query.to)) return false;
      if (statuses.size > 0 && !statuses.has(record.status)) return false;
      if (!search) return true;
      return matchesSearch(record, search);
    });
    const start = (page - 1) * pageSize;
    return { items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize };
  }

  async getTaskHistorySummary(): Promise<TaskHistorySummary> {
    const history = await this.readTaskHistory();
    const todayKey = localDateKey(new Date());
    const completed = history.filter((record) => finishedStatus(record.status));
    const today = completed.filter((record) => localDateKey(new Date(record.startedAt)) === todayKey);
    const totalRows = today.reduce((sum, record) => sum + record.totalRows, 0);
    const matchedRows = today.reduce((sum, record) => sum + record.matchedRows, 0);
    const trend = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      const dateKey = localDateKey(date);
      const records = completed.filter((record) => localDateKey(new Date(record.startedAt)) === dateKey);
      return {
        date: dateKey,
        files: records.reduce((sum, record) => sum + record.totalFiles, 0),
        matchedRows: records.reduce((sum, record) => sum + record.matchedRows, 0),
        totalRows: records.reduce((sum, record) => sum + record.totalRows, 0),
        exceptions: records.reduce((sum, record) => sum + record.exceptionRows, 0),
      };
    });
    return {
      today: {
        files: today.reduce((sum, record) => sum + record.totalFiles, 0),
        tasks: today.length,
        matchRate: totalRows > 0 ? matchedRows / totalRows : 0,
        exceptions: today.reduce((sum, record) => sum + record.exceptionRows, 0),
      },
      trend,
      recent: history.slice(0, 8),
    };
  }

  async getTaskAnalytics(query: TaskAnalyticsQuery = {}): Promise<TaskAnalyticsSummary> {
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const records = (await this.readTaskHistory()).filter((record) =>
      withinRange(record, query.from, query.to) && matchesSearch(record, search));
    const totalRows = records.reduce((sum, record) => sum + record.totalRows, 0);
    const matchedRows = records.reduce((sum, record) => sum + record.matchedRows, 0);
    const durations = records
      .filter((record) => finishedStatus(record.status) && typeof record.durationMs === "number")
      .map((record) => record.durationMs as number);
    const dates = new Map<string, TaskAnalyticsSummary["trend"][number]>();
    for (const record of records) {
      const date = localDateKey(new Date(record.startedAt));
      const current = dates.get(date) ?? {
        date,
        batches: 0,
        files: 0,
        totalRows: 0,
        matchedRows: 0,
        matchRate: null,
        exceptions: 0,
      };
      current.batches += 1;
      current.files += record.totalFiles;
      current.totalRows += record.totalRows;
      current.matchedRows += record.matchedRows;
      current.exceptions += record.exceptionRows;
      current.matchRate = current.totalRows > 0 ? current.matchedRows / current.totalRows : null;
      dates.set(date, current);
    }
    const statusOrder: TaskHistoryStatus[] = ["running", "awaiting_confirmation", "completed", "failed", "stopped", "interrupted"];
    const detailRows = await Promise.all(records.filter((record) => record.detailAvailable).map((record) => this.buildTaskHistoryDetail(record)));
    const issues = new Map<string, { code: TaskIssueSummary["code"]; label: string; count: number }>();
    for (const detail of detailRows) {
      for (const issue of detail?.issueSummaries ?? []) {
        const current = issues.get(issue.code) ?? { code: issue.code, label: issue.label, count: 0 };
        current.count += issue.count;
        issues.set(issue.code, current);
      }
    }
    return {
      totals: {
        batches: records.length,
        files: records.reduce((sum, record) => sum + record.totalFiles, 0),
        rows: totalRows,
        matchedRows,
        matchRate: totalRows > 0 ? matchedRows / totalRows : null,
        exceptions: records.reduce((sum, record) => sum + record.exceptionRows, 0),
        averageDurationMs: durations.length > 0
          ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
          : null,
      },
      trend: [...dates.values()].sort((left, right) => left.date.localeCompare(right.date)),
      statuses: statusOrder.map((status) => ({
        status,
        count: records.filter((record) => record.status === status).length,
      })),
      issues: [...issues.values()].sort((left, right) => right.count - left.count),
      records,
    };
  }

  async exportBatchJson(batchId: string): Promise<string | null> {
    const detail = await this.getTaskHistoryDetail(batchId);
    return detail ? `${JSON.stringify(detail, null, 2)}\n` : null;
  }

  async exportHistoryCsv(query: TaskHistoryQuery): Promise<string> {
    const firstPage = await this.listTaskHistory({ ...query, page: 1, pageSize: TASK_HISTORY_MAX_PAGE_SIZE });
    const history = [...firstPage.items];
    const pageCount = Math.ceil(firstPage.total / TASK_HISTORY_MAX_PAGE_SIZE);
    for (let page = 2; page <= pageCount; page += 1) {
      const next = await this.listTaskHistory({ ...query, page, pageSize: TASK_HISTORY_MAX_PAGE_SIZE });
      history.push(...next.items);
    }
    const headers = ["批次ID", "批次名称", "备注", "开始时间", "完成时间", "状态", "文件数", "完成文件", "失败文件", "总行数", "匹配行数", "异常行数", "匹配率", "耗时毫秒", "输出目录"];
    const rows = history.map((record) => [
      record.id,
      record.name ?? "",
      record.note ?? "",
      record.startedAt,
      record.completedAt ?? "",
      record.status,
      record.totalFiles,
      record.completedFiles,
      record.failedFiles,
      record.totalRows,
      record.matchedRows,
      record.exceptionRows,
      record.totalRows > 0 ? record.matchedRows / record.totalRows : "",
      record.durationMs ?? "",
      record.outputDir ?? "",
    ]);
    return [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  }

  async markInterruptedTasks(): Promise<void> {
    const running = (await this.readTaskHistory()).filter((record) => record.status === "running");
    for (const record of running) {
      const completedAt = new Date().toISOString();
      await this.persistTaskRecord({
        ...record,
        status: "interrupted",
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt)),
      });
      const detail = await this.getTaskHistoryDetail(record.id);
      const sequence = (detail?.events.at(-1)?.sequence ?? 0) + 1;
      await this.appendEvent(record.id, {
        id: `${record.id}-${sequence}`,
        sequence,
        time: completedAt,
        level: "error",
        phase: "batch",
        message: "应用上次退出时批次仍在运行，已标记为中断",
      });
    }
  }

  private appendDetailEntry(batchId: string, entry: TaskDetailEntry): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.detailsDir, { recursive: true });
      await appendFile(this.detailPath(batchId), `${JSON.stringify(entry)}\n`, "utf8");
    });
  }

  private async readDetailEntries(batchId: string): Promise<TaskDetailEntry[]> {
    let content = "";
    try {
      content = await readFile(this.detailPath(batchId), "utf8");
    } catch {
      return [];
    }
    const entries: TaskDetailEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TaskDetailEntry;
        if (entry?.kind === "event" || entry?.kind === "file") entries.push(entry);
      } catch {
        // 忽略被中断写入的尾行。
      }
    }
    return entries;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async cleanupDetailFiles(retainedIds: Set<string>): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.detailsDir);
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((name) => name.endsWith(".jsonl") && !retainedIds.has(name.slice(0, -6)))
      .map((name) => rm(join(this.detailsDir, name), { force: true })));
  }
}
