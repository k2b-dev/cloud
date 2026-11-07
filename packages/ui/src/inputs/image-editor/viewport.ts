/** The free canvas view: the image sits at (x, y) in canvas pixels and shows `zoom` canvas pixels per source pixel. */
export type ImageEditorView = { zoom: number; x: number; y: number };
export type ImageEditorInsets = { top: number; right: number; bottom: number; left: number };
type Size = { width: number; height: number };

export const IMAGE_EDITOR_MIN_ZOOM = 0.02;
export const IMAGE_EDITOR_MAX_ZOOM = 8;
/** At least this much of the image stays on the canvas, so it can always be grabbed again. */
const KEEP_VISIBLE = 72;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Fits the frame into the canvas minus the floating overlays; small images stay at 100 %. */
export function fitImageEditorView(frame: Size, canvas: Size, insets: ImageEditorInsets): ImageEditorView {
  const width = Math.max(40, canvas.width - insets.left - insets.right);
  const height = Math.max(40, canvas.height - insets.top - insets.bottom);
  const zoom = clamp(Math.min(width / frame.width, height / frame.height, 1), IMAGE_EDITOR_MIN_ZOOM, IMAGE_EDITOR_MAX_ZOOM);
  return { zoom, x: insets.left + (width - frame.width * zoom) / 2, y: insets.top + (height - frame.height * zoom) / 2 };
}

/** Keeps a strip of the image on the canvas; the image may otherwise move under every overlay. */
export function clampImageEditorView(view: ImageEditorView, frame: Size, canvas: Size): ImageEditorView {
  const keepX = Math.min(KEEP_VISIBLE, frame.width * view.zoom);
  const keepY = Math.min(KEEP_VISIBLE, frame.height * view.zoom);
  return {
    zoom: view.zoom,
    x: clamp(view.x, keepX - frame.width * view.zoom, canvas.width - keepX),
    y: clamp(view.y, keepY - frame.height * view.zoom, canvas.height - keepY),
  };
}

/** Zooms around a canvas point, so the pixel under the pointer stays where it is. */
export function zoomImageEditorView(view: ImageEditorView, zoom: number, at: { x: number; y: number }): ImageEditorView {
  const next = clamp(zoom, IMAGE_EDITOR_MIN_ZOOM, IMAGE_EDITOR_MAX_ZOOM);
  return { zoom: next, x: at.x - ((at.x - view.x) * next) / view.zoom, y: at.y - ((at.y - view.y) * next) / view.zoom };
}

export const sameImageEditorView = (a: ImageEditorView, b: ImageEditorView) =>
  Math.abs(a.zoom - b.zoom) < 0.002 && Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;

/**
 * A mouse wheel zooms; a trackpad scroll pans. Browsers expose no device type, so whole-line or
 * large integer steps without a horizontal part count as a wheel.
 */
export const isMouseWheel = (event: WheelEvent) =>
  event.deltaMode !== 0 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 50 && Number.isInteger(event.deltaY));
