import { imageEditorMatrix } from "./geometry";
import { effectiveEditorAdjustments } from "./model";
import type { ImageEditorAnnotation, ImageEditorSourceSize, ImageEditorState } from "./types";

const context = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw an image");
  return ctx;
};
let grainTile: HTMLCanvasElement | undefined;
const noiseTile = () => {
  if (grainTile) return grainTile;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = context(canvas);
  const pixels = ctx.createImageData(256, 256);
  let seed = 0x6d2b79f5;
  // Only this reusable 256px tile has a pixel loop. Never loop over the full photograph.
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const gray = seed >>> 24;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  // Prefilter the reusable texture once. Raw one-pixel noise aliases differently in a small preview and a
  // downsampled export. A shared low-frequency tile keeps grain stable at both sizes without per-photo loops.
  const reduced = document.createElement("canvas");
  reduced.width = reduced.height = 64;
  const downsample = context(reduced);
  downsample.imageSmoothingQuality = "high";
  downsample.drawImage(canvas, 0, 0, 64, 64);
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(reduced, 0, 0, 256, 256);
  reduced.width = reduced.height = 0;
  grainTile = canvas;
  return canvas;
};

const drawAnnotation = (ctx: CanvasRenderingContext2D, mark: ImageEditorAnnotation, size: ImageEditorSourceSize) => {
  const first = mark.points[0];
  if (!first) return;
  const last = mark.points.at(-1) ?? first;
  const x = first.x * size.width;
  const y = first.y * size.height;
  const endX = last.x * size.width;
  const endY = last.y * size.height;
  const width = (mark.width * Math.max(size.width, size.height)) / 1000;
  ctx.save();
  ctx.globalAlpha = mark.tool === "highlighter" ? 0.35 : 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = ctx.fillStyle = mark.tool === "redact" ? "#000000" : mark.color;
  ctx.beginPath();
  if (mark.tool === "text") {
    ctx.font = `${width}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(mark.text ?? "", x, y);
  } else if (mark.tool === "redact") {
    ctx.fillRect(Math.min(x, endX), Math.min(y, endY), Math.abs(endX - x), Math.abs(endY - y));
  } else if (mark.tool === "rect") {
    ctx.strokeRect(x, y, endX - x, endY - y);
  } else if (mark.tool === "ellipse") {
    ctx.ellipse((x + endX) / 2, (y + endY) / 2, Math.abs(endX - x) / 2, Math.abs(endY - y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mark.tool === "arrow") {
    const angle = Math.atan2(endY - y, endX - x);
    const head = width * 4;
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    ctx.moveTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(endX, endY);
    ctx.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  } else {
    ctx.moveTo(x, y);
    for (const point of mark.points.slice(1)) ctx.lineTo(point.x * size.width, point.y * size.height);
    if (mark.points.length === 1) {
      ctx.arc(x, y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.stroke();
  }
  ctx.restore();
};

/** Shared by interactive previews and final exports; uses Canvas2D compositing, never canvas/CSS filters. */
export function renderImageEditor(
  image: CanvasImageSource,
  source: ImageEditorSourceSize,
  state: ImageEditorState,
  canvas: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
): void {
  const { width, height } = canvas;
  const ctx = context(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const matrix = imageEditorMatrix(source, state, canvas);
  ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.drawImage(image, 0, 0, source.width, source.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  scratch.width = width;
  scratch.height = height;
  const helper = context(scratch);
  const adjustments = effectiveEditorAdjustments(state);
  const tint = (color: string, opacity: number) => {
    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  };
  const blend = (operation: GlobalCompositeOperation, opacity: number, draw: (target: CanvasRenderingContext2D) => void) => {
    if (opacity <= 0) return;
    helper.setTransform(1, 0, 0, 1, 0, 0);
    helper.globalAlpha = 1;
    helper.globalCompositeOperation = "source-over";
    helper.clearRect(0, 0, width, height);
    helper.drawImage(canvas, 0, 0);
    helper.globalCompositeOperation = operation;
    helper.globalAlpha = Math.min(1, opacity);
    draw(helper);
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  };
  if (adjustments.brightness < 1) tint("#000000", 1 - adjustments.brightness);
  else if (adjustments.brightness > 1) blend("lighter", adjustments.brightness - 1, (target) => target.drawImage(canvas, 0, 0));
  if (adjustments.contrast < 1) tint("rgb(128 128 128)", 1 - adjustments.contrast);
  else if (adjustments.contrast > 1) blend("overlay", (adjustments.contrast - 1) * 2, (target) => target.drawImage(canvas, 0, 0));
  if (adjustments.saturation !== 1)
    blend("saturation", adjustments.saturation < 1 ? 1 - adjustments.saturation : (adjustments.saturation - 1) / 2, (target) => {
      target.fillStyle = adjustments.saturation < 1 ? "hsl(0 0% 50%)" : "hsl(0 100% 50%)";
      target.fillRect(0, 0, width, height);
    });
  if (adjustments.warmth !== 0)
    blend("soft-light", Math.abs(adjustments.warmth), (target) => {
      target.fillStyle = adjustments.warmth > 0 ? "#ff9a3c" : "#3c8cff";
      target.fillRect(0, 0, width, height);
    });
  if (adjustments.vignette > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.scale(width, height);
    const gradient = ctx.createRadialGradient(0.5, 0.5, 0.225, 0.5, 0.5, 0.5);
    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(1, `rgba(0,0,0,${adjustments.vignette})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1, 1);
    ctx.restore();
  }
  if (adjustments.grain > 0)
    blend("overlay", adjustments.grain, (target) => {
      const pattern = target.createPattern(noiseTile(), "repeat");
      if (!pattern) throw new Error("This browser cannot draw image grain");
      const tileScale = Math.max(width, height) / (4 * 256);
      pattern.setTransform(new DOMMatrix().scale(tileScale));
      target.imageSmoothingEnabled = true;
      target.imageSmoothingQuality = "high";
      target.fillStyle = pattern;
      target.fillRect(0, 0, width, height);
    });
  ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  // Hidden marks are left out of the preview and the export alike.
  for (const annotation of state.annotations)
    if (annotation.tool !== "redact" && !annotation.hidden) drawAnnotation(ctx, annotation, source);
  // Opaque redactions always cover every adjustment and annotation, and are never hidden.
  for (const annotation of state.annotations) if (annotation.tool === "redact") drawAnnotation(ctx, annotation, source);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
