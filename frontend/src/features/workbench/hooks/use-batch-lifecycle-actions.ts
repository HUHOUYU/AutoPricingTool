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
  batchName: string;
  batchNote: string;
  ensureOutputDirectory: () => Promise<string | null>;
  setFiles: Dispatch<SetStateAction<string[]>>;
  setImportedAt: Dispatch<SetStateAction<Record<string, string>>>;
  setImportModes: Dispatch<SetStateAction<Record<string, ImportMode>>>;
  setSelectedPaths: Dispatch<SetStateAction<string[]>>;
  setBatchName: Dispatch<SetStateAction<string>>;
  setBatchNote: Dispatch<SetStateAction<string>>;
  setEditingBatchName: Dispatch<SetStateAction<boolean>>;
  batchNameEditedRef: CurrentValue<boolean>;
  setHistoryRevision: Dispatch<SetStateAction<number>>;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
  onResetBatchView: () => void;
};

export function useBatchLifecycleActions({
  session,
  files,
  batchName,
  batchNote,
  ensureOutputDirectory,
  setFiles,
  setImportedAt,
  setImportModes,
  setSelectedPaths,
  setBatchName,
  setBatchNote,
  setEditingBatchName,
  batchNameEditedRef,
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
    autoRunRequestedRef,
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
    setAnalysisCompletedToken,
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
    autoRunRequestedRef.current = false;
    autoRunTargetPathsRef.current = [];
    setAnalysisCompletedToken(0);
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    onResetBatchView();
  }, [
    activeMappingValidationRef,
    analysesRef,
    autoRunRequestedRef,
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

  const archiveAndNextBatch = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    const unresolvedFiles = files.filter((path) => results[path]?.status !== "completed");
    if (unresolvedFiles.length === 0) {
      await resetTask();
      toast.success("当前批次已完成，可以导入下一批文件");
      return;
    }
    const outputRoot = await ensureOutputDirectory();
    if (!outputRoot) return;
    try {
      const result = await api.finishTaskBatch({
        ...(batchIdRef.current ? { batchId: batchIdRef.current } : {}),
        name: batchName,
        ...(batchNote ? { note: batchNote } : {}),
        files,
        outputRoot,
        diagnostics: files.map((path) => ({
          inputPath: path,
          issueSummaries: taskIssueSummaries(
            analysesRef.current[path]?.unmatchedRows ?? [],
            writebackEditsRef.current[path] ?? [],
          ),
        })),
      });
      const archivedDirectory = result.unconfirmedDir;
      await resetTask();
      setHistoryRevision((current) => current + 1);
      appendLog(
        archivedDirectory
          ? `已保存当前批次，${result.archivedCount} 个未完成文件已归档到：${archivedDirectory}`
          : `已保存当前批次，归档 ${result.archivedCount} 个未完成文件`,
        "success",
      );
      toast.success(`已保存当前批次并归档 ${result.archivedCount} 个未完成文件，可以导入下一批`);
    } catch (error) {
      appendLog("保存当前批次失败：" + String(error), "error");
      toast.error(`保存当前批次失败：${String(error)}`);
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

  const discardAndNextBatch = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    const unresolvedFiles = files.filter((path) => results[path]?.status !== "completed");
    if (unresolvedFiles.length === 0) {
      await resetTask();
      toast.success("当前批次已完成，可以导入下一批文件");
      return;
    }
    try {
      if (batchIdRef.current) {
        await api.discardTaskBatch(batchIdRef.current);
        setHistoryRevision((current) => current + 1);
      }
      await resetTask();
      toast.success(`已丢弃当前批次及 ${unresolvedFiles.length} 个未完成文件，可以导入下一批`);
    } catch (error) {
      appendLog("丢弃当前批次失败：" + String(error), "error");
      toast.error(`丢弃当前批次失败：${String(error)}`);
    }
  }, [
    appendLog,
    batchIdRef,
    files,
    isAnalyzing,
    isRunning,
    resetTask,
    results,
    setHistoryRevision,
  ]);

  return {
    resetTask,
    archiveAndNextBatch,
    discardAndNextBatch,
  };
}
