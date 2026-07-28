import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAPI, TaskAnalyticsSummary } from "../../../preload";
import { AnalyticsPage } from "./analytics-page";

const analytics: TaskAnalyticsSummary = {
  totals: {
    batches: 2,
    files: 3,
    rows: 100,
    matchedRows: 95,
    matchRate: 0.95,
    exceptions: 5,
    averageDurationMs: 90_000,
  },
  trend: [{ date: "2026-07-28", batches: 2, files: 3, totalRows: 100, matchedRows: 95, matchRate: 0.95, exceptions: 5 }],
  statuses: [
    { status: "completed", count: 1 },
    { status: "failed", count: 1 },
  ],
  issues: [{ code: "sku", label: "SKU", count: 5 }],
  records: [{
    id: "batch-1",
    startedAt: "2026-07-28T01:00:00.000Z",
    completedAt: "2026-07-28T01:01:00.000Z",
    durationMs: 60_000,
    status: "completed",
    totalFiles: 3,
    completedFiles: 3,
    failedFiles: 0,
    totalRows: 100,
    matchedRows: 95,
    exceptionRows: 5,
    detailAvailable: true,
  }],
};

describe("AnalyticsPage", () => {
  it("uses one reconciled source for metrics and batch drill-down", async () => {
    const onOpenBatch = vi.fn();
    const api = { getTaskAnalytics: vi.fn(async () => analytics) } as unknown as DesktopAPI;
    render(<AnalyticsPage api={api} dark={false} revision={0} onOpenBatch={onOpenBatch} />);

    const filters = screen.getByRole("region", { name: "统计时间范围" });
    expect(within(filters).getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "数据统计" })).not.toBeInTheDocument();
    expect(await screen.findAllByText("95.0%")).toHaveLength(2);
    expect(screen.getByText("95.0%", { selector: ".analytics-metrics strong" }).closest("article")).toHaveClass("is-success");
    expect(screen.getByText("5", { selector: ".analytics-metrics strong" }).closest("article")).toHaveClass("is-error");
    expect(screen.getByText("1 分 30 秒").closest("article")).toHaveClass("is-warning");
    fireEvent.click(screen.getByText("已完成").closest("tr") as HTMLElement);
    expect(onOpenBatch).toHaveBeenCalledWith("batch-1");
  });

  it("shows an explicit empty state instead of zero-like business metrics", async () => {
    const api = {
      getTaskAnalytics: vi.fn(async () => ({
        ...analytics,
        totals: { batches: 0, files: 0, rows: 0, matchedRows: 0, matchRate: null, exceptions: 0, averageDurationMs: null },
        trend: [],
        statuses: [],
        issues: [],
        records: [],
      })),
    } as unknown as DesktopAPI;
    render(<AnalyticsPage api={api} dark={false} revision={0} onOpenBatch={() => undefined} />);
    expect(await screen.findByText("所选时间范围内没有处理记录")).toBeInTheDocument();
  });
});
