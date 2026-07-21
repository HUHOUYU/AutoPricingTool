import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  it("renders the application confirmation UI and handles both actions", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        open
        title="删除这个模板？"
        description="此操作无法撤销。"
        confirmLabel="确认删除"
        tone="danger"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("alertdialog", { name: "删除这个模板？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels with Escape unless an operation is in progress", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open title="恢复默认配置？" description="将覆盖当前文件。" confirmLabel="恢复默认" onCancel={onCancel} onConfirm={vi.fn()} />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(<ConfirmDialog open busy title="恢复默认配置？" description="将覆盖当前文件。" confirmLabel="恢复默认" onCancel={onCancel} onConfirm={vi.fn()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
