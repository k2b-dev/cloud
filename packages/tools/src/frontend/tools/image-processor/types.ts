import type { ImgData } from "@k2b/stdlib/browser";

export type Adjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  hueRotate: number;
  blur: number;
  sepia: number;
  vignette: number;
  grain: number;
  freeRotation: number;
  flipH: boolean;
  flipV: boolean;
};

export type MarkupPoint = { x: number; y: number };
export type MarkupTool = "select" | "pen" | "highlighter" | "redact" | "shape" | "text" | "eraser";
export type MarkupShapeKind = "rectangle" | "circle" | "arrow";

export type MarkupElement =
  | {
      id: string;
      kind: "stroke";
      points: MarkupPoint[];
      color: string;
      size: number;
      opacity: number;
    }
  | {
      id: string;
      kind: "redaction";
      start: MarkupPoint;
      end: MarkupPoint;
      color: string;
    }
  | {
      id: string;
      kind: "shape";
      shape: MarkupShapeKind;
      start: MarkupPoint;
      end: MarkupPoint;
      color: string;
      size: number;
    }
  | {
      id: string;
      kind: "text";
      position: MarkupPoint;
      text: string;
      color: string;
      size: number;
    };

export type ImageEntry = {
  id: string;
  file: File;
  source: ImgData;
  previewSource: ImgData;
  originalSource: ImgData;
  originalPreviewSource: ImgData;
  thumbUrl: string;
  name: string;
  adj: Adjustments;
  markup: MarkupElement[];
  markupUndo: MarkupElement[][];
  markupRedo: MarkupElement[][];
  cropped: boolean;
  cropBounds: CropRect;
};

export type CropAspect = "free" | "1:1" | "4:3" | "16:9" | "3:2";
export type CropRect = { x: number; y: number; w: number; h: number };
export type ExportFormat = "webp" | "jpeg" | "png";
export type Preset = Omit<Adjustments, "freeRotation" | "flipH" | "flipV">;
