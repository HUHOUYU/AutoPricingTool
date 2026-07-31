import { useCallback } from "react";
import { toast } from "sonner";
import { getDesktopAPI } from "../file-utils";

type UseTaskControlsOptions = {
  actionFiles: string[];
  isAnalyzing: boolean;
  isRunning: boolean;
  isPaused: boolean;
  hasAnalysis: (path: string) => boolean;
  onPrepareAutoRun: (paths: string[]) => void;
  onAnalyze: (paths: string[]) => Promise<void>;
  onRun: (paths: string[]) => Promise<void>;
};

export function useTaskControls({
  actionFiles,
  isAnalyzing,
  isRunning,
  isPaused,
  hasAnalysis,
  onPrepareAutoRun,
  onAnalyze,
  onRun,
}: UseTaskControlsOptions) {
  const startCurrentTask = useCallback(async (): Promise<void> => {
    if (isAnalyzing || isRunning) {
      toast.info("当前任务正在处理中");
      return;
    }
    if (actionFiles.length === 0) {
      toast.warning("请先导入 Excel 文件");
      return;
    }
    if (actionFiles.some((path) => !hasAnalysis(path))) {
      onPrepareAutoRun(actionFiles);
      await onAnalyze(actionFiles);
      return;
    }
    await onRun(actionFiles);
  }, [actionFiles, hasAnalysis, isAnalyzing, isRunning, onAnalyze, onPrepareAutoRun, onRun]);

  const togglePauseTask = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    if (!isAnalyzing && !isRunning) {
      toast.info("当前没有运行中的任务");
      return;
    }
    if (isPaused) await api.resumeProcessing();
    else await api.pauseProcessing();
  }, [isAnalyzing, isPaused, isRunning]);

  const stopCurrentTask = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    if (!isAnalyzing && !isRunning) {
      toast.info("当前没有可停止的任务");
      return;
    }
    await api.stopProcessing();
  }, [isAnalyzing, isRunning]);

  return {
    startCurrentTask,
    togglePauseTask,
    stopCurrentTask,
  };
}
