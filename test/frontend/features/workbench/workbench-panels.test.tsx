import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BatchFileToolbar,
  BatchProgressPanel,
  WorkbenchPagination,
} from "@/features/workbench/components/workbench-panels";
import type { FileTableModel } from "@/features/workbench/hooks/use-file-table-model";

const tableModel = {
  table: {
    getAllLeafColumns: () => [],
  },
} as unknown as FileTableModel;

describe("workbench panels", () => {
  it("routes batch-name and tab interactions through toolbar callbacks", () => {
    const onBeginBatchNameEdit = vi.fn();
    const onTabChange = vi.fn();
    render(
      <BatchFileToolbar
        visibleFileCount={2}
        fileCount={2}
        batchId={null}
        batchName="测试批次"
        defaultBatchName="默认批次"
        editingBatchName={false}
        activeTab="pending"
        tabCounts={{ pending: 2, queued: 0, confirm: 1, error: 0, success: 0 }}
        tableModel={tableModel}
        onBatchNameChange={vi.fn()}
        onCommitBatchName={vi.fn()}
        onCancelBatchName={vi.fn()}
        onBeginBatchNameEdit={onBeginBatchNameEdit}
        onTabChange={onTabChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑批次名称" }));
    fireEvent.click(screen.getByRole("button", { name: /待确认/ }));

    expect(onBeginBatchNameEdit).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith("confirm");
    expect(screen.getByRole("button", { name: /异常/ })).toHaveClass("is-error");
    expect(screen.getByRole("button", { name: /完成/ })).toHaveClass("is-success");
  });

  it("renders progress details and routes pagination changes", () => {
    const onPageIndexChange = vi.fn();
    const { rerender } = render(
      <BatchProgressPanel
        visible
        taskActive
        phaseLabel="正在核价"
        percent={50}
        current={1}
        total={2}
        fileCount={2}
        activePath="C:\\orders\\a.xlsx"
        actions={null}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "正在核价 50%" })).toBeInTheDocument();
    expect(screen.getByText(/a\.xlsx/)).toBeInTheDocument();

    rerender(
      <WorkbenchPagination
        itemCount={120}
        pageIndex={1}
        pageSize={50}
        pageCount={3}
        onPageIndexChange={onPageIndexChange}
        onPageSizeChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(onPageIndexChange).toHaveBeenNthCalledWith(1, 0);
    expect(onPageIndexChange).toHaveBeenNthCalledWith(2, 2);
  });
});
