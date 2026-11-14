export type FloatingWindowRect = { x: number; y: number; width: number; height: number };
/** The area a window lives in, in viewport pixels. Without `x` and `y` it starts at the top left corner. */
export type FloatingWindowBounds = { x?: number; y?: number; width: number; height: number };
export type FloatingWindowSize = { width: number; height: number };

export const FLOATING_WINDOW_VIEWPORT_GAP = 16;
/** A minimized window is a bar as tall as the window header. */
export const FLOATING_WINDOW_BAR: FloatingWindowSize = { width: 252, height: 42 };
/** Space between docked windows, and between the dock and the bottom edge. */
const DOCK_SPACE = 8;
const DOCK_BOTTOM = 12;
/** A maximized window keeps this much of the area visible around it; wide areas keep 5 % on each side. */
const MAXIMIZED_MARGIN = 24;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export const fitFloatingWindowRect = (
  rect: FloatingWindowRect,
  minWidth: number,
  minHeight: number,
  viewport: FloatingWindowBounds,
): FloatingWindowRect => {
  const left = viewport.x ?? 0;
  const top = viewport.y ?? 0;
  const maxWidth = Math.max(minWidth, viewport.width - FLOATING_WINDOW_VIEWPORT_GAP * 2);
  const maxHeight = Math.max(minHeight, viewport.height - FLOATING_WINDOW_VIEWPORT_GAP * 2);
  const width = clamp(rect.width, minWidth, maxWidth);
  const height = clamp(rect.height, minHeight, maxHeight);
  return {
    width,
    height,
    x: clamp(rect.x, left + FLOATING_WINDOW_VIEWPORT_GAP, left + viewport.width - width - FLOATING_WINDOW_VIEWPORT_GAP),
    y: clamp(rect.y, top + FLOATING_WINDOW_VIEWPORT_GAP, top + viewport.height - height - FLOATING_WINDOW_VIEWPORT_GAP),
  };
};

/** A maximized window covers almost the whole area. */
export const maximizedFloatingWindowRect = (bounds: FloatingWindowBounds): FloatingWindowRect => {
  const marginX = Math.max(MAXIMIZED_MARGIN, Math.round(bounds.width * 0.05));
  return {
    x: (bounds.x ?? 0) + marginX,
    y: (bounds.y ?? 0) + MAXIMIZED_MARGIN,
    width: Math.max(0, bounds.width - marginX * 2),
    height: Math.max(0, bounds.height - MAXIMIZED_MARGIN * 2),
  };
};

/**
 * Lines docked windows up along the bottom edge of the area, the first at the end. A row that is full continues
 * above the previous one, so no two docked windows overlap. A window wider than the area shrinks to fit it.
 */
export const layoutFloatingWindowDock = (sizes: readonly FloatingWindowSize[], bounds: FloatingWindowBounds): FloatingWindowRect[] => {
  const left = (bounds.x ?? 0) + FLOATING_WINDOW_VIEWPORT_GAP;
  const top = (bounds.y ?? 0) + FLOATING_WINDOW_VIEWPORT_GAP;
  const end = (bounds.x ?? 0) + bounds.width - FLOATING_WINDOW_VIEWPORT_GAP;
  let right = end;
  let bottom = (bounds.y ?? 0) + bounds.height - DOCK_BOTTOM;
  let rowHeight = 0;
  return sizes.map((size) => {
    const width = Math.max(0, Math.min(size.width, end - left));
    if (right - width < left && right < end) {
      bottom -= rowHeight + DOCK_SPACE;
      right = end;
      rowHeight = 0;
    }
    const height = Math.max(0, Math.min(size.height, bottom - top));
    const rect = { x: right - width, y: Math.max(top, bottom - height), width, height };
    right = rect.x - DOCK_SPACE;
    rowHeight = Math.max(rowHeight, height);
    return rect;
  });
};
