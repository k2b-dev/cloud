/** Screen transform of zoomable content: `translate(x, y) scale(scale)` from the viewport origin. */
export type ZoomPanTransform = { scale: number; x: number; y: number };

/** Viewport size and the content's untransformed box inside it, all in CSS pixels. */
export type ZoomPanGeometry = {
  width: number;
  height: number;
  content: { left: number; top: number; width: number; height: number };
};

/** Fit is the untransformed layout; zoom never goes below it. */
export const ZOOM_PAN_FIT: ZoomPanTransform = { scale: 1, x: 0, y: 0 };
export const ZOOM_PAN_MAX_SCALE = 8;
/** Button and key steps: six steps of √2 reach the maximum from fit. */
export const ZOOM_PAN_STEP = Math.SQRT2;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Keep content on screen: content larger than the viewport must cover it, and
 * smaller content must stay fully inside it. Fit is always a valid position.
 */
const clampAxis = (offset: number, scale: number, start: number, size: number, viewport: number): number => {
  const first = -scale * start;
  const last = viewport - scale * (start + size);
  return clamp(offset, Math.min(first, last), Math.max(first, last));
};

export const clampZoomPan = (transform: ZoomPanTransform, geometry: ZoomPanGeometry): ZoomPanTransform => {
  const scale = clamp(Number.isFinite(transform.scale) ? transform.scale : 1, 1, ZOOM_PAN_MAX_SCALE);
  // Snap to the exact fit so a zoom-out round trip leaves no residual offset.
  if (scale <= 1.0001) return ZOOM_PAN_FIT;
  const { content } = geometry;
  return {
    scale,
    x: clampAxis(transform.x, scale, content.left, content.width, geometry.width),
    y: clampAxis(transform.y, scale, content.top, content.height, geometry.height),
  };
};

/** Zoom to `scale` while the content point under `point` (viewport pixels) stays under it. */
export const zoomZoomPanAt = (
  transform: ZoomPanTransform,
  scale: number,
  point: { x: number; y: number },
  geometry: ZoomPanGeometry,
): ZoomPanTransform => {
  const next = clamp(scale, 1, ZOOM_PAN_MAX_SCALE);
  const ratio = next / transform.scale;
  return clampZoomPan(
    {
      scale: next,
      x: point.x - (point.x - transform.x) * ratio,
      y: point.y - (point.y - transform.y) * ratio,
    },
    geometry,
  );
};

export const panZoomPan = (transform: ZoomPanTransform, deltaX: number, deltaY: number, geometry: ZoomPanGeometry): ZoomPanTransform =>
  clampZoomPan({ scale: transform.scale, x: transform.x + deltaX, y: transform.y + deltaY }, geometry);
