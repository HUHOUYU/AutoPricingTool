import { useCallback, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { taskIssueSummaries } from "@/features/pricing/issues";
import { getDesktopAPI } from "../file-utils";
import type { ImportMode, LogEntry } from "../types";
import type { ProcessorSession } from "./use-processor-session";

type CurrentValue<T> = { current: T };

type UseBatchLifecycleActionsOptions = {
  session: ProcessorSession;
  files: string[];
  setFiles: Dispatch<SetStateAction<string[]>>;
  setImportedAt: Dispatch<SetStateAction<Record<string, string>>>;
  setImportModes: Dispatch<SetStateAction<Record<string, ImportMode>>>;
  setSelectedPaths: Dispatch<SetStateAction<string[]>>;
  batchName: string;
  setBatchName: Dispatch<SetStateAction<string>>;
  batchNote: string;
  setBatchNote: Dispatch<SetStateAction<string>>;
  setEditingBatchName: Dispatch<SetStateAction<boolean>>;
  batchNameEditedRef: CurrentValue<boolean>;
  ensureOutputDirectory: () => Promise<string | null>;
  setHistoryRevision: Dispatch<SetStateAction<number>>;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
  onResetBatchView: () => void;
};

export function useBatchLifecycleActions({
  session,
  files,
  setFiles,
  setImportedAt,
  setImportModes,
  setSelectedPaths,
  batchName,
  setBatchName,
  batchNote,
  setBatchNote,
  setEditingBatchName,
  batchNameEditedRef,
  ensureOutputDirectory,
  setHistoryRevision,
  appendLog,
  onResetBatchView,
}: UseBatchLifecycleActionsOptions) {
  const {
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
    mappingValidationVersionsRef,
    priceRowValidationVersionsRef,
    mappingValidationTimerRef,
    mappingValidationInFlightRef,
    activeMappingValidationRef,
    pendingMappingValidationRef,
    setMappingValidations,
    setMatchedOrderRowsBySheet,
    isAnalyzing,
    setIsAnalyzing,
    isRunning,
    setIsRunning,
    setIsPaused,
    setBatchStarted,
    batchIdRef,
    setBatchId,
    setActivePath,
    setExpandedPath,
    setProgress,
  } = session;

  const resetTask = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (api && (isAnalyzing || isRunning)) {
      try {
        await api.stopProcessing();
      } catch {
        // 即使处理器已经退出，也继续重置本地会话状态。
      }
    }
    setIsAnalyzing(false);
    setIsRunning(false);
    setIsPaused(false);
    setBatchStarted(false);
    batchIdRef.current = null;
    batchNameEditedRef.current = false;
    setBatchId(null);
    setBatchName("");
    setBatchNote("");
    setEditingBatchName(false);
    setActivePath("");
    setFiles([]);
    setImportedAt({});
    setImportModes({});
    setSelectedPaths([]);
    setAnalyses({});
    setMappings({});
    setWritebackEdits({});
    setCellEdits({});
    setMappingValidations({});
    setMatchedOrderRowsBySheet({});
    setResults({});
    setExpandedPath(null);
    analysesRef.current = {};
    mappingsRef.current = {};
    writebackEditsRef.current = {};
    cellEditsRef.current = {};
    mappingValidationVersionsRef.current = {};
    priceRowValidationVersionsRef.current = {};
    pendingMappingValidationRef.current = null;
    mappingValidationInFlightRef.current = false;
    activeMappingValidationRef.current = null;
    if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
    confirmedPathsRef.current = new Set();
    resultsRef.current = {};
    manualIssueReviewRef.current = null;
    setManualIssueReviewResolution(null);
    autoRunTargetPathsRef.current = [];
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    onResetBatchView();
  }, [
    activeMappingValidationRef,
    analysesRef,
    autoRunTargetPathsRef,
    batchIdRef,
    batchNameEditedRef,
    cellEditsRef,
    confirmedPathsRef,
    isAnalyzing,
    isRunning,
    manualIssueReviewRef,
    mappingValidationInFlightRef,
    mappingValidationTimerRef,
    mappingValidationVersionsRef,
    mappingsRef,
    onResetBatchView,
    pendingMappingValidationRef,
    priceRowValidationVersionsRef,
    resultsRef,
    writebackEditsRef,
  ]);

  const chooseNextBatch = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    const unresolvedFiles = files.filter((path) => results[path]?.status !== "completed");
    if (unresolvedFiles.length === 0) {
      await resetTask();
      toast.success("当前批次已完成，可以导入下一批文件");
      return;
    }
    const effectiveOutputRoot = await ensureOutputDirectory();
    if (!effectiveOutputRoot) return;
    try {
      const finished = await api.finishTaskBatch({
        ...(batchIdRef.current ? { batchId: batchIdRef.current } : {}),
        name: batchName,
        note: batchNote,
        files,
        outputRoot: effectiveOutputRoot,
        diagnostics: files.map((path) => ({
          inputPath: path,
          issueSummaries: taskIssueSummaries(
            analysesRef.current[path]?.unmatchedRows ?? [],
            writebackEditsRef.current[path] ?? [],
          ),
        })),
      });
      setHistoryRevision((current) => current + 1);
      appendLog(
        `当前批次已结束，${finished.archivedCount} 个未完成文件已归档到：${finished.unprocessedDir ?? "未处理目录"}`,
        "success",
      );
      await resetTask();
      toast.success(`已归档 ${finished.archivedCount} 个未完成文件，可以导入下一批`);
    } catch (error) {
      appendLog("结束当前批次失败：" + String(error), "error");
      toast.error(`结束当前批次失败：${String(error)}`);
    }
  }, [
    analysesRef,
    appendLog,
    batchIdRef,
    batchName,
    batchNote,
    ensureOutputDirectory,
    files,
    isAnalyzing,
    isRunning,
    resetTask,
    results,
    setHistoryRevision,
    writebackEditsRef,
  ]);

  return {
    resetTask,
    chooseNextBatch,
  };
}
