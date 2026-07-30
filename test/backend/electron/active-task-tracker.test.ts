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
  it("tracks a file from queued to completed and persists the final batch", async () => {
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
    });
    tracker.trackProcessorEvent({ type: "price-done", mode: "run", stopped: false });

    const persistCalls = vi.mocked(store.persistTaskRecord).mock.calls;
    expect(persistCalls.at(-1)?.[0]).toMatchObject({
      id: "batch-1",
      status: "completed",
      completedFiles: 1,
      failedFiles: 0,
      totalRows: 10,
      matchedRows: 9,
      exceptionRows: 1,
    });
    expect(vi.mocked(store.appendEvent).mock.calls.map((call) => call[1].message)).toEqual([
      "批次开始：自动处理 1 个文件",
      "开始处理 订单.xlsx",
      "订单.xlsx 处理完成：匹配 9/10 行，异常 1 行",
      "批次处理完成",
    ]);
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
      message: "本次人工确认处理完成，仍有 2 个文件待处理",
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
});
