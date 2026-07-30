import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_SIZE,
  initialWindowSize,
  normalizeWindowPreferences,
  setRememberedWindowSize,
} from "../../../backend/electron/main/window-preferences";

describe("window preferences", () => {
  it("uses the saved size only when remembering is enabled", () => {
    expect(initialWindowSize({ rememberSize: true, width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 });
    expect(initialWindowSize({ rememberSize: false, width: 1440, height: 900 })).toEqual(DEFAULT_WINDOW_SIZE);
  });

  it("rejects invalid persisted dimensions", () => {
    expect(normalizeWindowPreferences({ rememberSize: true, width: 800, height: "900" })).toEqual({ rememberSize: true });
    expect(initialWindowSize(normalizeWindowPreferences({ rememberSize: true, width: 800, height: "900" }))).toEqual(DEFAULT_WINDOW_SIZE);
  });

  it("captures the current size when the option is enabled", () => {
    expect(setRememberedWindowSize({ rememberSize: false }, true, { width: 1280, height: 800 })).toEqual({
      rememberSize: true,
      width: 1280,
      height: 800,
    });
  });
});
