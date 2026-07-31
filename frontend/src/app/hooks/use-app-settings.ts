import { useCallback, useEffect, useState } from "react";
import type { AppPreferences, AppState } from "@shared/desktop-api";
import { getDesktopAPI } from "@/features/workbench/file-utils";
import type { WorkbenchPage } from "@/stores/ui-store";
import type { LogEntry } from "@/features/workbench/types";

type UseAppSettingsOptions = {
  activePage: WorkbenchPage;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
};

export function useAppSettings({
  activePage,
  appendLog,
}: UseAppSettingsOptions) {
  const [inputDirectory, setInputDirectory] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [autoRevealManualResult, setAutoRevealManualResult] = useState(false);
  const [continuousIssueReviewEnabled, setContinuousIssueReviewEnabled] = useState(false);

  const applySettings = useCallback((preferences: AppPreferences, state: AppState): void => {
    setInputDirectory(state.recentInputDirectory);
    setOutputDirectory(state.recentOutputDirectory);
    setConfigPath(state.activeBusinessConfigPath);
    setAutoRevealManualResult(preferences.autoRevealManualResult);
    setContinuousIssueReviewEnabled(preferences.continuousIssueReviewEnabled);
  }, []);

  useEffect(() => {
    const api = getDesktopAPI();
    if (!api) {
      appendLog("Electron 接口未加载，请从桌面应用启动", "error");
      return undefined;
    }
    let active = true;
    void Promise.all([api.getAppPreferences(), api.getAppState()])
      .then(([preferences, state]) => {
        if (active) applySettings(preferences, state);
      })
      .catch((error: unknown) => appendLog("读取应用设置失败：" + String(error), "warning"));
    return () => {
      active = false;
    };
  }, [activePage, appendLog, applySettings]);

  return {
    inputDirectory,
    outputDirectory,
    configPath,
    autoRevealManualResult,
    continuousIssueReviewEnabled,
    setInputDirectory,
    setOutputDirectory,
    setConfigPath,
    applySettings,
  };
}

export type AppSettingsState = ReturnType<typeof useAppSettings>;
