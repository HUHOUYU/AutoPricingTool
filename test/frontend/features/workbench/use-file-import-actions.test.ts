import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileImportActions } from "@/features/workbench/hooks/use-file-import-actions";
import type { DesktopAPI } from "@shared/desktop-api";

const originalDesktopAPI = window.desktopAPI;

afterEach(() => {
  window.desktopAPI = originalDesktopAPI;
});

describe("useFileImportActions", () => {
  it("filters unsupported selections before registering file paths", async () => {
    const registerPaths = vi.fn(() => ({ imported: 1, duplicates: 0 }));
    const appendLog = vi.fn();
    const selectExcelFiles = vi.fn(async () => [
      "C:\\orders\\a.xlsx",
      "C:\\orders\\notes.txt",
    ]);
    window.desktopAPI = {
      selectExcelFiles,
    } as unknown as DesktopAPI;

    const { result } = renderHook(() =>
      useFileImportActions({
        batchStarted: false,
        directorySelectionDisabled: false,
        importSourceMode: "file",
        outputDirectory: "C:\\output",
        registerPaths,
        appendLog,
        onOutputDirectoryChange: vi.fn(),
        onInputDirectoryChange: vi.fn(),
        onInputDirectorySelectedChange: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.chooseInputFiles();
    });

    expect(selectExcelFiles).toHaveBeenCalledTimes(1);
    expect(registerPaths).toHaveBeenCalledWith(["C:\\orders\\a.xlsx"], "file");
    expect(appendLog).toHaveBeenCalledWith("所选文件不是支持的 Excel 格式", "warning");
  });

  it("keeps folder selection disabled while processing", async () => {
    const selectDirectory = vi.fn(async () => "C:\\orders");
    window.desktopAPI = {
      selectDirectory,
    } as unknown as DesktopAPI;

    const { result } = renderHook(() =>
      useFileImportActions({
        batchStarted: true,
        directorySelectionDisabled: true,
        importSourceMode: "folder",
        outputDirectory: "C:\\output",
        registerPaths: vi.fn(() => ({ imported: 0, duplicates: 0 })),
        appendLog: vi.fn(),
        onOutputDirectoryChange: vi.fn(),
        onInputDirectoryChange: vi.fn(),
        onInputDirectorySelectedChange: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.chooseInputDirectory();
    });

    expect(selectDirectory).not.toHaveBeenCalled();
  });
});
