import { files as fileTools, images as imageTools } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ColorInput,
  DetailPanel,
  Dropdown,
  IconButton,
  NoticeCard,
  NumberInput,
  prompts,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Tooltip,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DEFAULT_ADJ, PRESETS } from "./image-processor/constants";
import { type CropHandle, createCropRect, moveCropRect, resizeCropRect, toPixelCropRect } from "./image-processor/crop-geometry";
import { buildImagePipeline, makePreviewSource, rotatedImageDimensions } from "./image-processor/image-processing";
import MarkupOverlay from "./image-processor/MarkupOverlay";
import { composeCropBounds, FULL_CROP_BOUNDS, restoreMarkupFromCrop, transformMarkupForCrop } from "./image-processor/markup";
import { commitMarkupHistory, redoMarkupHistory, undoMarkupHistory } from "./image-processor/markup-history";
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
} from "./image-processor/types";

let nextId = 0;
const uid = () => `images-${++nextId}`;
const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 4;
const PREVIEW_ZOOM_STEP = 1.2;
type SizedMarkupTool = "pen" | "highlighter" | "shape" | "text";
type MarkupSelection = { imageId: string; elementId: string };
const MARKUP_COLORS = [
  { value: "#111827", label: "Black" },
  { value: "#ef4444", label: "Red" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#22c55e", label: "Green" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#ffffff", label: "White" },
] as const;

// ====================================
// Component
// ====================================

type ImageProcessorViewProps = {
  readonly initialImages?: readonly ImageEntry[];
  readonly initialEditorMode?: "edit" | "markup";
  readonly initialCropActive?: boolean;
};

/** @internal Controlled render seam; the route-facing island below remains zero-prop. */
export function ImageProcessorView(props: ImageProcessorViewProps = {}) {
  // --- Image list ---
  const [images, setImages] = createSignal<ImageEntry[]>([...(props.initialImages ?? [])]);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [error, setError] = createSignal("");
  const [basePreview, setBasePreview] = createSignal(props.initialImages?.[0]?.thumbUrl ?? "");
  const [previewBusy, setPreviewBusy] = createSignal(false);
  const [previewZoom, setPreviewZoom] = createSignal(1);
  const [previewViewportSize, setPreviewViewportSize] = createSignal({ width: 1, height: 1 });
  const [inspectorOpen, setInspectorOpen] = createSignal(true);

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

  // --- Derived ---
  const activeImage = createMemo(() => images()[activeIndex()] ?? null);
  const hasImages = createMemo(() => images().length > 0);
  const adj = createMemo(() => activeImage()?.adj ?? DEFAULT_ADJ);
  const activeImageSubtitle = () => {
    const image = activeImage();
    if (!image) return "No image selected";
    return `${image.source.width} × ${image.source.height} px${image.file ? ` · ${(image.file.size / 1024).toFixed(0)} KB` : ""}`;
  };
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
  const cssFilter = createMemo(() => {
    const a = adj();
    const parts: string[] = [];
    if (a.brightness !== 1) parts.push(`brightness(${a.brightness})`);
    if (a.contrast !== 1) parts.push(`contrast(${a.contrast})`);
    if (a.saturation !== 1) parts.push(`saturate(${a.saturation})`);
    if (a.hueRotate !== 0) parts.push(`hue-rotate(${a.hueRotate}deg)`);
    if (a.blur > 0) parts.push(`blur(${a.blur}px)`);
    if (a.sepia > 0) parts.push(`sepia(${a.sepia})`);
    return parts.join(" ") || "none";
  });

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

  const loadMutation = mutations.create<void, File[]>({
    mutation: async (files) => {
      const entries: ImageEntry[] = [];
      const failures: string[] = [];
      for (const file of files) {
        try {
          const source = await imageTools.create(file);
          const previewSource = await makePreviewSource(source);
          const thumbUrl = await imageTools.presets.thumbnail(file, 64, "#000", "jpeg");
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
          const reason = loadError instanceof Error ? loadError.message : "The file could not be decoded";
          failures.push(`Could not load "${file.name}": ${reason}`);
        }
      }
      if (entries.length === 0) {
        const firstFailure = failures[0] ?? "The selected files could not be decoded";
        throw new Error(failures.length > 1 ? `No images could be loaded. ${firstFailure}` : firstFailure);
      }

      const wasEmpty = images().length === 0;
      setImages((prev) => [...prev, ...entries]);
      if (wasEmpty) setActiveIndex(0);
      await rebuildBasePreview();
      const firstFailure = failures[0];
      if (firstFailure) {
        setError(failures.length === 1 ? firstFailure : `${failures.length} images could not be loaded. ${firstFailure}`);
      }
    },
    onError: (err) => {
      if (err.message !== "File dialog cancelled") setError(err.message);
    },
  });

  const loadFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (cropActive() || cropBusy()) {
      setError("Apply or cancel the crop before adding images");
      return;
    }
    if (loadMutation.loading()) {
      setError("Wait for the current images to finish loading");
      return;
    }
    setError("");
    loadMutation.mutate(files);
  };

  const selectFiles = async () => {
    try {
      const files = await fileTools.showFileDialog({ accept: "image/*", multiple: true });
      loadFiles(files);
    } catch (selectionError) {
      if (selectionError instanceof Error && selectionError.message === "File dialog cancelled") return;
      setError(selectionError instanceof Error ? selectionError.message : "Could not open the image picker");
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
      setError(e instanceof Error ? `Could not build the preview: ${e.message}` : "Could not build the image preview");
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
      const thumbUrl = await imageTools.presets.thumbnail(croppedPreview.canvas, 64, "#000", "jpeg");
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
      setError(cropError instanceof Error ? cropError.message : "Cropping failed");
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
      const thumbUrl = await imageTools.presets.thumbnail(entry.originalPreviewSource.canvas, 64, "#000", "jpeg");
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
      setError(cropError instanceof Error ? cropError.message : "Resetting the crop failed");
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

  const addMarkupText = async (position: MarkupPoint, imageId: string) => {
    const color = markupColor();
    const size = markupSizes().text / 1_000;
    const result = await prompts.form({
      title: "Add text",
      icon: "ti ti-text-resize",
      confirmText: "Add",
      fields: {
        text: {
          type: "text" as const,
          label: "Text",
          required: true,
        },
      },
    });
    const text = String(result?.text ?? "").trim();
    const image = images().find((entry) => entry.id === imageId);
    if (!text || !image) return;
    const element: MarkupElement = {
      id: crypto.randomUUID(),
      kind: "text",
      position,
      text,
      color,
      size,
    };
    mutateMarkup(imageId, (markup) => [...markup, element]);
    if (activeImage()?.id === imageId) {
      selectMarkup(element.id, imageId);
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
    const confirmed = await prompts.confirm("Remove all markup from this image?", {
      title: "Clear markup",
      icon: "ti ti-eraser",
      confirmText: "Clear",
      variant: "danger",
    });
    if (!confirmed) return;
    replaceMarkup([], image.id);
    setMarkupSelection(null);
  };

  // ====================================
  // Export Modal
  // ====================================

  const showExportModal = async (mode: "single" | "all") => {
    const count = mode === "all" ? images().length : 1;

    await prompts.dialog<void>(
      (close) => {
        const [fmt, setFmt] = createSignal<ExportFormat>("webp");
        const [qual, setQual] = createSignal(0.8);
        const [mw, setMw] = createSignal<number | null>(null);
        const [mh, setMh] = createSignal<number | null>(null);
        const [progress, setProgress] = createSignal<number | null>(null);
        const [exporting, setExporting] = createSignal(false);
        const [exportError, setExportError] = createSignal("");

        const doExport = async () => {
          if (exporting()) return;
          setExporting(true);
          setExportError("");
          let completed = 0;
          try {
            const active = activeImage();
            const entries = mode === "all" ? images() : active ? [active] : [];
            if (entries.length === 0) throw new Error("No image is available to export");

            setProgress(0);
            for (let i = 0; i < entries.length; i++) {
              setProgress((i + 0.5) / entries.length);
              const entry = entries[i]!;
              const blob = await buildImagePipeline(entry, mw() ?? undefined, mh() ?? undefined).then(imageTools.toBlob(fmt(), qual()));
              const name = entry.name.replace(/\.[^.]+$/, "") + `.${fmt()}`;
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = name;
              a.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
              completed = i + 1;
              setProgress((i + 1) / entries.length);
              if (entries.length > 1) await new Promise((resolve) => setTimeout(resolve, 200));
            }
            close();
          } catch (exportFailure) {
            const reason = exportFailure instanceof Error ? exportFailure.message : "Unknown export error";
            const prefix = completed > 0 ? `Export stopped after ${completed} of ${count} images. ` : "";
            setExportError(`${prefix}${reason}`);
          } finally {
            setExporting(false);
          }
        };

        return (
          <div class="flex flex-col gap-4 min-w-70">
            <Select
              label="Format"
              icon="ti ti-file-type-jpg"
              value={fmt}
              onValueChange={(v) => setFmt(v as ExportFormat)}
              options={[
                { id: "webp", label: "WebP" },
                { id: "jpeg", label: "JPEG" },
                { id: "png", label: "PNG" },
              ]}
            />
            <Show when={fmt() !== "png"}>
              <Slider
                label="Quality"
                value={qual}
                onValueChange={setQual}
                min={0.1}
                max={1}
                step={0.05}
                showValue
                formatValue={(v) => `${Math.round(v * 100)}%`}
              />
            </Show>
            <div class="grid grid-cols-2 gap-2">
              <NumberInput
                name="image-export-max-width"
                label="Max width"
                placeholder="Auto"
                value={mw}
                onValueChange={setMw}
                min={1}
                allowNegative={false}
                showSteppers={false}
              />
              <NumberInput
                name="image-export-max-height"
                label="Max height"
                placeholder="Auto"
                value={mh}
                onValueChange={setMh}
                min={1}
                allowNegative={false}
                showSteppers={false}
              />
            </div>
            <p class="text-xs text-dimmed">Leave empty to keep original size</p>

            <Show when={exportError()}>
              <NoticeCard tone="danger" icon={false} bodyClass="flex items-center gap-2">
                <i class="ti ti-alert-circle" /> {exportError()}
              </NoticeCard>
            </Show>

            <Show when={progress() !== null}>
              <div class="flex flex-col gap-1">
                <div class="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                  <div
                    class="h-full bg-blue-500 rounded-full transition-all"
                    style={{ width: `${Math.round((progress() ?? 0) * 100)}%` }}
                  />
                </div>
                <p class="text-xs text-dimmed text-center">{Math.round((progress() ?? 0) * 100)}%</p>
              </div>
            </Show>

            <div class="flex gap-2 justify-end">
              <Button variant="secondary" size="sm" onClick={() => close()} disabled={exporting()}>
                Cancel
              </Button>
              <Button size="sm" onClick={doExport} loading={exporting()} loadingLabel="Exporting">
                <i class="ti ti-download" />
                {mode === "all" ? `Export ${count}` : "Export"}
              </Button>
            </div>
          </div>
        );
      },
      {
        title: mode === "all" ? `Export ${count} Images` : "Export Image",
        icon: "ti ti-download",
      },
    );
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
  // Drag & Drop + Keyboard
  // ====================================

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    const files = dropped.filter((f) => f.type.startsWith("image/"));
    if (dropped.length > 0 && files.length === 0) {
      setError("Drop an image file to add it");
      return;
    }
    loadFiles(files);
  };

  const isEditableTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable || target.closest("[contenteditable='true']") !== null);

  const isControlTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    target.closest("button, a, input, textarea, select, [role='button'], [role='slider'], [role='tab']") !== null;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || isEditableTarget(e.target)) return;
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

  onMount(() => {
    if (props.initialImages?.length) void rebuildBasePreview();
    measurePreviewViewport();
    const previewObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measurePreviewViewport);
    const desktopMedia = window.matchMedia("(min-width: 1024px)");
    const reopenInspectorOnDesktop = () => {
      if (desktopMedia.matches) setInspectorOpen(true);
    };
    if (previewViewportRef) previewObserver?.observe(previewViewportRef);
    if (!previewObserver) window.addEventListener("resize", measurePreviewViewport);
    desktopMedia.addEventListener("change", reopenInspectorOnDesktop);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointermove", onCropPointerMove, { passive: false });
    document.addEventListener("pointerup", onCropPointerUp);
    document.addEventListener("pointercancel", onCropPointerUp);

    onCleanup(() => {
      previewObserver?.disconnect();
      if (!previewObserver) window.removeEventListener("resize", measurePreviewViewport);
      desktopMedia.removeEventListener("change", reopenInspectorOnDesktop);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointermove", onCropPointerMove);
      document.removeEventListener("pointerup", onCropPointerUp);
      document.removeEventListener("pointercancel", onCropPointerUp);
    });
  });

  const SectionLabel = (props: { label: string }) => <span class="section-label mb-0">{props.label}</span>;

  const MarkupSettings = () => (
    <div class="flex flex-col gap-[var(--ui-space-section)]">
      <Show when={markupTool() === "shape"}>
        <div class="flex min-w-0 flex-col gap-2">
          <SectionLabel label="Shape" />
          <div class="max-w-full overflow-x-auto scrollbar">
            <SegmentedControl<MarkupShapeKind>
              options={[
                { value: "rectangle", label: "Rectangle", icon: "ti ti-rectangle" },
                { value: "circle", label: "Circle", icon: "ti ti-circle" },
                { value: "arrow", label: "Arrow", icon: "ti ti-arrow-up-right" },
              ]}
              value={markupShape}
              onValueChange={setMarkupShape}
              aria-label="Shape type"
            />
          </div>
        </div>
      </Show>

      <Show when={isSizedMarkupTool(markupTool())}>
        <div class="flex flex-col gap-2">
          <SectionLabel label="Color" />
          <div class="flex flex-wrap items-center gap-2">
            <For each={MARKUP_COLORS}>
              {(color) => (
                <button
                  type="button"
                  class="h-8 w-8 rounded border border-black/15 shadow-sm dark:border-white/20"
                  classList={{ "ring-2 ring-blue-500 ring-offset-1": markupColor() === color.value }}
                  style={{ "background-color": color.value }}
                  onClick={() => setMarkupColor(color.value)}
                  aria-label={`Use ${color.label}`}
                  aria-pressed={markupColor() === color.value}
                />
              )}
            </For>
            <Tooltip.Anchor content="Custom color">
              <ColorInput compact label="Custom color" value={markupColor} onValueChange={setMarkupColor} />
            </Tooltip.Anchor>
          </div>
        </div>

        <Slider
          label={markupTool() === "text" ? "Text size" : "Size"}
          value={markupSize}
          onValueChange={setMarkupSize}
          min={markupSizeRange().min}
          max={markupSizeRange().max}
          step={1}
          showValue
        />
      </Show>
    </div>
  );

  // ====================================
  // Render
  // ====================================

  return (
    <>
      <AppWorkspace.Main class="tools-main" scroll={false}>
        <div
          class="flex min-h-0 min-w-0 flex-1 flex-col"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          role="region"
          aria-label="Image processor canvas"
        >
          <div
            ref={previewViewportRef}
            class="relative min-h-75 min-w-0 flex-1 overflow-auto bg-[var(--ui-surface)] p-[var(--ui-space-shell)]"
          >
            <Show when={!inspectorOpen()}>
              <Tooltip.Anchor content="Open image controls">
                <IconButton
                  label="Open image controls"
                  class="absolute right-[var(--ui-space-shell)] top-[var(--ui-space-shell)] z-10 lg:hidden"
                  onClick={() => setInspectorOpen(true)}
                >
                  <i class="ti ti-adjustments-horizontal" />
                </IconButton>
              </Tooltip.Anchor>
            </Show>

            {/* Loading overlay */}
            <Show when={loadMutation.loading() || previewBusy() || cropBusy()}>
              <div class="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-black/50 z-10">
                <i class="ti ti-loader-2 animate-spin text-2xl text-dimmed" />
              </div>
            </Show>

            {/* Empty state */}
            <Show when={!hasImages() && !loadMutation.loading()}>
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-dimmed">
                <i class="ti ti-photo text-4xl" />
                <p class="text-sm font-medium">No image selected</p>
              </div>
            </Show>

            <Show when={basePreview()}>
              <Show when={previewLayout()}>
                {(layout) => (
                  <div class="flex min-h-full min-w-full">
                    <div
                      class="relative m-auto shrink-0"
                      style={{ width: `${layout().stageWidth}px`, height: `${layout().stageHeight}px` }}
                    >
                      <div class="absolute inset-0 flex items-center justify-center">
                        <div
                          class="relative shrink-0"
                          style={{
                            width: `${layout().imageWidth}px`,
                            height: `${layout().imageHeight}px`,
                            transform: cropActive() || editorMode() === "markup" ? "none" : cssTransform(),
                          }}
                        >
                          <img
                            ref={imgRef}
                            src={basePreview()}
                            alt="Preview"
                            class="block h-full w-full object-fill thumbnail"
                            style={{ filter: cssFilter() }}
                            draggable={false}
                          />

                          <Show when={adj().vignette > 0}>
                            <div
                              class="absolute inset-0 pointer-events-none rounded"
                              style={{
                                background: `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,${adj().vignette}) 100%)`,
                              }}
                            />
                          </Show>

                          <Show when={adj().grain > 0}>
                            <div
                              class="absolute inset-0 pointer-events-none rounded mix-blend-overlay"
                              style={{
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
                                onText={addMarkupText}
                              />
                            )}
                          </Show>

                          {/* Crop overlay */}
                          <Show when={cropActive()}>
                            <div class="absolute inset-0 touch-none">
                              {/* Dark mask with hole via clip-path */}
                              <div
                                class="absolute inset-0 bg-black/50"
                                style={{
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
                                class="absolute border-2 border-white cursor-move"
                                style={{
                                  left: `${cropRect().x * 100}%`,
                                  top: `${cropRect().y * 100}%`,
                                  width: `${cropRect().w * 100}%`,
                                  height: `${cropRect().h * 100}%`,
                                }}
                                onPointerDown={(e) => startCropDrag("move", e)}
                              >
                                <div class="absolute inset-0 pointer-events-none">
                                  <div class="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
                                  <div class="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
                                  <div class="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
                                  <div class="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
                                </div>
                                {(["nw", "ne", "sw", "se"] as const).map((h) => (
                                  <div
                                    class={`absolute h-6 w-6 ${h.includes("n") ? "-top-3" : "-bottom-3"} ${
                                      h.includes("w") ? "-left-3" : "-right-3"
                                    } ${h === "nw" || h === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize"} z-10`}
                                    onPointerDown={(e) => startCropDrag(h, e)}
                                  >
                                    <div class="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-zinc-400 bg-white" />
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

          <Show when={images().length > 1}>
            <nav
              class="flex flex-none items-center gap-2 overflow-x-auto bg-[var(--ui-surface-subtle)] px-[var(--ui-space-shell)] py-[var(--ui-space-section)] scrollbar"
              aria-label="Images"
            >
              <For each={images()}>
                {(image, index) => (
                  <button
                    type="button"
                    class="h-12 w-12 shrink-0 overflow-hidden rounded border border-[var(--ui-border)] bg-[var(--ui-surface)] p-0.5"
                    classList={{ "ring-2 ring-blue-500": activeIndex() === index() }}
                    onClick={() => switchImage(index())}
                    disabled={cropActive()}
                    aria-label={`Open ${image.name}`}
                    aria-current={activeIndex() === index() ? "true" : undefined}
                    title={image.name}
                  >
                    <img src={image.thumbUrl} alt="" class="h-full w-full rounded-sm object-cover" draggable={false} />
                  </button>
                )}
              </For>
            </nav>
          </Show>
        </div>
      </AppWorkspace.Main>

      <AppWorkspace.Detail
        id="image-processor-inspector"
        open={inspectorOpen()}
        width="md"
        minWidth={288}
        viewTransitionName="tools-image-inspector"
      >
        <DetailPanel>
          <DetailPanel.Header
            icon="ti ti-photo"
            title={activeImage()?.name ?? "Image controls"}
            subtitle={activeImageSubtitle()}
            actions={
              <>
                <Show when={hasImages()}>
                  <Tooltip.Anchor content="Add images">
                    <IconButton
                      label="Add images"
                      size="sm"
                      class="h-8 w-8 shrink-0"
                      onClick={selectFiles}
                      disabled={loadMutation.loading() || cropActive()}
                    >
                      <i class="ti ti-photo-plus" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                  <Tooltip.Anchor content="Remove image">
                    <IconButton
                      label="Remove image"
                      size="sm"
                      class="h-8 w-8 shrink-0 text-red-600 dark:text-red-400"
                      onClick={() => removeImage(activeIndex())}
                      disabled={cropActive() || cropBusy()}
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                </Show>
                <IconButton label="Show image canvas" size="sm" class="h-8 w-8 shrink-0 lg:hidden" onClick={() => setInspectorOpen(false)}>
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </>
            }
            primaryActions={
              <Show
                when={hasImages()}
                fallback={
                  <Button size="sm" class="w-full" onClick={selectFiles} loading={loadMutation.loading()} loadingLabel="Adding images">
                    <i class="ti ti-photo-plus" aria-hidden="true" /> Add images
                  </Button>
                }
              >
                <SegmentedControl<"edit" | "markup">
                  options={[
                    { value: "edit", label: "Edit", icon: "ti ti-adjustments-horizontal" },
                    { value: "markup", label: "Markup", icon: "ti ti-pencil" },
                  ]}
                  value={editorMode}
                  onValueChange={changeEditorMode}
                  aria-label="Editor mode"
                />
              </Show>
            }
          />

          <DetailPanel.Body>
            <Show when={error()}>
              <div
                class="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                role="alert"
              >
                <i class="ti ti-alert-circle shrink-0" />
                <span class="min-w-0 flex-1">{error()}</span>
                <IconButton label="Dismiss error" size="xs" class="h-6 w-6 shrink-0 text-current" onClick={() => setError("")}>
                  <i class="ti ti-x" />
                </IconButton>
              </div>
            </Show>

            <Show when={hasImages()}>
              <DetailPanel.Summary
                title="Preview"
                actions={<span class="text-xs tabular-nums text-dimmed">{Math.round(previewZoom() * 100)}%</span>}
              >
                <div class="flex items-center gap-1">
                  <Tooltip.Anchor content="Zoom out">
                    <IconButton
                      label="Zoom out"
                      size="sm"
                      class="h-8 w-8"
                      onClick={() => setClampedPreviewZoom(previewZoom() / PREVIEW_ZOOM_STEP)}
                      disabled={previewZoom() <= MIN_PREVIEW_ZOOM}
                    >
                      <i class="ti ti-minus" />
                    </IconButton>
                  </Tooltip.Anchor>
                  <Tooltip.Anchor content="Zoom in">
                    <IconButton
                      label="Zoom in"
                      size="sm"
                      class="h-8 w-8"
                      onClick={() => setClampedPreviewZoom(previewZoom() * PREVIEW_ZOOM_STEP)}
                      disabled={previewZoom() >= MAX_PREVIEW_ZOOM}
                    >
                      <i class="ti ti-plus" />
                    </IconButton>
                  </Tooltip.Anchor>
                  <Tooltip.Anchor content="Fit image">
                    <IconButton label="Fit image" size="sm" class="h-8 w-8" onClick={fitPreview}>
                      <i class="ti ti-focus-centered" />
                    </IconButton>
                  </Tooltip.Anchor>
                </div>
              </DetailPanel.Summary>

              <Show when={editorMode() === "markup"}>
                <DetailPanel.Group label="Markup controls">
                  <DetailPanel.Section title="Tool" icon="ti ti-pencil" tone="accent">
                    <div class="flex flex-col gap-2">
                      <div class="grid grid-cols-7 gap-1">
                        <For
                          each={[
                            { value: "select" as const, label: "Select", icon: "ti-selector" },
                            { value: "pen" as const, label: "Pen", icon: "ti-pencil" },
                            { value: "highlighter" as const, label: "Highlight", icon: "ti-highlight" },
                            { value: "redact" as const, label: "Redact", icon: "ti-square" },
                            { value: "shape" as const, label: "Shape", icon: "ti-shape" },
                            { value: "text" as const, label: "Text", icon: "ti-text-resize" },
                            { value: "eraser" as const, label: "Erase strokes", icon: "ti-eraser" },
                          ]}
                        >
                          {(tool) => (
                            <Tooltip.Anchor content={tool.label}>
                              <IconButton
                                label={tool.label}
                                size="sm"
                                class="h-9 w-full"
                                onClick={() => chooseMarkupTool(tool.value)}
                                aria-pressed={markupTool() === tool.value}
                              >
                                <i class={`ti ${tool.icon}`} />
                              </IconButton>
                            </Tooltip.Anchor>
                          )}
                        </For>
                      </div>
                      <div class="flex items-center gap-1">
                        <Tooltip.Anchor content="Undo">
                          <IconButton label="Undo markup" size="sm" class="h-8 w-8" onClick={undoMarkup} disabled={!canUndoMarkup()}>
                            <i class="ti ti-arrow-back-up" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content="Redo">
                          <IconButton label="Redo markup" size="sm" class="h-8 w-8" onClick={redoMarkup} disabled={!canRedoMarkup()}>
                            <i class="ti ti-arrow-forward-up" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content="Delete selected markup">
                          <IconButton
                            label="Delete selected markup"
                            size="sm"
                            class="h-8 w-8 text-red-600 dark:text-red-400"
                            onClick={deleteSelectedMarkup}
                            disabled={!selectedMarkupId()}
                          >
                            <i class="ti ti-trash" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content="Clear markup">
                          <IconButton
                            label="Clear markup"
                            size="sm"
                            class="h-8 w-8 text-red-600 dark:text-red-400"
                            onClick={clearMarkup}
                            disabled={(activeImage()?.markup.length ?? 0) === 0}
                          >
                            <i class="ti ti-trash-x" />
                          </IconButton>
                        </Tooltip.Anchor>
                      </div>
                    </div>
                  </DetailPanel.Section>
                  <Show when={markupTool() === "shape" || isSizedMarkupTool(markupTool())}>
                    <DetailPanel.Section title="Style" icon="ti ti-palette" tone="neutral">
                      <MarkupSettings />
                    </DetailPanel.Section>
                  </Show>
                </DetailPanel.Group>
              </Show>

              <Show when={editorMode() === "edit"}>
                <>
                  <DetailPanel.Group label="Geometry">
                    {/* Crop */}
                    <DetailPanel.Section title="Crop" icon="ti ti-crop" tone="accent">
                      <div class="flex flex-col gap-2">
                        <div class="flex gap-2">
                          <Show
                            when={cropActive()}
                            fallback={
                              <Button variant="secondary" size="sm" class="flex-1" onClick={startCrop} disabled={cropBusy()}>
                                <i class="ti ti-crop" /> Crop
                              </Button>
                            }
                          >
                            <Button size="sm" class="flex-1" onClick={applyCrop} loading={cropBusy()} loadingLabel="Applying">
                              <i class="ti ti-check" /> Apply
                            </Button>
                          </Show>
                          <Dropdown.Root
                            position="bottom-left"
                            items={(
                              [
                                ["free", "Free"],
                                ["1:1", "1:1"],
                                ["4:3", "4:3"],
                                ["16:9", "16:9"],
                                ["3:2", "3:2"],
                              ] as const
                            ).map(([id, label]) => ({
                              label,
                              icon: cropAspect() === id ? "ti ti-check" : undefined,
                              action: () => selectCropAspect(id),
                            }))}
                          >
                            <Dropdown.Trigger variant="secondary" size="sm">
                              {cropAspect() === "free" ? "Free" : cropAspect()} <i class="ti ti-chevron-down text-[10px]" />
                            </Dropdown.Trigger>
                          </Dropdown.Root>
                          <Show when={!cropActive() && activeImage()?.cropped}>
                            <IconButton label="Reset crop" size="sm" onClick={resetCrop} loading={cropBusy()} loadingLabel="Resetting crop">
                              <i class="ti ti-arrow-back-up" />
                            </IconButton>
                          </Show>
                        </div>
                        <Show when={cropActive()}>
                          <Button variant="secondary" size="sm" class="w-full" onClick={cancelCrop} disabled={cropBusy()}>
                            Cancel
                          </Button>
                        </Show>
                      </div>
                    </DetailPanel.Section>

                    {/* Transform */}
                    <DetailPanel.Section title="Transform" icon="ti ti-transform" tone="neutral">
                      <div class="flex flex-col gap-2">
                        <Slider
                          label="Rotation"
                          value={() => adj().freeRotation}
                          onValueChange={(v) => setAdj("freeRotation", v)}
                          min={-180}
                          max={180}
                          step={0.5}
                          center
                          showValue
                          formatValue={(v) => `${v > 0 ? "+" : ""}${v}\u00b0`}
                        />
                        <div class="grid grid-cols-2 gap-2">
                          <Switch label="Flip H" value={() => adj().flipH} onValueChange={(v) => setAdj("flipH", v)} />
                          <Switch label="Flip V" value={() => adj().flipV} onValueChange={(v) => setAdj("flipV", v)} />
                        </div>
                      </div>
                    </DetailPanel.Section>
                  </DetailPanel.Group>

                  <DetailPanel.Group label="Appearance">
                    {/* Adjustments */}
                    <DetailPanel.Section
                      title="Adjustments"
                      icon="ti ti-adjustments-horizontal"
                      tone="accent"
                      actions={
                        <Button variant="ghost" size="xs" onClick={resetAdjustments}>
                          Reset
                        </Button>
                      }
                    >
                      <div class="flex flex-col gap-2">
                        <Slider
                          label="Brightness"
                          value={() => adj().brightness}
                          onValueChange={(v) => setAdj("brightness", v)}
                          min={0.5}
                          max={1.5}
                          step={0.01}
                          center
                          showValue
                          formatValue={(v) => `${Math.round(v * 100)}%`}
                        />
                        <Slider
                          label="Contrast"
                          value={() => adj().contrast}
                          onValueChange={(v) => setAdj("contrast", v)}
                          min={0.5}
                          max={2}
                          step={0.01}
                          center
                          showValue
                          formatValue={(v) => `${Math.round(v * 100)}%`}
                        />
                        <Slider
                          label="Saturation"
                          value={() => adj().saturation}
                          onValueChange={(v) => setAdj("saturation", v)}
                          min={0}
                          max={2}
                          step={0.01}
                          center
                          showValue
                          formatValue={(v) => `${Math.round(v * 100)}%`}
                        />
                        <Slider
                          label="Hue"
                          value={() => adj().hueRotate}
                          onValueChange={(v) => setAdj("hueRotate", v)}
                          min={0}
                          max={360}
                          step={1}
                          showValue
                          formatValue={(v) => `${v}\u00b0`}
                        />
                        <Slider
                          label="Blur"
                          value={() => adj().blur}
                          onValueChange={(v) => setAdj("blur", v)}
                          min={0}
                          max={10}
                          step={0.1}
                          showValue
                          formatValue={(v) => `${v.toFixed(1)}px`}
                        />
                        <Slider
                          label="Sepia"
                          value={() => adj().sepia}
                          onValueChange={(v) => setAdj("sepia", v)}
                          min={0}
                          max={1}
                          step={0.01}
                          showValue
                          formatValue={(v) => `${Math.round(v * 100)}%`}
                        />
                        <Slider
                          label="Vignette"
                          value={() => adj().vignette}
                          onValueChange={(v) => setAdj("vignette", v)}
                          min={0}
                          max={1}
                          step={0.01}
                          showValue
                          formatValue={(v) => `${Math.round(v * 100)}%`}
                        />
                        <Slider
                          label="Grain"
                          value={() => adj().grain}
                          onValueChange={(v) => setAdj("grain", v)}
                          min={0}
                          max={0.5}
                          step={0.01}
                          showValue
                          formatValue={(v) => `${Math.round(v * 200)}%`}
                        />
                      </div>
                    </DetailPanel.Section>

                    {/* Presets */}
                    <DetailPanel.Section title="Presets" icon="ti ti-wand" tone="neutral">
                      <div class="grid grid-cols-4 gap-1">
                        <For each={Object.entries(PRESETS)}>
                          {([key, preset]) => (
                            <Button variant="secondary" size="sm" onClick={() => applyPreset(key)}>
                              {preset.label}
                            </Button>
                          )}
                        </For>
                      </div>
                    </DetailPanel.Section>

                    {/* Copy / Paste Edits */}
                    <DetailPanel.Section title="Edits" icon="ti ti-copy" tone="neutral">
                      <div class="grid grid-cols-3 gap-1">
                        <Button variant="secondary" size="sm" onClick={copyEdits} title="Copy adjustments from this image">
                          <i class="ti ti-copy" /> Copy
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={pasteEdits}
                          disabled={!clipboard()}
                          title="Paste adjustments to this image"
                        >
                          <i class="ti ti-clipboard" /> Paste
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={pasteEditsAll}
                          disabled={!clipboard()}
                          title="Paste adjustments to all images"
                        >
                          <i class="ti ti-clipboard-check" /> All
                        </Button>
                      </div>
                    </DetailPanel.Section>
                  </DetailPanel.Group>
                </>
              </Show>
            </Show>
          </DetailPanel.Body>

          <Show when={hasImages()}>
            <footer class="flex flex-none flex-col gap-2">
              <Button size="sm" class="w-full" onClick={() => showExportModal("single")} disabled={cropActive() || cropBusy()}>
                <i class="ti ti-download" /> Export image
              </Button>
              <Show when={images().length > 1}>
                <Button
                  variant="secondary"
                  size="sm"
                  class="w-full"
                  onClick={() => showExportModal("all")}
                  disabled={cropActive() || cropBusy()}
                >
                  <i class="ti ti-download" /> Export all ({images().length})
                </Button>
              </Show>
            </footer>
          </Show>
        </DetailPanel>
      </AppWorkspace.Detail>
    </>
  );
}

export default function ImageProcessor() {
  return <ImageProcessorView />;
}
