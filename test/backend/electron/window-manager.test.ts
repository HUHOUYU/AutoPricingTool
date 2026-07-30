import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowPreferences } from "../../../backend/electron/main/window-preferences";

const electronMocks = vi.hoisted(() => {
  const senderWindow = {
    close: vi.fn(),
    getSize: vi.fn(() => [1400, 900] as [number, number]),
    isMaximized: vi.fn(() => false),
    maximize: vi.fn(),
    minimize: vi.fn(),
    unmaximize: vi.fn(),
  };
  class BrowserWindow {
    static fromWebContents = vi.fn(() => senderWindow);
  }
  return { BrowserWindow, senderWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMocks.BrowserWindow,
}));

import { createWindowManager } from "../../../backend/electron/main/window-manager";

function createManager(initial: WindowPreferences = { rememberSize: false }) {
  let preferences = initial;
  const onRememberSizeChange = vi.fn(async (
    _rememberSize: boolean,
    next: WindowPreferences,
  ) => {
    preferences = next;
  });
  const manager = createWindowManager({
    appIconPath: "icon.ico",
    backgroundColor: "#fff",
    getPreferences: () => preferences,
    isRememberSizeEnabled: () => preferences.rememberSize,
    onRememberSizeChange,
    persistWindowSize: vi.fn(async () => undefined),
    preloadPath: "preload.js",
    resizeSaveDelayMs: 300,
    trustedRendererLocation: { rendererHtmlPath: "index.html" },
  });
  return { manager, onRememberSizeChange };
}

describe("createWindowManager", () => {
  beforeEach(() => {
    electronMocks.senderWindow.isMaximized.mockReturnValue(false);
  });

  it("persists the current window size when remembering is enabled", async () => {
    const { manager, onRememberSizeChange } = createManager();
    const sender = {} as Electron.WebContents;

    const result = await manager.setRememberSize(sender, true);

    expect(onRememberSizeChange).toHaveBeenCalledWith(true, {
      rememberSize: true,
      width: 1400,
      height: 900,
    });
    expect(result).toEqual({ rememberSize: true, width: 1400, height: 900 });
  });

  it("delegates window commands to the sender window", () => {
    const { manager } = createManager();
    const sender = {} as Electron.WebContents;

    manager.minimize(sender);
    manager.toggleMaximize(sender);
    electronMocks.senderWindow.isMaximized.mockReturnValue(true);
    manager.toggleMaximize(sender);
    manager.close(sender);

    expect(electronMocks.senderWindow.minimize).toHaveBeenCalledOnce();
    expect(electronMocks.senderWindow.maximize).toHaveBeenCalledOnce();
    expect(electronMocks.senderWindow.unmaximize).toHaveBeenCalledOnce();
    expect(electronMocks.senderWindow.close).toHaveBeenCalledOnce();
  });
});
