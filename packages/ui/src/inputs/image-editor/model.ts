import { normalizeImageCropRotation } from "../image-crop";
import type { ImageEditorAdjustments, ImageEditorSourceSize, ImageEditorState } from "./types";

export const DEFAULT_IMAGE_OUTPUT_MEGAPIXELS = 16.7;
export const IMAGE_EDITOR_PREVIEW_LONG_EDGE = 2048;
// Preserve Tools' existing 50-step undo budget, now shared by every kind of edit.
const HISTORY_LIMIT = 50;
export const initialImageEditorState = (): ImageEditorState => ({
  crop: { x: 0, y: 0, width: 1, height: 1 },
  rotation: 0,
  straighten: 0,
  flipX: false,
  flipY: false,
  adjustments: { brightness: 1, contrast: 1, saturation: 1, warmth: 0, vignette: 0, grain: 0 },
  look: "original",
  lookStrength: 1,
  annotations: [],
});

type Entry = { state: ImageEditorState };
export type ImageEditorHistory = { entries: readonly Entry[]; index: number; saved: Entry };
export const createImageEditorHistory = (state = initialImageEditorState()): ImageEditorHistory => {
  const entry = { state };
  return { entries: [entry], index: 0, saved: entry };
};
export const currentImageEditorEntry = (history: ImageEditorHistory): Entry => {
  const entry = history.entries[history.index];
  if (!entry) throw new Error("Image editor history has no current entry");
  return entry;
};
export const imageEditorDirty = (history: ImageEditorHistory): boolean => currentImageEditorEntry(history) !== history.saved;
export const commitImageEditorState = (history: ImageEditorHistory, state: ImageEditorState): ImageEditorHistory => {
  if (state === currentImageEditorEntry(history).state) return history;
  const entries = [...history.entries.slice(0, history.index + 1), { state }].slice(-(HISTORY_LIMIT + 1));
  return { ...history, entries, index: entries.length - 1 };
};
export const undoImageEditor = (history: ImageEditorHistory): ImageEditorHistory => ({ ...history, index: Math.max(0, history.index - 1) });
export const redoImageEditor = (history: ImageEditorHistory): ImageEditorHistory => ({
  ...history,
  index: Math.min(history.entries.length - 1, history.index + 1),
});
export const markImageEditorSaved = (history: ImageEditorHistory, entry = currentImageEditorEntry(history)): ImageEditorHistory => ({
  ...history,
  saved: entry,
});

export const rotatedEditorSize = (source: ImageEditorSourceSize, state: ImageEditorState) =>
  state.rotation === 90 || state.rotation === 270
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height };
export const rotateEditorRight = (state: ImageEditorState): ImageEditorState => ({
  ...state,
  rotation: normalizeImageCropRotation(state.rotation + 90),
  crop: { x: 1 - state.crop.y - state.crop.height, y: state.crop.x, width: state.crop.height, height: state.crop.width },
  // Flip axes belong to the rotated coordinate system.
  flipX: state.flipY,
  flipY: state.flipX,
});

export const editorOutputSize = (
  source: ImageEditorSourceSize,
  state: ImageEditorState,
  maxMegapixels: number | "device" = DEFAULT_IMAGE_OUTPUT_MEGAPIXELS,
  maxLongEdge?: number,
) => {
  if (![source.width, source.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Invalid image dimensions");
  if (maxMegapixels !== "device" && (!Number.isFinite(maxMegapixels) || maxMegapixels <= 0)) throw new Error("Invalid image output limit");
  if (maxLongEdge !== undefined && (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0)) throw new Error("Invalid image output edge");
  const size = rotatedEditorSize(source, state);
  const width = Math.max(1, Math.floor(size.width * state.crop.width));
  const height = Math.max(1, Math.floor(size.height * state.crop.height));
  const pixelScale = maxMegapixels === "device" ? 1 : Math.sqrt((maxMegapixels * 1_000_000) / (width * height));
  const scale = Math.min(1, pixelScale, maxLongEdge === undefined ? 1 : maxLongEdge / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), downscaled: scale < 1 };
};

const looks: Record<ImageEditorState["look"], Partial<ImageEditorAdjustments>> = {
  original: {},
  vivid: { contrast: 1.15, saturation: 1.25 },
  soft: { contrast: 0.85, brightness: 1.05, warmth: 0.08 },
  mono: { saturation: 0, contrast: 1.1 },
  warm: { warmth: 0.24, saturation: 1.05 },
  cool: { warmth: -0.2, saturation: 0.95 },
};
export const effectiveEditorAdjustments = (state: ImageEditorState): ImageEditorAdjustments => {
  const defaults = initialImageEditorState().adjustments;
  const preset = looks[state.look];
  const strength = Math.max(0, Math.min(1, state.lookStrength));
  const adjust = (key: keyof ImageEditorAdjustments) =>
    state.adjustments[key] + ((preset[key] ?? defaults[key]) - defaults[key]) * strength;
  return {
    brightness: Math.max(0, adjust("brightness")),
    contrast: Math.max(0, adjust("contrast")),
    saturation: Math.max(0, adjust("saturation")),
    warmth: Math.max(-1, Math.min(1, adjust("warmth"))),
    vignette: Math.max(0, Math.min(1, adjust("vignette"))),
    grain: Math.max(0, Math.min(1, adjust("grain"))),
  };
};
