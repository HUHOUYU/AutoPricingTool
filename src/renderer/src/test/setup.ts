import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback): number => window.setTimeout(() => callback(performance.now()), 0),
});

Object.defineProperty(window, "cancelAnimationFrame", {
  configurable: true,
  value: (handle: number): void => window.clearTimeout(handle),
});

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  value: MockResizeObserver,
});

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: MockResizeObserver,
});

Object.defineProperty(Element.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});
