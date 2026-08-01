import { access, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type {
  TaskAnalyticsQuery,
  TaskBatchDiscardResult,
  TaskBatchFinishRequest,
  TaskBatchFinishResult,
  TaskHistoryDetail,
  TaskHistoryExportRequest,
  TaskHistoryRecord,
  TaskRunDiagnostics,
} from "../../../shared/task-history";
import {
  archiveUnprocessedFiles,
  createBatchOutputDirectory,
  remapBatchOutputPath,
  renameBatchOutputDirectory,
} from "./batch-output";
import { samePath } from "./path-utils";
import { TASK_HISTORY_SCHEMA_VERSION, type TaskHistoryStore } from "./task-history-store";
import {
  aggregateTaskFiles,
  batchName,
  batchNote,
  defaultBatchName,
  normalizeTaskDiagnostics,
  requireRecord,
  validateBatchId,
  validateTaskBatchMetadataUpdate,
  validateTaskHistoryQuery,
} from "./task-history-utils";

const SUPPORTED_EXCEL_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xlsb", ".xls"]);
const WINDOWS_MAX_PATH_LENGTH = 32_767;

type SaveDialogFilter = {
  name: string;
  extensions: string[];
};

export type TaskHistoryServiceOptions = {
  store: TaskHistoryStore;
  maxInputFiles: number;
  isActiveBatch: (batchId: string) => boolean;
  onActiveRecordUpdated: (record: TaskHistoryRecord) => void;
  selectSavePath: (defaultPath: string, filters: SaveDialogFilter[]) => Promise<string | null>;
  now?: () => Date;
  createBatchId?: () => string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function validateFinishRequest(value: unknown, maxInputFiles: number): Promise<TaskBatchFinishRequest> {
  const input = requireRecord(value, "批次结束参数");
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > maxInputFiles) {
    throw new TypeError(`批次结束参数 files 必须是 1-${maxInputFiles} 个文件路径`);
  }
  const files: string[] = [];
  for (const item of input.files) {
    const validPath = typeof item === "string"
      && isAbsolute(item)
      && SUPPORTED_EXCEL_EXTENSIONS.has(extname(item).toLocaleLowerCase())
      && await pathExists(item);
    if (!validPath) {
      throw new TypeError(`未处理文件不存在或不是有效的 Excel 文件：${String(item)}`);
    }
    files.push(resolve(item));
  }
  if (typeof input.outputRoot !== "string"
    || !isAbsolute(input.outputRoot)
    || input.outputRoot.length > WINDOWS_MAX_PATH_LENGTH) {
    throw new TypeError("批次结束参数 outputRoot 必须是有效的绝对路径");
  }
  return {
    ...(input.batchId !== undefined ? { batchId: validateBatchId(input.batchId) } : {}),
    name: batchName(input.name),
    ...(input.note !== undefined ? { note: batchNote(input.note) } : {}),
    files,
    outputRoot: resolve(input.outputRoot),
    ...(Array.isArray(input.diagnostics) ? { diagnostics: input.diagnostics as TaskRunDiagnostics[] } : {}),
  };
}

export function createTaskHistoryService(options: TaskHistoryServiceOptions) {
  const now = options.now ?? (() => new Date());
  const createBatchId = options.createBatchId
    ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  async function updateMetadata(value: unknown): Promise<TaskHistoryDetail> {
    const update = validateTaskBatchMetadataUpdate(value);
    const detail = await options.store.getTaskHistoryDetail(update.batchId);
    if (!detail) throw new Error("批次不存在");
    if (update.name !== undefined && options.isActiveBatch(update.batchId)) {
      throw new Error("批次处理中不能修改名称，请在本轮处理完成后重试");
    }
    const nextName = update.name === undefined
      ? detail.record.name
      : update.name || defaultBatchName(detail.record.fileNames, detail.record.id);
    let nextOutputDir = detail.record.outputDir;
    let nextFiles = detail.files;
    if (update.name !== undefined && nextName && detail.record.outputRoot && detail.record.outputDir) {
      const previousOutputDir = detail.record.outputDir;
      nextOutputDir = await renameBatchOutputDirectory(
        detail.record.outputRoot,
        previousOutputDir,
        nextName,
        detail.record.id,
      );
      if (!samePath(previousOutputDir, nextOutputDir)) {
        nextFiles = detail.files.map((file) => ({
          ...file,
          ...(file.outputPath
            ? { outputPath: remapBatchOutputPath(file.outputPath, previousOutputDir, nextOutputDir!) }
            : {}),
          ...(file.archivedPath
            ? { archivedPath: remapBatchOutputPath(file.archivedPath, previousOutputDir, nextOutputDir!) }
            : {}),
        }));
        for (const file of nextFiles) await options.store.appendFileResult(detail.record.id, file);
      }
    }
    const record: TaskHistoryRecord = {
      ...detail.record,
      ...(update.name !== undefined ? { name: nextName } : {}),
      ...(update.note !== undefined ? { note: update.note } : {}),
      ...(nextOutputDir ? { outputDir: nextOutputDir } : {}),
    };
    await options.store.persistTaskRecord(record);
    if (options.isActiveBatch(record.id)) options.onActiveRecordUpdated(record);
    return { ...detail, record, files: nextFiles };
  }

  async function finishBatch(value: unknown): Promise<TaskBatchFinishResult> {
    const request = await validateFinishRequest(value, options.maxInputFiles);
    const id = request.batchId ?? createBatchId();
    if (options.isActiveBatch(id)) throw new Error("批次仍在处理中");
    const detail = await options.store.getTaskHistoryDetail(id);
    if (request.batchId && !detail) throw new Error("批次不存在");
    const diagnostics = normalizeTaskDiagnostics(request.diagnostics);
    const filesByPath = new Map((detail?.files ?? []).map((file) => [resolve(file.path), file]));
    for (const path of request.files) {
      if (filesByPath.has(path)) continue;
      filesByPath.set(path, {
        path,
        fileName: basename(path),
        status: "queued",
        totalRows: 0,
        matchedRows: 0,
        exceptionRows: 0,
        issueSummaries: diagnostics.get(path) ?? [],
      });
    }
    const currentFiles = [...filesByPath.values()];
    const unresolvedFiles = currentFiles.filter((file) => file.status !== "completed");
    if (unresolvedFiles.length === 0) throw new Error("当前批次没有需要归档的未处理文件");
    const name = request.name
      || detail?.record.name
      || defaultBatchName(request.files.map((path) => basename(path)), id);
    const outputRoot = detail?.record.outputRoot ?? request.outputRoot;
    const outputDir = detail?.record.outputDir
      ?? await createBatchOutputDirectory(outputRoot, name, id);
    let archived: Awaited<ReturnType<typeof archiveUnprocessedFiles>>;
    try {
      archived = await archiveUnprocessedFiles(
        outputDir,
        id,
        unresolvedFiles.map((file) => file.path),
      );
    } catch (error) {
      throw new Error(`归档未处理文件失败：${String(error)}`);
    }
    const completedAt = now().toISOString();
    const archivedPaths = new Map(archived.files.map((file) => [file.sourcePath, file.archivedPath]));
    const files = currentFiles.map((file) => file.status === "completed"
      ? file
      : {
          ...file,
          ...(file.status === "queued" || file.status === "running" ? { status: "stopped" as const } : {}),
          completedAt: file.completedAt ?? completedAt,
          archivedPath: archivedPaths.get(resolve(file.path)),
        });
    const record: TaskHistoryRecord = {
      ...(detail?.record ?? {
        id,
        startedAt: completedAt,
        status: "stopped" as const,
        totalFiles: files.length,
        completedFiles: 0,
        failedFiles: 0,
        totalRows: 0,
        matchedRows: 0,
        exceptionRows: 0,
      }),
      id,
      name,
      ...(request.note !== undefined ? { note: request.note } : {}),
      schemaVersion: TASK_HISTORY_SCHEMA_VERSION,
      ...aggregateTaskFiles(files),
      totalFiles: files.length,
      status: "stopped",
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(detail?.record.startedAt ?? completedAt)),
      outputRoot,
      outputDir,
      fileNames: files.map((file) => file.fileName),
      detailAvailable: true,
    };
    const nextSequence = (detail?.events.at(-1)?.sequence ?? 0) + 1;
    try {
      for (const file of files.filter((file) => file.status !== "completed")) {
        await options.store.appendFileResult(id, file);
      }
      await options.store.appendEvent(id, {
        id: `${id}-${nextSequence}`,
        sequence: nextSequence,
        time: completedAt,
        level: "warning",
        phase: "batch",
        message: `用户结束当前批次，${unresolvedFiles.length} 个未完成文件已归档到：${archived.directory}`,
      });
      await options.store.persistTaskRecord(record);
    } catch (error) {
      await rm(archived.directory, { recursive: true, force: true });
      throw new Error(`保存批次结束记录失败：${String(error)}`);
    }
    return {
      record,
      archivedCount: unresolvedFiles.length,
      unprocessedDir: archived.directory,
    };
  }

  async function discardBatch(value: unknown): Promise<TaskBatchDiscardResult> {
    const id = validateBatchId(value);
    if (options.isActiveBatch(id)) throw new Error("批次仍在处理中");
    const detail = await options.store.getTaskHistoryDetail(id);
    if (!detail) throw new Error("批次不存在");
    const outputDir = detail.record.outputDir;
    const outputRoot = detail.record.outputRoot;
    if (outputDir) {
      if (!outputRoot || !samePath(dirname(resolve(outputDir)), resolve(outputRoot))) {
        throw new Error("批次输出目录不在登记的输出根目录下，已停止删除");
      }
      await rm(outputDir, { recursive: true, force: true });
    }
    await options.store.deleteTaskHistory(id);
    return {
      batchId: id,
      ...(outputDir ? { deletedOutputDirectory: outputDir } : {}),
    };
  }

  async function exportHistory(value: unknown): Promise<string | null> {
    const input = requireRecord(value, "历史导出参数") as Partial<TaskHistoryExportRequest>;
    if (input.format === "json") {
      const batchId = validateBatchId(input.batchId);
      const content = await options.store.exportBatchJson(batchId);
      if (content === null) throw new Error("批次不存在");
      const path = await options.selectSavePath(
        `pricing-batch-${batchId}.json`,
        [{ name: "JSON 文件", extensions: ["json"] }],
      );
      if (!path) return null;
      await writeFile(path, content, "utf8");
      return path;
    }
    if (input.format === "csv") {
      const query = validateTaskHistoryQuery(input.query);
      const content = await options.store.exportHistoryCsv(query);
      const path = await options.selectSavePath(
        `pricing-batches-${now().toISOString().slice(0, 10)}.csv`,
        [{ name: "CSV 文件", extensions: ["csv"] }],
      );
      if (!path) return null;
      await writeFile(path, `\uFEFF${content}`, "utf8");
      return path;
    }
    throw new TypeError("不支持的历史导出格式");
  }

  return {
    getSummary: () => options.store.getTaskHistorySummary(),
    list: (query: unknown) => options.store.listTaskHistory(validateTaskHistoryQuery(query)),
    getDetail: (batchId: unknown) => options.store.getTaskHistoryDetail(validateBatchId(batchId)),
    updateMetadata,
    discardBatch,
    finishBatch,
    getAnalytics: (query: unknown) => {
      const validated = validateTaskHistoryQuery(query);
      const analyticsQuery: TaskAnalyticsQuery = {
        from: validated.from,
        to: validated.to,
        search: validated.search,
      };
      return options.store.getTaskAnalytics(analyticsQuery);
    },
    exportHistory,
  };
}
