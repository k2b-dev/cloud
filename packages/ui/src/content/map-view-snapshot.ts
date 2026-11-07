import type { MapViewSnapshot } from "./map-view-types";

/** Same decoded RGBA budget as Cloud's isolated print-image worker (64 MiB). */
export const MAP_SNAPSHOT_MAX_PIXELS = 16 * 1024 * 1024;
export type MapSnapshotErrorCode =
  | "not_ready"
  | "resource_failed"
  | "changed"
  | "disposed"
  | "busy"
  | "too_large"
  | "timed_out"
  | "aborted"
  | "capture_failed";
export class MapSnapshotError extends Error {
  constructor(readonly code: MapSnapshotErrorCode) {
    super(`Map snapshot: ${code}`);
    this.name = "MapSnapshotError";
  }
}

export function snapshotAborted(signal: AbortSignal): MapSnapshotError {
  return signal.reason instanceof MapSnapshotError ? signal.reason : new MapSnapshotError("aborted");
}

/** Also observes late rejection; a cancelled image/font/encoding operation never becomes unhandled. */
export function snapshotWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(snapshotAborted(signal));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const svgNamespace = "http://www.w3.org/2000/svg";
// Only renderer-owned shapes and paint cross into the rasterizer; no foreignObject, links, images or CSS URLs.
const paints = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
] as const;
function geometryImage(root: HTMLElement, bounds: DOMRect): HTMLImageElement | undefined {
  const source = root.querySelector<SVGSVGElement>(".k2b-map-view__geometry");
  if (!source) return;
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("width", String(bounds.width));
  svg.setAttribute("height", String(bounds.height));
  const geometry = document.createElementNS(svgNamespace, "svg");
  const box = source.getBoundingClientRect();
  for (const [name, value] of Object.entries({
    x: box.left - bounds.left,
    y: box.top - bounds.top,
    width: box.width,
    height: box.height,
    viewBox: source.getAttribute("viewBox") ?? "",
    preserveAspectRatio: "none",
    overflow: "visible",
  }))
    geometry.setAttribute(name, String(value));
  for (const shape of source.querySelectorAll("path")) {
    const copy = document.createElementNS(svgNamespace, shape.localName);
    for (const name of ["d", "cx", "cy", "r", "vector-effect"]) {
      const value = shape.getAttribute(name);
      if (value !== null) copy.setAttribute(name, value);
    }
    const style = getComputedStyle(shape);
    for (const name of paints) {
      const value = style.getPropertyValue(name);
      if (value.includes("url(")) throw new MapSnapshotError("capture_failed");
      copy.setAttribute(name, value);
    }
    geometry.append(copy);
  }
  svg.append(geometry);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  return image;
}

function drawPins(ctx: CanvasRenderingContext2D, root: HTMLElement, bounds: DOMRect) {
  const pins = Array.from(root.querySelectorAll<HTMLElement>(".k2b-map-view__pin"));
  // The selected pin paints above the others, as in the DOM.
  pins.sort((a, b) => Number(a.getAttribute("aria-pressed") === "true") - Number(b.getAttribute("aria-pressed") === "true"));
  for (const pin of pins) {
    const box = pin.getBoundingClientRect();
    const style = getComputedStyle(pin);
    const x = box.left - bounds.left,
      y = box.top - bounds.top;
    // Resolve CSS variables through a paint property, since custom properties can still contain var().
    const selected = pin.getAttribute("aria-pressed") === "true" || pin.hasAttribute("data-selected");
    const stop = pin.hasAttribute("data-stop");
    const surface = getComputedStyle(root.querySelector(".k2b-map-view__attribution") ?? root).backgroundColor;
    ctx.save();
    if (pin.hasAttribute("data-drop")) {
      const span = pin.querySelector("span")!;
      ctx.fillStyle = getComputedStyle(span).backgroundColor;
      ctx.beginPath();
      ctx.ellipse(x + box.width / 2, y + box.height / 2, box.width / 2, box.height / 2, 0, Math.PI, Math.PI * 2);
      ctx.lineTo(x + box.width, y + box.height * 0.68);
      ctx.lineTo(x + box.width / 2, y + box.height);
      ctx.lineTo(x, y + box.height * 0.68);
      ctx.closePath();
      ctx.fill();
      if (selected) {
        ctx.fillStyle = surface;
        ctx.beginPath();
        ctx.arc(x + box.width / 2, y + box.height * 0.34, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(x + box.width / 2, y + box.height / 2, box.width / 2 + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + box.width / 2, y + box.height / 2, box.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = style.backgroundColor;
      ctx.fill();
      // The first box-shadow is the resolved inset tone ring. Text ink can differ in dark mode.
      const ring = style.boxShadow.match(/(?:rgba?|color|oklch|oklab)\([^)]*\)/)?.[0];
      if (!ring && !stop && !selected) throw new MapSnapshotError("capture_failed");
      ctx.strokeStyle = stop || selected ? style.backgroundColor : ring!;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + box.width / 2, y + box.height / 2, box.width / 2 - 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = style.color;
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(pin.textContent ?? "", x + box.width / 2, y + box.height / 2);
    }
    ctx.restore();
  }
}

function drawAttribution(ctx: CanvasRenderingContext2D, root: HTMLElement, bounds: DOMRect) {
  const attribution = root.querySelector<HTMLElement>(".k2b-map-view__attribution");
  if (!attribution?.textContent?.trim()) throw new MapSnapshotError("capture_failed");
  const box = attribution.getBoundingClientRect();
  const style = getComputedStyle(attribution);
  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(box.left - bounds.left, box.top - bounds.top, box.width, box.height);
  const walker = document.createTreeWalker(attribution, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement!;
    const ink = getComputedStyle(parent);
    ctx.fillStyle = ink.color;
    ctx.font = `${ink.fontWeight} ${ink.fontSize} ${ink.fontFamily}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    // Per-character ranges preserve line breaks, wrapping, and bidi positions without capturing arbitrary HTML.
    const range = document.createRange();
    for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      ctx.fillText(node.textContent![i]!, r.left - bounds.left, r.top - bounds.top);
    }
  }
}

/** Called synchronously in MapLibre's render event, before WebGL clears its drawing buffer. */
export async function rasterizeMapView(root: HTMLElement, base: HTMLCanvasElement, signal: AbortSignal): Promise<MapViewSnapshot> {
  const bounds = root.getBoundingClientRect();
  const width = Math.round(bounds.width),
    height = Math.round(bounds.height);
  if (width < 1 || height < 1 || width > 16383 || height > 16383 || width * height > MAP_SNAPSHOT_MAX_PIXELS)
    throw new MapSnapshotError("too_large");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new MapSnapshotError("capture_failed");
  try {
    // Copy the GPU frame immediately. No preserveDrawingBuffer overhead for ordinary interactive maps.
    ctx.drawImage(base, 0, 0, width, height);
    const geometry = geometryImage(root, bounds);
    // Save all overlay pixels before yielding, so subsequent DOM changes cannot mix revisions.
    const overlay = document.createElement("canvas");
    overlay.width = width;
    overlay.height = height;
    try {
      const ink = overlay.getContext("2d")!;
      drawPins(ink, root, bounds);
      drawAttribution(ink, root, bounds);
      if (geometry) {
        await snapshotWait(geometry.decode(), signal);
        ctx.drawImage(geometry, 0, 0, width, height);
      }
      ctx.drawImage(overlay, 0, 0);
    } finally {
      overlay.width = overlay.height = 0;
    }
    const data = await snapshotWait(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new MapSnapshotError("capture_failed"))), "image/png"),
      ),
      signal,
    );
    return { data, width, height };
  } catch (error) {
    if (error instanceof MapSnapshotError) throw error;
    throw new MapSnapshotError("capture_failed");
  } finally {
    canvas.width = canvas.height = 0;
  }
}
