import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAPI, TaskHistoryDetail, TaskHistoryRecord } from "@shared/desktop-api";
import { LogCenterPage } from "@/features/history/components/log-center-page";

const record: TaskHistoryRecord = {
  id: "batch-20260728",
  schemaVersion: 6,
  startedAt: "2026-07-28T01:00:00.000Z",
  completedAt: "2026-07-28T01:01:00.000Z",
  durationMs: 60_000,
  status: "awaiting_confirmation",
  totalFiles: 1,
  completedFiles: 0,
  awaitingConfirmationFiles: 1,
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
    status: "awaiting_confirmation",
    totalRows: 10,
    matchedRows: 9,
    exceptionRows: 1,
    durationMs: 50_000,
    outputPath: "C:\\output\\orders.xlsx",
    issueSummaries: [{
      code: "amount_difference",
      label: "金额差异常",
      count: 1,
      positiveDifferenceRows: 1,
      negativeDifferenceRows: 0,
      samples: [{ sourceRow: 8, country: "", sku: "", quantity: 2, reason: "金额差为正 1.5" }],
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
    code: "amount_difference",
    label: "金额差异常",
    count: 1,
    positiveDifferenceRows: 1,
    negativeDifferenceRows: 0,
    samples: [{ sourceRow: 8, country: "", sku: "", quantity: 2, reason: "金额差为正 1.5" }],
  }],
};

function apiFor(value: TaskHistoryDetail = detail): DesktopAPI {
  return {
    listTaskHistory: vi.fn(async () => ({ items: [value.record], total: 1, page: 1, pageSize: 30 })),
    getTaskHistoryDetail: vi.fn(async () => value),
    updateTaskBatchMetadata: vi.fn(async ({ name, note }) => ({
      ...value,
      record: { ...value.record, name: name || value.record.fileNames?.[0], note },
    })),
    exportTaskHistory: vi.fn(async () => null),
    openPath: vi.fn(async () => ""),
  } as unknown as DesktopAPI;
}

describe("LogCenterPage", () => {
  it("shows batch metrics, file results, issue summaries and timeline", async () => {
    const api = apiFor();
    render(<LogCenterPage api={api} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    const filters = screen.getByRole("region", { name: "批次筛选" });
    expect(within(filters).getByRole("button", { name: "导出列表" })).toBeInTheDocument();
    expect(within(filters).getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "日志中心" })).not.toBeInTheDocument();
    expect(await screen.findByText("orders.xlsx")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("文件结果")).toBeInTheDocument());
    expect(within(screen.getByRole("complementary", { name: "批次列表" })).getByRole("button", { name: /orders\.xlsx/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("region", { name: "文件结果表格" })).toHaveClass("batch-file-table-wrap");
    expect(screen.getByRole("region", { name: "文件结果表格" }).closest(".batch-detail-body")).toHaveClass("is-compact");
    expect(screen.getByText("匹配率", { selector: ".batch-list-metrics small" })).toBeInTheDocument();
    expect(screen.getAllByText("90.0%")).toHaveLength(2);
    const metrics = screen.getByLabelText("批次指标");
    expect(within(metrics).getByText("90.0%").closest("article")).toHaveClass("is-success");
    expect(within(metrics).getByText("待确认文件").closest("article")).toHaveTextContent("1");
    expect(within(metrics).getByText("1 分 0 秒").closest("article")).toHaveClass("is-confirm");
    expect(screen.getByText("金额差异常（正差 1，负差 0）")).toBeInTheDocument();
    expect(screen.getByText("第 8 行")).toHaveClass("batch-issue-row");
    expect(screen.getByText("数量 2")).toHaveClass("is-quantity");
    expect(screen.getByText("金额差为正 1.5").querySelector("strong")).toHaveTextContent("原因");
    expect(screen.getByText("批次开始")).toBeInTheDocument();
    const openResult = screen.getByRole("button", { name: "打开 orders.xlsx 结果" });
    expect(openResult).toHaveClass("file-result-open");
    fireEvent.click(openResult);
    expect(api.openPath).toHaveBeenCalledWith("C:\\output\\orders.xlsx");
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

  it("labels detailed records created before the final anomaly schema", async () => {
    render(<LogCenterPage api={apiFor({ ...detail, record: { ...record, schemaVersion: 5 } })} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    expect(await screen.findByText("旧记录使用原异常口径，未记录核价三列异常明细。")).toBeInTheDocument();
  });

  it("opens an archived unresolved file without falling back to the source", async () => {
    const unresolvedDetail: TaskHistoryDetail = {
      ...detail,
      record: {
        ...record,
        status: "stopped",
        completedFiles: 0,
      },
      files: [{
        ...detail.files[0]!,
        status: "stopped",
        outputPath: undefined,
        archivedPath: "C:\\output\\批次\\未处理\\orders.xlsx",
      }],
    };
    const api = apiFor(unresolvedDetail);
    render(<LogCenterPage api={api} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    const openArchive = await screen.findByRole("button", { name: "打开 orders.xlsx 未处理归档" });
    fireEvent.click(openArchive);
    expect(api.openPath).toHaveBeenCalledWith("C:\\output\\批次\\未处理\\orders.xlsx");
    expect(api.openPath).not.toHaveBeenCalledWith("C:\\input\\orders.xlsx");
  });

  it("filters the detail panels when a file row is selected", async () => {
    render(<LogCenterPage api={apiFor()} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);
    const fileCell = await screen.findByTitle("C:\\input\\orders.xlsx");
    fireEvent.click(fileCell.closest("tr") as HTMLElement);
    expect(await screen.findByText("已筛选：orders.xlsx")).toBeInTheDocument();
  });

  it("uses the full-height split layout when a batch has many files", async () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      ...detail.files[0],
      path: `C:\\input\\orders-${index}.xlsx`,
      fileName: `orders-${index}.xlsx`,
    }));
    render(<LogCenterPage api={apiFor({ ...detail, files })} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    const table = await screen.findByRole("region", { name: "文件结果表格" });
    expect(table.closest(".batch-detail-body")).not.toHaveClass("is-compact");
  });

  it("keeps the previous detail in place while the next batch is loading", async () => {
    const nextRecord = { ...record, id: "batch-next", fileNames: ["next.xlsx"] };
    const nextDetail = {
      ...detail,
      record: nextRecord,
      files: [{ ...detail.files[0], path: "C:\\input\\next.xlsx", fileName: "next.xlsx" }],
    };
    let resolveNextDetail: (value: TaskHistoryDetail) => void = () => undefined;
    const pendingNextDetail = new Promise<TaskHistoryDetail>((resolve) => {
      resolveNextDetail = resolve;
    });
    const api = {
      listTaskHistory: vi.fn(async () => ({ items: [record, nextRecord], total: 2, page: 1, pageSize: 30 })),
      getTaskHistoryDetail: vi.fn((batchId: string) => batchId === record.id ? Promise.resolve(detail) : pendingNextDetail),
      exportTaskHistory: vi.fn(async () => null),
      openPath: vi.fn(async () => ""),
    } as unknown as DesktopAPI;
    render(<LogCenterPage api={api} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    await screen.findByRole("region", { name: "文件结果表格" });
    fireEvent.click(within(screen.getByRole("complementary", { name: "批次列表" })).getByRole("button", { name: /next\.xlsx/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("正在切换批次");
    expect(screen.getByText("orders.xlsx", { selector: ".batch-detail-header h2" })).toBeInTheDocument();
    expect(screen.getByText("orders.xlsx", { selector: ".batch-detail-header h2" }).closest(".batch-detail-content")).toHaveClass("is-updating");

    resolveNextDetail(nextDetail);
    expect(await screen.findByText("next.xlsx", { selector: ".batch-detail-header h2" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("edits and persists the batch name and note", async () => {
    const api = apiFor();
    render(<LogCenterPage api={api} revision={0} requestedBatchId={null} onRequestedBatchHandled={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "名称与备注" }));
    const editor = screen.getByRole("region", { name: "编辑批次名称和备注" });
    fireEvent.change(within(editor).getByLabelText("批次名称"), { target: { value: "法国补发批次" } });
    fireEvent.change(within(editor).getByLabelText("备注"), { target: { value: "七月售后复核" } });
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.updateTaskBatchMetadata).toHaveBeenCalledWith({
      batchId: "batch-20260728",
      name: "法国补发批次",
      note: "七月售后复核",
    }));
    expect(await screen.findAllByText("法国补发批次")).toHaveLength(2);
    expect(screen.getByText("七月售后复核")).toBeInTheDocument();
  });
});
