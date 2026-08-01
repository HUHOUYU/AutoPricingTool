import { basename, resolve } from "node:path";
import type {
  TaskExecutionType,
  TaskFileResult,
  TaskHistoryEvent,
  TaskHistoryRecord,
  TaskHistoryStatus,
  TaskIssueSummary,
} from "../../../shared/task-history";
import { TASK_ISSUE_LABELS } from "../../../shared/task-history";
import type { TaskHistoryStore } from "./task-history-store";
import {
  aggregateTaskFiles,
  normalizePricingAnomalySummary,
  pricingAnomalyIssueSummaries,
} from "./task-history-utils";

export type ActiveTaskRun = {
  record: TaskHistoryRecord;
  existingFiles: TaskFileResult[];
  allFiles: string[];
  runFiles: string[];
  remainingFiles: number;
  executionType: TaskExecutionType;
  diagnostics: Map<string, TaskIssueSummary[]>;
  eventSequence: number;
  isContinuation: boolean;
};

export type ActiveTaskTrackerOptions = {
  store: TaskHistoryStore;
  progressPersistFileInterval: number;
  now?: () => Date;
};

function executionTypeLabel(value: TaskExecutionType): string {
  if (value === "automatic") return "自动处理";
  if (value === "manual") return "人工确认处理";
  return "重新处理";
}

export function createActiveTaskTracker(options: ActiveTaskTrackerOptions) {
  const now = options.now ?? (() => new Date());
  let activeTask: TaskHistoryRecord | null = null;
  let eventSequence = 0;
  let lastPersistedFiles = 0;
  const taskFiles = new Map<string, TaskFileResult>();
  const activeRunFiles = new Set<string>();
  let remainingFiles = 0;
  let executionType: TaskExecutionType = "automatic";

  function persistRecord(record: TaskHistoryRecord): Promise<void> {
    return options.store.persistTaskRecord(record);
  }

  function appendEvent(
    level: TaskHistoryEvent["level"],
    phase: TaskHistoryEvent["phase"],
    message: string,
    filePath?: string,
  ): void {
    if (!activeTask) return;
    eventSequence += 1;
    const event: TaskHistoryEvent = {
      id: `${activeTask.id}-${eventSequence}`,
      sequence: eventSequence,
      time: now().toISOString(),
      level,
      phase,
      message,
      ...(filePath ? { filePath } : {}),
    };
    void options.store.appendEvent(activeTask.id, event);
  }

  function saveFile(file: TaskFileResult): void {
    if (!activeTask) return;
    taskFiles.set(file.path, file);
    void options.store.appendFileResult(activeTask.id, file);
  }

  function aggregateFiles(): Pick<
    TaskHistoryRecord,
    "completedFiles" | "awaitingConfirmationFiles" | "failedFiles" | "totalRows" | "matchedRows" | "exceptionRows"
  > {
    return aggregateTaskFiles([...taskFiles.values()]);
  }

  function reset(): void {
    activeTask = null;
    taskFiles.clear();
    activeRunFiles.clear();
    remainingFiles = 0;
    executionType = "automatic";
    eventSequence = 0;
    lastPersistedFiles = 0;
  }

  function complete(status: TaskHistoryStatus, message: string): void {
    if (!activeTask) return;
    const completedAt = now().toISOString();
    const { completedAt: _previousCompletedAt, ...activeTaskWithoutCompletion } = activeTask;
    for (const path of activeRunFiles) {
      const file = taskFiles.get(path);
      if (!file || (file.status !== "queued" && file.status !== "running")) continue;
      saveFile({
        ...file,
        status: "stopped",
        completedAt,
        durationMs: file.startedAt
          ? Math.max(0, Date.parse(completedAt) - Date.parse(file.startedAt))
          : undefined,
      });
    }
    appendEvent(
      status === "completed" ? "success" : status === "failed" ? "error" : "warning",
      "batch",
      message,
    );
    const completed: TaskHistoryRecord = {
      ...activeTaskWithoutCompletion,
      ...aggregateFiles(),
      status,
      ...(status === "awaiting_confirmation" ? {} : { completedAt }),
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(activeTask.startedAt)),
    };
    reset();
    void persistRecord(completed);
  }

  async function startRun(run: ActiveTaskRun): Promise<void> {
    activeTask = run.record;
    eventSequence = run.eventSequence;
    lastPersistedFiles = 0;
    taskFiles.clear();
    activeRunFiles.clear();
    for (const file of run.existingFiles) taskFiles.set(file.path, file);
    for (const path of run.allFiles) {
      if (taskFiles.has(path)) continue;
      const queuedFile: TaskFileResult = {
        path,
        fileName: basename(path),
        status: "queued",
        totalRows: 0,
        matchedRows: 0,
        exceptionRows: 0,
        issueSummaries: run.diagnostics.get(path) ?? [],
      };
      taskFiles.set(path, queuedFile);
      saveFile(queuedFile);
    }
    for (const path of run.runFiles) activeRunFiles.add(path);
    remainingFiles = run.remainingFiles;
    executionType = run.executionType;
    activeTask = { ...activeTask, ...aggregateFiles() };
    await persistRecord(activeTask);
    appendEvent(
      "info",
      "batch",
      `${run.isContinuation ? "继续批次" : "批次开始"}：${executionTypeLabel(run.executionType)} ${run.runFiles.length} 个文件`,
    );
    for (const path of run.runFiles) {
      const current = taskFiles.get(path);
      saveFile({
        ...(current ?? {
          path,
          fileName: basename(path),
          totalRows: 0,
          matchedRows: 0,
          exceptionRows: 0,
          issueSummaries: [],
        }),
        status: "queued",
        executionType: run.executionType,
        completedAt: undefined,
        durationMs: undefined,
        issueSummaries: run.diagnostics.get(path) ?? current?.issueSummaries ?? [],
      });
    }
  }

  function trackProcessorEvent(event: unknown): void {
    if (!activeTask || !event || typeof event !== "object" || Array.isArray(event)) return;
    const payload = event as Record<string, unknown>;
    if (payload.type === "price-progress" && typeof payload.path === "string" && payload.path) {
      const path = resolve(payload.path);
      const file = taskFiles.get(path);
      if (file?.status === "queued") {
        const startedAt = now().toISOString();
        saveFile({ ...file, status: "running", startedAt });
        appendEvent("info", "file", `开始处理 ${file.fileName}`, path);
      }
    }
    if (payload.type === "log" && typeof payload.message === "string") {
      const level = payload.level === "success" || payload.level === "warning" || payload.level === "error"
        ? payload.level
        : "info";
      appendEvent(level, "processor", payload.message);
    }
    if (payload.type === "error" && typeof payload.message === "string") {
      appendEvent("error", "processor", payload.message);
    }
    if (payload.type === "price-file-result") trackFileResult(payload);
    if (payload.type === "price-done" && payload.mode === "run") completeFromProcessor(payload);
  }

  function trackFileResult(payload: Record<string, unknown>): void {
    if (!activeTask) return;
    const path = typeof payload.path === "string" ? resolve(payload.path) : "";
    const currentFile = taskFiles.get(path);
    const totalRows = typeof payload.totalRows === "number" ? payload.totalRows : 0;
    const matchedRows = typeof payload.matchedRows === "number" ? payload.matchedRows : 0;
    const exceptionRows = typeof payload.exceptionRows === "number" ? payload.exceptionRows : 0;
    const anomalySummary = normalizePricingAnomalySummary(payload.anomalySummary);
    const finalExceptionRows = Math.max(exceptionRows, anomalySummary?.affectedRows ?? 0);
    const completedAt = now().toISOString();
    if (currentFile) {
      const startedAt = currentFile.startedAt ?? activeTask.startedAt;
      const status = payload.status === "failed"
        ? "failed"
        : payload.status === "awaiting_confirmation" || finalExceptionRows > 0
          ? "awaiting_confirmation"
          : "completed";
      const issueSummaries = status === "failed"
        ? [...currentFile.issueSummaries, {
            code: "file_processing" as const,
            label: TASK_ISSUE_LABELS.file_processing,
            count: 1,
            samples: [{
              sourceRow: 0,
              country: "",
              sku: "",
              quantity: null,
              reason: String(payload.message ?? "文件处理失败"),
            }],
          }]
        : pricingAnomalyIssueSummaries(anomalySummary);
      saveFile({
        ...currentFile,
        status,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        totalRows,
        matchedRows,
        exceptionRows: finalExceptionRows,
        ...(anomalySummary ? { anomalySummary } : {}),
        issueSummaries,
        ...(typeof payload.coverage === "number" ? { coverage: payload.coverage } : {}),
        ...(typeof payload.outputPath === "string" ? { outputPath: payload.outputPath } : {}),
        ...(typeof payload.message === "string" ? { message: payload.message } : {}),
      });
      appendEvent(
        status === "failed" ? "error" : status === "awaiting_confirmation" ? "warning" : "success",
        "file",
        status === "failed"
          ? `${currentFile.fileName} 处理失败：${String(payload.message ?? "未知错误")}`
          : status === "awaiting_confirmation"
            ? `${currentFile.fileName} 处理完成：匹配 ${matchedRows}/${totalRows} 行，发现 ${finalExceptionRows} 行核价结果异常，等待确认`
            : `${currentFile.fileName} 处理完成：匹配 ${matchedRows}/${totalRows} 行，异常 0 行`,
        path,
      );
    }
    activeTask = { ...activeTask, ...aggregateFiles() };
    const processedFiles = [...activeRunFiles].filter((runPath) => {
      const status = taskFiles.get(runPath)?.status;
      return status === "completed" || status === "awaiting_confirmation" || status === "failed";
    }).length;
    if (
      processedFiles === activeRunFiles.size
      || processedFiles - lastPersistedFiles >= options.progressPersistFileInterval
    ) {
      lastPersistedFiles = processedFiles;
      void persistRecord(activeTask);
    }
  }

  function completeFromProcessor(payload: Record<string, unknown>): void {
    if (!activeTask) return;
    const status = payload.stopped
      ? "stopped"
      : activeTask.failedFiles > 0
          ? "failed"
          : remainingFiles > 0 || (activeTask.awaitingConfirmationFiles ?? 0) > 0
            ? "awaiting_confirmation"
            : "completed";
    complete(
      status,
      status === "completed"
        ? "批次处理完成"
        : status === "awaiting_confirmation"
          ? `本次${executionTypeLabel(executionType)}完成，仍有 ${(activeTask.awaitingConfirmationFiles ?? 0) + remainingFiles} 个文件待确认`
          : status === "stopped"
            ? "批次已停止"
            : `批次完成，但有 ${activeTask.failedFiles} 个文件失败`,
    );
  }

  return {
    appendEvent,
    complete,
    isActiveBatch: (batchId: string) => activeTask?.id === batchId,
    startRun,
    trackProcessorEvent,
    updateRecord: (record: TaskHistoryRecord) => {
      if (activeTask?.id === record.id) activeTask = record;
    },
  };
}
