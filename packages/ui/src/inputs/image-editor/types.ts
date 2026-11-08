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
  /** Browser-verified encoders allowed by this editor, populated asynchronously. */
  readonly formats: readonly ImageEditorFormat[];
  save: (commit: (result: ImageEditorResult) => Promise<void>, output?: ImageEditorOutput) => Promise<void>;
  dirty: boolean;
  busy: boolean;
};
/** One image in the strip beside the view bar: the opened photos in Tools, the folder or selection in Files. */
export type ImageEditorItem = {
  id: string;
  name: string;
  /** Small image URL, or a component that renders the caller's own thumbnail; a neutral tile shows until it loads. */
  thumbnail?: string | (() => JSX.Element);
  /** Marks an image with unsaved edits. */
  dirty?: boolean;
};
/** An extra info chip after name, size and format, such as a file version or "Read only". */
export type ImageEditorFact = { label: string; icon?: string; tooltip?: string };
export type ImageEditorProps = {
  source: File | Blob | string;
  /** Name in the first chip. Defaults to the File's name. */
  title?: string;
  facts?: readonly ImageEditorFact[];
  /** A quiet line above the save actions that holds for the whole session, such as why saving is locked. */
  notice?: string;
  /** Shown while the image has redactions, for example when older unredacted versions remain. */
  redactionNotice?: string;
  /** With more than one item the strip appears; the caller swaps `source` on selection. */
  items?: readonly ImageEditorItem[];
  currentItem?: string;
  onSelectItem?: (id: string) => void;
  /** Adds a "+" at the end of the strip. */
  onAddItems?: () => void;
  /** Required with previews, so opening the editor does not read the full source. */
  sourceSize?: ImageEditorSourceSize;
  previews?: readonly ImageEditorPreview[];
  /** Default 16.7 MP. "device" attempts the source size, subject to runtime canvas/encoder support. */
  maxOutputMegapixels?: number | "device";
  features: ImageEditorFeatures;
  output?: ImageEditorOutput;
  saveActions?: (actions: ImageEditorSaveActions) => JSX.Element;
  /** Replaces the retry action for a rejected caller commit. Export and size failures keep their own retry. */
  saveErrorAction?: { label: string; onClick: () => void };
  onSave?: (result: ImageEditorResult) => void | Promise<void>;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  class?: string;
};

export type ImageEditorPoint = { x: number; y: number };
export type ImageEditorAnnotation = {
  /** Stable within an editing session; names and selection follow it while layers move. */
  id?: string;
  /** Hidden marks are neither drawn nor exported. Redactions are never hidden. */
  hidden?: boolean;
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
/** Slider values set by Auto; a slider counts as "Auto" while its value still equals this. */
export type ImageEditorAutoAdjustments = Partial<Pick<ImageEditorAdjustments, "brightness" | "contrast" | "saturation" | "warmth">>;
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
  auto?: ImageEditorAutoAdjustments;
};
