import { describe, expect, it } from "vitest";
import {
  clampDetailDrawerWidth,
  clampDetailSidebarWidth,
  detailDrawerBounds,
  detailSidebarBounds,
} from "@/features/workbench/detail-layout";

describe("detail layout", () => {
  it("keeps drawer width inside the viewport bounds", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });

    expect(detailDrawerBounds()).toEqual({ min: 760, max: 1_128 });
    expect(clampDetailDrawerWidth(400)).toBe(760);
    expect(clampDetailDrawerWidth(1_400)).toBe(1_128);
  });

  it("keeps the sidebar within its content-aware bounds", () => {
    expect(detailSidebarBounds(1_000)).toEqual({ min: 280, max: 520 });
    expect(clampDetailSidebarWidth(200, 1_000)).toBe(280);
    expect(clampDetailSidebarWidth(700, 1_000)).toBe(520);
  });
});
