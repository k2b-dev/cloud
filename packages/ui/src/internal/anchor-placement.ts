/** Distance between a surface and its anchor. */
export const ANCHOR_GAP = 6;
/** Distance a surface keeps from the edges of the visible viewport. */
const MARGIN = 8;
/** Where a surface at a control becomes a bottom sheet across the screen. */
export const SHEET_QUERY = "(max-width: 47.999rem)";

export type AnchorPlacementOptions = {
  /** The side tried first. Defaults to `below`. */
  side?: "below" | "above";
  /** Which edge lines up with the anchor. */
  align: "start" | "end";
  /** The side chosen earlier, kept so a surface that grows never flips while open. */
  above?: boolean;
  /** The tallest the surface gets while open; the side is chosen for this height. */
  plannedHeight?: number;
};

/**
 * Places a fixed surface below or above its anchor, lined up with the anchor's start or end edge, and clamps it into
 * the visible viewport with a margin. The surface flips to the other side only when that side has more room. Returns
 * the chosen side, to keep it while the surface stays open, and the room on that side.
 */
export const placeAtAnchor = (
  surface: HTMLElement,
  anchor: HTMLElement,
  options: AnchorPlacementOptions,
): { above: boolean; room: number } => {
  const viewport = window.visualViewport;
  const view = {
    top: (viewport?.offsetTop ?? 0) + MARGIN,
    bottom: (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - MARGIN,
    left: (viewport?.offsetLeft ?? 0) + MARGIN,
    right: (viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - MARGIN,
  };
  const box = anchor.getBoundingClientRect();
  const size = surface.getBoundingClientRect();
  const roomAbove = box.top - ANCHOR_GAP - view.top;
  const roomBelow = view.bottom - box.bottom - ANCHOR_GAP;
  let above = options.above;
  if (above === undefined) {
    const planned = Math.max(size.height, options.plannedHeight ?? 0);
    above =
      (options.side ?? "below") === "above" ? planned <= roomAbove || roomAbove > roomBelow : planned > roomBelow && roomAbove > roomBelow;
  }
  const top = above ? box.top - ANCHOR_GAP - size.height : box.bottom + ANCHOR_GAP;
  const left = options.align === "end" ? box.right - size.width : box.left;
  surface.style.left = `${Math.round(Math.max(view.left, Math.min(left, view.right - size.width)))}px`;
  surface.style.top = `${Math.round(Math.max(view.top, Math.min(top, view.bottom - size.height)))}px`;
  return { above, room: above ? roomAbove : roomBelow };
};
