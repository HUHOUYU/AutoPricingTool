import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileListView } from "@/features/workbench/hooks/use-file-list-view";
import type { FileResult } from "@/features/workbench/types";

describe("useFileListView", () => {
  it("derives statuses, tab counts, filtering, and pagination from one source", () => {
    const files = ["C:\\orders\\a.xlsx", "C:\\orders\\b.xlsx", "C:\\orders\\c.xlsx", "C:\\orders\\d.xlsx"];
    const results: Record<string, FileResult> = {
      [files[2]]: {
        path: files[2],
        status: "completed",
        exceptionRows: 0,
        completedAt: "2026-07-31 12:00:00",
      },
      [files[3]]: {
        path: files[3],
        status: "failed",
        completedAt: "2026-07-31 12:00:01",
      },
    };

    const { result } = renderHook(() =>
      useFileListView({
        files,
        analyses: {},
        results,
        activePath: files[1],
        busy: true,
        confirmedPaths: new Set(),
        activeTab: "pending",
        pageIndex: 1,
        pageSize: 1,
      }),
    );

    expect(result.current.fileStatusByPath).toEqual({
      [files[0]]: "pending",
      [files[1]]: "running",
      [files[2]]: "success",
      [files[3]]: "error",
    });
    expect(result.current.progressDotCounts).toEqual({
      pending: 1,
      running: 1,
      ready: 0,
      success: 1,
      warning: 0,
      error: 1,
    });
    expect(result.current.tabCounts).toEqual({ pending: 2, confirm: 0, error: 1, success: 1 });
    expect(result.current.visibleFiles).toEqual(files.slice(0, 2));
    expect(result.current.pageCount).toBe(2);
    expect(result.current.pagedFiles).toEqual([files[1]]);
  });
});
