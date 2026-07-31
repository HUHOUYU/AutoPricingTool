import { useCallback } from "react";
import type { FileTab } from "@/stores/ui-store";
import type {
  PriceCheckMapping,
  PricePreviewCellEdit,
  PricePreviewWritebackRow,
  TaskExecutionType,
} from "@shared/desktop-api";
import { taskIssueSummaries } from "@/features/pricing/issues";
import { getDesktopAPI } from "../file-utils";
import { isAnalysisError } from "../status";
import type { AnalyzeFilesOptions, LogEntry } from "../types";
import type { ProcessorSession } from "./use-processor-session";

type UseProcessingCommandsOptions = {
  session: ProcessorSession;
  actionFiles: string[];
  files: string[];
  configPath: string;
  outputDirectory: string;
  batchName: string;
  batchNote: string;
  ensureOutputDirectory: () => Promise<string | null>;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
  setActiveTab: (tab: FileTab) => void;
  onClearAnalysisView: () => void;
};

export function useProcessingCommands({
  session,
  actionFiles,
  files,
  configPath,
  outputDirectory,
  batchName,
  batchNote,
  ensureOutputDirectory,
  appendLog,
  setActiveTab,
  onClearAnalysisView,
}: UseProcessingCommandsOptions) {
  const {
    analyses,
    analysesRef,
    setAnalyses,
    mappings,
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
    mappingValidationVersionsRef,
    priceRowValidationVersionsRef,
    mappingValidationTimerRef,
    mappingValidationInFlightRef,
    activeMappingValidationRef,
    pendingMappingValidationRef,
    manualIssueReviewRef,
    setManualIssueReviewResolution,
    batchIdRef,
    setBatchId,
    isAnalyzing,
    setIsAnalyzing,
    isRunning,
    setIsRunning,
    setIsPaused,
    setBatchStarted,
    setActivePath,
    setExpandedPath,
    setProgress,
    setMappingValidations,
    setMatchedOrderRowsBySheet,
  } = session;

  const analyzeFiles = useCallback(async (
    targetFiles: string[] = actionFiles,
    configPathOverride?: string,
    options: AnalyzeFilesOptions = {},
  ): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || targetFiles.length === 0 || isAnalyzing || isRunning) return;
    setBatchStarted(true);
    setIsAnalyzing(true);
    setActiveTab("pending");
    setActivePath("");
    if (!options.preserveExisting) {
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
      setAnalyses({});
      setMappings({});
      setWritebackEdits({});
      setCellEdits({});
      setMappingValidations({});
      setMatchedOrderRowsBySheet({});
      onClearAnalysisView();
      resultsRef.current = {};
      setResults({});
      setExpandedPath(null);
      confirmedPathsRef.current = new Set();
    }
    setProgress({ current: 0, total: targetFiles.length, phase: "analyze", path: "" });
    appendLog("开始分析 " + targetFiles.length + " 个文件");
    try {
      const effectiveConfigPath = configPathOverride ?? configPath;
      await api.analyzePriceFiles({
        files: targetFiles,
        ...(effectiveConfigPath ? { configPath: effectiveConfigPath } : {}),
      });
    } catch (error) {
      setIsAnalyzing(false);
      const manualReview = manualIssueReviewRef.current;
      if (manualReview?.phase === "analysis" && manualReview.path === targetFiles[0]) {
        manualIssueReviewRef.current = null;
        setManualIssueReviewResolution({
          path: manualReview.path,
          preferredTab: manualReview.preferredTab,
          outcome: "failed",
        });
      }
      appendLog("提交分析失败：" + String(error), "error");
    }
  }, [
    actionFiles,
    activeMappingValidationRef,
    analysesRef,
    appendLog,
    cellEditsRef,
    configPath,
    confirmedPathsRef,
    isAnalyzing,
    isRunning,
    manualIssueReviewRef,
    mappingValidationInFlightRef,
    mappingValidationTimerRef,
    mappingValidationVersionsRef,
    mappingsRef,
    onClearAnalysisView,
    pendingMappingValidationRef,
    priceRowValidationVersionsRef,
    resultsRef,
    setActiveTab,
    writebackEditsRef,
  ]);

  const runPricing = useCallback(async (
    targetFiles: string[] = actionFiles,
    executionType: TaskExecutionType = batchIdRef.current ? "retry" : "automatic",
  ): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || targetFiles.length === 0 || isAnalyzing || isRunning) return;
    const blockedFiles = targetFiles.filter((path) => {
      const analysis = analysesRef.current[path] ?? analyses[path];
      return !analysis || isAnalysisError(analysis) || (analysis.requiresConfirmation && !confirmedPathsRef.current.has(path));
    });
    const blockedSet = new Set(blockedFiles);
    const runnableFiles = targetFiles.filter((path) => !blockedSet.has(path));
    if (blockedFiles.length > 0) {
      appendLog(
        blockedFiles.length + " 个文件仍待确认或存在异常，已跳过；请在待确认/异常 Tab 查看",
        "warning",
      );
    }
    if (runnableFiles.length === 0) return;
    const runMappings = runnableFiles
      .map((path) => ({
        inputPath: path,
        mapping: mappingsRef.current[path] ?? analysesRef.current[path]?.suggestedMapping ?? mappings[path] ?? analyses[path]?.suggestedMapping ?? null,
        writebackRows: writebackEditsRef.current[path] ?? [],
        cellEdits: cellEditsRef.current[path] ?? [],
      }))
      .filter((item): item is {
        inputPath: string;
        mapping: PriceCheckMapping;
        writebackRows: PricePreviewWritebackRow[];
        cellEdits: PricePreviewCellEdit[];
      } => item.mapping !== null);
    if (runMappings.length !== runnableFiles.length) {
      appendLog("仍有文件没有可执行字段映射，请先分析并确认", "warning");
      return;
    }
    const effectiveOutputDir = await ensureOutputDirectory();
    if (!effectiveOutputDir) return;
    setBatchStarted(true);
    setIsAnalyzing(false);
    setIsRunning(true);
    setIsPaused(false);
    const nextResults = { ...resultsRef.current };
    for (const path of runnableFiles) delete nextResults[path];
    resultsRef.current = nextResults;
    setResults((current) => {
      const next = { ...current };
      for (const path of runnableFiles) delete next[path];
      return next;
    });
    setExpandedPath(null);
    setActivePath("");
    setProgress({ current: 0, total: runnableFiles.length, phase: "run", path: "" });
    appendLog("开始核价 " + runnableFiles.length + " 个文件，结果写入：" + effectiveOutputDir);
    try {
      const runnableSet = new Set(runnableFiles);
      const remainingFiles = files.filter((path) =>
        !runnableSet.has(path) && results[path]?.status !== "completed").length;
      const response = await api.runPriceCheck({
        files: runnableFiles,
        outputDir: effectiveOutputDir,
        ...(batchIdRef.current ? { batchId: batchIdRef.current } : {}),
        batchName,
        batchNote,
        batchFiles: files,
        executionType,
        remainingFiles,
        mappings: runMappings,
        diagnostics: runnableFiles.map((path) => ({
          inputPath: path,
          issueSummaries: taskIssueSummaries(
            analysesRef.current[path]?.unmatchedRows ?? [],
            writebackEditsRef.current[path] ?? [],
          ),
        })),
        ...(configPath ? { configPath } : {}),
      });
      batchIdRef.current = response.batchId;
      setBatchId(response.batchId);
      if (outputDirectory) await api.setAppState({ recentOutputDirectory: outputDirectory });
    } catch (error) {
      setIsRunning(false);
      const manualReview = manualIssueReviewRef.current;
      if (manualReview?.phase === "run" && runnableFiles.includes(manualReview.path)) {
        manualIssueReviewRef.current = null;
        setManualIssueReviewResolution({
          path: manualReview.path,
          preferredTab: manualReview.preferredTab,
          outcome: "failed",
        });
      }
      appendLog("提交核价失败：" + String(error), "error");
    }
  }, [
    actionFiles,
    analyses,
    analysesRef,
    appendLog,
    batchIdRef,
    batchName,
    batchNote,
    cellEditsRef,
    configPath,
    confirmedPathsRef,
    ensureOutputDirectory,
    files,
    isAnalyzing,
    isRunning,
    manualIssueReviewRef,
    mappings,
    mappingsRef,
    outputDirectory,
    results,
    resultsRef,
    writebackEditsRef,
  ]);

  return {
    analyzeFiles,
    runPricing,
  };
}
