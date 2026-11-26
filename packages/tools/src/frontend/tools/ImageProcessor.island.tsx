import { files as fileTools, images as imageTools } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { ColorInput, Slider, suppressTextSelection, useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Check,
  Choice,
  Dialog,
  Empty,
  type Fact,
  Facts,
  Field,
  Inline,
  Input,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  Progress,
  Section,
  Tabs,
  Text,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { IMAGE_ACCEPT } from "./image-intake/formats";
import { disposeHeifDecoder, ImageIntakeError, type ImageIntakeFailure, type ImageIntakeStage, prepareImage } from "./image-intake/intake";
import { imageIntakeMessages } from "./image-intake/messages";
import { DEFAULT_ADJ, PRESETS } from "./image-processor/constants";
import { type CropHandle, createCropRect, moveCropRect, resizeCropRect, toPixelCropRect } from "./image-processor/crop-geometry";
import { buildImagePipeline, makePreviewSource, makeThumbnail, rotatedImageDimensions } from "./image-processor/image-processing";
import MarkupOverlay from "./image-processor/MarkupOverlay";
import { composeCropBounds, FULL_CROP_BOUNDS, restoreMarkupFromCrop, transformMarkupForCrop } from "./image-processor/markup";
import { commitMarkupHistory, redoMarkupHistory, undoMarkupHistory } from "./image-processor/markup-history";
import { imageProcessorMessages, type PresetLabelKey, presetLabelKeys } from "./image-processor/messages";
import type {
  Adjustments,
  CropAspect,
  CropRect,
  ExportFormat,
  ImageEntry,
  MarkupElement,
  MarkupPoint,
  MarkupShapeKind,
  MarkupTool,
  Preset,
} from "./image-processor/types";

let nextId = 0;
const uid = () => `images-${++nextId}`;
const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 4;
const PREVIEW_ZOOM_STEP = 1.2;
/** The stage before the browser has measured its pane, and its floor: a photo needs room to be seen. */
const STAGE_HEIGHT = 560;
const STAGE_MIN = 320;
type SizedMarkupTool = "pen" | "highlighter" | "shape" | "text";
type MarkupSelection = { imageId: string; elementId: string };
const MARKUP_COLORS = [
  { value: "#111827", labelKey: "colorBlack" },
  { value: "#ef4444", labelKey: "colorRed" },
  { value: "#f59e0b", labelKey: "colorAmber" },
  { value: "#22c55e", labelKey: "colorGreen" },
  { value: "#3b82f6", labelKey: "colorBlue" },
  { value: "#ffffff", labelKey: "colorWhite" },
] as const;
const CROP_ASPECTS: readonly CropAspect[] = ["free", "1:1", "4:3", "16:9", "3:2"];
const EXPORT_FORMATS: readonly ExportFormat[] = ["webp", "jpeg", "png"];
const ADJUSTMENT_KEYS = ["brightness", "contrast", "saturation", "hueRotate", "blur", "sepia", "vignette", "grain"] as const;

/** The CSS filter of a look: the preview of an adjustment while it is set, and the face of each preset. */
const filterOf = (a: Pick<Adjustments, "brightness" | "contrast" | "saturation" | "hueRotate" | "blur" | "sepia">) => {
  const parts: string[] = [];
  if (a.brightness !== 1) parts.push(`brightness(${a.brightness})`);
  if (a.contrast !== 1) parts.push(`contrast(${a.contrast})`);
  if (a.saturation !== 1) parts.push(`saturate(${a.saturation})`);
  if (a.hueRotate !== 0) parts.push(`hue-rotate(${a.hueRotate}deg)`);
  if (a.blur > 0) parts.push(`blur(${a.blur}px)`);
  if (a.sepia > 0) parts.push(`sepia(${a.sepia})`);
  return parts.join(" ") || "none";
};

const sameLook = (a: Adjustments, preset: Preset) => ADJUSTMENT_KEYS.every((key) => Math.abs(a[key] - preset[key]) < 1e-9);

// k2b-ui gap: the last step of a head's Path does not give way to the head's actions (a long name cut the export
// button at 1024 px); a file name is cut in its middle here, so its start and its extension stay.
const shortName = (name: string, max = 40) => (name.length <= max ? name : `${name.slice(0, max - 15)}…${name.slice(-14)}`);

/** A limit in pixels from a field: empty is no limit, anything else must be a whole positive number. */
const pixels = (value: string): number | null | undefined => {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};
/** A quality in percent from a field, 10 to 100, or not valid. */
const percent = (value: string): number | undefined => {
  const number = Number(value);
  return value.trim() && Number.isFinite(number) && number >= 10 && number <= 100 ? number / 100 : undefined;
};

// ====================================
// Component
// ====================================

type LoadFailure = { file: File; reason: ImageIntakeFailure["reason"] | "crop-active" };

type ImageProcessorViewProps = {
  readonly initialImages?: readonly ImageEntry[];
  readonly initialEditorMode?: "edit" | "markup";
  readonly initialCropActive?: boolean;
  readonly initialLoadFailures?: readonly LoadFailure[];
};

/** @internal Controlled render seam; the route-facing island below remains zero-prop. */
export function ImageProcessorView(props: ImageProcessorViewProps = {}) {
  const locale = useLocale();
  const t = () => imageProcessorMessages.resolve([locale()]).t;
  const intakeT = () => imageIntakeMessages.resolve([locale()]).t;
  const presetLabel = (key: string) => (key in presetLabelKeys ? t()[presetLabelKeys[key as PresetLabelKey]] : key);

  // --- Image list ---
  const [images, setImages] = createSignal<ImageEntry[]>([...(props.initialImages ?? [])]);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [error, setError] = createSignal("");
  const [loadFailures, setLoadFailures] = createSignal<LoadFailure[]>([...(props.initialLoadFailures ?? [])]);
  const [currentLoad, setCurrentLoad] = createSignal<{ name: string; stage: ImageIntakeStage; index: number; count: number } | null>(null);
  const [basePreview, setBasePreview] = createSignal(props.initialImages?.[0]?.thumbUrl ?? "");
  const [previewBusy, setPreviewBusy] = createSignal(false);
  const [previewZoom, setPreviewZoom] = createSignal(1);
  const [previewViewportSize, setPreviewViewportSize] = createSignal({ width: 1, height: 1 });
  const [stageHeight, setStageHeight] = createSignal(STAGE_HEIGHT);
  const [phone, setPhone] = createSignal(false);
  const [draggingFiles, setDraggingFiles] = createSignal(false);

  // --- Editor mode + markup ---
  const [editorMode, setEditorMode] = createSignal<"edit" | "markup">(props.initialEditorMode ?? "edit");
  const [markupTool, setMarkupTool] = createSignal<MarkupTool>("pen");
  const [markupShape, setMarkupShape] = createSignal<MarkupShapeKind>("rectangle");
  const [markupColor, setMarkupColor] = createSignal("#ef4444");
  const [markupSizes, setMarkupSizes] = createSignal<Record<SizedMarkupTool, number>>({
    pen: 8,
    highlighter: 28,
    shape: 6,
    text: 32,
  });
  const [markupSelection, setMarkupSelection] = createSignal<MarkupSelection | null>(null);
  const [textDraft, setTextDraft] = createSignal<{ position: MarkupPoint; imageId: string; text: string } | null>(null);

  // --- Clipboard for copy/paste edits ---
  const [clipboard, setClipboard] = createSignal<Adjustments | null>(null);

  // --- Crop ---
  const [cropActive, setCropActive] = createSignal(Boolean(props.initialCropActive && props.initialImages?.length));
  const [cropBusy, setCropBusy] = createSignal(false);
  const [cropAspect, setCropAspect] = createSignal<CropAspect>("free");
  const [cropRect, setCropRect] = createSignal<CropRect>(createCropRect("free"));
  const [dragging, setDragging] = createSignal<"move" | CropHandle | null>(null);
  const [dragStart, setDragStart] = createSignal<{
    mx: number;
    my: number;
    rect: CropRect;
    pointerId: number;
  } | null>(null);

  let previewRequest = 0;
  let previewViewportRef: HTMLDivElement | undefined;
  let stageRef: HTMLDivElement | undefined;

  // --- Derived ---
  const activeImage = createMemo(() => images()[activeIndex()] ?? null);
  const hasImages = createMemo(() => images().length > 0);
  const adj = createMemo(() => activeImage()?.adj ?? DEFAULT_ADJ);
  const selectedMarkupId = createMemo(() => {
    const image = activeImage();
    const selection = markupSelection();
    return markupTool() === "select" && image && selection?.imageId === image.id ? selection.elementId : null;
  });

  // Helper to update adj for the active image
  const setAdj = (key: keyof Adjustments, value: number | boolean) => {
    setImages((prev) => prev.map((e, i) => (i === activeIndex() ? { ...e, adj: { ...e.adj, [key]: value } } : e)));
  };

  // CSS filter — reactive, instant preview
  const cssFilter = createMemo(() => filterOf(adj()));

  const cssTransform = createMemo(() => {
    const a = adj();
    const parts: string[] = [];
    if (a.flipH) parts.push("scaleX(-1)");
    if (a.flipV) parts.push("scaleY(-1)");
    if (a.freeRotation !== 0) parts.push(`rotate(${a.freeRotation}deg)`);
    return parts.join(" ") || "none";
  });

  const previewLayout = createMemo(() => {
    const image = activeImage();
    if (!image) return null;

    const sourceWidth = image.previewSource.width;
    const sourceHeight = image.previewSource.height;
    const rotation = cropActive() || editorMode() === "markup" ? 0 : adj().freeRotation;
    const bounds = rotatedImageDimensions(sourceWidth, sourceHeight, rotation);
    const viewport = previewViewportSize();
    const fitScale = Math.min(viewport.width / bounds.width, viewport.height / bounds.height);
    const scale = Math.max(0.001, fitScale) * previewZoom();

    return {
      imageWidth: sourceWidth * scale,
      imageHeight: sourceHeight * scale,
      stageWidth: bounds.width * scale,
      stageHeight: bounds.height * scale,
    };
  });

  const measurePreviewViewport = () => {
    const element = previewViewportRef;
    if (!element) return;
    const style = getComputedStyle(element);
    const paddingLeft = Number.parseFloat(style.paddingLeft);
    const paddingRight = Number.parseFloat(style.paddingRight);
    const paddingTop = Number.parseFloat(style.paddingTop);
    const paddingBottom = Number.parseFloat(style.paddingBottom);
    const horizontalPadding = (Number.isFinite(paddingLeft) ? paddingLeft : 0) + (Number.isFinite(paddingRight) ? paddingRight : 0);
    const verticalPadding = (Number.isFinite(paddingTop) ? paddingTop : 0) + (Number.isFinite(paddingBottom) ? paddingBottom : 0);
    setPreviewViewportSize({
      width: Math.max(1, element.clientWidth - horizontalPadding),
      height: Math.max(1, element.clientHeight - verticalPadding),
    });
  };

  // k2b-ui gap: a Canvas has a fixed height or its drawing's; none fills the rest of its pane. The stage measures it:
  // beside the inspector it reaches the pane's end, on the phone (where the panes stack) it takes most of the window.
  const measureStage = () => {
    const stage = stageRef;
    if (!stage) return;
    const pane = stage.closest('[data-k2-part="Pane"]');
    const wide = typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;
    setPhone(!wide);
    // on the phone the stage fills the rest of the first view; the tools follow below it
    const room =
      wide && pane
        ? pane.getBoundingClientRect().bottom - stage.getBoundingClientRect().top
        : window.innerHeight - stage.getBoundingClientRect().top - window.scrollY;
    setStageHeight(Math.max(STAGE_MIN, Math.floor(room)));
  };

  const setClampedPreviewZoom = (next: number) => {
    const viewport = previewViewportRef;
    const centerX = viewport ? (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(1, viewport.scrollWidth) : 0.5;
    const centerY = viewport ? (viewport.scrollTop + viewport.clientHeight / 2) / Math.max(1, viewport.scrollHeight) : 0.5;
    setPreviewZoom(Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, next)));
    requestAnimationFrame(() => {
      if (!viewport) return;
      viewport.scrollTo({
        left: centerX * viewport.scrollWidth - viewport.clientWidth / 2,
        top: centerY * viewport.scrollHeight - viewport.clientHeight / 2,
      });
    });
  };

  const fitPreview = () => {
    setPreviewZoom(1);
    requestAnimationFrame(() => previewViewportRef?.scrollTo({ left: 0, top: 0 }));
  };

  // ====================================
  // File Loading
  // ====================================

  let loadingFiles: File[] = [];
  const loadMutation = mutations.create<void, File[]>({
    mutation: async (files, { abortSignal }) => {
      let index = 0;
      // Drops can also arrive while rebuilding the final preview.
      do {
        const entries: ImageEntry[] = [];
        for (; index < files.length; index++) {
          const file = files[index]!;
          abortSignal.throwIfAborted();
          setCurrentLoad({ name: file.name, stage: "waiting", index: index + 1, count: files.length });
          try {
            const prepared = await prepareImage(file, {
              signal: abortSignal,
              onStage: (stage) => {
                if (!abortSignal.aborted) setCurrentLoad({ name: file.name, stage, index: index + 1, count: files.length });
              },
            });
            const source = await imageTools.create(prepared.source);
            const previewSource = await makePreviewSource(source);
            const thumbUrl = await makeThumbnail(previewSource);
            abortSignal.throwIfAborted();
            entries.push({
              id: uid(),
              file,
              source,
              previewSource,
              originalSource: source,
              originalPreviewSource: previewSource,
              thumbUrl,
              name: file.name,
              adj: { ...DEFAULT_ADJ },
              markup: [],
              markupUndo: [],
              markupRedo: [],
              cropped: false,
              cropBounds: { ...FULL_CROP_BOUNDS },
            });
          } catch (loadError) {
            abortSignal.throwIfAborted();
            const reason = loadError instanceof ImageIntakeError ? loadError.reason : "decode-failed";
            setLoadFailures((current) => [...current, { file, reason }]);
          }
        }
        abortSignal.throwIfAborted();
        if (entries.length === 0) continue;

        const wasEmpty = images().length === 0;
        setImages((prev) => [...prev, ...entries]);
        if (wasEmpty) setActiveIndex(0);
        await rebuildBasePreview();
      } while (index < files.length);
    },
    onError: (err) => {
      if (err.message !== "File dialog cancelled") setError(err.message);
    },
    onFinally: () => {
      loadingFiles = [];
      setCurrentLoad(null);
    },
  });

  const loadFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (cropActive() || cropBusy()) {
      setLoadFailures((current) => [...current, ...files.map((file) => ({ file, reason: "crop-active" as const }))]);
      return;
    }
    if (loadMutation.loading()) {
      // The running mutation drains this same array.
      loadingFiles.push(...files);
      setCurrentLoad((current) => current && { ...current, count: loadingFiles.length });
      return;
    }
    setError("");
    setLoadFailures([]);
    loadingFiles = [...files];
    loadMutation.mutate(loadingFiles);
  };

  const selectFiles = async () => {
    try {
      const files = await fileTools.showFileDialog({ accept: IMAGE_ACCEPT, multiple: true });
      loadFiles(files);
    } catch (selectionError) {
      if (selectionError instanceof Error && selectionError.message === "File dialog cancelled") return;
      setError(selectionError instanceof Error ? selectionError.message : t().pickerFailed);
    }
  };

  const removeImage = (index: number) => {
    const previous = images();
    if (index < 0 || index >= previous.length || cropBusy()) return;

    const currentIndex = activeIndex();
    const currentImageId = previous[currentIndex]?.id;
    const remaining = previous.filter((_, i) => i !== index);
    const nextIndex = index < currentIndex ? currentIndex - 1 : Math.min(currentIndex, remaining.length - 1);
    const nextImageId = remaining[nextIndex]?.id;
    setImages(remaining);
    setActiveIndex(Math.max(0, nextIndex));
    setCropActive(false);
    setDragging(null);
    setDragStart(null);
    setMarkupSelection(null);
    if (currentImageId !== nextImageId) {
      fitPreview();
      setBasePreview("");
      void rebuildBasePreview();
    }
  };

  const switchImage = (index: number) => {
    if (index < 0 || index >= images().length || index === activeIndex() || cropBusy()) return;
    fitPreview();
    setBasePreview("");
    setActiveIndex(index);
    setCropActive(false);
    setDragging(null);
    setDragStart(null);
    setMarkupSelection(null);
    void rebuildBasePreview();
  };

  // ====================================
  // Base Preview (just the raw image — no transforms)
  // ====================================

  const rebuildBasePreview = async () => {
    const request = ++previewRequest;
    const entry = activeImage();
    if (!entry) {
      setBasePreview("");
      setPreviewBusy(false);
      return;
    }
    setPreviewBusy(true);
    try {
      const result = await imageTools.toBase64("png")(entry.previewSource);
      if (request !== previewRequest || activeImage()?.id !== entry.id) return;
      setBasePreview(result);
      setError("");
    } catch (e) {
      if (request !== previewRequest || activeImage()?.id !== entry.id) return;
      setError(e instanceof Error ? t().previewBuildFailed({ reason: e.message }) : t().previewBuildFailedGeneric);
    } finally {
      if (request === previewRequest && activeImage()?.id === entry.id) setPreviewBusy(false);
    }
  };

  // ====================================
  // Crop
  // ====================================

  const startCrop = () => {
    if (cropBusy()) return;
    const image = activeImage();
    if (!image) return;
    setDragging(null);
    setDragStart(null);
    setMarkupSelection(null);
    setCropRect(createCropRect(cropAspect(), image.source.width, image.source.height));
    setCropActive(true);
  };

  const selectCropAspect = (aspect: CropAspect) => {
    if (cropBusy()) return;
    const image = activeImage();
    if (!image) return;
    setDragging(null);
    setDragStart(null);
    setMarkupSelection(null);
    setCropAspect(aspect);
    setCropRect(createCropRect(aspect, image.source.width, image.source.height));
    setCropActive(true);
  };

  const cancelCrop = () => {
    if (cropBusy()) return;
    setCropActive(false);
    setDragging(null);
    setDragStart(null);
  };

  const applyCrop = async () => {
    const entry = activeImage();
    if (!entry || cropBusy()) return;

    setCropBusy(true);
    setError("");
    try {
      const r = cropRect();
      const sourceCrop = toPixelCropRect(r, entry.source.width, entry.source.height);
      const previewCrop = toPixelCropRect(r, entry.previewSource.width, entry.previewSource.height);
      const effectiveCrop = {
        x: sourceCrop.x / entry.source.width,
        y: sourceCrop.y / entry.source.height,
        w: sourceCrop.w / entry.source.width,
        h: sourceCrop.h / entry.source.height,
      };
      const cropped = await imageTools.crop(sourceCrop.x, sourceCrop.y, sourceCrop.w, sourceCrop.h)(entry.source);
      const croppedPreview = await imageTools.crop(previewCrop.x, previewCrop.y, previewCrop.w, previewCrop.h)(entry.previewSource);
      const thumbUrl = await makeThumbnail(croppedPreview);
      const sizeScale = Math.min(entry.source.width, entry.source.height) / Math.min(cropped.width, cropped.height);
      setImages((prev) =>
        prev.map((image) =>
          image.id === entry.id
            ? {
                ...image,
                source: cropped,
                previewSource: croppedPreview,
                thumbUrl,
                markup: transformMarkupForCrop(image.markup, effectiveCrop, sizeScale),
                markupUndo: [],
                markupRedo: [],
                cropped: true,
                cropBounds: composeCropBounds(image.cropBounds, effectiveCrop),
              }
            : image,
        ),
      );
      setCropActive(false);
      setCropRect(createCropRect(cropAspect(), cropped.width, cropped.height));
      fitPreview();
      setBasePreview("");
      await rebuildBasePreview();
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : t().croppingFailed);
    } finally {
      setCropBusy(false);
    }
  };

  const resetCrop = async () => {
    const entry = activeImage();
    if (!entry || !entry.cropped || cropBusy()) return;

    setMarkupSelection(null);
    setCropBusy(true);
    setError("");
    try {
      const thumbUrl = await makeThumbnail(entry.originalPreviewSource);
      const sizeScale =
        Math.min(entry.source.width, entry.source.height) / Math.min(entry.originalSource.width, entry.originalSource.height);
      setImages((prev) =>
        prev.map((image) =>
          image.id === entry.id
            ? {
                ...image,
                source: image.originalSource,
                previewSource: image.originalPreviewSource,
                thumbUrl,
                markup: restoreMarkupFromCrop(image.markup, image.cropBounds, sizeScale),
                markupUndo: [],
                markupRedo: [],
                cropped: false,
                cropBounds: { ...FULL_CROP_BOUNDS },
              }
            : image,
        ),
      );
      fitPreview();
      setBasePreview("");
      await rebuildBasePreview();
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : t().resetCropFailed);
    } finally {
      setCropBusy(false);
    }
  };

  let imgRef: HTMLImageElement | undefined;

  const getCropPointerPos = (e: PointerEvent) => {
    if (!imgRef) return { mx: 0, my: 0 };
    const rect = imgRef.getBoundingClientRect();
    return {
      mx: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      my: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const startCropDrag = (handle: "move" | CropHandle, e: PointerEvent) => {
    if (cropBusy() || dragging() || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    // A crop drag can leave the image across the inspector; the pointer's own pointerup or pointercancel ends the hold.
    suppressTextSelection(e.pointerId);
    setDragging(handle);
    setDragStart({ ...getCropPointerPos(e), rect: { ...cropRect() }, pointerId: e.pointerId });
  };

  const onCropPointerMove = (e: PointerEvent) => {
    const handle = dragging(),
      start = dragStart();
    if (!handle || !start || e.pointerId !== start.pointerId) return;
    e.preventDefault();
    const pos = getCropPointerPos(e);
    const dx = pos.mx - start.mx,
      dy = pos.my - start.my;

    if (handle === "move") {
      setCropRect(moveCropRect(start.rect, dx, dy));
    } else {
      const image = activeImage();
      setCropRect(resizeCropRect(start.rect, handle, dx, dy, cropAspect(), image?.source.width, image?.source.height));
    }
  };

  const onCropPointerUp = (e: PointerEvent) => {
    const start = dragStart();
    if (start && e.pointerId !== start.pointerId) return;
    setDragging(null);
    setDragStart(null);
  };

  // ====================================
  // Copy / Paste Edits
  // ====================================

  const copyEdits = () => setClipboard({ ...adj() });

  const pasteEdits = () => {
    const c = clipboard();
    if (!c) return;
    setImages((prev) => prev.map((e, i) => (i === activeIndex() ? { ...e, adj: { ...c } } : e)));
  };

  const pasteEditsAll = () => {
    const c = clipboard();
    if (!c) return;
    setImages((prev) => prev.map((e) => ({ ...e, adj: { ...c } })));
  };

  // ====================================
  // Markup
  // ====================================

  const isSizedMarkupTool = (tool: MarkupTool): tool is SizedMarkupTool =>
    tool === "pen" || tool === "highlighter" || tool === "shape" || tool === "text";

  const markupSize = createMemo(() => {
    const tool = markupTool();
    return isSizedMarkupTool(tool) ? markupSizes()[tool] : 0;
  });
  const markupSizeRange = createMemo(() => {
    const tool = markupTool();
    if (tool === "highlighter") return { min: 8, max: 64 };
    if (tool === "text") return { min: 16, max: 72 };
    if (tool === "shape") return { min: 2, max: 20 };
    return { min: 2, max: 32 };
  });
  const canUndoMarkup = createMemo(() => (activeImage()?.markupUndo.length ?? 0) > 0);
  const canRedoMarkup = createMemo(() => (activeImage()?.markupRedo.length ?? 0) > 0);

  const setMarkupSize = (value: number) => {
    const tool = markupTool();
    if (!isSizedMarkupTool(tool)) return;
    setMarkupSizes((current) => ({ ...current, [tool]: value }));
  };

  const changeEditorMode = (mode: "edit" | "markup") => {
    if (mode === "markup") cancelCrop();
    else setMarkupSelection(null);
    setEditorMode(mode);
  };

  const chooseMarkupTool = (tool: MarkupTool) => {
    setMarkupTool(tool);
    if (tool !== "select") setMarkupSelection(null);
  };

  const selectMarkup = (elementId: string | null, imageId: string) => {
    setMarkupSelection(elementId ? { imageId, elementId } : null);
  };

  const mutateMarkup = (imageId: string, update: (markup: MarkupElement[]) => MarkupElement[]) => {
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== imageId) return image;
        const next = commitMarkupHistory(image, update(image.markup));
        return next === image ? image : { ...image, ...next };
      }),
    );
  };

  const replaceMarkup = (markup: MarkupElement[], imageId = activeImage()?.id) => {
    if (!imageId) return;
    mutateMarkup(imageId, () => markup);
  };

  // A click with the text tool asks for the words in a dialog; the colour and size are those set when it was asked.
  const askMarkupText = (position: MarkupPoint, imageId: string) => setTextDraft({ position, imageId, text: "" });

  const addMarkupText = () => {
    const draft = textDraft();
    const text = draft?.text.trim() ?? "";
    if (!draft || !text) return;
    setTextDraft(null);
    const image = images().find((entry) => entry.id === draft.imageId);
    if (!image) return;
    const element: MarkupElement = {
      id: crypto.randomUUID(),
      kind: "text",
      position: draft.position,
      text,
      color: markupColor(),
      size: markupSizes().text / 1_000,
    };
    mutateMarkup(draft.imageId, (markup) => [...markup, element]);
    if (activeImage()?.id === draft.imageId) {
      selectMarkup(element.id, draft.imageId);
      setMarkupTool("select");
    }
  };

  const undoMarkup = () => {
    const imageId = activeImage()?.id;
    if (!imageId) return;
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== imageId) return image;
        const next = undoMarkupHistory(image);
        return next === image ? image : { ...image, ...next };
      }),
    );
    setMarkupSelection(null);
  };

  const redoMarkup = () => {
    const imageId = activeImage()?.id;
    if (!imageId) return;
    setImages((prev) =>
      prev.map((image) => {
        if (image.id !== imageId) return image;
        const next = redoMarkupHistory(image);
        return next === image ? image : { ...image, ...next };
      }),
    );
    setMarkupSelection(null);
  };

  const deleteSelectedMarkup = () => {
    const image = activeImage();
    const elementId = selectedMarkupId();
    if (!image || !elementId) return;
    const markup = image.markup.filter((element) => element.id !== elementId);
    if (markup.length === image.markup.length) return;
    replaceMarkup(markup, image.id);
    setMarkupSelection(null);
  };

  const clearMarkup = async () => {
    const image = activeImage();
    if (!image || image.markup.length === 0) return;
    const confirmed = await Dialog.confirm({
      title: t().clearMarkup,
      description: t().clearMarkupConfirm,
      confirm: t().clearMarkupAction,
      cancel: t().cancel,
    });
    if (!confirmed) return;
    replaceMarkup([], image.id);
    setMarkupSelection(null);
  };

  // ====================================
  // Export
  // ====================================

  const [exportOpen, setExportOpen] = createSignal(false);
  const [exportScope, setExportScope] = createSignal<"single" | "all">("single");
  const [exportFormat, setExportFormat] = createSignal<ExportFormat>("webp");
  // The fields keep what was typed; a value that is not valid says so at its field and holds the export.
  const [qualityText, setQualityText] = createSignal("80");
  const [widthText, setWidthText] = createSignal("");
  const [heightText, setHeightText] = createSignal("");
  const exportQuality = () => percent(qualityText()) ?? 0.8;
  const exportWidth = () => pixels(widthText()) ?? null;
  const exportHeight = () => pixels(heightText()) ?? null;
  const qualityError = () => (exportFormat() !== "png" && percent(qualityText()) === undefined ? t().qualityInvalid : undefined);
  const widthError = () => (pixels(widthText()) === undefined ? t().pixelsInvalid : undefined);
  const heightError = () => (pixels(heightText()) === undefined ? t().pixelsInvalid : undefined);
  const exportInvalid = () => Boolean(qualityError() || widthError() || heightError());
  const [exportProgress, setExportProgress] = createSignal<number | null>(null);
  const [exporting, setExporting] = createSignal(false);
  const [exportError, setExportError] = createSignal("");
  const exportCount = () => (exportScope() === "all" ? images().length : 1);

  const openExport = () => {
    setExportScope("single");
    setExportProgress(null);
    setExportError("");
    setExportOpen(true);
  };

  const doExport = async () => {
    if (exporting() || exportInvalid()) return;
    setExporting(true);
    setExportError("");
    const count = exportCount();
    let completed = 0;
    try {
      const active = activeImage();
      const entries = exportScope() === "all" ? images() : active ? [active] : [];
      if (entries.length === 0) throw new Error(t().noImageToExport);

      setExportProgress(0);
      for (let i = 0; i < entries.length; i++) {
        if (left) return;
        setExportProgress((i + 0.5) / entries.length);
        const entry = entries[i]!;
        const format = exportFormat();
        const blob = await buildImagePipeline(entry, exportWidth() ?? undefined, exportHeight() ?? undefined).then(
          imageTools.toBlob(format, exportQuality()),
        );
        const name = entry.name.replace(/\.[^.]+$/, "") + `.${format}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        completed = i + 1;
        setExportProgress((i + 1) / entries.length);
        if (entries.length > 1) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      setExportOpen(false);
    } catch (exportFailure) {
      const reason = exportFailure instanceof Error ? exportFailure.message : t().unknownExportError;
      setExportError(completed > 0 ? `${t().exportStopped({ completed, count })} ${reason}` : reason);
    } finally {
      setExporting(false);
    }
  };

  // ====================================
  // Presets
  // ====================================

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    if (!p) return;
    setImages((prev) =>
      prev.map((e, i) =>
        i === activeIndex()
          ? {
              ...e,
              adj: {
                ...e.adj,
                brightness: p.brightness,
                contrast: p.contrast,
                saturation: p.saturation,
                hueRotate: p.hueRotate,
                blur: p.blur,
                sepia: p.sepia,
                vignette: p.vignette,
                grain: p.grain,
              },
            }
          : e,
      ),
    );
  };

  const resetAdjustments = () => {
    setImages((prev) =>
      prev.map((e, i) =>
        i === activeIndex()
          ? {
              ...e,
              adj: {
                ...DEFAULT_ADJ,
                freeRotation: e.adj.freeRotation,
                flipH: e.adj.flipH,
                flipV: e.adj.flipV,
              },
            }
          : e,
      ),
    );
  };

  // ====================================
  // Keyboard
  // ====================================

  const isEditableTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable || target.closest("[contenteditable='true']") !== null);

  const isControlTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    target.closest("button, a, input, textarea, select, [role='button'], [role='slider'], [role='tab']") !== null;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || isEditableTarget(e.target) || exportOpen() || textDraft()) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && editorMode() === "markup") {
      if (e.shiftKey) redoMarkup();
      else undoMarkup();
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    if (editorMode() === "markup" && !cropActive() && !isControlTarget(e.target)) {
      if ((e.key === "Backspace" || e.key === "Delete") && selectedMarkupId()) {
        deleteSelectedMarkup();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && selectedMarkupId()) {
        setMarkupSelection(null);
        e.preventDefault();
        return;
      }
    }
    if (cropActive()) {
      if (e.key === "Escape" && !cropBusy()) {
        cancelCrop();
        e.preventDefault();
      }
      return;
    }
    if (isControlTarget(e.target)) return;
    if (e.key === "ArrowLeft" && activeIndex() > 0) {
      switchImage(activeIndex() - 1);
      e.preventDefault();
    }
    if (e.key === "ArrowRight" && activeIndex() < images().length - 1) {
      switchImage(activeIndex() + 1);
      e.preventDefault();
    }
  };

  /** Set when the view leaves the page, for example through a page swap, so a running export stops downloading. */
  let left = false;
  onCleanup(() => {
    left = true;
    loadMutation.abort();
    disposeHeifDecoder();
  });

  onMount(() => {
    if (props.initialImages?.length) void rebuildBasePreview();
    measurePreviewViewport();
    measureStage();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            measureStage();
            measurePreviewViewport();
          });
    const watch = () => {
      observer?.disconnect();
      if (previewViewportRef) observer?.observe(previewViewportRef);
      const pane = stageRef?.closest('[data-k2-part="Pane"]');
      if (pane) observer?.observe(pane);
    };
    watch();
    const onResize = () => {
      measureStage();
      measurePreviewViewport();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointermove", onCropPointerMove, { passive: false });
    document.addEventListener("pointerup", onCropPointerUp);
    document.addEventListener("pointercancel", onCropPointerUp);

    // k2b-ui gap: v2 has no file drop target; the page takes dropped images itself and the status row says so.
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDraggingFiles(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDraggingFiles(false);
    };
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const dropped = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      depth = 0;
      setDraggingFiles(false);
      loadFiles(files);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", dropped);

    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointermove", onCropPointerMove);
      document.removeEventListener("pointerup", onCropPointerUp);
      document.removeEventListener("pointercancel", onCropPointerUp);
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", dropped);
    });
  });

  // The stage comes with the first image; it measures its place and its viewport once it is there.
  const stageMounted = (element: HTMLDivElement) => {
    stageRef = element;
    queueMicrotask(() => {
      // a stage that left again before this turn (the page went) has nothing to measure
      if (!element.isConnected) return;
      measureStage();
      measurePreviewViewport();
    });
  };

  // ====================================
  // Render
  // ====================================

  const busy = () => loadMutation.loading() || previewBusy() || cropBusy();
  /** What is happening now, on the stage: a photo being opened, or photos being dragged over the page. */
  const happening = () => {
    const load = currentLoad();
    if (load) return intakeT().loadingFile({ ...load, stage: intakeT()[load.stage] });
    return draggingFiles() ? t().dropToAdd : undefined;
  };
  /** What the open photo is: its size, its file and where it stands among the open ones (the inspector's first facts). */
  const facts = (): Fact[] => {
    const image = activeImage();
    if (!image) return [];
    const { width, height } = image.source;
    return [
      { label: t().factSize, value: `${width} × ${height} px` },
      ...(image.file ? [{ label: t().factFile, value: `${(image.file.size / 1024).toFixed(0)} KB` }] : []),
      ...(images().length > 1
        ? [{ label: t().factPosition, value: t().positionOf({ index: activeIndex() + 1, count: images().length }) }]
        : []),
    ];
  };
  const imageDeeds = (index: number): MenuEntry[] => [
    {
      label: t().removeImage,
      icon: "trash",
      danger: true,
      disabled: cropActive() || cropBusy(),
      onClick: () => removeImage(index),
    },
  ];
  const markupTools = (): { value: MarkupTool; label: string; icon: string }[] => [
    { value: "select", label: t().toolSelect, icon: "pointer" },
    { value: "pen", label: t().toolPen, icon: "pencil" },
    { value: "highlighter", label: t().toolHighlight, icon: "highlight" },
    { value: "redact", label: t().toolRedact, icon: "square" },
    { value: "shape", label: t().toolShape, icon: "shape" },
    { value: "text", label: t().toolText, icon: "text-resize" },
    { value: "eraser", label: t().toolEraser, icon: "eraser" },
  ];
  const aspectLabel = (aspect: CropAspect) => (aspect === "free" ? t().aspectFree : aspect);
  // The failures say per file what went wrong and how to go on; each can be put away on its own.
  const failureNotices = () => (
    <For each={loadFailures()}>
      {(failure) => (
        <Notice
          tone="bad"
          title={`${failure.file.name}: ${failure.reason === "crop-active" ? t().applyOrCancelCrop : intakeT()[`${failure.reason}Title`]}`}
          actions={[
            {
              label: t().dismissFailure({ name: failure.file.name }),
              onClick: () => setLoadFailures((current) => current.filter((other) => other !== failure)),
            },
          ]}
        >
          {failure.reason === "crop-active" ? t().cropRefusalHint : intakeT()[`${failure.reason}Hint`]}
        </Notice>
      )}
    </For>
  );

  return (
    <ToolsScreen
      tool="image"
      item={activeImage() ? shortName(activeImage()!.name) : undefined}
      primary={
        hasImages()
          ? { label: t().exportAction, icon: "download", onClick: openExport, disabled: cropActive() || cropBusy() }
          : { label: t().addImages, icon: "photo-plus", onClick: () => void selectFiles() }
      }
      end={
        <>
          <Button icon="photo-plus" onClick={() => void selectFiles()} disabled={cropActive() || cropBusy()}>
            {t().addImages}
          </Button>
          <Show when={hasImages()}>
            <Button variant="primary" icon="download" onClick={openExport} disabled={cropActive() || cropBusy()}>
              {t().exportAction}
            </Button>
            <Menu label={t().moreImageActions} items={imageDeeds(activeIndex())} />
          </Show>
        </>
      }
    >
      <Pane.Split>
        <Pane label={t().canvasLabel}>
          <Show
            when={hasImages()}
            fallback={
              <>
                {failureNotices()}
                <Empty
                  icon="photo-plus"
                  text={loadMutation.loading() ? (happening() ?? t().addingImages) : t().emptyText}
                  action={{ label: t().addImages, icon: "photo-plus", onClick: () => void selectFiles() }}
                />
                <Band>
                  <Text type="meta" muted>
                    {t().staysInBrowser}
                  </Text>
                </Band>
              </>
            }
          >
            {/* The stage: the photo with its look, markup and crop, and the strip of every open image under it. */}
            <Canvas label={t().canvasLabel} height={stageHeight()}>
              <div
                ref={stageMounted}
                style={{ display: "flex", "flex-direction": "column", height: "100%", background: "var(--k2-canvas)" }}
              >
                {/* What is happening floats at the stage's top left, the zoom at its top right; both stay while the photo
                    scrolls under them. */}
                <div style={{ position: "relative", flex: "1 1 auto", "min-height": "0", display: "flex" }}>
                  <Show when={happening()}>
                    {(text) => (
                      <p
                        role="status"
                        style={{
                          position: "absolute",
                          top: "12px",
                          left: "12px",
                          "z-index": "20",
                          "max-width": "calc(100% - 220px)",
                          margin: "0",
                          padding: "6px 10px",
                          "border-radius": "10px",
                          background: "var(--k2-surface)",
                          "box-shadow": "var(--k2-float)",
                          font: "400 13px/20px var(--k2-font)",
                          color: "var(--k2-text)",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {text()}
                      </p>
                    )}
                  </Show>
                  <div
                    role="group"
                    aria-label={t().zoom}
                    style={{
                      position: "absolute",
                      top: "12px",
                      right: "12px",
                      "z-index": "20",
                      display: "flex",
                      "align-items": "center",
                      gap: "2px",
                      padding: "2px 4px",
                      "border-radius": "10px",
                      background: "var(--k2-surface)",
                      "box-shadow": "var(--k2-float)",
                      font: "500 12px/1 var(--k2-font)",
                      color: "var(--k2-muted)",
                      "font-variant-numeric": "tabular-nums",
                    }}
                  >
                    <Button
                      variant="ghost"
                      icon="minus"
                      label={t().zoomOut}
                      onClick={() => setClampedPreviewZoom(previewZoom() / PREVIEW_ZOOM_STEP)}
                      disabled={previewZoom() <= MIN_PREVIEW_ZOOM}
                    />
                    <span style={{ "min-width": "40px", "text-align": "center" }}>{`${Math.round(previewZoom() * 100)} %`}</span>
                    <Button
                      variant="ghost"
                      icon="plus"
                      label={t().zoomIn}
                      onClick={() => setClampedPreviewZoom(previewZoom() * PREVIEW_ZOOM_STEP)}
                      disabled={previewZoom() >= MAX_PREVIEW_ZOOM}
                    />
                    <Button variant="ghost" icon="focus-centered" label={t().fitImage} onClick={fitPreview} />
                  </div>
                  <div
                    ref={previewViewportRef}
                    style={{ position: "relative", flex: "1 1 auto", "min-width": "0", overflow: "auto", padding: "20px" }}
                  >
                    <Show when={busy()}>
                      <div
                        aria-hidden="true"
                        data-stage-busy=""
                        style={{
                          position: "absolute",
                          inset: "0",
                          "z-index": "10",
                          background: "color-mix(in srgb, var(--k2-surface) 45%, transparent)",
                        }}
                      />
                    </Show>
                    <Show when={basePreview()}>
                      <Show when={previewLayout()}>
                        {(layout) => (
                          <div style={{ display: "flex", "min-width": "100%", "min-height": "100%" }}>
                            <div
                              style={{
                                position: "relative",
                                margin: "auto",
                                "flex-shrink": "0",
                                width: `${layout().stageWidth}px`,
                                height: `${layout().stageHeight}px`,
                              }}
                            >
                              <div
                                style={{
                                  position: "absolute",
                                  inset: "0",
                                  display: "flex",
                                  "align-items": "center",
                                  "justify-content": "center",
                                }}
                              >
                                <div
                                  style={{
                                    position: "relative",
                                    "flex-shrink": "0",
                                    width: `${layout().imageWidth}px`,
                                    height: `${layout().imageHeight}px`,
                                    transform: cropActive() || editorMode() === "markup" ? "none" : cssTransform(),
                                    "box-shadow": "0 1px 2px rgb(0 0 0 / 0.12), 0 8px 24px rgb(0 0 0 / 0.10)",
                                  }}
                                >
                                  <img
                                    ref={imgRef}
                                    src={basePreview()}
                                    alt={t().previewAlt}
                                    style={{ display: "block", width: "100%", height: "100%", "object-fit": "fill", filter: cssFilter() }}
                                    draggable={false}
                                  />

                                  <Show when={adj().vignette > 0}>
                                    <div
                                      style={{
                                        position: "absolute",
                                        inset: "0",
                                        "pointer-events": "none",
                                        background: `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,${adj().vignette}) 100%)`,
                                      }}
                                    />
                                  </Show>

                                  <Show when={adj().grain > 0}>
                                    <div
                                      style={{
                                        position: "absolute",
                                        inset: "0",
                                        "pointer-events": "none",
                                        "mix-blend-mode": "overlay",
                                        opacity: adj().grain * 2,
                                        "background-image": `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
                                        "background-size": "128px 128px",
                                      }}
                                    />
                                  </Show>

                                  <Show when={activeImage()}>
                                    {(entry) => (
                                      <MarkupOverlay
                                        imageId={entry().id}
                                        width={entry().previewSource.width}
                                        height={entry().previewSource.height}
                                        elements={entry().markup}
                                        active={editorMode() === "markup" && !cropActive()}
                                        tool={markupTool()}
                                        shape={markupShape()}
                                        color={markupColor()}
                                        size={markupSize() / 1_000}
                                        selectedId={selectedMarkupId()}
                                        onCommit={replaceMarkup}
                                        onSelect={selectMarkup}
                                        onText={askMarkupText}
                                      />
                                    )}
                                  </Show>

                                  {/* Crop overlay */}
                                  <Show when={cropActive()}>
                                    <div style={{ position: "absolute", inset: "0", "touch-action": "none" }}>
                                      {/* Dark mask with hole via clip-path */}
                                      <div
                                        style={{
                                          position: "absolute",
                                          inset: "0",
                                          background: "rgb(0 0 0 / 0.5)",
                                          "clip-path": `polygon(
                          0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                          ${cropRect().x * 100}% ${cropRect().y * 100}%,
                          ${cropRect().x * 100}% ${(cropRect().y + cropRect().h) * 100}%,
                          ${(cropRect().x + cropRect().w) * 100}% ${(cropRect().y + cropRect().h) * 100}%,
                          ${(cropRect().x + cropRect().w) * 100}% ${cropRect().y * 100}%,
                          ${cropRect().x * 100}% ${cropRect().y * 100}%
                        )`,
                                        }}
                                      />
                                      {/* Crop border + handles */}
                                      <div
                                        data-crop-frame=""
                                        style={{
                                          position: "absolute",
                                          border: "2px solid #fff",
                                          cursor: "move",
                                          left: `${cropRect().x * 100}%`,
                                          top: `${cropRect().y * 100}%`,
                                          width: `${cropRect().w * 100}%`,
                                          height: `${cropRect().h * 100}%`,
                                        }}
                                        onPointerDown={(e) => startCropDrag("move", e)}
                                      >
                                        <div
                                          style={{
                                            position: "absolute",
                                            inset: "0",
                                            "pointer-events": "none",
                                            "background-image":
                                              "linear-gradient(90deg, transparent calc(33.33% - 0.5px), rgb(255 255 255 / 0.3) calc(33.33% - 0.5px), rgb(255 255 255 / 0.3) calc(33.33% + 0.5px), transparent calc(33.33% + 0.5px), transparent calc(66.66% - 0.5px), rgb(255 255 255 / 0.3) calc(66.66% - 0.5px), rgb(255 255 255 / 0.3) calc(66.66% + 0.5px), transparent calc(66.66% + 0.5px)), linear-gradient(180deg, transparent calc(33.33% - 0.5px), rgb(255 255 255 / 0.3) calc(33.33% - 0.5px), rgb(255 255 255 / 0.3) calc(33.33% + 0.5px), transparent calc(33.33% + 0.5px), transparent calc(66.66% - 0.5px), rgb(255 255 255 / 0.3) calc(66.66% - 0.5px), rgb(255 255 255 / 0.3) calc(66.66% + 0.5px), transparent calc(66.66% + 0.5px))",
                                          }}
                                        />
                                        {(["nw", "ne", "sw", "se"] as const).map((h) => (
                                          <div
                                            data-crop-handle={h}
                                            style={{
                                              position: "absolute",
                                              width: "24px",
                                              height: "24px",
                                              "z-index": "10",
                                              [h.includes("n") ? "top" : "bottom"]: "-12px",
                                              [h.includes("w") ? "left" : "right"]: "-12px",
                                              cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize",
                                            }}
                                            onPointerDown={(e) => startCropDrag(h, e)}
                                          >
                                            <div
                                              style={{
                                                position: "absolute",
                                                left: "6px",
                                                top: "6px",
                                                width: "12px",
                                                height: "12px",
                                                "border-radius": "2px",
                                                border: "1px solid #a1a1aa",
                                                background: "#fff",
                                              }}
                                            />
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </Show>
                    </Show>
                  </div>
                </div>

                {/* Every open image as its own picture; the open one carries the blue ring.
                    k2b-ui gap: no v2 picture tile (Tiles media, #4208) or swatch; the strip, its add tile, the presets
                    and the colour swatches are drawn here, with the focus ring of app.css ([data-tools-tile]). */}
                <Show when={images().length > 0}>
                  <nav
                    aria-label={t().filmstripLabel}
                    style={{
                      display: "flex",
                      "flex-shrink": "0",
                      gap: "8px",
                      // on the phone the floating main action stands at the end of the strip: no photo under it
                      padding: phone() ? "10px 88px 10px 20px" : "10px 20px",
                      "overflow-x": "auto",
                      "border-top": "1px solid var(--k2-line)",
                      background: "var(--k2-surface)",
                      "scrollbar-width": "thin",
                    }}
                  >
                    <For each={images()}>
                      {(image, index) => (
                        <Menu.Context items={imageDeeds(index())}>
                          <button
                            type="button"
                            data-tools-tile=""
                            onClick={() => switchImage(index())}
                            disabled={cropActive()}
                            aria-label={t().openImage({ name: image.name })}
                            aria-current={activeIndex() === index() ? "true" : undefined}
                            title={image.name}
                            style={{
                              width: "52px",
                              height: "52px",
                              "flex-shrink": "0",
                              padding: "0",
                              overflow: "hidden",
                              "border-radius": "6px",
                              border: "1px solid var(--k2-line)",
                              background: "var(--k2-canvas)",
                              cursor: cropActive() ? "default" : "pointer",
                              opacity: cropActive() && activeIndex() !== index() ? "0.5" : "1",
                              "box-shadow": activeIndex() === index() ? "0 0 0 2px var(--k2-surface), 0 0 0 4px var(--k2-blue)" : "none",
                            }}
                          >
                            <img
                              src={image.thumbUrl}
                              alt=""
                              draggable={false}
                              style={{
                                display: "block",
                                width: "100%",
                                height: "100%",
                                "object-fit": "cover",
                                filter: filterOf(image.adj),
                              }}
                            />
                          </button>
                        </Menu.Context>
                      )}
                    </For>
                    {/* the way to more photos stays on the stage, also on the phone where the head gives way */}
                    <button
                      type="button"
                      data-tools-tile=""
                      onClick={() => void selectFiles()}
                      disabled={cropActive() || cropBusy()}
                      aria-label={t().addImages}
                      title={t().addImages}
                      style={{
                        width: "52px",
                        height: "52px",
                        "flex-shrink": "0",
                        display: "grid",
                        "place-items": "center",
                        "border-radius": "6px",
                        border: "1px dashed var(--k2-line-control, var(--k2-line))",
                        background: "transparent",
                        color: "var(--k2-muted)",
                        cursor: cropActive() ? "default" : "pointer",
                        "font-size": "20px",
                      }}
                    >
                      <i class="ti ti-photo-plus" aria-hidden="true" />
                    </button>
                  </nav>
                </Show>
              </div>
            </Canvas>
          </Show>
        </Pane>

        <Show when={hasImages()}>
          <Pane
            label={t().imageControls}
            width={{ min: 288, default: 340 }}
            scrollKey="tools-image-inspector"
            head={
              <Tabs
                label={t().editorMode}
                items={[
                  {
                    label: t().editMode,
                    icon: "adjustments-horizontal",
                    current: editorMode() === "edit",
                    onClick: () => changeEditorMode("edit"),
                  },
                  {
                    label: t().markupMode,
                    icon: "pencil",
                    count: activeImage()?.markup.length || undefined,
                    current: editorMode() === "markup",
                    onClick: () => changeEditorMode("markup"),
                  },
                ]}
              />
            }
          >
            <Show when={error()}>
              {(message) => (
                <Notice tone="bad" title={t().somethingFailed} actions={[{ label: t().dismissError, onClick: () => setError("") }]}>
                  {message()}
                </Notice>
              )}
            </Show>
            {failureNotices()}

            <Show when={editorMode() === "markup"}>
              <Section icon="pencil" title={t().tool} summary={t().markupHint}>
                <Inline>
                  <For each={markupTools()}>
                    {(tool) => (
                      <Button
                        variant="ghost"
                        icon={tool.icon}
                        label={tool.label}
                        pressed={markupTool() === tool.value}
                        onClick={() => chooseMarkupTool(tool.value)}
                      />
                    )}
                  </For>
                </Inline>
              </Section>
              <Section icon="history" title={t().history} count={activeImage()?.markup.length ?? 0}>
                <Inline>
                  <Button icon="arrow-back-up" label={t().undoMarkup} title={t().undo} onClick={undoMarkup} disabled={!canUndoMarkup()} />
                  <Button
                    icon="arrow-forward-up"
                    label={t().redoMarkup}
                    title={t().redo}
                    onClick={redoMarkup}
                    disabled={!canRedoMarkup()}
                  />
                  <Button icon="trash" label={t().deleteSelectedMarkup} onClick={deleteSelectedMarkup} disabled={!selectedMarkupId()} />
                  <Button
                    icon="trash-x"
                    label={t().clearMarkup}
                    onClick={() => void clearMarkup()}
                    disabled={(activeImage()?.markup.length ?? 0) === 0}
                  />
                </Inline>
              </Section>
              <Show when={isSizedMarkupTool(markupTool())}>
                <Section icon="palette" title={t().style}>
                  <Show when={markupTool() === "shape"}>
                    <Field label={t().shape}>
                      <Choice
                        name="image-markup-shape"
                        value={markupShape()}
                        onChange={(value) => setMarkupShape(value === "circle" || value === "arrow" ? value : "rectangle")}
                        options={[
                          { value: "rectangle", label: t().shapeRectangle },
                          { value: "circle", label: t().shapeCircle },
                          { value: "arrow", label: t().shapeArrow },
                        ]}
                      />
                    </Field>
                  </Show>
                  {/* k2b-ui gap: no v2 colour picker or slider (lane Y); the swatches, the picker and the size are drawn here. */}
                  <Canvas label={t().color}>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "4px 20px 8px" }}>
                      <div
                        role="group"
                        aria-label={t().color}
                        style={{ display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "8px" }}
                      >
                        <For each={MARKUP_COLORS}>
                          {(color) => (
                            <button
                              type="button"
                              data-tools-tile=""
                              onClick={() => setMarkupColor(color.value)}
                              aria-label={t().useColor({ color: t()[color.labelKey] })}
                              aria-pressed={markupColor() === color.value}
                              title={t()[color.labelKey]}
                              style={{
                                width: "28px",
                                height: "28px",
                                padding: "0",
                                "border-radius": "999px",
                                cursor: "pointer",
                                border: "1px solid rgb(0 0 0 / 0.15)",
                                "background-color": color.value,
                                "box-shadow":
                                  markupColor() === color.value ? "0 0 0 2px var(--k2-surface), 0 0 0 4px var(--k2-blue)" : "none",
                              }}
                            />
                          )}
                        </For>
                        <ColorInput compact label={t().customColor} value={markupColor} onValueChange={setMarkupColor} />
                      </div>
                      <Slider
                        label={markupTool() === "text" ? t().textSize : t().size}
                        value={markupSize}
                        onValueChange={setMarkupSize}
                        min={markupSizeRange().min}
                        max={markupSizeRange().max}
                        step={1}
                        showValue
                      />
                    </div>
                  </Canvas>
                </Section>
              </Show>
            </Show>

            <Show when={editorMode() === "edit"}>
              <Section icon="photo" title={t().factsTitle}>
                <Facts items={facts()} />
              </Section>
              {/* The crop button names the group itself; a heading "Zuschneiden" above it would say the word twice. */}
              <Band label={t().crop}>
                <Inline>
                  <Show
                    when={cropActive()}
                    fallback={
                      <Button icon="crop" onClick={startCrop} disabled={cropBusy()}>
                        {t().crop}
                      </Button>
                    }
                  >
                    <Button icon="check" onClick={() => void applyCrop()} busy={cropBusy()}>
                      {t().apply}
                    </Button>
                    <Button variant="ghost" onClick={cancelCrop} disabled={cropBusy()}>
                      {t().cancel}
                    </Button>
                  </Show>
                  <Menu
                    variant="ghost"
                    label={t().aspectLabel({ aspect: aspectLabel(cropAspect()) })}
                    disabled={cropBusy()}
                    items={[
                      {
                        title: t().aspect,
                        choice: cropAspect(),
                        onChoose: (value) => {
                          const aspect = CROP_ASPECTS.find((each) => each === value);
                          if (aspect) selectCropAspect(aspect);
                        },
                        items: CROP_ASPECTS.map((aspect) => ({ label: aspectLabel(aspect), value: aspect })),
                      },
                    ]}
                  >
                    {aspectLabel(cropAspect())}
                  </Menu>
                  <Show when={!cropActive() && activeImage()?.cropped}>
                    <Button variant="ghost" icon="arrow-back-up" onClick={() => void resetCrop()} busy={cropBusy()}>
                      {t().resetCrop}
                    </Button>
                  </Show>
                </Inline>
                <Show when={cropActive() ? t().cropHint : activeImage()?.cropped ? t().croppedHint : undefined}>
                  {(hint) => (
                    <Text type="meta" muted>
                      {hint()}
                    </Text>
                  )}
                </Show>
              </Band>

              <Section icon="rotate" title={t().transform}>
                {/* k2b-ui gap: no v2 slider (lane Y); the rotation keeps its slider, drawn here. */}
                <Canvas label={t().rotation}>
                  <div style={{ padding: "0 20px 4px" }}>
                    <Slider
                      label={t().rotation}
                      value={() => adj().freeRotation}
                      onValueChange={(v) => setAdj("freeRotation", v)}
                      defaultValue={DEFAULT_ADJ.freeRotation}
                      min={-180}
                      max={180}
                      step={0.5}
                      center
                      showValue
                      formatValue={(v) => `${v > 0 ? "+" : ""}${v}°`}
                    />
                  </div>
                </Canvas>
                <Check switch label={t().flipH} checked={adj().flipH} onChange={(v) => setAdj("flipH", v)} />
                <Check switch label={t().flipV} checked={adj().flipV} onChange={(v) => setAdj("flipV", v)} />
              </Section>

              <Section
                icon="adjustments"
                title={t().adjustments}
                actions={[{ label: t().reset, icon: "restore", onClick: resetAdjustments }]}
              >
                {/* k2b-ui gap: no v2 slider (lane Y); each adjustment keeps its slider, drawn here. */}
                <Canvas label={t().adjustments}>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "0 20px 4px" }}>
                    <Slider
                      label={t().brightness}
                      value={() => adj().brightness}
                      onValueChange={(v) => setAdj("brightness", v)}
                      defaultValue={DEFAULT_ADJ.brightness}
                      min={0.5}
                      max={1.5}
                      step={0.01}
                      center
                      showValue
                      formatValue={(v) => `${Math.round(v * 100)}%`}
                    />
                    <Slider
                      label={t().contrast}
                      value={() => adj().contrast}
                      onValueChange={(v) => setAdj("contrast", v)}
                      defaultValue={DEFAULT_ADJ.contrast}
                      min={0.5}
                      max={2}
                      step={0.01}
                      center
                      showValue
                      formatValue={(v) => `${Math.round(v * 100)}%`}
                    />
                    <Slider
                      label={t().saturation}
                      value={() => adj().saturation}
                      onValueChange={(v) => setAdj("saturation", v)}
                      defaultValue={DEFAULT_ADJ.saturation}
                      min={0}
                      max={2}
                      step={0.01}
                      center
                      showValue
                      formatValue={(v) => `${Math.round(v * 100)}%`}
                    />
                    <Slider
                      label={t().hue}
                      value={() => adj().hueRotate}
                      onValueChange={(v) => setAdj("hueRotate", v)}
                      defaultValue={DEFAULT_ADJ.hueRotate}
                      min={0}
                      max={360}
                      step={1}
                      showValue
                      formatValue={(v) => `${v}°`}
                    />
                    <Slider
                      label={t().blur}
                      value={() => adj().blur}
                      onValueChange={(v) => setAdj("blur", v)}
                      defaultValue={DEFAULT_ADJ.blur}
                      min={0}
                      max={10}
                      step={0.1}
                      showValue
                      formatValue={(v) => `${v.toFixed(1)}px`}
                    />
                    <Slider
                      label={t().sepia}
                      value={() => adj().sepia}
                      onValueChange={(v) => setAdj("sepia", v)}
                      defaultValue={DEFAULT_ADJ.sepia}
                      min={0}
                      max={1}
                      step={0.01}
                      showValue
                      formatValue={(v) => `${Math.round(v * 100)}%`}
                    />
                    <Slider
                      label={t().vignette}
                      value={() => adj().vignette}
                      onValueChange={(v) => setAdj("vignette", v)}
                      defaultValue={DEFAULT_ADJ.vignette}
                      min={0}
                      max={1}
                      step={0.01}
                      showValue
                      formatValue={(v) => `${Math.round(v * 100)}%`}
                    />
                    <Slider
                      label={t().grain}
                      value={() => adj().grain}
                      onValueChange={(v) => setAdj("grain", v)}
                      defaultValue={DEFAULT_ADJ.grain}
                      min={0}
                      max={0.5}
                      step={0.01}
                      showValue
                      formatValue={(v) => `${Math.round(v * 200)}%`}
                    />
                  </div>
                </Canvas>
              </Section>

              <Section icon="wand" title={t().presets}>
                {/* Each preset shows itself on the open photo; the one that matches the current look is pressed. */}
                <Canvas label={t().presets}>
                  <div style={{ display: "grid", "grid-template-columns": "repeat(4, minmax(0, 1fr))", gap: "8px", padding: "0 20px 4px" }}>
                    <For each={Object.keys(PRESETS)}>
                      {(key) => (
                        <button
                          type="button"
                          data-tools-tile=""
                          onClick={() => applyPreset(key)}
                          aria-pressed={sameLook(adj(), PRESETS[key]!)}
                          style={{
                            display: "flex",
                            "flex-direction": "column",
                            gap: "4px",
                            "min-width": "0",
                            padding: "0",
                            border: "0",
                            background: "none",
                            color: "var(--k2-text)",
                            font: "inherit",
                            "font-size": "12px",
                            cursor: "pointer",
                          }}
                        >
                          <img
                            src={activeImage()?.thumbUrl}
                            alt=""
                            draggable={false}
                            style={{
                              display: "block",
                              width: "100%",
                              "aspect-ratio": "1",
                              "object-fit": "cover",
                              "border-radius": "6px",
                              filter: filterOf(PRESETS[key]!),
                              "box-shadow": sameLook(adj(), PRESETS[key]!)
                                ? "0 0 0 2px var(--k2-surface), 0 0 0 4px var(--k2-blue)"
                                : "0 0 0 1px var(--k2-line)",
                            }}
                          />
                          <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                            {presetLabel(key)}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Canvas>
              </Section>

              <Section icon="copy" title={t().edits} summary={images().length > 1 ? t().editsHint : undefined}>
                <Inline>
                  <Button icon="copy" title={t().copyAdjustmentsTitle} onClick={copyEdits}>
                    {t().copy}
                  </Button>
                  <Button icon="clipboard" title={t().pasteAdjustmentsTitle} onClick={pasteEdits} disabled={!clipboard()}>
                    {t().paste}
                  </Button>
                  <Show when={images().length > 1}>
                    <Button icon="clipboard-check" title={t().pasteAdjustmentsAllTitle} onClick={pasteEditsAll} disabled={!clipboard()}>
                      {t().pasteAll}
                    </Button>
                  </Show>
                </Inline>
              </Section>
            </Show>
          </Pane>
        </Show>
      </Pane.Split>

      <Dialog
        title={exportScope() === "all" ? t().exportImagesTitle({ count: images().length }) : t().exportImageTitle}
        open={exportOpen()}
        onOpenChange={(open) => {
          if (!exporting()) setExportOpen(open);
        }}
        foot={
          <>
            <Button onClick={() => setExportOpen(false)} disabled={exporting()}>
              {t().cancel}
            </Button>
            <Button variant="primary" icon="download" busy={exporting()} disabled={exportInvalid()} onClick={() => void doExport()}>
              {exportCount() > 1 ? t().exportCountAction({ count: exportCount() }) : t().exportAction}
            </Button>
          </>
        }
      >
        <Show when={images().length > 1}>
          <Field label={t().exportWhat}>
            <Choice
              name="image-export-scope"
              value={exportScope()}
              disabled={exporting()}
              onChange={(value) => setExportScope(value === "all" ? "all" : "single")}
              options={[
                { value: "single", label: activeImage()?.name ?? t().exportThis },
                { value: "all", label: t().exportAllImages({ count: images().length }) },
              ]}
            />
          </Field>
        </Show>
        <Field label={t().formatLabel}>
          <Choice
            name="image-export-format"
            value={exportFormat()}
            disabled={exporting()}
            onChange={(value) => setExportFormat(EXPORT_FORMATS.find((each) => each === value) ?? "webp")}
            options={[
              { value: "webp", label: "WebP" },
              { value: "jpeg", label: "JPEG" },
              { value: "png", label: "PNG" },
            ]}
          />
        </Field>
        <Show when={exportFormat() !== "png"}>
          {/* k2b-ui gap: no v2 slider (lane Y); the quality is a number in percent, as in the converter. */}
          <Field label={t().qualityLabel} optional="%" error={qualityError()}>
            <Input type="number" min={10} max={100} value={qualityText()} disabled={exporting()} onInput={setQualityText} />
          </Field>
        </Show>
        <Field.Row>
          <Field label={t().maxWidth} optional="px" hint={t().keepOriginalSize} error={widthError()}>
            <Input
              type="number"
              min={1}
              name="image-export-max-width"
              placeholder={t().autoPlaceholder}
              value={widthText()}
              disabled={exporting()}
              onInput={setWidthText}
            />
          </Field>
          <Field label={t().maxHeight} optional="px" error={heightError()}>
            <Input
              type="number"
              min={1}
              name="image-export-max-height"
              placeholder={t().autoPlaceholder}
              value={heightText()}
              disabled={exporting()}
              onInput={setHeightText}
            />
          </Field>
        </Field.Row>
        <Show when={exportError()}>
          {(message) => (
            <Notice tone="bad" title={t().exportFailed}>
              {message()}
            </Notice>
          )}
        </Show>
        <Show when={exportProgress() !== null}>
          <Bar start={<Progress value={Math.round((exportProgress() ?? 0) * 100)} of={100} label={t().exporting} />} />
        </Show>
      </Dialog>

      <Dialog
        title={t().addTextTitle}
        open={textDraft() !== null}
        onOpenChange={(open) => {
          if (!open) setTextDraft(null);
        }}
        foot={
          <>
            <Button onClick={() => setTextDraft(null)}>{t().cancel}</Button>
            <Button variant="primary" icon="text-resize" disabled={!textDraft()?.text.trim()} onClick={addMarkupText}>
              {t().addTextAction}
            </Button>
          </>
        }
      >
        <Field label={t().textFieldLabel} required>
          <Input
            value={textDraft()?.text ?? ""}
            onInput={(text) => setTextDraft((draft) => draft && { ...draft, text })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) addMarkupText();
            }}
          />
        </Field>
      </Dialog>
    </ToolsScreen>
  );
}

export default function ImageProcessor() {
  return <ImageProcessorView />;
}
