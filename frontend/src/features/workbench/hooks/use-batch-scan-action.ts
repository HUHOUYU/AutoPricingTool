import { useCallback, type Dispatch, type SetStateAction } from "react";
import { getDesktopAPI } from "../file-utils";
import {
  MAX_INPUT_FILES,
  type AnalyzeFilesOptions,
  type LogEntry,
} from "../types";
import type { ProcessorSession } from "./use-processor-session";

type AnalyzeFiles = (
  targetFiles?: string[],
  configPathOverride?: string,
  options?: AnalyzeFilesOptions,
) => Promise<void>;

type UseBatchScanActionOptions = {
  session: ProcessorSession;
  actionFiles: string[];
  inputDirectorySelected: boolean;
  inputDirectory: string;
  setFiles: Dispatch<SetStateAction<string[]>>;
  setImportedAt: Dispatch<SetStateAction<Record<string, string>>>;
  setSelectedPaths: Dispatch<SetStateAction<string[]>>;
  analyzeFiles: AnalyzeFiles;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
};

export function useBatchScanAction({
  session,
  actionFiles,
  inputDirectorySelected,
  inputDirectory,
  setFiles,
  setImportedAt,
  setSelectedPaths,
  analyzeFiles,
  appendLog,
}: UseBatchScanActionOptions) {
  const { isAnalyzing, isRunning } = session;

  const scanFiles = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    let targetFiles = actionFiles;
    if (inputDirectorySelected && inputDirectory) {
      try {
        const scan = await api.listExcelFiles(inputDirectory);
        const discovered = scan.files;
        if (discovered.length > MAX_INPUT_FILES) {
          appendLog(`文件夹超过 ${MAX_INPUT_FILES} 个文件上限，未开始分析`, "error");
          return;
        }
        setFiles(discovered);
        const scannedTime = new Date().toLocaleString("zh-CN", { hour12: false });
        setImportedAt(Object.fromEntries(discovered.map((path) => [path, scannedTime])));
        setSelectedPaths([]);
        targetFiles = discovered;
        if (discovered.length === 0) {
          appendLog("所选文件夹中没有发现 Excel 文件", "warning");
          return;
        }
        appendLog("扫描文件夹发现 " + discovered.length + " 个 Excel 文件", "success");
      } catch (error) {
        appendLog("扫描文件夹失败：" + String(error), "error");
        return;
      }
    }
    if (targetFiles.length === 0) {
      appendLog("请先选择目标文件夹或拖入 Excel 文件", "warning");
      return;
    }
    await analyzeFiles(targetFiles);
  }, [
    actionFiles,
    analyzeFiles,
    appendLog,
    inputDirectory,
    inputDirectorySelected,
    isAnalyzing,
    isRunning,
    setFiles,
    setImportedAt,
    setSelectedPaths,
  ]);

  return { scanFiles };
}
