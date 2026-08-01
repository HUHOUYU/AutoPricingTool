import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TaskHistoryRecord } from "../../../shared/task-history";
import { createActiveTaskTracker } from "../../../backend/electron/main/active-task-tracker";
import type { TaskHistoryStore } from "../../../backend/electron/main/task-history-store";

function createStore() {
  return {
    appendEvent: vi.fn(async () => undefined),
    appendFileResult: vi.fn(async () => undefined),
    persistTaskRecord: vi.fn(async () => undefined),
  } as unknown as TaskHistoryStore;
}

function runningRecord(path: string): TaskHistoryRecord {
  return {
    id: "batch-1",
    name: "测试批次",
    startedAt: "2026-07-30T10:00:00.000Z",
    status: "running",
    totalFiles: 1,
    completedFiles: 0,
    failedFiles: 0,
    totalRows: 0,
    matchedRows: 0,
    exceptionRows: 0,
    fileNames: [path],
    detailAvailable: true,
  };
}

function createFixture() {
  const store = createStore();
  let tick = 0;
  const tracker = createActiveTaskTracker({
    store,
    progressPersistFileInterval: 10,
    now: () => new Date(Date.parse("2026-07-30T10:00:01.000Z") + tick++ * 1_000),
  });
  return { store, tracker };
}

describe("createActiveTaskTracker", () => {
  it("keeps a file with final pricing anomalies awaiting confirmation", async () => {
    const { store, tracker } = createFixture();
    const path = resolve("订单.xlsx");
    await tracker.startRun({
      record: runningRecord(path),
      existingFiles: [],
      allFiles: [path],
      runFiles: [path],
      remainingFiles: 0,
      executionType: "automatic",
      diagnostics: new Map(),
      eventSequence: 0,
      isContinuation: false,
    });

    tracker.trackProcessorEvent({ type: "price-progress", path });
    tracker.trackProcessorEvent({
      type: "price-file-result",
      path,
      status: "completed",
      totalRows: 10,
      matchedRows: 9,
      exceptionRows: 1,
      outputPath: resolve("订单_核价结果.xlsx"),
      anomalySummary: {
        affectedRows: 1,
        priceUnavailableRows: 0,
        amountDifferenceRows: 1,
        positiveDifferenceRows: 1,
        negativeDifferenceRows: 0,
        quantityAnomalyRows: 0,
        quantityMismatchRows: 0,
        quantityCalculationErrorRows: 0,
        priceUnavailableSamples: [],
        amountDifferenceSamples: [{ sourceRow: 8, reason: "金额差为正 1.5", priceDifference: 1.5 }],
        quantityMismatchSamples: [],
        quantityCalculationErrorSamples: [],
      },
    });
    tracker.trackProcessorEvent({ type: "price-done", mode: "run", stopped: false });

    const persistCalls = vi.mocked(store.persistTaskRecord).mock.calls;
    expect(persistCalls.at(-1)?.[0]).toMatchObject({
      id: "batch-1",
      status: "awaiting_confirmation",
      completedFiles: 0,
      awaitingConfirmationFiles: 1,
      failedFiles: 0,
      totalRows: 10,
      matchedRows: 9,
      exceptionRows: 1,
    });
    expect(vi.mocked(store.appendEvent).mock.calls.map((call) => call[1].message)).toEqual([
      "批次开始：自动处理 1 个文件",
      "开始处理 订单.xlsx",
      "订单.xlsx 处理完成：匹配 9/10 行，发现 1 行核价结果异常，等待确认",
      "本次自动处理完成，仍有 1 个文件待确认",
    ]);
    expect(vi.mocked(store.appendFileResult).mock.calls.some(([, file]) => (
      file.status === "awaiting_confirmation"
      && file.issueSummaries.map((issue) => issue.code).includes("amount_difference")
    ))).toBe(true);
    expect(tracker.isActiveBatch("batch-1")).toBe(false);
  });

  it("keeps a batch awaiting confirmation when files remain", async () => {
    const { store, tracker } = createFixture();
    const path = resolve("订单.xlsx");
    await tracker.startRun({
      record: runningRecord(path),
      existingFiles: [],
      allFiles: [path],
      runFiles: [path],
      remainingFiles: 2,
      executionType: "manual",
      diagnostics: new Map(),
      eventSequence: 4,
      isContinuation: true,
    });

    tracker.trackProcessorEvent({ type: "price-done", mode: "run", stopped: false });

    expect(vi.mocked(store.persistTaskRecord).mock.calls.at(-1)?.[0]).toMatchObject({
      status: "awaiting_confirmation",
    });
    expect(vi.mocked(store.appendEvent).mock.calls.at(-1)?.[1]).toMatchObject({
      sequence: 6,
      message: "本次人工确认处理完成，仍有 2 个文件待确认",
    });
  });

  it("marks unfinished run files as stopped", async () => {
    const { store, tracker } = createFixture();
    const path = resolve("订单.xlsx");
    await tracker.startRun({
      record: runningRecord(path),
      existingFiles: [],
      allFiles: [path],
      runFiles: [path],
      remainingFiles: 0,
      executionType: "retry",
      diagnostics: new Map(),
      eventSequence: 0,
      isContinuation: false,
    });

    tracker.complete("stopped", "批次已由用户停止");

    expect(vi.mocked(store.appendFileResult).mock.calls.at(-1)?.[1]).toMatchObject({
      path,
      status: "stopped",
    });
    expect(vi.mocked(store.persistTaskRecord).mock.calls.at(-1)?.[0]).toMatchObject({
      status: "stopped",
    });
  });

  it("keeps failed files above awaiting-confirmation files in the batch status", async () => {
    const { store, tracker } = createFixture();
    const awaitingPath = resolve("待确认.xlsx");
    const failedPath = resolve("失败.xlsx");
    await tracker.startRun({
      record: { ...runningRecord(awaitingPath), totalFiles: 2, fileNames: [awaitingPath, failedPath] },
      existingFiles: [],
      allFiles: [awaitingPath, failedPath],
      runFiles: [awaitingPath, failedPath],
      remainingFiles: 0,
      executionType: "automatic",
      diagnostics: new Map(),
      eventSequence: 0,
      isContinuation: false,
    });

    tracker.trackProcessorEvent({
      type: "price-file-result",
      path: awaitingPath,
      status: "awaiting_confirmation",
      totalRows: 2,
      matchedRows: 2,
      exceptionRows: 1,
    });
    tracker.trackProcessorEvent({
      type: "price-file-result",
      path: failedPath,
      status: "failed",
      message: "写入结果文件失败",
    });
    tracker.trackProcessorEvent({ type: "price-done", mode: "run", stopped: false });

    expect(vi.mocked(store.persistTaskRecord).mock.calls.at(-1)?.[0]).toMatchObject({
      status: "failed",
      awaitingConfirmationFiles: 1,
      failedFiles: 1,
    });
  });
});
