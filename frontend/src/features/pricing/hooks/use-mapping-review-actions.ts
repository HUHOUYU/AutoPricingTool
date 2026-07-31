import { useCallback } from "react";
import { toast } from "sonner";
import type { FileTab } from "@/stores/ui-store";
import { mappingIsComplete } from "../mapping";
import type { ProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import type { AnalyzeFilesOptions } from "@/features/workbench/types";
import type { TaskExecutionType } from "@shared/desktop-api";

type AnalyzeFiles = (
  targetFiles?: string[],
  configPathOverride?: string,
  options?: AnalyzeFilesOptions,
) => Promise<void>;

type RunPricing = (
  targetFiles?: string[],
  executionType?: TaskExecutionType,
) => Promise<void>;

type UseMappingReviewActionsOptions = {
  session: ProcessorSession;
  continuousIssueReviewEnabled: boolean;
  analyzeFiles: AnalyzeFiles;
  runPricing: RunPricing;
  setActiveTab: (tab: FileTab) => void;
  onCloseDetail: () => void;
};

export function useMappingReviewActions({
  session,
  continuousIssueReviewEnabled,
  analyzeFiles,
  runPricing,
  setActiveTab,
  onCloseDetail,
}: UseMappingReviewActionsOptions) {
  const {
    analysesRef,
    setAnalyses,
    mappings,
    mappingsRef,
    setMappings,
    setResults,
    mappingValidations,
    setMappingValidations,
    setMatchedOrderRowsBySheet,
    writebackEditsRef,
    setWritebackEdits,
    cellEditsRef,
    setCellEdits,
    confirmedPathsRef,
    manualIssueReviewRef,
    mappingValidationVersionsRef,
    autoRunRequestedRef,
    autoRunTargetPathsRef,
  } = session;

  const confirmAndContinue = useCallback(async (path: string): Promise<void> => {
    const mapping = mappingsRef.current[path] ?? mappings[path];
    const validation = mappingValidations[path];
    if (!mappingIsComplete(mapping) || validation?.status !== "ready" || (validation.result?.errors.length ?? 1) > 0) {
      toast.error("请先完成字段映射并等待试算通过");
      return;
    }
    confirmedPathsRef.current.add(path);
    if (continuousIssueReviewEnabled) {
      manualIssueReviewRef.current = { path, preferredTab: "confirm", phase: "run" };
    }
    onCloseDetail();
    toast.success("映射已确认，开始处理当前文件");
    await runPricing([path], "manual");
  }, [
    confirmedPathsRef,
    continuousIssueReviewEnabled,
    manualIssueReviewRef,
    mappingValidations,
    mappings,
    mappingsRef,
    onCloseDetail,
    runPricing,
  ]);

  const retryAnalysis = useCallback(async (path: string): Promise<void> => {
    if (continuousIssueReviewEnabled) {
      manualIssueReviewRef.current = { path, preferredTab: "error", phase: "analysis" };
    }
    onCloseDetail();
    const nextWritebackEdits = { ...writebackEditsRef.current };
    delete nextWritebackEdits[path];
    writebackEditsRef.current = nextWritebackEdits;
    setWritebackEdits(nextWritebackEdits);
    const nextCellEdits = { ...cellEditsRef.current };
    delete nextCellEdits[path];
    cellEditsRef.current = nextCellEdits;
    setCellEdits(nextCellEdits);
    setResults((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
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
    setMappingValidations((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setMatchedOrderRowsBySheet((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    delete mappingValidationVersionsRef.current[path];
    confirmedPathsRef.current.delete(path);
    setActiveTab("pending");
    autoRunRequestedRef.current = true;
    autoRunTargetPathsRef.current = [path];
    await analyzeFiles([path], undefined, { preserveExisting: true });
  }, [
    analysesRef,
    analyzeFiles,
    autoRunRequestedRef,
    autoRunTargetPathsRef,
    cellEditsRef,
    confirmedPathsRef,
    continuousIssueReviewEnabled,
    manualIssueReviewRef,
    mappingValidationVersionsRef,
    mappingsRef,
    onCloseDetail,
    setActiveTab,
    writebackEditsRef,
  ]);

  return {
    confirmAndContinue,
    retryAnalysis,
  };
}
