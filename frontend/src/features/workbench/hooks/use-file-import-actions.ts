import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  droppedFolderName,
  getDesktopAPI,
  getNativeFilesFromEvent,
  isExcelFile,
  isExcelPath,
} from "../file-utils";
import type {
  ImportMode,
  ImportSourceMode,
  ImportSummary,
  LogEntry,
} from "../types";

type UseFileImportActionsOptions = {
  batchStarted: boolean;
  directorySelectionDisabled: boolean;
  importSourceMode: ImportSourceMode;
  outputDirectory: string;
  registerPaths: (paths: string[], mode: ImportMode) => ImportSummary;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
  onOutputDirectoryChange: (directory: string) => void;
  onInputDirectoryChange: (directory: string) => void;
  onInputDirectorySelectedChange: (selected: boolean) => void;
};

export function useFileImportActions({
  batchStarted,
  directorySelectionDisabled,
  importSourceMode,
  outputDirectory,
  registerPaths,
  appendLog,
  onOutputDirectoryChange,
  onInputDirectoryChange,
  onInputDirectorySelectedChange,
}: UseFileImportActionsOptions) {
  const ensureOutputDirectory = useCallback(async (): Promise<string | null> => {
    const api = getDesktopAPI();
    if (!api) return null;
    if (outputDirectory) return outputDirectory;
    try {
      const configuredOutputDir = (await api.getAppState()).recentOutputDirectory.trim();
      if (configuredOutputDir) {
        onOutputDirectoryChange(configuredOutputDir);
        return configuredOutputDir;
      }
    } catch {
      // 读取失败时仍允许用户重新选择并修复输出目录配置。
    }
    const selected = await api.selectDirectory("output", true);
    if (!selected) {
      appendLog("未选择输出文件夹，本次导入已取消", "warning");
      toast.warning("请选择输出文件夹后再导入");
      return null;
    }
    onOutputDirectoryChange(selected);
    appendLog("输出文件夹已保存：" + selected, "success");
    return selected;
  }, [appendLog, onOutputDirectoryChange, outputDirectory]);

  const addFiles = useCallback(async (incoming: File[]): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const supportedFiles = incoming.filter(isExcelFile);
    if (supportedFiles.length === 0) {
      appendLog("没有发现支持的 Excel 文件（xlsx、xlsm、xlsb、xls）", "warning");
      toast.warning("没有发现支持的 Excel 文件");
      return;
    }
    const paths = supportedFiles.map((file) => {
      try {
        return api.getPathForFile(file);
      } catch {
        return "";
      }
    }).filter(Boolean);
    if (paths.length === 0) {
      appendLog("无法读取所选文件的本地路径，请双击选择文件重试", "warning");
      toast.warning("无法读取文件路径，请双击选择文件重试");
      return;
    }
    if (!await ensureOutputDirectory()) return;
    registerPaths(paths, "file");
  }, [appendLog, ensureOutputDirectory, registerPaths]);

  const chooseInputFiles = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || batchStarted) return;
    const selected = await api.selectExcelFiles();
    if (!selected?.length) return;
    const supportedPaths = selected.filter(isExcelPath);
    if (supportedPaths.length !== selected.length) {
      appendLog("所选文件不是支持的 Excel 格式", "warning");
      toast.warning("仅支持 Excel 文件（xlsx、xlsm、xlsb、xls）");
    }
    if (supportedPaths.length > 0) registerPaths(supportedPaths, "file");
  }, [appendLog, batchStarted, registerPaths]);

  const scanInputDirectory = useCallback(async (directoryPath: string): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    onInputDirectoryChange(directoryPath);
    onInputDirectorySelectedChange(true);
    try {
      const scan = await api.listExcelFiles(directoryPath);
      registerPaths(scan.files, "folder");
      const skipped = scan.skippedTemporary + scan.skippedUnsupported + scan.skippedOutput;
      if (skipped > 0) {
        toast.info(`文件夹扫描完成，已跳过 ${skipped} 项`);
      }
      appendLog(`文件夹扫描完成：发现 ${scan.files.length} 个 Excel 文件，跳过 ${skipped} 项`, "success");
    } catch (error) {
      appendLog("扫描文件夹失败：" + String(error), "error");
      toast.error("文件夹扫描失败");
    }
  }, [appendLog, onInputDirectoryChange, onInputDirectorySelectedChange, registerPaths]);

  const chooseInputDirectory = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || directorySelectionDisabled) return;
    const selected = await api.selectDirectory("input");
    if (!selected) return;
    await scanInputDirectory(selected);
  }, [directorySelectionDisabled, scanInputDirectory]);

  const addFolder = useCallback(async (incoming: File[]): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    if (incoming.length === 1 && !isExcelFile(incoming[0]) && !droppedFolderName(incoming[0])) {
      try {
        const directoryPath = api.getPathForFile(incoming[0]);
        if (!directoryPath) throw new Error("无法读取文件夹路径");
        if (!await ensureOutputDirectory()) return;
        await scanInputDirectory(directoryPath);
        return;
      } catch (error) {
        appendLog("无法读取拖入的文件夹：" + String(error), "warning");
        toast.warning("无法读取拖入的文件夹，请双击选择文件夹");
        return;
      }
    }
    const folderNames = new Set(incoming.map(droppedFolderName).filter((name): name is string => Boolean(name)));
    if (folderNames.size !== 1 || incoming.some((file) => !droppedFolderName(file))) {
      appendLog("文件夹模式只接受 1 个完整文件夹", "warning");
      toast.warning("文件夹模式只接受 1 个完整文件夹");
      return;
    }
    const paths = incoming.filter(isExcelFile).map((file) => {
      try {
        return api.getPathForFile(file);
      } catch {
        return "";
      }
    }).filter(Boolean);
    if (paths.length === 0) {
      appendLog("拖入的文件夹中没有支持的 Excel 文件", "warning");
      toast.warning("拖入的文件夹中没有支持的 Excel 文件");
      return;
    }
    if (!await ensureOutputDirectory()) return;
    registerPaths(paths, "folder");
    const skipped = incoming.length - paths.length;
    if (skipped > 0) toast.info(`文件夹导入完成，已跳过 ${skipped} 个非 Excel 文件`);
  }, [appendLog, ensureOutputDirectory, registerPaths, scanInputDirectory]);

  const dropzone = useDropzone({
    accept: importSourceMode === "file" ? {
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx", ".xlsm", ".xlsb"],
    } : undefined,
    maxFiles: 0,
    multiple: true,
    disabled: batchStarted,
    getFilesFromEvent: importSourceMode === "file" ? getNativeFilesFromEvent : undefined,
    noClick: true,
    noKeyboard: true,
    onDrop: (acceptedFiles, rejections) => {
      if (rejections.length > 0) {
        const message = importSourceMode === "file"
          ? "仅支持 Excel 文件（xlsx、xlsm、xlsb、xls）"
          : "文件夹模式只接受文件夹";
        appendLog(message, "warning");
        toast.warning(message);
        return;
      }
      if (importSourceMode === "file") void addFiles(acceptedFiles);
      else void addFolder(acceptedFiles);
    },
  });

  return {
    ensureOutputDirectory,
    chooseInputFiles,
    chooseInputDirectory,
    getRootProps: dropzone.getRootProps,
    getInputProps: dropzone.getInputProps,
    isDragActive: dropzone.isDragActive,
  };
}
