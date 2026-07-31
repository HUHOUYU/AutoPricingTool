import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useBatchFileActions } from "@/features/workbench/hooks/use-batch-file-actions";
import { useProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import type { ImportMode } from "@/features/workbench/types";

describe("useBatchFileActions", () => {
  it("registers unique paths and keeps file metadata in one collection", () => {
    const { result } = renderHook(() => {
      const session = useProcessorSession();
      const [files, setFiles] = useState<string[]>([]);
      const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
      const [importedAt, setImportedAt] = useState<Record<string, string>>({});
      const [importModes, setImportModes] = useState<Record<string, ImportMode>>({});
      const [batchName, setBatchName] = useState("");
      const [, setBatchNote] = useState("");
      const [, setInputDirectorySelected] = useState(false);
      const [, setInputDirectory] = useState("");
      const batchNameEditedRef = useRef(false);
      const actions = useBatchFileActions({
        session,
        files,
        setFiles,
        selectedPaths,
        setSelectedPaths,
        setImportedAt,
        setImportModes,
        batchStarted: false,
        setBatchName,
        setBatchNote,
        batchNameEditedRef,
        setInputDirectorySelected,
        setInputDirectory,
        activeTab: "pending",
        setActiveTab: vi.fn(),
        appendLog: vi.fn(),
        onResetFileView: vi.fn(),
        onRemoveFileView: vi.fn(),
      });
      return { files, importedAt, importModes, batchName, ...actions };
    });

    let summary = { imported: 0, duplicates: 0 };
    act(() => {
      summary = result.current.registerPaths([
        "C:\\orders\\a.xlsx",
        "c:\\orders\\A.xlsx",
      ], "file");
    });

    expect(summary).toEqual({ imported: 1, duplicates: 1 });
    expect(result.current.files).toEqual(["c:\\orders\\A.xlsx"]);
    expect(result.current.importModes["c:\\orders\\A.xlsx"]).toBe("file");
    expect(result.current.importedAt["c:\\orders\\A.xlsx"]).toBeTruthy();
    expect(result.current.batchName).toContain("A");
  });
});
