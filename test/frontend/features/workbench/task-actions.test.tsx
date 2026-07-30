import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Play } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskActions } from "@/features/workbench/components/task-actions";

function renderActions(overrides: Partial<React.ComponentProps<typeof TaskActions>> = {}) {
  const props: React.ComponentProps<typeof TaskActions> = {
    batchStarted: false,
    canReset: true,
    canStart: true,
    className: "actions",
    collapsed: false,
    isPaused: false,
    isTaskActive: false,
    nextAction: null,
    pendingReviewCount: 0,
    onFinishBatch: vi.fn(),
    onPause: vi.fn(),
    onReset: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <TaskActions {...props} />
    </TooltipProvider>,
  );
  return props;
}

describe("TaskActions", () => {
  it("runs start and reset actions before a batch starts", () => {
    const props = renderActions({ showReset: true });

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    fireEvent.click(screen.getByRole("button", { name: "重置本批" }));

    expect(props.onStart).toHaveBeenCalledOnce();
    expect(props.onReset).toHaveBeenCalledOnce();
  });

  it("shows active controls and the next action for a completed batch", () => {
    const nextAction = {
      label: "处理下一批",
      icon: Play,
      className: "next",
      onClick: vi.fn(),
    };
    const props = renderActions({
      batchStarted: true,
      isPaused: true,
      isTaskActive: true,
      nextAction,
      showNext: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "继续任务" }));
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    fireEvent.click(screen.getByRole("button", { name: "处理下一批" }));

    expect(props.onPause).toHaveBeenCalledOnce();
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(nextAction.onClick).toHaveBeenCalledOnce();
  });
});
