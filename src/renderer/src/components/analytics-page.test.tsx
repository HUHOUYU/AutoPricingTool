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
    name: "法国补发批次",
    note: "七月售后复核",
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
    expect(within(filters).getByRole("button", { name: "最近 30 天" })).toHaveTextContent("近 30 天");
    expect(within(filters).getByRole("button", { name: "最近 60 天" })).toHaveTextContent("近 60 天");
    expect(within(filters).getByRole("button", { name: "最近 90 天" })).toHaveTextContent("近 90 天");
    expect(within(filters).getByRole("button", { name: "自定义日期" })).toHaveTextContent("自定义");
    expect(filters.querySelectorAll(".analytics-range-label-compact")).toHaveLength(4);
    expect(within(filters).getByRole("textbox", { name: "批次" })).toHaveAttribute("placeholder", "批次");
    expect(within(filters).getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "数据统计" })).not.toBeInTheDocument();
    expect(await screen.findAllByText("95.0%")).toHaveLength(2);
    expect(screen.getByText("95.0%", { selector: ".analytics-metrics strong" }).closest("article")).toHaveClass("is-success");
    expect(screen.getByText("5", { selector: ".analytics-metrics strong" }).closest("article")).toHaveClass("is-error");
    expect(screen.getByText("1 分 30 秒").closest("article")).toHaveClass("is-warning");
    expect(screen.getByRole("region", { name: "批次明细表格" })).toHaveClass("analytics-records-table");
    expect(screen.getByText("法国补发批次")).toHaveAttribute("title", "七月售后复核");
    expect(screen.getByText("共 1 条 · 第 1-1 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    fireEvent.click(screen.getByText("已完成").closest("tr") as HTMLElement);
    expect(onOpenBatch).toHaveBeenCalledWith("batch-1");
  });

  it("paginates batch records instead of creating a long scrolling table", async () => {
    const onOpenBatch = vi.fn();
    const records = Array.from({ length: 11 }, (_, index) => ({
      ...analytics.records[0],
      id: `batch-${index + 1}`,
      totalRows: index + 1,
      matchedRows: index + 1,
    }));
    const api = { getTaskAnalytics: vi.fn(async () => ({ ...analytics, records })) } as unknown as DesktopAPI;
    render(<AnalyticsPage api={api} dark={false} revision={0} onOpenBatch={onOpenBatch} />);

    expect(await screen.findByText("共 11 条 · 第 1-10 条")).toBeInTheDocument();
    expect(screen.getByText("批次明细").closest("section")).toHaveClass("is-filled-page");
    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("共 11 条 · 第 11-11 条")).toBeInTheDocument();
    expect(screen.getByText("批次明细").closest("section")).toHaveClass("is-compact-page");
    const rows = screen.getByRole("region", { name: "批次明细表格" }).querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0]);
    expect(onOpenBatch).toHaveBeenCalledWith("batch-11");
  });

  it("keeps the footer outside the scrollable table when showing 50 records", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const records = Array.from({ length: 51 }, (_, index) => ({
      ...analytics.records[0],
      id: `batch-${index + 1}`,
      totalRows: index + 1,
      matchedRows: index + 1,
    }));
    const api = { getTaskAnalytics: vi.fn(async () => ({ ...analytics, records })) } as unknown as DesktopAPI;
    render(<AnalyticsPage api={api} dark={false} revision={0} onOpenBatch={() => undefined} />);

    await screen.findByText("共 51 条 · 第 1-10 条");
    fireEvent.click(screen.getByRole("combobox", { name: "每页条数" }));
    fireEvent.click(await screen.findByRole("option", { name: "50 条" }));

    expect(screen.getByText("共 51 条 · 第 1-50 条")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "批次明细表格" }).querySelectorAll("tbody tr")).toHaveLength(50);
    expect(screen.getByText("共 51 条 · 第 1-50 条").closest("footer")).toHaveClass("analytics-table-footer");
    expect(screen.getByText("批次明细").closest("section")).not.toHaveClass("is-compact-page", "is-filled-page");
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

  it("applies the keyword to the whole analytics query", async () => {
    const api = { getTaskAnalytics: vi.fn(async () => analytics) } as unknown as DesktopAPI;
    render(<AnalyticsPage api={api} dark={false} revision={0} onOpenBatch={() => undefined} />);

    const search = await screen.findByRole("textbox", { name: "批次" });
    fireEvent.change(search, { target: { value: "法国补发" } });

    expect(await screen.findByText("法国补发批次")).toBeInTheDocument();
    expect(api.getTaskAnalytics).toHaveBeenLastCalledWith(expect.objectContaining({ search: "法国补发" }));
  });
});
