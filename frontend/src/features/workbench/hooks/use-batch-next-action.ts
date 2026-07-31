import { useMemo } from "react";
import { CircleHelp, FileCheck2, FilePlus2, Play } from "lucide-react";
import type { FileTab } from "@/stores/ui-store";
import type { TaskNextAction } from "../components/task-actions";
import { tabForStatus } from "../status";
import type { FileResult, FileStatus } from "../types";

const BATCH_NEXT_ACTION_CLASS = "cyber-action is-start is-batch-next";

type UseBatchNextActionOptions = {
  batchStarted: boolean;
  isTaskActive: boolean;
  files: string[];
  fileStatusByPath: Record<string, FileStatus>;
  results: Record<string, FileResult>;
  tabCounts: Record<FileTab, number>;
  hasAnalysis: (path: string) => boolean;
  onOpenConfirm: (paths: string[]) => void;
  onOpenErrors: () => void;
  onContinue: (paths: string[], needsAnalysis: boolean) => void;
  onNextBatch: () => void;
};

export function useBatchNextAction({
  batchStarted,
  isTaskActive,
  files,
  fileStatusByPath,
  results,
  tabCounts,
  hasAnalysis,
  onOpenConfirm,
  onOpenErrors,
  onContinue,
  onNextBatch,
}: UseBatchNextActionOptions): TaskNextAction | null {
  return useMemo(() => {
    if (isTaskActive || !batchStarted) return null;
    if (tabCounts.confirm > 0) {
      const confirmPaths = files.filter((path) => tabForStatus(fileStatusByPath[path]) === "confirm");
      return {
        label: confirmPaths.length === 1 ? "查看详情" : "去确认",
        icon: FileCheck2,
        className: BATCH_NEXT_ACTION_CLASS,
        onClick: () => onOpenConfirm(confirmPaths),
      };
    }
    if (tabCounts.error > 0) {
      return {
        label: "查看异常",
        icon: CircleHelp,
        className: BATCH_NEXT_ACTION_CLASS,
        onClick: onOpenErrors,
      };
    }
    if (tabCounts.queued > 0 || tabCounts.pending > 0) {
      return {
        label: tabCounts.pending > 0 ? "继续未完成" : "继续核价",
        icon: Play,
        className: BATCH_NEXT_ACTION_CLASS,
        onClick: () => {
          const unfinishedFiles = files.filter((path) => results[path]?.status !== "completed");
          if (unfinishedFiles.length === 0) return;
          onContinue(unfinishedFiles, unfinishedFiles.some((path) => !hasAnalysis(path)));
        },
      };
    }
    if (tabCounts.success > 0) {
      return {
        label: "处理下一批",
        icon: FilePlus2,
        className: BATCH_NEXT_ACTION_CLASS,
        onClick: onNextBatch,
      };
    }
    return null;
  }, [
    batchStarted,
    fileStatusByPath,
    files,
    hasAnalysis,
    isTaskActive,
    onContinue,
    onNextBatch,
    onOpenConfirm,
    onOpenErrors,
    results,
    tabCounts,
  ]);
}
