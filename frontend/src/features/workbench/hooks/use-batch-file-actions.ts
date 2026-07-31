import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { FileTab } from "@/stores/ui-store";
import { defaultDraftBatchName, parentDirectory } from "../file-utils";
import { statusForFile, tabForStatus } from "../status";
import {
  MAX_INPUT_FILES,
  type ImportMode,
  type ImportSummary,
  type LogEntry,
  type RegisterPathsOptions,
} from "../types";
import type { ProcessorSession } from "./use-processor-session";

type CurrentValue<T> = { current: T };

type UseBatchFileActionsOptions = {
  session: ProcessorSession;
  files: string[];
  setFiles: Dispatch<SetStateAction<string[]>>;
  selectedPaths: string[];
  setSelectedPaths: Dispatch<SetStateAction<string[]>>;
  setImportedAt: Dispatch<SetStateAction<Record<string, string>>>;
  setImportModes: Dispatch<SetStateAction<Record<string, ImportMode>>>;
  batchStarted: boolean;
  setBatchName: Dispatch<SetStateAction<string>>;
  setBatchNote: Dispatch<SetStateAction<string>>;
  batchNameEditedRef: CurrentValue<boolean>;
  setInputDirectorySelected: Dispatch<SetStateAction<boolean>>;
  setInputDirectory: Dispatch<SetStateAction<string>>;
  activeTab: FileTab;
  setActiveTab: (tab: FileTab) => void;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
  onResetFileView: (replaceBatch: boolean) => void;
  onRemoveFileView: (path: string) => void;
};

export function useBatchFileActions({
  session,
  files,
  setFiles,
  selectedPaths,
  setSelectedPaths,
  setImportedAt,
  setImportModes,
  batchStarted,
  setBatchName,
  setBatchNote,
  batchNameEditedRef,
  setInputDirectorySelected,
  setInputDirectory,
  activeTab,
  setActiveTab,
  appendLog,
  onResetFileView,
  onRemoveFileView,
}: UseBatchFileActionsOptions) {
  const {
    analyses,
    analysesRef,
    setAnalyses,
    mappingsRef,
    setMappings,
    results,
    resultsRef,
    setResults,
    writebackEditsRef,
    setWritebackEdits,
    cellEditsRef,
    setCellEdits,
    confirmedPathsRef,
    manualIssueReviewRef,
    setManualIssueReviewResolution,
    autoRunTargetPathsRef,
    priceRowValidationVersionsRef,
    setMappingValidations,
    setMatchedOrderRowsBySheet,
    setExpandedPath,
    setProgress,
    setActivePath,
    activePath,
    isAnalyzing,
    isRunning,
    batchIdRef,
    setBatchId,
    setBatchStarted,
  } = session;

  const registerPaths = useCallback((
    paths: string[],
    mode: ImportMode,
    options: RegisterPathsOptions = {},
  ): ImportSummary => {
    const replaceBatch = options.replaceBatch === true;
    if (batchStarted && !replaceBatch) {
      toast.info("当前批次已开始，请先完成或结束当前批次");
      return { imported: 0, duplicates: 0 };
    }
    const existingFiles = replaceBatch ? [] : files;
    const existingKeys = new Set(existingFiles.map((path) => path.toLocaleLowerCase()));
    const uniqueIncoming = Array.from(new Map(
      paths.map((path) => [path.toLocaleLowerCase(), path]),
    ).values());
    const newPaths = uniqueIncoming.filter((path) => !existingKeys.has(path.toLocaleLowerCase()));
    const duplicateCount = paths.length - newPaths.length;
    if (newPaths.length === 0) {
      toast.info(duplicateCount > 0 ? `已跳过 ${duplicateCount} 个重复文件` : "没有发现支持的 Excel 文件");
      return { imported: 0, duplicates: duplicateCount };
    }
    const nextFiles = [...existingFiles, ...newPaths];
    if (nextFiles.length > MAX_INPUT_FILES) {
      appendLog(`文件数量超过上限，最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`, "error");
      toast.error(`最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`);
      return { imported: 0, duplicates: duplicateCount };
    }
    const importedTime = new Date().toLocaleString("zh-CN", { hour12: false });
    setFiles(nextFiles);
    if (replaceBatch) {
      batchIdRef.current = null;
      batchNameEditedRef.current = false;
      setBatchId(null);
      setBatchNote("");
    }
    if (replaceBatch || !batchNameEditedRef.current) {
      setBatchName(defaultDraftBatchName(nextFiles, mode));
    }
    setImportedAt((current) => ({
      ...current,
      ...Object.fromEntries(newPaths.map((path) => [path, importedTime])),
    }));
    setImportModes((current) => ({
      ...current,
      ...Object.fromEntries(newPaths.map((path) => [path, mode])),
    }));
    setSelectedPaths([]);
    setActiveTab("pending");
    setInputDirectorySelected(mode !== "file");
    setInputDirectory((current) => current || parentDirectory(newPaths[0]));
    analysesRef.current = {};
    mappingsRef.current = {};
    writebackEditsRef.current = {};
    cellEditsRef.current = {};
    priceRowValidationVersionsRef.current = {};
    setAnalyses({});
    setMappings({});
    setWritebackEdits({});
    setCellEdits({});
    setMappingValidations({});
    setMatchedOrderRowsBySheet({});
    resultsRef.current = {};
    setResults({});
    setExpandedPath(null);
    manualIssueReviewRef.current = null;
    setManualIssueReviewResolution(null);
    autoRunTargetPathsRef.current = [];
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    setActivePath("");
    if (replaceBatch) setBatchStarted(false);
    confirmedPathsRef.current = new Set();
    onResetFileView(replaceBatch);
    const modeLabel = mode === "file" ? "文件" : mode === "folder" ? "文件夹" : "配置目录";
    appendLog(`${replaceBatch ? "下一批已通过" : "已通过"}${modeLabel}模式加入 ${newPaths.length} 个 Excel 文件`);
    toast.success(`${replaceBatch ? "下一批已导入" : "已导入"} ${newPaths.length} 个 Excel 文件${duplicateCount ? `，跳过 ${duplicateCount} 个重复文件` : ""}`);
    return { imported: newPaths.length, duplicates: duplicateCount };
  }, [
    analysesRef,
    appendLog,
    autoRunTargetPathsRef,
    batchIdRef,
    batchNameEditedRef,
    batchStarted,
    cellEditsRef,
    confirmedPathsRef,
    files,
    manualIssueReviewRef,
    mappingsRef,
    onResetFileView,
    priceRowValidationVersionsRef,
    resultsRef,
    setActiveTab,
    writebackEditsRef,
  ]);

  const removeFile = useCallback((path: string): void => {
    setFiles((current) => current.filter((item) => item !== path));
    setSelectedPaths((current) => current.filter((item) => item !== path));
    setAnalyses((current) => {
      const next = { ...current };
      delete next[path];
      analysesRef.current = next;
      return next;
    });
    setMappings((current) => {
      const next = { ...current };
      delete next[path];
      mappingsRef.current = next;
      return next;
    });
    setResults((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    confirmedPathsRef.current.delete(path);
    setImportedAt((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setImportModes((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setMatchedOrderRowsBySheet((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    onRemoveFileView(path);
  }, [analysesRef, confirmedPathsRef, mappingsRef, onRemoveFileView]);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const actionFiles = useMemo(
    () => (selectedPaths.length > 0 ? files.filter((path) => selectedSet.has(path)) : files),
    [files, selectedPaths.length, selectedSet],
  );

  const toggleSelected = useCallback((path: string): void => {
    setSelectedPaths((current) => (
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    ));
  }, [setSelectedPaths]);

  const toggleAllSelected = useCallback((): void => {
    const visiblePaths = files.filter((path) => {
      const status = statusForFile(
        path,
        analyses[path],
        results[path],
        activePath,
        isAnalyzing || isRunning,
        confirmedPathsRef.current.has(path),
        isRunning,
      );
      return tabForStatus(status) === activeTab;
    });
    const allSelected = visiblePaths.length > 0 && visiblePaths.every((path) => selectedSet.has(path));
    setSelectedPaths((current) => (
      allSelected
        ? current.filter((path) => !visiblePaths.includes(path))
        : Array.from(new Set([...current, ...visiblePaths]))
    ));
  }, [
    activePath,
    activeTab,
    analyses,
    confirmedPathsRef,
    files,
    isAnalyzing,
    isRunning,
    results,
    selectedSet,
    setSelectedPaths,
  ]);

  return {
    registerPaths,
    removeFile,
    selectedSet,
    actionFiles,
    toggleSelected,
    toggleAllSelected,
  };
}
