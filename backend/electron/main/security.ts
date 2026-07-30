import type { IpcMainInvokeEvent } from "electron";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TrustedRendererLocation = {
  rendererHtmlPath: string;
  devServerUrl?: string;
};

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isTrustedRendererUrl(url: string, location: TrustedRendererLocation): boolean {
  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return false;
  }

  if (location.devServerUrl) {
    try {
      const expected = new URL(location.devServerUrl);
      return (
        ["http:", "https:"].includes(candidate.protocol) &&
        candidate.origin === expected.origin
      );
    } catch {
      return false;
    }
  }

  if (candidate.protocol !== "file:") {
    return false;
  }
  candidate.hash = "";
  candidate.search = "";
  try {
    return comparablePath(fileURLToPath(candidate)) === comparablePath(location.rendererHtmlPath);
  } catch {
    return false;
  }
}

export function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  location: TrustedRendererLocation,
): void {
  const senderFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!senderFrame) {
    throw new Error("拒绝 IPC 请求：发送页面已失效");
  }
  if (
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.routingId !== mainFrame.routingId
  ) {
    throw new Error("拒绝 IPC 请求：发送页面不是应用主页面");
  }
  if (!isTrustedRendererUrl(senderFrame.url, location)) {
    throw new Error(`拒绝 IPC 请求：页面地址不受信任 (${senderFrame.url})`);
  }
}
