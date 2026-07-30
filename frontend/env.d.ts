import type { DesktopAPI } from "../backend/electron/preload";

declare global {
  interface Window {
    desktopAPI: DesktopAPI;
  }
}

export {};
