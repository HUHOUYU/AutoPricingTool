import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampDetailDrawerWidth,
  clampDetailSidebarWidth,
  defaultDetailDrawerWidth,
  detailDrawerBounds,
  detailSidebarBounds,
  DETAIL_DRAWER_KEYBOARD_STEP,
  DETAIL_SIDEBAR_DEFAULT_WIDTH,
  DETAIL_SIDEBAR_KEYBOARD_STEP,
} from "@/features/workbench/detail-layout";

export function useDetailDrawerLayout(): {
  drawerBounds: { min: number; max: number };
  drawerWidth: number;
  sidebarBounds: { min: number; max: number };
  sidebarWidth: number;
  resetDrawerWidth: () => void;
  resizeDrawerWithKeyboard: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  resizeSidebarWithKeyboard: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  startDrawerResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  startSidebarResize: (event: React.PointerEvent<HTMLDivElement>) => void;
} {
  const [drawerWidth, setDrawerWidth] = useState(defaultDetailDrawerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(DETAIL_SIDEBAR_DEFAULT_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const drawerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const customDrawerWidthRef = useRef(false);
  const drawerWidthRef = useRef(drawerWidth);
  const drawerBounds = detailDrawerBounds(viewportWidth);
  const sidebarBounds = detailSidebarBounds(drawerWidth);

  useEffect(() => {
    const handleWindowResize = (): void => {
      setViewportWidth(window.innerWidth);
      setDrawerWidth((current) => customDrawerWidthRef.current
        ? clampDetailDrawerWidth(current)
        : defaultDetailDrawerWidth());
    };
    const handlePointerMove = (event: PointerEvent): void => {
      const drawerResize = drawerResizeRef.current;
      if (drawerResize) {
        setDrawerWidth(clampDetailDrawerWidth(
          drawerResize.startWidth + drawerResize.startX - event.clientX,
        ));
      }
      const sidebarResize = sidebarResizeRef.current;
      if (sidebarResize) {
        setSidebarWidth(clampDetailSidebarWidth(
          sidebarResize.startWidth + sidebarResize.startX - event.clientX,
          drawerWidthRef.current,
        ));
      }
    };
    const handlePointerUp = (): void => {
      drawerResizeRef.current = null;
      sidebarResizeRef.current = null;
    };

    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    drawerWidthRef.current = drawerWidth;
    setSidebarWidth((current) => clampDetailSidebarWidth(current, drawerWidth));
  }, [drawerWidth]);

  const resetDrawerWidth = useCallback((): void => {
    customDrawerWidthRef.current = false;
    setDrawerWidth(defaultDetailDrawerWidth());
  }, []);

  const startDrawerResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    customDrawerWidthRef.current = true;
    drawerResizeRef.current = { startX: event.clientX, startWidth: drawerWidth };
  }, [drawerWidth]);

  const resizeDrawerWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = drawerWidth + DETAIL_DRAWER_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = drawerWidth - DETAIL_DRAWER_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = drawerBounds.min;
    if (event.key === "End") nextWidth = drawerBounds.max;
    if (nextWidth === null) return;
    event.preventDefault();
    customDrawerWidthRef.current = true;
    setDrawerWidth(clampDetailDrawerWidth(nextWidth));
  }, [drawerBounds.max, drawerBounds.min, drawerWidth]);

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    sidebarResizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
  }, [sidebarWidth]);

  const resizeSidebarWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth + DETAIL_SIDEBAR_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth - DETAIL_SIDEBAR_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = sidebarBounds.min;
    if (event.key === "End") nextWidth = sidebarBounds.max;
    if (nextWidth === null) return;
    event.preventDefault();
    setSidebarWidth(clampDetailSidebarWidth(nextWidth, drawerWidth));
  }, [drawerWidth, sidebarBounds.max, sidebarBounds.min, sidebarWidth]);

  return {
    drawerBounds,
    drawerWidth,
    sidebarBounds,
    sidebarWidth,
    resetDrawerWidth,
    resizeDrawerWithKeyboard,
    resizeSidebarWithKeyboard,
    startDrawerResize,
    startSidebarResize,
  };
}
