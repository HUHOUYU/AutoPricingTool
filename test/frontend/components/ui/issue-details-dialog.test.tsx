import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueDetailsDialog, type IssueDetail } from "@/components/ui/issue-details-dialog";

describe("IssueDetailsDialog", () => {
  it("renders one compact table for 100 issues and preserves SKU details", () => {
    const longSku = "TC3348-L-4-VERY-LONG-SKU-VALUE-FOR-ELLIPSIS";
    const issues: IssueDetail[] = Array.from({ length: 100 }, (_, index) => ({
      label: `第 ${index + 2} 行`,
      message: `第 ${index + 1} 个数量问题`,
      ...(index === 0 ? {
        emphasis: [
          { label: "类型", value: "数量档位不存在", tone: "danger" as const },
          { label: "国家", value: "FR-D", tone: "warning" as const },
          { label: "数量", value: "2", tone: "info" as const },
        ],
        message: "核价 Sheet price 的国家路由 FR-D、SKU TC3348-L-4 没有数量 2 对应的档位",
        messageHighlights: [
          { value: "没有数量 2 对应的档位", tone: "danger" as const },
          { value: "price", tone: "info" as const },
          { value: "FR-D", tone: "warning" as const },
          { value: "TC3348-L-4", tone: "info" as const },
          { value: "2", tone: "info" as const },
        ],
      } : {}),
      ...(index === 99 ? {} : {
        skuTags: [
          { role: "previous" as const, label: "J 列", value: index === 0 ? longSku : `SECONDARY-${index + 1}` },
          { role: "main" as const, label: "L 列", value: `MAIN-${index + 1}` },
        ],
      }),
    }));

    render(
      <IssueDetailsDialog
        open
        title="数量计算问题"
        summary="100 行数量无法计算，需要确认"
        issues={issues}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "数量计算问题" });
    const table = within(dialog).getByRole("table", { name: "数量问题明细" });
    expect(within(table).getAllByRole("row")).toHaveLength(101);
    expect(within(table).getByRole("columnheader", { name: "次要 SKU" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "主要 SKU" })).toBeInTheDocument();
    expect(within(table).getByTitle(`J 列 · ${longSku}`)).toHaveClass("is-previous");
    expect(within(table).getByLabelText("无次要 SKU 信息")).toHaveTextContent("—");
    expect(within(table).getByLabelText("无主要 SKU 信息")).toHaveTextContent("—");
    expect(dialog.querySelector(".issue-details-dialog-table-scroll")).toContainElement(table);
    expect(within(table).getByText("数量档位不存在").closest("span")).toHaveClass("is-danger");
    expect(within(table).getByText("FR-D", { selector: ".issue-details-dialog-reason-markers strong" }).closest("span")).toHaveClass("is-warning");
    expect(within(table).getByText("2", { selector: ".issue-details-dialog-reason-markers strong" }).closest("span")).toHaveClass("is-info");
    expect(within(table).getByText("price", { selector: "mark" })).toHaveClass("is-info");
    expect(within(table).getByText("TC3348-L-4", { selector: "mark" })).toHaveClass("is-info");
    expect(within(table).getByText("没有数量 2 对应的档位", { selector: "mark" })).toHaveClass("is-danger");
  });

  it("scrolls the issue table to its header and footer", () => {
    render(
      <IssueDetailsDialog
        open
        title="数量计算问题"
        summary="100 行数量无法计算，需要确认"
        issues={[{ label: "第 2 行", message: "SKU 关系无法计算" }]}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "数量计算问题" });
    const scrollContainer = dialog.querySelector(".issue-details-dialog-table-scroll") as HTMLDivElement;
    const scrollActions = dialog.querySelector(".issue-details-dialog-scroll-actions") as HTMLDivElement;
    expect(scrollContainer).not.toContainElement(scrollActions);
    const scrollTo = vi.fn();
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1800 });
    Object.defineProperty(scrollContainer, "scrollTo", { configurable: true, value: scrollTo });

    fireEvent.click(within(dialog).getByRole("button", { name: "滚动到表尾" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1800, behavior: "smooth" });

    fireEvent.click(within(dialog).getByRole("button", { name: "滚动到表头" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
  });

  it("runs the optional original-value action", () => {
    const onAction = vi.fn();
    render(
      <IssueDetailsDialog
        open
        title="数量计算问题"
        summary="1 行数量无法计算，需要确认"
        issues={[{ label: "第 2 行", message: "SKU 关系无法计算" }]}
        actionLabel="使用原始 SKU 和数量"
        onAction={onAction}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用原始 SKU 和数量" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
