import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskHistoryRecord } from "../../../shared/task-history";
import { createTaskHistoryService } from "../../../backend/electron/main/task-history-service";
import { TaskHistoryStore } from "../../../backend/electron/main/task-history-store";
import {
  aggregateTaskFiles,
  normalizeTaskDiagnostics,
  validateTaskHistoryQuery,
} from "../../../backend/electron/main/task-history-utils";

const temporaryDirectories: string[] = [];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-pricing-history-service-"));
  temporaryDirectories.push(root);
  const store = new TaskHistoryStore(
    join(root, "task-history.jsonl"),
    join(root, "task-details"),
  );
  const onActiveRecordUpdated = vi.fn();
  const service = createTaskHistoryService({
    store,
    maxInputFiles: 10,
    isActiveBatch: () => false,
    onActiveRecordUpdated,
    selectSavePath: async () => null,
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    createBatchId: () => "batch-fixed",
  });
  return { root, store, service, onActiveRecordUpdated };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("task history utilities", () => {
  it("normalizes query fields and ignores invalid statuses", () => {
    expect(validateTaskHistoryQuery({
      from: "2026-07-01T08:00:00",
      statuses: ["completed", "unknown"],
      search: "order",
      page: 2,
    })).toEqual({
      from: "2026-07-01",
      statuses: ["completed"],
      search: "order",
      page: 2,
    });
  });

  it("aggregates file metrics and diagnostics by resolved path", () => {
    expect(aggregateTaskFiles([
      {
        path: "a.xlsx",
        fileName: "a.xlsx",
        status: "completed",
        totalRows: 10,
        matchedRows: 8,
        exceptionRows: 2,
        issueSummaries: [],
      },
      {
        path: "b.xlsx",
        fileName: "b.xlsx",
        status: "failed",
        totalRows: 3,
        matchedRows: 0,
        exceptionRows: 3,
        issueSummaries: [],
      },
    ])).toEqual({
      completedFiles: 1,
      awaitingConfirmationFiles: 0,
      failedFiles: 1,
      totalRows: 13,
      matchedRows: 8,
      exceptionRows: 5,
    });
    expect(normalizeTaskDiagnostics([
      { inputPath: "a.xlsx", issueSummaries: [] },
      { inputPath: 42, issueSummaries: [] },
    ]).size).toBe(1);
  });
});

describe("createTaskHistoryService", () => {
  it("renames the batch output directory and remaps stored file paths", async () => {
    const { root, store, service } = await createFixture();
    const outputRoot = join(root, "output");
    const previousOutputDir = join(outputRoot, "旧批次");
    await mkdir(previousOutputDir, { recursive: true });
    const resultPath = join(previousOutputDir, "订单_核价结果.xlsx");
    await writeFile(resultPath, "result");
    const record: TaskHistoryRecord = {
      id: "batch-1",
      name: "旧批次",
      startedAt: "2026-07-30T10:00:00.000Z",
      status: "completed",
      totalFiles: 1,
      completedFiles: 1,
      failedFiles: 0,
      totalRows: 10,
      matchedRows: 10,
      exceptionRows: 0,
      outputRoot,
      outputDir: previousOutputDir,
      fileNames: ["订单.xlsx"],
      detailAvailable: true,
    };
    await store.persistTaskRecord(record);
    await store.appendFileResult(record.id, {
      path: join(root, "订单.xlsx"),
      fileName: "订单.xlsx",
      status: "completed",
      outputPath: resultPath,
      totalRows: 10,
      matchedRows: 10,
      exceptionRows: 0,
      issueSummaries: [],
    });

    const updated = await service.updateMetadata({
      batchId: record.id,
      name: "新批次",
      note: "  已复核\n完成  ",
    });

    expect(updated.record).toMatchObject({
      name: "新批次",
      note: "已复核 完成",
      outputDir: join(outputRoot, "新批次"),
    });
    expect(updated.files[0]?.outputPath).toBe(join(outputRoot, "新批次", "订单_核价结果.xlsx"));
    expect(await readFile(updated.files[0]!.outputPath!, "utf8")).toBe("result");
  });

  it("archives unresolved files and persists a stopped batch", async () => {
    const { root, store, service } = await createFixture();
    const inputDirectory = join(root, "input");
    const outputRoot = join(root, "output");
    await mkdir(inputDirectory);
    const sourcePath = join(inputDirectory, "订单.xlsx");
    await writeFile(sourcePath, "source");

    const result = await service.finishBatch({
      name: "待处理批次",
      note: "稍后处理",
      files: [sourcePath],
      outputRoot,
    });

    expect(result.record).toMatchObject({
      id: "batch-fixed",
      name: "待处理批次",
      note: "稍后处理",
      status: "stopped",
      totalFiles: 1,
    });
    expect(result.archivedCount).toBe(1);
    expect(await readFile(join(result.unprocessedDir!, "订单.xlsx"), "utf8")).toBe("source");
    expect((await store.getTaskHistoryDetail("batch-fixed"))?.files[0]).toMatchObject({
      status: "stopped",
      archivedPath: join(result.unprocessedDir!, "订单.xlsx"),
    });
  });

  it("discards the batch output and removes it from history", async () => {
    const { root, store, service } = await createFixture();
    const inputDir = join(root, "input");
    const outputRoot = join(root, "output");
    const outputDir = join(outputRoot, "partial-batch");
    await mkdir(inputDir);
    await mkdir(outputDir, { recursive: true });
    const inputPath = join(inputDir, "订单.xlsx");
    const outputPath = join(outputDir, "订单_核价结果.xlsx");
    await writeFile(inputPath, "source");
    await writeFile(outputPath, "result");
    await store.persistTaskRecord({
      id: "batch-1",
      startedAt: "2026-07-30T10:00:00.000Z",
      status: "stopped",
      totalFiles: 2,
      completedFiles: 1,
      failedFiles: 0,
      totalRows: 10,
      matchedRows: 10,
      exceptionRows: 0,
      outputRoot,
      outputDir,
      detailAvailable: true,
    });
    await store.appendFileResult("batch-1", {
      path: inputPath,
      fileName: "订单.xlsx",
      status: "completed",
      outputPath,
      totalRows: 10,
      matchedRows: 10,
      exceptionRows: 0,
      issueSummaries: [],
    });

    const discarded = await service.discardBatch("batch-1");

    expect(discarded).toEqual({ batchId: "batch-1", deletedOutputDirectory: outputDir });
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
    expect(await readFile(inputPath, "utf8")).toBe("source");
    await expect(access(outputRoot)).resolves.toBeUndefined();
    expect(await store.getTaskHistoryDetail("batch-1")).toBeNull();
  });

  it("refuses to discard an output directory outside its registered root", async () => {
    const { root, store, service } = await createFixture();
    const outputRoot = join(root, "output");
    const unsafeDir = join(root, "outside");
    await mkdir(unsafeDir);
    await writeFile(join(unsafeDir, "keep.txt"), "keep");
    await store.persistTaskRecord({
      id: "batch-unsafe",
      startedAt: "2026-07-30T10:00:00.000Z",
      status: "stopped",
      totalFiles: 1,
      completedFiles: 0,
      failedFiles: 0,
      totalRows: 0,
      matchedRows: 0,
      exceptionRows: 0,
      outputRoot,
      outputDir: unsafeDir,
      detailAvailable: true,
    });

    await expect(service.discardBatch("batch-unsafe")).rejects.toThrow("不在登记的输出根目录下");
    expect(await readFile(join(unsafeDir, "keep.txt"), "utf8")).toBe("keep");
    expect(await store.getTaskHistoryDetail("batch-unsafe")).not.toBeNull();
  });
});
