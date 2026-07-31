import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTaskControls } from "@/features/workbench/hooks/use-task-controls";
import type { DesktopAPI } from "@shared/desktop-api";

const files = ["C:\\orders\\a.xlsx"];
const originalDesktopAPI = window.desktopAPI;

afterEach(() => {
  window.desktopAPI = originalDesktopAPI;
});

describe("useTaskControls", () => {
  it("prepares automatic execution before analyzing files without analysis", async () => {
    const onPrepareAutoRun = vi.fn();
    const onAnalyze = vi.fn(async () => undefined);
    const onRun = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useTaskControls({
        actionFiles: files,
        isAnalyzing: false,
        isRunning: false,
        isPaused: false,
        hasAnalysis: () => false,
        onPrepareAutoRun,
        onAnalyze,
        onRun,
      }),
    );

    await act(async () => {
      await result.current.startCurrentTask();
    });

    expect(onPrepareAutoRun).toHaveBeenCalledWith(files);
    expect(onAnalyze).toHaveBeenCalledWith(files);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("runs files directly when their analysis already exists", async () => {
    const onRun = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useTaskControls({
        actionFiles: files,
        isAnalyzing: false,
        isRunning: false,
        isPaused: false,
        hasAnalysis: () => true,
        onPrepareAutoRun: vi.fn(),
        onAnalyze: vi.fn(async () => undefined),
        onRun,
      }),
    );

    await act(async () => {
      await result.current.startCurrentTask();
    });

    expect(onRun).toHaveBeenCalledWith(files);
  });

  it("routes pause, resume, and stop commands to the desktop processor", async () => {
    const pauseProcessing = vi.fn(async () => undefined);
    const resumeProcessing = vi.fn(async () => undefined);
    const stopProcessing = vi.fn(async () => undefined);
    window.desktopAPI = {
      pauseProcessing,
      resumeProcessing,
      stopProcessing,
    } as unknown as DesktopAPI;

    const { result, rerender } = renderHook(
      ({ isPaused }) =>
        useTaskControls({
          actionFiles: files,
          isAnalyzing: false,
          isRunning: true,
          isPaused,
          hasAnalysis: () => true,
          onPrepareAutoRun: vi.fn(),
          onAnalyze: vi.fn(async () => undefined),
          onRun: vi.fn(async () => undefined),
        }),
      { initialProps: { isPaused: false } },
    );

    await act(async () => {
      await result.current.togglePauseTask();
    });
    expect(pauseProcessing).toHaveBeenCalledTimes(1);

    rerender({ isPaused: true });
    await act(async () => {
      await result.current.togglePauseTask();
      await result.current.stopCurrentTask();
    });
    expect(resumeProcessing).toHaveBeenCalledTimes(1);
    expect(stopProcessing).toHaveBeenCalledTimes(1);
  });
});
