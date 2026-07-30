import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDetailDrawerLayout } from "@/features/workbench/hooks/use-detail-drawer-layout";

describe("useDetailDrawerLayout", () => {
  it("resizes the drawer with keyboard controls inside viewport bounds", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    const { result } = renderHook(() => useDetailDrawerLayout());
    const preventDefault = vi.fn();

    act(() => {
      result.current.resizeDrawerWithKeyboard({
        key: "Home",
        preventDefault,
      } as unknown as React.KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.drawerWidth).toBe(result.current.drawerBounds.min);

    act(() => {
      result.current.resizeDrawerWithKeyboard({
        key: "End",
        preventDefault,
      } as unknown as React.KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.drawerWidth).toBe(result.current.drawerBounds.max);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("keeps the detail sidebar within content-aware bounds", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    const { result } = renderHook(() => useDetailDrawerLayout());

    act(() => {
      result.current.resizeSidebarWithKeyboard({
        key: "Home",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.sidebarWidth).toBe(result.current.sidebarBounds.min);
  });
});
