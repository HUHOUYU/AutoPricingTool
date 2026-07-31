import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileTableModel } from "@/features/workbench/hooks/use-file-table-model";
import type { FileTab } from "@/stores/ui-store";

const files = ["C:\\orders\\a.xlsx", "C:\\orders\\b.xlsx"];

describe("useFileTableModel", () => {
  it("selects columns by tab and keeps table interaction state inside the model", () => {
    const { result, rerender } = renderHook(
      ({ activeTab }: { activeTab: FileTab }) =>
        useFileTableModel({
          files,
          pagedFiles: files,
          activeTab,
          analyses: {},
          mappings: {},
          results: {},
          importModes: {},
          importedAt: {},
          fileStatusByPath: {
            [files[0]]: "pending",
            [files[1]]: "pending",
          },
          expandedPath: null,
        }),
      { initialProps: { activeTab: "pending" as FileTab } },
    );

    expect(result.current.table.getAllLeafColumns().map((column) => column.id)).toEqual([
      "select",
      "index",
      "fileName",
      "importMode",
      "status",
      "createdAt",
      "actions",
    ]);

    act(() => result.current.toggleColumnPin("fileName"));
    expect(result.current.table.getColumn("fileName")?.getIsPinned()).toBe("left");

    act(() => result.current.resizeColumn("fileName", 240, 8));
    expect(result.current.table.getColumn("fileName")?.getSize()).toBe(248);

    rerender({ activeTab: "confirm" });
    expect(result.current.table.getAllLeafColumns().map((column) => column.id)).toEqual([
      "select",
      "index",
      "fileName",
      "orderSheet",
      "pricingSheet",
      "coverage",
      "evidence",
      "issue",
      "actions",
    ]);
  });
});
