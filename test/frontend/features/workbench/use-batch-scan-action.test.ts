import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBatchScanAction } from "@/features/workbench/hooks/use-batch-scan-action";
import { useProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import type { DesktopAPI } from "@shared/desktop-api";

const originalDesktopAPI = window.desktopAPI;

afterEach(() => {
  window.desktopAPI = originalDesktopAPI;
});

describe("useBatchScanAction", () => {
  it("replaces the visible collection with scanned files before analysis", async () => {
    const discovered = ["C:\\orders\\a.xlsx", "C:\\orders\\b.xlsx"];
    const listExcelFiles = vi.fn(async () => ({
      files: discovered,
      skippedTemporary: 0,
      skippedUnsupported: 0,
      skippedOutput: 0,
    }));
    const analyzeFiles = vi.fn(async () => undefined);
    window.desktopAPI = {
      listExcelFiles,
    } as unknown as DesktopAPI;
    const { result } = renderHook(() => {
      const session = useProcessorSession();
      const [files, setFiles] = useState<string[]>([]);
      const [importedAt, setImportedAt] = useState<Record<string, string>>({});
      const [selectedPaths, setSelectedPaths] = useState<string[]>(["old.xlsx"]);
      const { scanFiles } = useBatchScanAction({
        session,
        actionFiles: [],
        inputDirectorySelected: true,
        inputDirectory: "C:\\orders",
        setFiles,
        setImportedAt,
        setSelectedPaths,
        analyzeFiles,
        appendLog: vi.fn(),
      });
      return { files, importedAt, selectedPaths, scanFiles };
    });

    await act(async () => {
      await result.current.scanFiles();
    });

    expect(listExcelFiles).toHaveBeenCalledWith("C:\\orders");
    expect(result.current.files).toEqual(discovered);
    expect(result.current.selectedPaths).toEqual([]);
    expect(Object.keys(result.current.importedAt)).toEqual(discovered);
    expect(analyzeFiles).toHaveBeenCalledWith(discovered);
  });
});
