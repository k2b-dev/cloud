import { DIALOG_LIFT } from "./dialog-core";

/** The least room a lifted frame keeps above it, as the frame's own budget keeps at the viewport's edge. */
const EDGE = 8;

/** A frame centered by its stylesheet, which grows down by half of any new height: a sheet or a placed window does not. */
const centered = (frame: HTMLElement): boolean => {
  if (frame.style.inset || frame.hasAttribute("data-k2b-follow-content") || frame.hasAttribute("data-k2b-frame-motion")) return false;
  const transform = getComputedStyle(frame).transform;
  return Boolean(transform && transform !== "none" && new DOMMatrixReadOnly(transform).m42 < -0.5);
};

/**
 * Keeps a dialog's footer where it is whenever the frame's height changes while it is open, such as when an error
 * shows above the footer (K16): a centered frame grows down by half of the new height, so it moves up by that much
 * and grows upwards only; it shrinks from the top as well. It never moves past the top edge: a frame at its full
 * height scrolls its body instead. A frame that follows its content folds from its top edge on its own, a placed
 * window keeps its place, and a sheet keeps its bottom anyway. A new window size centers the frame again.
 * Returns a function that stops it.
 */
export const holdDialogFoot = (footer: HTMLElement): (() => void) | undefined => {
  const frame = footer.closest("dialog");
  if (!frame || typeof ResizeObserver === "undefined") return;
  // The first measure of an open frame is where the footer stands; opening is no change.
  let height: number | undefined;
  const observer = new ResizeObserver(() => {
    const next = frame.offsetHeight;
    const delta = height === undefined || !frame.open ? 0 : next - height;
    height = frame.open ? next : undefined;
    // Only the level on show holds its footer; a level hidden below another one changes nothing.
    if (Math.abs(delta) < 0.5 || !frame.open || !footer.isConnected || footer.offsetParent === null || !centered(frame)) return;
    const half = delta / 2;
    const shift = half > 0 ? Math.min(half, Math.max(0, frame.getBoundingClientRect().top - EDGE)) : half;
    const lift = Math.max(0, (Number.parseFloat(frame.style.getPropertyValue(DIALOG_LIFT)) || 0) + shift);
    if (lift < 0.5) frame.style.removeProperty(DIALOG_LIFT);
    else frame.style.setProperty(DIALOG_LIFT, `${Math.round(lift)}px`);
  });
  const recenter = () => frame.style.removeProperty(DIALOG_LIFT);
  observer.observe(frame);
  window.addEventListener("resize", recenter);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", recenter);
  };
};
