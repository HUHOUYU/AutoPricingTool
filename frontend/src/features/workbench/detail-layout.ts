export const DETAIL_DRAWER_KEYBOARD_STEP = 24;
export const DETAIL_SIDEBAR_DEFAULT_WIDTH = 360;
export const DETAIL_SIDEBAR_KEYBOARD_STEP = 16;
export const DETAIL_PREVIEW_MIN_WIDTH = 360;
export const DETAIL_CONTENT_RESIZER_WIDTH = 12;

const DETAIL_DRAWER_DEFAULT_RATIO = 0.9;
const DETAIL_DRAWER_MIN_WIDTH = 760;
const DETAIL_DRAWER_EDGE_GAP = 72;
const DETAIL_SIDEBAR_MIN_WIDTH = 280;
const DETAIL_SIDEBAR_MAX_WIDTH = 520;
const DETAIL_CONTENT_HORIZONTAL_PADDING = 28;

export function detailDrawerBounds(
  viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth,
): { min: number; max: number } {
  const max = Math.max(320, viewportWidth - DETAIL_DRAWER_EDGE_GAP);
  return { min: Math.min(DETAIL_DRAWER_MIN_WIDTH, max), max };
}

export function clampDetailDrawerWidth(width: number): number {
  const bounds = detailDrawerBounds();
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

export function defaultDetailDrawerWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  return clampDetailDrawerWidth(Math.round(viewportWidth * DETAIL_DRAWER_DEFAULT_RATIO));
}

export function detailSidebarBounds(drawerWidth: number): { min: number; max: number } {
  const availableMax = drawerWidth
    - DETAIL_CONTENT_HORIZONTAL_PADDING
    - DETAIL_CONTENT_RESIZER_WIDTH
    - DETAIL_PREVIEW_MIN_WIDTH;
  return {
    min: DETAIL_SIDEBAR_MIN_WIDTH,
    max: Math.max(DETAIL_SIDEBAR_MIN_WIDTH, Math.min(DETAIL_SIDEBAR_MAX_WIDTH, availableMax)),
  };
}

export function clampDetailSidebarWidth(width: number, drawerWidth: number): number {
  const bounds = detailSidebarBounds(drawerWidth);
  return Math.min(bounds.max, Math.max(bounds.min, width));
}
