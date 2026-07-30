import type { PriceAnalysisFile } from "../../../../backend/electron/preload";
import type { FileTab } from "@/stores/ui-store";
import type { FileResult, FileStatus } from "./types";

export function isAnalysisError(analysis: PriceAnalysisFile | undefined): boolean {
  if (!analysis) return false;
  return (
    analysis.orderSheetCandidates.length === 0
    || analysis.pricingSheetCandidates.length === 0
    || analysis.issues.some((issue) =>
      issue.startsWith("读取失败") || issue.startsWith("未识别到"))
  );
}

export function tabForStatus(status: FileStatus): FileTab {
  if (status === "pending" || status === "running") return "pending";
  if (status === "success") return "success";
  if (status === "warning" || status === "error") return "error";
  return "confirm";
}

/** 批处理结束后优先落到有结果的 Tab */
export function pickBestResultTab(counts: Record<FileTab, number>): FileTab | null {
  if (counts.confirm > 0) return "confirm";
  if (counts.error > 0) return "error";
  if (counts.success > 0) return "success";
  if (counts.pending > 0) return "pending";
  return null;
}

export function statusForFile(
  path: string,
  analysis: PriceAnalysisFile | undefined,
  result: FileResult | undefined,
  activePath: string,
  isBusy: boolean,
  manuallyConfirmed: boolean,
): FileStatus {
  if (result?.status === "failed") return "error";
  if (result?.status === "completed") {
    return manuallyConfirmed || (result.exceptionRows ?? 0) === 0 ? "success" : "warning";
  }
  if (isBusy && activePath === path) return "running";
  if (analysis) {
    if (isAnalysisError(analysis) || analysis.automationDecision.status === "error") return "error";
    return analysis.automationDecision.status === "confirm" ? "ready" : "pending";
  }
  return "pending";
}
