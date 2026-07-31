import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBatchNextAction } from "@/features/workbench/hooks/use-batch-next-action";

const files = ["C:\\orders\\a.xlsx", "C:\\orders\\b.xlsx"];

describe("useBatchNextAction", () => {
  it("prioritizes confirmation and opens the only matching file", () => {
    const onOpenConfirm = vi.fn();
    const { result } = renderHook(() =>
      useBatchNextAction({
        batchStarted: true,
        isTaskActive: false,
        files,
        fileStatusByPath: {
          [files[0]]: "ready",
          [files[1]]: "success",
        },
        results: {},
        tabCounts: { pending: 0, queued: 0, confirm: 1, error: 0, success: 1 },
        hasAnalysis: () => true,
        onOpenConfirm,
        onOpenErrors: vi.fn(),
        onContinue: vi.fn(),
        onNextBatch: vi.fn(),
      }),
    );

    expect(result.current?.label).toBe("查看详情");
    act(() => result.current?.onClick());
    expect(onOpenConfirm).toHaveBeenCalledWith([files[0]]);
  });

  it("continues only unfinished files and reports whether analysis is missing", () => {
    const onContinue = vi.fn();
    const { result } = renderHook(() =>
      useBatchNextAction({
        batchStarted: true,
        isTaskActive: false,
        files,
        fileStatusByPath: {
          [files[0]]: "pending",
          [files[1]]: "success",
        },
        results: {
          [files[1]]: {
            path: files[1],
            status: "completed",
            completedAt: "2026-07-31 12:00:00",
          },
        },
        tabCounts: { pending: 1, queued: 0, confirm: 0, error: 0, success: 1 },
        hasAnalysis: () => false,
        onOpenConfirm: vi.fn(),
        onOpenErrors: vi.fn(),
        onContinue,
        onNextBatch: vi.fn(),
      }),
    );

    expect(result.current?.label).toBe("继续未完成");
    act(() => result.current?.onClick());
    expect(onContinue).toHaveBeenCalledWith([files[0]], true);
  });

  it("offers the next batch only after successful files remain", () => {
    const onNextBatch = vi.fn();
    const { result } = renderHook(() =>
      useBatchNextAction({
        batchStarted: true,
        isTaskActive: false,
        files,
        fileStatusByPath: {
          [files[0]]: "success",
          [files[1]]: "success",
        },
        results: {},
        tabCounts: { pending: 0, queued: 0, confirm: 0, error: 0, success: 2 },
        hasAnalysis: () => true,
        onOpenConfirm: vi.fn(),
        onOpenErrors: vi.fn(),
        onContinue: vi.fn(),
        onNextBatch,
      }),
    );

    expect(result.current?.label).toBe("处理下一批");
    act(() => result.current?.onClick());
    expect(onNextBatch).toHaveBeenCalledTimes(1);
  });
});
