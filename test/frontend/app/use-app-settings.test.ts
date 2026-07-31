import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppSettings } from "@/app/hooks/use-app-settings";
import type { DesktopAPI } from "@shared/desktop-api";

const originalDesktopAPI = window.desktopAPI;

afterEach(() => {
  window.desktopAPI = originalDesktopAPI;
});

describe("useAppSettings", () => {
  it("loads persisted directories, config and preferences", async () => {
    window.desktopAPI = {
      getAppPreferences: vi.fn(async () => ({
        autoRevealManualResult: true,
        continuousIssueReviewEnabled: true,
      })),
      getAppState: vi.fn(async () => ({
        recentInputDirectory: "C:\\orders",
        recentOutputDirectory: "C:\\results",
        activeBusinessConfigPath: "C:\\config\\rules.json",
      })),
    } as unknown as DesktopAPI;

    const { result } = renderHook(() =>
      useAppSettings({
        activePage: "workbench",
        appendLog: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.configPath).toBe("C:\\config\\rules.json");
    });
    expect(result.current.inputDirectory).toBe("C:\\orders");
    expect(result.current.outputDirectory).toBe("C:\\results");
    expect(result.current.autoRevealManualResult).toBe(true);
    expect(result.current.continuousIssueReviewEnabled).toBe(true);
  });

  it("reports a missing desktop bridge", () => {
    const appendLog = vi.fn();
    Object.defineProperty(window, "desktopAPI", {
      configurable: true,
      value: undefined,
    });

    renderHook(() =>
      useAppSettings({
        activePage: "workbench",
        appendLog,
      }),
    );

    expect(appendLog).toHaveBeenCalledWith(
      "Electron 接口未加载，请从桌面应用启动",
      "error",
    );
  });
});
