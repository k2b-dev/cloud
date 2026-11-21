/**
 * The custom property that lifts a centered dialog frame. The dialog core clears it whenever another level shows, so
 * each level starts centered.
 */
export const DIALOG_LIFT = "--k2b-dialog-lift";

/** The least room a lifted frame keeps above it, as the frame's own budget keeps at the viewport's edge. */
const EDGE = 8;

/**
 * Keeps a dialog's footer where it was before content above it, such as an error cell, appeared or left (K16): a
 * centered frame grows downwards by half of the new height, so it moves up by that much and so grows upwards only.
 * A frame placed by the page (a modeless window) or anchored at the bottom (a sheet) does not move its footer anyway.
 */
export const keepDialogFoot = (footer: HTMLElement | undefined, before: number | undefined): void => {
  if (!footer?.isConnected || before === undefined) return;
  const frame = footer.closest("dialog");
  // A frame placed by the page keeps its place; a frame that follows its content folds from its top edge on its own.
  if (!frame || frame.style.inset || frame.hasAttribute("data-k2b-follow-content")) return;
  const delta = footer.getBoundingClientRect().bottom - before;
  if (Math.abs(delta) < 0.5) return;
  const top = frame.getBoundingClientRect().top;
  // Never past the top edge: a frame at its full height scrolls its body instead.
  const shift = delta > 0 ? Math.min(delta, Math.max(0, top - EDGE)) : delta;
  const lift = (Number.parseFloat(frame.style.getPropertyValue(DIALOG_LIFT)) || 0) + shift;
  if (Math.abs(lift) < 0.5) return void frame.style.removeProperty(DIALOG_LIFT);
  frame.style.setProperty(DIALOG_LIFT, `${Math.round(lift)}px`);
  // A new window size centers the frame again, so a lift never pushes its header off a smaller screen.
  window.addEventListener("resize", () => frame.style.removeProperty(DIALOG_LIFT), { once: true });
};
