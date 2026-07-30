import { BrowserWindow, type WebContents } from "electron";
import { join } from "node:path";
import { isTrustedRendererUrl, type TrustedRendererLocation } from "./security";
import {
  initialWindowSize,
  MIN_WINDOW_SIZE,
  setRememberedWindowSize,
  type WindowPreferences,
  type WindowSize,
} from "./window-preferences";

type WindowManagerOptions = {
  appIconPath: string;
  backgroundColor: string;
  getPreferences: () => WindowPreferences;
  isRememberSizeEnabled: () => boolean;
  onRememberSizeChange: (
    rememberSize: boolean,
    preferences: WindowPreferences,
  ) => Promise<void>;
  persistWindowSize: (size: WindowSize) => Promise<void>;
  preloadPath: string;
  resizeSaveDelayMs: number;
  trustedRendererLocation: TrustedRendererLocation;
};

export function createWindowManager(options: WindowManagerOptions) {
  function createWindow(): BrowserWindow {
    const initialSize = initialWindowSize(options.getPreferences());
    const mainWindow = new BrowserWindow({
      width: initialSize.width,
      height: initialSize.height,
      minWidth: MIN_WINDOW_SIZE.width,
      minHeight: MIN_WINDOW_SIZE.height,
      title: "Excel 订单批量核价工具",
      backgroundColor: options.backgroundColor,
      show: false,
      frame: false,
      icon: options.appIconPath,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let resizeSaveTimer: NodeJS.Timeout | undefined;
    let pendingWindowSize: WindowSize | undefined;

    const persistPendingSize = (): void => {
      if (!pendingWindowSize) return;
      const next = setRememberedWindowSize(options.getPreferences(), true, pendingWindowSize);
      pendingWindowSize = undefined;
      if (next.width === undefined || next.height === undefined) return;
      void options.persistWindowSize({ width: next.width, height: next.height }).catch(() => undefined);
    };

    mainWindow.on("resize", () => {
      if (!options.isRememberSizeEnabled()
        || mainWindow.isMaximized()
        || mainWindow.isMinimized()
        || mainWindow.isFullScreen()) return;
      const [width, height] = mainWindow.getSize();
      pendingWindowSize = { width, height };
      if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
      resizeSaveTimer = setTimeout(persistPendingSize, options.resizeSaveDelayMs);
    });
    mainWindow.on("closed", () => {
      if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
      if (options.isRememberSizeEnabled()) persistPendingSize();
    });
    mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!isTrustedRendererUrl(url, options.trustedRendererLocation)) event.preventDefault();
    });

    const { devServerUrl, rendererHtmlPath } = options.trustedRendererLocation;
    if (devServerUrl) void mainWindow.loadURL(devServerUrl);
    else void mainWindow.loadFile(rendererHtmlPath);
    return mainWindow;
  }

  function minimize(sender: WebContents): void {
    BrowserWindow.fromWebContents(sender)?.minimize();
  }

  function toggleMaximize(sender: WebContents): void {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }

  function close(sender: WebContents): void {
    BrowserWindow.fromWebContents(sender)?.close();
  }

  async function setRememberSize(sender: WebContents, rememberSize: boolean): Promise<WindowPreferences> {
    const targetWindow = BrowserWindow.fromWebContents(sender);
    const fallbackSize = initialWindowSize(options.getPreferences());
    const [width, height] = targetWindow?.getSize() ?? [fallbackSize.width, fallbackSize.height];
    const next = setRememberedWindowSize(options.getPreferences(), rememberSize, { width, height });
    await options.onRememberSizeChange(rememberSize, next);
    return options.getPreferences();
  }

  return {
    close,
    createWindow,
    getPreferences: options.getPreferences,
    minimize,
    setRememberSize,
    toggleMaximize,
  };
}
