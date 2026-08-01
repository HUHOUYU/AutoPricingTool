import { access, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskFileResult, TaskHistoryRecord } from "../../../shared/task-history";
import { TaskHistoryStore, TASK_HISTORY_SCHEMA_VERSION } from "../../../backend/electron/main/task-history-store";

const temporaryDirs: string[] = [];

function localDate(value: string): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function createStore(): Promise<{ root: string; store: TaskHistoryStore; historyPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "auto-pricing-history-"));
  temporaryDirs.push(root);
  const historyPath = join(root, "runtime", "task-history.jsonl");
  return {
    root,
    historyPath,
    store: new TaskHistoryStore(historyPath, join(root, "runtime", "task-details")),
  };
}

function record(overrides: Partial<TaskHistoryRecord> = {}): TaskHistoryRecord {
  return {
    id: "batch-1",
    schemaVersion: TASK_HISTORY_SCHEMA_VERSION,
    startedAt: "2026-07-28T01:00:00.000Z",
    completedAt: "2026-07-28T01:01:00.000Z",
    durationMs: 60_000,
    status: "completed",
    totalFiles: 1,
    completedFiles: 1,
    failedFiles: 0,
    totalRows: 10,
    matchedRows: 9,
    exceptionRows: 1,
    outputDir: "C:\\output",
    fileNames: ["orders.xlsx"],
    detailAvailable: true,
    ...overrides,
  };
}

function fileResult(overrides: Partial<TaskFileResult> = {}): TaskFileResult {
  return {
    path: "C:\\input\\orders.xlsx",
    fileName: "orders.xlsx",
    status: "completed",
    startedAt: "2026-07-28T01:00:00.000Z",
    completedAt: "2026-07-28T01:01:00.000Z",
    durationMs: 60_000,
    outputPath: "C:\\output\\orders.xlsx",
    totalRows: 10,
    matchedRows: 9,
    exceptionRows: 1,
    coverage: 0.9,
    issueSummaries: [{
      code: "country_route",
      label: "国家路由",
      count: 1,
      samples: [{ sourceRow: 8, country: "FR-D", sku: "SKU-1", quantity: 2, reason: "国家路由不存在" }],
    }],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
describe("task history store", () => {
  it("persists batch details and reconciles analytics from the same records", async () => {
    const { store } = await createStore();
    await store.persistTaskRecord(record());
    await store.appendFileResult("batch-1", fileResult());
    await store.appendEvent("batch-1", {
      id: "batch-1-1",
      sequence: 1,
      time: "2026-07-28T01:00:00.000Z",
      level: "info",
      phase: "batch",
      message: "批次开始",
    });

    const detail = await store.getTaskHistoryDetail("batch-1");
    expect(detail?.legacy).toBe(false);
    expect(detail?.files).toHaveLength(1);
    expect(detail?.issueSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "country_route", count: 1 }),
    ]));

    const recordDate = localDate(record().startedAt);
    const analytics = await store.getTaskAnalytics({ from: recordDate, to: recordDate });
    expect(analytics.totals).toMatchObject({
      batches: 1,
      files: 1,
      rows: 10,
      matchedRows: 9,
      matchRate: 0.9,
      exceptions: 1,
      averageDurationMs: 60_000,
    });
    expect(analytics.issues).toEqual([{ code: "country_route", label: "国家路由", count: 1 }]);
  });

  it("keeps legacy summaries readable and ignores a truncated final line", async () => {
    const { store, historyPath } = await createStore();
    await store.persistTaskRecord(record({ schemaVersion: undefined, detailAvailable: undefined }));
    await appendFile(historyPath, "{\"id\":\"truncated\"", "utf8");

    const page = await store.listTaskHistory({ search: "orders.xlsx" });
    expect(page.items).toHaveLength(1);
    const detail = await store.getTaskHistoryDetail("batch-1");
    expect(detail?.legacy).toBe(true);
    expect(detail?.files).toEqual([]);
  });

  it("marks running batches interrupted and preserves a detail event", async () => {
    const { store } = await createStore();
    await store.persistTaskRecord(record({
      status: "running",
      completedAt: undefined,
      durationMs: undefined,
      completedFiles: 0,
      totalRows: 0,
      matchedRows: 0,
      exceptionRows: 0,
    }));
    await store.markInterruptedTasks();

    const [saved] = await store.readTaskHistory();
    expect(saved.status).toBe("interrupted");
    const detail = await store.getTaskHistoryDetail(saved.id);
    expect(detail?.events.at(-1)?.message).toContain("已标记为中断");
  });

  it("removes detail files for records outside the retention period", async () => {
    const { store } = await createStore();
    const oldId = "old-batch";
    await store.appendFileResult(oldId, fileResult());
    await store.persistTaskRecord(record({
      id: oldId,
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:01:00.000Z",
    }));

    await expect(access(store.detailPath(oldId))).rejects.toThrow();
    expect(await store.readTaskHistory()).toEqual([]);
  });

  it("deletes one batch summary and its detail file", async () => {
    const { store } = await createStore();
    await store.persistTaskRecord(record());
    await store.persistTaskRecord(record({ id: "batch-2" }));
    await store.appendFileResult("batch-1", fileResult());

    await store.deleteTaskHistory("batch-1");

    expect((await store.readTaskHistory()).map((item) => item.id)).toEqual(["batch-2"]);
    await expect(access(store.detailPath("batch-1"))).rejects.toThrow();
  });

  it("exports filtered batch rows as Excel-friendly CSV content", async () => {
    const { store } = await createStore();
    await store.persistTaskRecord(record());
    await store.persistTaskRecord(record({ id: "batch-2", status: "failed", fileNames: ["failed.xlsx"] }));

    const csv = await store.exportHistoryCsv({ statuses: ["failed"] });
    expect(csv).toContain("批次ID");
    expect(csv).toContain("batch-2");
    expect(csv).not.toContain("batch-1,");
    expect((await readFile(store.detailPath("missing"), "utf8").catch(() => ""))).toBe("");
  });

  it("filters history and analytics by batch name, note, or file name", async () => {
    const { store } = await createStore();
    await store.persistTaskRecord(record({
      name: "法国补发批次",
      note: "七月售后复核",
    }));
    await store.persistTaskRecord(record({
      id: "batch-2",
      name: "英国正常订单",
      note: "日常核价",
      fileNames: ["uk-orders.xlsx"],
    }));

    expect((await store.listTaskHistory({ search: "售后" })).items.map((item) => item.id)).toEqual(["batch-1"]);
    expect((await store.listTaskHistory({ search: "uk-orders" })).items.map((item) => item.id)).toEqual(["batch-2"]);

    const recordDate = localDate(record().startedAt);
    const analytics = await store.getTaskAnalytics({
      from: recordDate,
      to: recordDate,
      search: "法国补发",
    });
    expect(analytics.totals.batches).toBe(1);
    expect(analytics.records.map((item) => item.id)).toEqual(["batch-1"]);
  });
});
