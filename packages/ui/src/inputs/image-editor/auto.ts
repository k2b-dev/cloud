import { initialImageEditorState } from "./model";
import { renderImageEditor } from "./render";
import type { ImageEditorAutoAdjustments, ImageEditorSourceSize, ImageEditorState } from "./types";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const SAMPLE_LONG_EDGE = 256;

/**
 * Auto is an analysis, not a filter: it measures the framed photo (crop, rotation and straightening applied,
 * the current sliders ignored) and returns slider values that stay freely editable.
 *
 * This is deliberately one replaceable function. A shared browser and server calculation for the colour
 * sliders may replace its body later; the editor only depends on this signature.
 */
export function analyzeImageEditorAuto(
  image: CanvasImageSource,
  source: ImageEditorSourceSize,
  state: ImageEditorState,
): ImageEditorAutoAdjustments {
  const frame = { ...initialImageEditorState(), crop: state.crop, rotation: state.rotation, straighten: state.straighten };
  const turned = state.rotation === 90 || state.rotation === 270;
  const width = (turned ? source.height : source.width) * state.crop.width;
  const height = (turned ? source.width : source.height) * state.crop.height;
  const scale = Math.min(1, SAMPLE_LONG_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  const scratch = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    renderImageEditor(image, source, frame, canvas, scratch);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser cannot read image pixels");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const histogram = new Uint32Array(256);
    let red = 0;
    let blue = 0;
    let saturation = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 128) continue;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const max = Math.max(r, g, b);
      histogram[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]!++;
      red += r;
      blue += b;
      saturation += max ? (max - Math.min(r, g, b)) / max : 0;
      count++;
    }
    if (!count) return {};
    const percentile = (q: number) => {
      let total = 0;
      for (let v = 0; v < 256; v++) {
        total += histogram[v] ?? 0;
        if (total >= q * count) return v / 255;
      }
      return 1;
    };
    const low = percentile(0.01);
    const middle = percentile(0.5);
    const high = percentile(0.99);
    // Values in slider units (-100…100), converted to the model's factors below.
    const brightness = clamp(Math.round((0.46 - middle) * 80), -30, 30);
    const contrast = clamp(Math.round((0.9 / Math.max(0.2, high - low) - 1) * 60), -20, 30);
    const saturate = clamp(Math.round((0.3 - saturation / count) * 80), -20, 20);
    const warmth = clamp(Math.round(((blue - red) / count / 255) * 120), -20, 20);
    return { brightness: 1 + brightness / 100, contrast: 1 + contrast / 100, saturation: 1 + saturate / 100, warmth: warmth / 100 };
  } finally {
    canvas.width = canvas.height = scratch.width = scratch.height = 0;
  }
}
