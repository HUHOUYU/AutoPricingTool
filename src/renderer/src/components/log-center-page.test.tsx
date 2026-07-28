import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAPI, TaskHistoryDetail, TaskHistoryRecord } from "../../../preload";
import { LogCenterPage } from "./log-center-page";

const record: TaskHistoryRecord = {
  id: "batch-20260728",
  schemaVersion: 2,
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
};

const detail: TaskHistoryDetail = {
  record,
  legacy: false,
  files: [{
    path: "C:\\input\\orders.xlsx",
    fileName: "orders.xlsx",
    status: "completed",
    totalRows: 10,
    matchedRows: 9,
    exceptionRows: 1,
    durationMs: 50_000,
    outputPath: "C:\\output\\orders.xlsx",
    issueSummaries: [{
      code: "country_route",
      label: "国家路由",
      count: 1,
      samples: [{ sourceRow: 8, country: "FR-D", sku: "SKU-1", quantity: 2, reason: "国家路由不存在" }],
    }],
  }],
  events: [{
    id: "event-1",
    sequence: 1,
    time: "2026-07-28T01:00:00.000Z",
    level: "info",
    phase: "batch",
    message: "批次开始",
  }],
  issueSummaries: [{
    code: "country_route",
    label: "国家路由",
    count: 1,
    samples: [{ sourceRow: 8, country: "FR-D", sku: "SKU-1", quantity: 2, reason: "国家路由不存在" }],
  }],
};

function apiFor(value: TaskHistoryDetail = detail): DesktopAPI {
  return {
    listTaskHistory: vi.fn(async () => ({ items: [value.record], total: 1, page: 1, pageSize: 30 })),
    getTaskHistoryDetail: vi.fn(async () => value),
    exportTaskHistory: vi.fn(async () => null),
    openPath: vi.fn(async () => ""),
  } as unknown as DesktopAPI;
}

describe("LogCenterPage", () => {
  it("shows batch metrics, file results, issue summaries and timeline", async () => {
    render(<LogCenterPage api={apiFor()} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    const filters = screen.getByRole("region", { name: "批次筛选" });
    expect(within(filters).getByRole("button", { name: "导出列表" })).toBeInTheDocument();
    expect(within(filters).getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "日志中心" })).not.toBeInTheDocument();
    expect(await screen.findByText("orders.xlsx")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("文件结果")).toBeInTheDocument());
    expect(screen.getAllByText("90.0%")).toHaveLength(2);
    const metrics = screen.getByLabelText("批次指标");
    expect(within(metrics).getByText("90.0%").closest("article")).toHaveClass("is-success");
    expect(within(metrics).getByText("1 分 0 秒").closest("article")).toHaveClass("is-confirm");
    expect(screen.getByText("国家路由")).toBeInTheDocument();
    expect(screen.getByText("批次开始")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 orders.xlsx 结果" })).toHaveClass("file-result-open");
  });

  it("marks old records as summary-only instead of inventing details", async () => {
    const legacyDetail: TaskHistoryDetail = {
      record: { ...record, detailAvailable: false },
      files: [],
      events: [],
      issueSummaries: [],
      legacy: true,
    };
    render(<LogCenterPage api={apiFor(legacyDetail)} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    expect(await screen.findByText("仅有汇总")).toBeInTheDocument();
    expect(await screen.findByText("该批次由旧版本创建，历史版本未记录文件明细。")).toBeInTheDocument();
  });

  it("filters the detail panels when a file row is selected", async () => {
    render(<LogCenterPage api={apiFor()} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);
    const fileCell = await screen.findByTitle("C:\\input\\orders.xlsx");
    fireEvent.click(fileCell.closest("tr") as HTMLElement);
    expect(await screen.findByText("已筛选：orders.xlsx")).toBeInTheDocument();
  });
});
