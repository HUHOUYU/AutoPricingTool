import { useEffect } from "react";
import { toast } from "sonner";
import type { TaskExecutionType } from "@shared/desktop-api";
import type { ProcessorSession } from "./use-processor-session";

type RunPricing = (
  targetFiles?: string[],
  executionType?: TaskExecutionType,
) => Promise<void>;

type UseProcessingAutoRunOptions = {
  session: ProcessorSession;
  files: string[];
  runPricing: RunPricing;
};

export function useProcessingAutoRun({
  session,
  files,
  runPricing,
}: UseProcessingAutoRunOptions): void {
  const {
    analysesRef,
    analysisCompletedToken,
    autoRunRequestedRef,
    autoRunTargetPathsRef,
    batchIdRef,
  } = session;

  useEffect(() => {
    if (analysisCompletedToken === 0 || !autoRunRequestedRef.current) return;
    autoRunRequestedRef.current = false;
    const requestedPaths = autoRunTargetPathsRef.current;
    autoRunTargetPathsRef.current = [];
    const requestedSet = new Set(requestedPaths);
    const analyzedFiles = files.filter((path) => (
      analysesRef.current[path]
      && (requestedSet.size === 0 || requestedSet.has(path))
    ));
    const eligibleFiles = analyzedFiles.filter((path) => (
      analysesRef.current[path]?.automationDecision.status === "eligible"
    ));
    const confirmCount = analyzedFiles.filter((path) => (
      analysesRef.current[path]?.automationDecision.status === "confirm"
    )).length;
    const errorCount = analyzedFiles.filter((path) => (
      analysesRef.current[path]?.automationDecision.status === "error"
    )).length;
    if (eligibleFiles.length === 0) {
      toast.warning(`分析完成：待确认 ${confirmCount}，异常 ${errorCount}，没有可自动核价的文件`);
      return;
    }
    toast.success(`分析完成：自动核价 ${eligibleFiles.length}，待确认 ${confirmCount}，异常 ${errorCount}`);
    void runPricing(eligibleFiles, batchIdRef.current ? "retry" : "automatic");
  }, [
    analysesRef,
    analysisCompletedToken,
    autoRunRequestedRef,
    autoRunTargetPathsRef,
    batchIdRef,
    files,
    runPricing,
  ]);
}
