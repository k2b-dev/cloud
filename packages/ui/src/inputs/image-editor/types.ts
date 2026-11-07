import type { JSX } from "solid-js";
import type { ImageCropRect, ImageCropRotation } from "../image-crop";

export type ImageEditorFormat = "image/jpeg" | "image/png" | "image/webp";
export type ImageEditorAspect =
  | "free"
  | "original"
  | "1:1"
  | "4:5"
  | "3:2"
  | "4:3"
  | "16:9"
  | "9:16"
  | { width: number; height: number; label: string };
export type ImageEditorAnnotationTool = "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "text";
export type ImageEditorFeatures = {
  crop?: boolean | { aspects?: readonly ImageEditorAspect[]; defaultAspect?: ImageEditorAspect; locked?: boolean };
  rotate?: boolean;
  straighten?: boolean;
  adjust?: boolean;
  filters?: boolean;
  annotate?: boolean | { tools?: readonly ImageEditorAnnotationTool[] };
  redact?: boolean;
  export?: boolean | { formats?: readonly ImageEditorFormat[]; quality?: boolean; resize?: boolean };
};
export type ImageEditorSourceSize = { width: number; height: number; type?: string };
export type ImageEditorPreview = { source: Blob | string; width: number; height: number };
export type ImageEditorOutput = { format?: ImageEditorFormat | "same"; quality?: number; maxLongEdge?: number };
export type ImageEditorResult = {
  blob: Blob;
  width: number;
  height: number;
  type: ImageEditorFormat;
  originalWidth: number;
  originalHeight: number;
  downscaled: boolean;
};
export type ImageEditorSaveActions = {
  save: (commit: (result: ImageEditorResult) => Promise<void>, output?: ImageEditorOutput) => Promise<void>;
  dirty: boolean;
  busy: boolean;
};
export type ImageEditorProps = {
  source: File | Blob | string;
  /** Required with previews, so opening the editor does not read the full source. */
  sourceSize?: ImageEditorSourceSize;
  previews?: readonly ImageEditorPreview[];
  /** Default 16.7 MP. "device" attempts the source size, subject to runtime canvas/encoder support. */
  maxOutputMegapixels?: number | "device";
  features: ImageEditorFeatures;
  output?: ImageEditorOutput;
  saveActions?: (actions: ImageEditorSaveActions) => JSX.Element;
  onSave?: (result: ImageEditorResult) => void | Promise<void>;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  class?: string;
};

export type ImageEditorPoint = { x: number; y: number };
export type ImageEditorAnnotation = {
  tool: ImageEditorAnnotationTool | "redact";
  points: readonly ImageEditorPoint[];
  color: string;
  /** Relative to the source's long edge, in thousandths. */
  width: number;
  text?: string;
};
export type ImageEditorAdjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  vignette: number;
  grain: number;
};
export type ImageEditorLook = "original" | "vivid" | "soft" | "mono" | "warm" | "cool" | "mono-hard" | "faded" | "vintage";
export type ImageEditorState = {
  cropAspect: ImageEditorAspect;
  cropAspectSwapped: boolean;
  crop: ImageCropRect;
  rotation: ImageCropRotation;
  straighten: number;
  flipX: boolean;
  flipY: boolean;
  adjustments: ImageEditorAdjustments;
  look: ImageEditorLook;
  lookStrength: number;
  annotations: readonly ImageEditorAnnotation[];
};
