import type { IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertTrustedIpcSender, isTrustedRendererUrl } from "./security";

describe("renderer URL validation", () => {
  const rendererHtmlPath = "C:\\apps\\table-handle-line\\out\\renderer\\index.html";

  it("accepts only the packaged renderer entry file", () => {
    expect(
      isTrustedRendererUrl(pathToFileURL(rendererHtmlPath).href, { rendererHtmlPath }),
    ).toBe(true);
    expect(
      isTrustedRendererUrl("file:///C:/apps/table-handle-line/out/renderer/other.html", {
        rendererHtmlPath,
      }),
    ).toBe(false);
    expect(isTrustedRendererUrl("https://example.com", { rendererHtmlPath })).toBe(false);
  });

  it("accepts only the configured development server origin", () => {
    const location = { rendererHtmlPath, devServerUrl: "http://127.0.0.1:5173/" };
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/settings", location)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/", location)).toBe(false);
    expect(isTrustedRendererUrl("https://127.0.0.1:5173/", location)).toBe(false);
  });

  it("accepts distinct WebFrameMain wrappers for the same main frame", () => {
    const mainFrame = { processId: 17, routingId: 29 };
    const senderFrame = {
      processId: 17,
      routingId: 29,
      url: "http://127.0.0.1:5173/",
    };
    const event = {
      senderFrame,
      sender: { mainFrame },
    } as unknown as IpcMainInvokeEvent;

    expect(() =>
      assertTrustedIpcSender(event, {
        rendererHtmlPath,
        devServerUrl: "http://127.0.0.1:5173/",
      }),
    ).not.toThrow();
  });

  it("rejects a different renderer frame even on the trusted origin", () => {
    const mainFrame = { processId: 17, routingId: 29 };
    const event = {
      senderFrame: {
        processId: 17,
        routingId: 30,
        url: "http://127.0.0.1:5173/",
      },
      sender: { mainFrame },
    } as unknown as IpcMainInvokeEvent;

    expect(() =>
      assertTrustedIpcSender(event, {
        rendererHtmlPath,
        devServerUrl: "http://127.0.0.1:5173/",
      }),
    ).toThrow("发送页面不是应用主页面");
  });
});
