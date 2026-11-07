import { onBeforeLeave, swapPage } from "@k2b/ssr/nav";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Button, IconButton } from "../../actions/Button";
import { prompts } from "../../feedback/prompts";
import { useLocale } from "../../intl/locale";
import { NoticeCard } from "../../surfaces/NoticeCard";
import Placeholder from "../../surfaces/Placeholder";
import { Slider } from "../ChoiceInputs";
import { ChoiceTiles } from "../ChoiceTiles";
import { ColorChoices } from "../ColorChoices";
import {
  clampImageCropRect,
  getInitialImageCropRect,
  type ImageCropAspect,
  type ImageCropRect,
  type ImageCropResizeHandle,
  resizeImageCropFromCorner,
} from "../image-crop";
import { NumberInput } from "../NumberInput";
import { Select } from "../Select";
import { TextInput } from "../TextInput";
import { imageEditorMatrix, inverseEditorPoint, transformEditorPoint } from "./geometry";
import { exportImageEditor, ImageEditorSizeError, loadImageEditorPreview, supportedImageEditorFormats } from "./image";
import { useImageEditorMessages } from "./messages";
import {
  commitImageEditorState,
  createImageEditorHistory,
  currentImageEditorEntry,
  editorOutputSize,
  imageEditorDirty,
  initialImageEditorState,
  markImageEditorSaved,
  redoImageEditor,
  rotatedEditorSize,
  rotateEditorRight,
  undoImageEditor,
} from "./model";
import { renderImageEditor } from "./render";
import type {
  ImageEditorAdjustments,
  ImageEditorAnnotation,
  ImageEditorAnnotationTool,
  ImageEditorAspect,
  ImageEditorFormat,
  ImageEditorLook,
  ImageEditorOutput,
  ImageEditorPoint,
  ImageEditorProps,
  ImageEditorResult,
  ImageEditorSaveActions,
  ImageEditorState,
} from "./types";

type Tool = "crop" | "adjust" | "looks" | "annotate" | "redact" | "export";
const fullCrop = { x: 0, y: 0, width: 1, height: 1 };
const corners = ["nw", "ne", "sw", "se"] as const;
const defaultAspects: readonly ImageEditorAspect[] = ["free", "original", "1:1", "4:5", "3:2", "4:3", "16:9", "9:16"];
const annotationTools: readonly ImageEditorAnnotationTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse", "text"];
const adjustments = ["brightness", "contrast", "saturation", "warmth", "vignette", "grain"] as const;
const lookOptions: readonly {
  value: ImageEditorLook;
  label: "natural" | "vivid" | "soft" | "mono" | "warm" | "cool" | "monoHard" | "faded" | "vintage";
}[] = [
  { value: "original", label: "natural" },
  { value: "vivid", label: "vivid" },
  { value: "warm", label: "warm" },
  { value: "cool", label: "cool" },
  { value: "mono", label: "mono" },
  { value: "soft", label: "soft" },
  { value: "mono-hard", label: "monoHard" },
  { value: "faded", label: "faded" },
  { value: "vintage", label: "vintage" },
];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** A new source has its own history, async lifetime, and saved identity. */
export default function ImageEditorView(props: ImageEditorProps): JSX.Element {
  return (
    <Show when={props.source} keyed>
      {(source) => <ImageEditorSession {...props} source={source} />}
    </Show>
  );
}

function ImageEditorSession(props: ImageEditorProps): JSX.Element {
  const t = useImageEditorMessages();
  const locale = useLocale();
  const helpId = createUniqueId();
  const [history, setHistory] = createSignal(createImageEditorHistory());
  const [draft, setDraft] = createSignal<ImageEditorState>();
  const state = () => draft() ?? currentImageEditorEntry(history()).state;
  const dirty = () => imageEditorDirty(history()) || draft() !== undefined || inlineText() !== undefined;
  const tools = createMemo(() => {
    const f = props.features;
    return [
      { value: "crop" as const, label: t().crop, icon: "ti ti-crop", enabled: f.crop || f.rotate || f.straighten },
      { value: "adjust" as const, label: t().adjust, icon: "ti ti-adjustments-horizontal", enabled: f.adjust },
      { value: "looks" as const, label: t().looks, icon: "ti ti-color-swatch", enabled: f.filters },
      { value: "annotate" as const, label: t().annotate, icon: "ti ti-pencil", enabled: f.annotate },
      { value: "redact" as const, label: t().redact, icon: "ti ti-square-filled", enabled: f.redact },
      { value: "export" as const, label: t().export, icon: "ti ti-download", enabled: f.export },
    ].filter((tool) => tool.enabled);
  });
  const [tool, setTool] = createSignal<Tool>(untrack(() => tools()[0]?.value ?? "crop"));
  const cropOptions = () => (typeof props.features.crop === "object" ? props.features.crop : undefined);
  const aspects = () => {
    const configured = cropOptions()?.aspects;
    const values = configured?.length ? configured : defaultAspects;
    const initial = cropOptions()?.defaultAspect;
    return initial && !values.includes(initial) ? [initial, ...values] : values;
  };
  const aspectIndex = () => Math.max(0, aspects().indexOf(state().cropAspect));
  const aspectFor = (edit: ImageEditorState): ImageCropAspect => {
    const value = edit.cropAspect;
    const source = preview()?.sourceSize;
    if (value === "free") return "free";
    const result =
      typeof value === "object"
        ? value
        : value === "original" && source
          ? source
          : (() => {
              const [width, height] = value.split(":").map(Number);
              return { width: width ?? 1, height: height ?? 1 };
            })();
    return edit.cropAspectSwapped ? { width: result.height, height: result.width } : result;
  };
  const aspect = () => aspectFor(state());
  const [preview, setPreview] = createSignal<Awaited<ReturnType<typeof loadImageEditorPreview>>>();
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal(false);
  const [loadAttempt, setLoadAttempt] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const [suggestedMP, setSuggestedMP] = createSignal<number>();
  const [acceptedMP, setAcceptedMP] = createSignal<number>();
  const [output, setOutput] = createSignal<ImageEditorOutput>({ ...props.output });
  const [formats, setFormats] = createSignal<ImageEditorFormat[]>([]);
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [compare, setCompare] = createSignal(false);
  const markTools = () =>
    typeof props.features.annotate === "object" ? (props.features.annotate.tools ?? annotationTools) : annotationTools;
  const [markTool, setMarkTool] = createSignal<ImageEditorAnnotationTool>(markTools()[0] ?? "pen");
  createEffect(() => {
    const available = tools();
    if (!available.some((candidate) => candidate.value === tool())) setTool(available[0]?.value ?? "crop");
    if (!markTools().includes(markTool())) setMarkTool(markTools()[0] ?? "pen");
  });
  const [color, setColor] = createSignal("#ef4444");
  const [width, setWidth] = createSignal(6);
  const [inlineText, setInlineText] = createSignal<{ point: ImageEditorPoint; value: string; index?: number }>();
  const [feedbackInset, setFeedbackInset] = createSignal(0);
  let feedbackError: HTMLDivElement | undefined;
  const [viewport, setViewport] = createSignal({ width: 640, height: 420 });
  let stage: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let scratch: HTMLCanvasElement | undefined;
  let frame = 0;
  let alive = true;
  let generation = 0;
  let saveAbort: AbortController | undefined;
  let lastSave: { commit: (result: ImageEditorResult) => Promise<void>; output?: ImageEditorOutput } | undefined;
  let cropDrag: { id: number; corner: ImageCropResizeHandle | "move"; x: number; y: number; rect: ImageCropRect } | undefined;
  let stroke: { id: number; mark: ImageEditorAnnotation } | undefined;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; zoom: number } | undefined;
  let panDrag: { id: number; x: number; y: number; origin: ImageEditorPoint } | undefined;

  const commit = (next: ImageEditorState) => {
    setDraft(undefined);
    setHistory((h) => commitImageEditorState(h, next));
    setSaved(false);
  };
  const finishDraft = () => {
    const next = draft();
    if (next) commit(next);
  };
  const change = (update: (current: ImageEditorState) => ImageEditorState) => {
    finishText();
    finishDraft();
    commit(update(state()));
  };
  const updateSlider = (update: (current: ImageEditorState) => ImageEditorState) => {
    setDraft(update(state()));
    setSaved(false);
  };
  const undo = () => {
    setInlineText(undefined);
    setDraft(undefined);
    setHistory(undoImageEditor);
    setSaved(false);
  };
  const redo = () => {
    setInlineText(undefined);
    setDraft(undefined);
    setHistory(redoImageEditor);
    setSaved(false);
  };
  const renderedState = (): ImageEditorState =>
    compare() ? initialImageEditorState() : tool() === "crop" && props.features.crop ? { ...state(), crop: fullCrop } : state();
  const size = () => (preview() ? rotatedEditorSize(preview()!.sourceSize, state()) : { width: 1, height: 1 });
  const dimensions = createMemo(() => {
    const source = preview()?.sourceSize;
    return source ? editorOutputSize(source, state(), acceptedMP() ?? props.maxOutputMegapixels, output().maxLongEdge) : undefined;
  });
  const display = createMemo(() => {
    const source = preview()?.sourceSize;
    const rs = renderedState();
    const rotated = source ? rotatedEditorSize(source, rs) : { width: 3, height: 2 };
    const ratio = (rotated.width * rs.crop.width) / (rotated.height * rs.crop.height);
    const scale = Math.min(Math.max(1, viewport().width - 48) / ratio, Math.max(1, viewport().height - feedbackInset() - 112));
    return { width: scale * ratio * zoom(), height: scale * zoom() };
  });
  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const setClampedZoom = (value: number) => {
    setZoom(clamp(value, 0.5, 4));
    if (value <= 1) setPan({ x: 0, y: 0 });
  };
  const sourcePoint = (clientX: number, clientY: number): ImageEditorPoint => {
    const bounds = canvas!.getBoundingClientRect();
    const source = preview()!.sourceSize;
    const p = inverseEditorPoint(imageEditorMatrix(source, renderedState(), canvas!), {
      x: ((clientX - bounds.left) * canvas!.width) / bounds.width,
      y: ((clientY - bounds.top) * canvas!.height) / bounds.height,
    });
    return { x: clamp(p.x / source.width, 0, 1), y: clamp(p.y / source.height, 0, 1) };
  };
  const textPosition = () => {
    const edit = inlineText();
    const source = preview()?.sourceSize;
    if (!edit || !source) return { left: "50%", top: "50%" };
    const p = transformEditorPoint(imageEditorMatrix(source, renderedState(), { width: display().width, height: display().height }), {
      x: edit.point.x * source.width,
      y: edit.point.y * source.height,
    });
    const left = (viewport().width - display().width) / 2 + pan().x + p.x;
    const top = (viewport().height - 64 - feedbackInset() - display().height) / 2 + feedbackInset() + pan().y + p.y;
    return {
      left: `clamp(.5rem, ${left}px, max(.5rem, calc(100% - 15rem - .5rem)))`,
      top: `clamp(.5rem, ${top}px, max(.5rem, calc(100% - 3rem)))`,
    };
  };
  function finishText() {
    const text = inlineText();
    if (!text) return;
    setInlineText(undefined);
    const marks = [...state().annotations];
    const previous = text.index === undefined ? undefined : marks[text.index];
    if (previous?.text === text.value) return;
    if (text.index !== undefined) marks.splice(text.index, 1);
    if (text.value.trim())
      marks.push({
        tool: "text",
        points: [text.point],
        text: text.value,
        color: previous?.color ?? color(),
        width: previous?.width ?? width() * 4,
      });
    if (previous || text.value.trim()) commit({ ...state(), annotations: marks });
  }

  createEffect(
    on(
      () => [props.source, props.sourceSize, props.previews, loadAttempt()] as const,
      () => {
        const abort = new AbortController();
        const current = ++generation;
        setLoading(true);
        setLoadError(false);
        setError("");
        setPreview(undefined);
        setBusy(false);
        saveAbort?.abort();
        let loaded: Awaited<ReturnType<typeof loadImageEditorPreview>> | undefined;
        void loadImageEditorPreview(props, abort.signal)
          .then((result) => {
            if (abort.signal.aborted) {
              result.dispose();
              return;
            }
            loaded = result;
            setPreview(result);
            setLoading(false);
            if (history().entries.length === 1 && props.features.crop) {
              const options = cropOptions();
              const initial = options?.defaultAspect ?? (aspects().includes("free") ? "free" : aspects()[0]);
              if (initial && initial !== "free") {
                const next = { ...initialImageEditorState(), cropAspect: initial };
                next.crop = getInitialImageCropRect(rotatedEditorSize(result.sourceSize, next), aspectFor(next));
                setHistory(createImageEditorHistory(next));
              }
            }
          })
          .catch(() => {
            if (alive && current === generation && !abort.signal.aborted) {
              setLoading(false);
              setLoadError(true);
            }
          });
        onCleanup(() => {
          abort.abort();
          loaded?.dispose();
        });
      },
    ),
  );
  createEffect(() => {
    props.onDirtyChange?.(dirty());
  });
  createEffect(() => {
    const image = preview();
    const edit = renderedState();
    if (!image || !canvas) return;
    cancelAnimationFrame(frame);
    const paint = () => {
      if (!canvas || !alive) return;
      try {
        scratch ??= document.createElement("canvas");
        const rotated = rotatedEditorSize(image.sourceSize, edit);
        const renderScale = Math.min(1, 1600 / Math.max(rotated.width * edit.crop.width, rotated.height * edit.crop.height));
        canvas.width = Math.max(1, Math.round(rotated.width * edit.crop.width * renderScale));
        canvas.height = Math.max(1, Math.round(rotated.height * edit.crop.height * renderScale));
        renderImageEditor(image.image, image.sourceSize, edit, canvas, scratch);
      } catch {
        setError(t().loadFailed);
      }
    };
    // Gestures may coalesce, but a committed edit (including undo) must already match its visible preview.
    if (draft()) frame = requestAnimationFrame(paint);
    else paint();
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty() || inlineText()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  onBeforeLeave((event) => {
    if (!(dirty() || inlineText())) return;
    event.preventDefault();
    void event.restored.then(async () => {
      if (alive && (await confirmDiscard())) {
        setHistory((h) => markImageEditorSaved(h));
        setDraft(undefined);
        setInlineText(undefined);
        if (event.delta !== undefined && event.delta < 0) window.history.go(event.delta);
        else void swapPage(event.url.href);
      }
    });
  });
  onMount(() => {
    window.addEventListener("beforeunload", beforeUnload);
    const observer = new ResizeObserver(() => {
      if (stage) setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    });
    if (stage) observer.observe(stage);
    void supportedImageEditorFormats()
      .then((available) => {
        if (alive) setFormats(available);
      })
      .catch(() => {
        if (alive) setError(t().saveFailed);
      });
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("beforeunload", beforeUnload);
    });
  });
  createEffect(() => {
    if (!error()) {
      setFeedbackInset(0);
      return;
    }
    const box = feedbackError;
    const surface = stage;
    if (!box || !surface) return;
    // Keep the stage and tool regions fixed while giving a long retry notice its own photo inset.
    const measure = () => setFeedbackInset(Math.max(0, box.getBoundingClientRect().bottom - surface.getBoundingClientRect().top));
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(surface);
    measure();
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    alive = false;
    generation++;
    saveAbort?.abort();
    cancelAnimationFrame(frame);
    if (canvas) canvas.width = canvas.height = 0;
    if (scratch) scratch.width = scratch.height = 0;
    pointers.clear();
  });

  const save = async (callerCommit: (result: ImageEditorResult) => Promise<void>, override?: ImageEditorOutput, reduced?: number) => {
    if (busy() || !preview()) return;
    finishText();
    finishDraft();
    const entry = currentImageEditorEntry(history());
    const current = generation;
    const abort = new AbortController();
    saveAbort = abort;
    lastSave = { commit: callerCommit, output: override };
    setBusy(true);
    setError("");
    setSaved(false);
    setSuggestedMP(undefined);
    let uploading = false;
    try {
      if (reduced !== undefined) setAcceptedMP(reduced);
      const maxMegapixels = reduced ?? acceptedMP();
      const result = await exportImageEditor(
        maxMegapixels === undefined ? props : { ...props, maxOutputMegapixels: maxMegapixels },
        entry.state,
        { ...output(), ...override },
        abort.signal,
      );
      abort.signal.throwIfAborted();
      uploading = true;
      await callerCommit(result);
      if (!alive || current !== generation || abort.signal.aborted) return;
      setHistory((h) => markImageEditorSaved(h, entry));
      setSaved(!dirty());
    } catch (failure) {
      if (!alive || current !== generation || abort.signal.aborted) return;
      if (failure instanceof ImageEditorSizeError) {
        setSuggestedMP(failure.suggestedMegapixels);
        setError(t().sizeRefused);
      } else setError(uploading && failure instanceof Error && failure.message ? failure.message : t().saveFailed);
    } finally {
      if (alive && current === generation) setBusy(false);
    }
  };
  const actions: ImageEditorSaveActions = {
    save,
    get formats() {
      return availableFormats();
    },
    get dirty() {
      return dirty();
    },
    get busy() {
      return busy() || loading();
    },
  };
  const confirmDiscard = () => prompts.confirm(t().discard, { variant: "danger" });
  const cancel = async () => {
    if (!(dirty() || inlineText()) || (await confirmDiscard())) props.onCancel?.();
  };
  const retry = () => {
    if (lastSave) void save(lastSave.commit, lastSave.output, suggestedMP());
    else setLoadAttempt((n) => n + 1);
  };
  const switchTool = (next: Tool) => {
    finishText();
    finishDraft();
    setTool(next);
    resetZoom();
  };
  const rotate = (right: boolean) => {
    change((state) => {
      const next = right ? rotateEditorRight(state) : rotateEditorRight(rotateEditorRight(rotateEditorRight(state)));
      if (cropOptions()?.locked) {
        next.cropAspectSwapped = false;
        next.crop = getInitialImageCropRect(rotatedEditorSize(preview()!.sourceSize, next), aspectFor(next));
      } else next.cropAspectSwapped = !state.cropAspectSwapped;
      return next;
    });
  };
  const setCrop = (rect: ImageCropRect) => setDraft({ ...state(), crop: rect });
  const cropKey = (event: KeyboardEvent, corner: ImageCropResizeHandle | "move") => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.key === "ArrowLeft" ? -0.01 : event.key === "ArrowRight" ? 0.01 : 0;
    const dy = event.key === "ArrowUp" ? -0.01 : event.key === "ArrowDown" ? 0.01 : 0;
    const rect = state().crop;
    setCrop(
      corner === "move" && !event.shiftKey
        ? clampImageCropRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, size(), aspect())
        : resizeImageCropFromCorner(rect, size(), aspect(), corner === "move" ? "se" : corner, dx, dy),
    );
  };
  const startCrop = (event: PointerEvent, corner: ImageCropResizeHandle | "move") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      cropDrag = undefined;
      setDraft(undefined);
      const [a, b] = [...pointers.values()];
      if (a && b) pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoom() };
      canvas?.parentElement?.setPointerCapture(event.pointerId);
      return;
    }
    (event.currentTarget as HTMLElement).focus();
    cropDrag = { id: event.pointerId, corner, x: event.clientX, y: event.clientY, rect: state().crop };
    canvas?.parentElement?.setPointerCapture(event.pointerId);
  };
  const startPointer = (event: PointerEvent) => {
    if (!canvas || !preview() || event.button !== 0 || (event.target as HTMLElement).closest("input,textarea,button")) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget && (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      stroke = undefined;
      cropDrag = undefined;
      setDraft(undefined);
      const [a, b] = [...pointers.values()];
      if (a && b) pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoom() };
      return;
    }
    if (event.altKey || !["annotate", "redact"].includes(tool())) {
      panDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: pan() };
      return;
    }
    finishText();
    finishDraft();
    const point = sourcePoint(event.clientX, event.clientY);
    if (tool() === "annotate" && markTool() === "text") {
      const index = state().annotations.findLastIndex(
        (mark) =>
          mark.tool === "text" &&
          !!mark.points[0] &&
          Math.abs(mark.points[0].x - point.x) < 0.12 &&
          Math.abs(mark.points[0].y - point.y) < 0.06,
      );
      const mark = state().annotations[index];
      setInlineText({ point: mark?.points[0] ?? point, value: mark?.text ?? "", index: index < 0 ? undefined : index });
      return;
    }
    const mark: ImageEditorAnnotation = {
      tool: tool() === "redact" ? "redact" : markTool(),
      points: [point],
      width: width(),
      color: color(),
    };
    stroke = { id: event.pointerId, mark };
    setDraft({ ...state(), annotations: [...state().annotations, mark] });
  };
  const movePointer = (event: PointerEvent) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a && b) setClampedZoom((pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, pinch.distance));
      return;
    }
    if (cropDrag?.id === event.pointerId && canvas) {
      const bounds = canvas.getBoundingClientRect();
      const drag = cropDrag;
      const dx = (event.clientX - drag.x) / bounds.width;
      const dy = (event.clientY - drag.y) / bounds.height;
      setCrop(
        drag.corner === "move"
          ? clampImageCropRect({ ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }, size(), aspect())
          : resizeImageCropFromCorner(drag.rect, size(), aspect(), drag.corner, dx, dy),
      );
    } else if (stroke?.id === event.pointerId) {
      const point = sourcePoint(event.clientX, event.clientY);
      const first = stroke.mark.points[0];
      const last = stroke.mark.points.at(-1);
      if (last && Math.hypot((last.x - point.x) * display().width, (last.y - point.y) * display().height) < 1) return;
      const points = ["pen", "highlighter"].includes(stroke.mark.tool) ? [...stroke.mark.points, point] : first ? [first, point] : [point];
      stroke.mark = { ...stroke.mark, points };
      setDraft({ ...state(), annotations: [...state().annotations.slice(0, -1), stroke.mark] });
    } else if (panDrag?.id === event.pointerId)
      setPan({ x: panDrag.origin.x + event.clientX - panDrag.x, y: panDrag.origin.y + event.clientY - panDrag.y });
  };
  const endPointer = (event: PointerEvent, canceled = false) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = undefined;
    if (cropDrag?.id === event.pointerId || stroke?.id === event.pointerId) {
      cropDrag = undefined;
      stroke = undefined;
      if (canceled) setDraft(undefined);
      else finishDraft();
    }
    if (panDrag?.id === event.pointerId) panDrag = undefined;
    if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId))
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    }
    if (event.key === "Escape") {
      setInlineText(undefined);
      setDraft(undefined);
      resetZoom();
    }
  };
  const sliderValue = (key: keyof ImageEditorAdjustments) =>
    (state().adjustments[key] - (["brightness", "contrast", "saturation"].includes(key) ? 1 : 0)) * 100;
  const sliderChange = (key: keyof ImageEditorAdjustments, value: number) =>
    updateSlider((s) => ({
      ...s,
      adjustments: { ...s.adjustments, [key]: value / 100 + (["brightness", "contrast", "saturation"].includes(key) ? 1 : 0) },
    }));
  const exportFeatures = () => (typeof props.features.export === "object" ? props.features.export : undefined);
  const sourceType = () => preview()?.sourceSize.type ?? (typeof props.source === "string" ? undefined : props.source.type);
  const losslessOutput = () =>
    output().format === "image/png" || ((!output().format || output().format === "same") && sourceType() === "image/png");
  const availableFormats = () => formats().filter((format) => !exportFeatures()?.formats || exportFeatures()?.formats?.includes(format));

  return (
    <section class={`k2b-image-editor ${props.class ?? ""}`} aria-label={t().editor} onKeyDown={keyboard} data-dirty={dirty()}>
      <header class="k2b-image-editor__header">
        <Show when={props.onCancel}>
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            {t().cancel}
          </Button>
        </Show>
        <IconButton variant="ghost" size="sm" label={t().undo} disabled={history().index === 0 && !draft()} onClick={undo}>
          <i class="ti ti-arrow-back-up" aria-hidden="true" />
        </IconButton>
        <IconButton variant="ghost" size="sm" label={t().redo} disabled={history().index >= history().entries.length - 1} onClick={redo}>
          <i class="ti ti-arrow-forward-up" aria-hidden="true" />
        </IconButton>
        <div class="k2b-image-editor__title">
          <strong>
            {t().editor}
            <Show when={dirty()}> •</Show>
          </strong>
          <span>{preview() ? `${preview()!.sourceSize.width} × ${preview()!.sourceSize.height} px` : loadError() ? "" : t().loading}</span>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label={t().compare}
          disabled={!preview()}
          aria-pressed={compare()}
          onPointerDown={() => setCompare(true)}
          onPointerUp={() => setCompare(false)}
          onPointerLeave={() => setCompare(false)}
          onPointerCancel={() => setCompare(false)}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") setCompare(true);
          }}
          onKeyUp={() => setCompare(false)}
          onBlur={() => setCompare(false)}
        >
          <i class="ti ti-layout-columns" aria-hidden="true" />
        </IconButton>
        <div class="k2b-image-editor__save">
          {props.saveActions ? (
            props.saveActions(actions)
          ) : (
            <Button
              size="sm"
              disabled={!preview() || loading() || busy()}
              loading={busy()}
              loadingLabel={t().saving}
              onClick={() =>
                void save(async (result) => {
                  await props.onSave?.(result);
                })
              }
            >
              {t().done}
            </Button>
          )}
        </div>
      </header>
      <div class="k2b-image-editor__status" aria-live="polite" aria-busy={busy()}>
        <div class="k2b-image-editor__feedback">
          <div>
            <p class="k2b-image-editor__notice">
              {t().metadata} <Show when={dimensions()?.downscaled}>{t().smaller(dimensions()!)}</Show>
            </p>
            <span>{busy() ? t().saving : saved() ? t().saved : ""}</span>
          </div>
          <Show when={error()}>
            <div class="k2b-image-editor__error" ref={feedbackError}>
              <NoticeCard role="alert" tone="danger" icon title={error()} />
              <Button size="sm" variant="secondary" disabled={busy()} onClick={retry}>
                {suggestedMP()
                  ? t().retrySmaller({
                      megapixels: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(suggestedMP() ?? 0),
                    })
                  : t().retry}
              </Button>
            </div>
          </Show>
        </div>
      </div>
      <div class="k2b-image-editor__workspace">
        <div class="k2b-image-editor__stage" ref={stage} style={{ "padding-top": `${feedbackInset()}px` }}>
          <Show
            when={preview()}
            fallback={
              <Placeholder
                state={loadError() ? "error" : "loading"}
                title={loadError() ? t().loadFailed : t().loading}
                onRetry={loadError() ? () => setLoadAttempt((n) => n + 1) : undefined}
                variant="panel"
              />
            }
          >
            <div
              class="k2b-image-editor__image"
              style={{ width: `${display().width}px`, height: `${display().height}px`, transform: `translate(${pan().x}px,${pan().y}px)` }}
              onPointerDown={startPointer}
              onPointerMove={movePointer}
              onPointerUp={(e) => endPointer(e)}
              onPointerCancel={(e) => endPointer(e, true)}
            >
              <canvas ref={canvas} aria-label={t().preview} role="img" />
              <Show when={tool() === "crop" && props.features.crop && !compare()}>
                <div
                  class="k2b-image-editor__crop"
                  style={{
                    left: `${state().crop.x * 100}%`,
                    top: `${state().crop.y * 100}%`,
                    width: `${state().crop.width * 100}%`,
                    height: `${state().crop.height * 100}%`,
                  }}
                >
                  <button
                    type="button"
                    class="k2b-image-editor__crop-move"
                    aria-label={t().moveCrop}
                    aria-describedby={helpId}
                    onPointerDown={(e) => startCrop(e, "move")}
                    onKeyDown={(e) => cropKey(e, "move")}
                    onKeyUp={finishDraft}
                    onBlur={finishDraft}
                  />
                  <For each={corners}>
                    {(corner) => (
                      <button
                        type="button"
                        class="k2b-image-editor__corner"
                        data-corner={corner}
                        aria-label={t().resizeCrop({ corner })}
                        aria-describedby={helpId}
                        onPointerDown={(e) => startCrop(e, corner)}
                        onKeyDown={(e) => cropKey(e, corner)}
                        onKeyUp={finishDraft}
                        onBlur={finishDraft}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <Show when={inlineText()}>
            {(text) => (
              <div class="k2b-image-editor__text" style={textPosition()}>
                <TextInput
                  aria-label={t().textPlaceholder}
                  placeholder={t().textPlaceholder}
                  value={text().value}
                  ref={(element) =>
                    queueMicrotask(() => {
                      element.focus({ preventScroll: true });
                      element.select();
                    })
                  }
                  onValueChange={(value) => setInlineText({ ...text(), value })}
                  onBlur={finishText}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setInlineText(undefined);
                    } else if (e.key === "Enter" && !e.isComposing) {
                      e.preventDefault();
                      finishText();
                    }
                  }}
                />
              </div>
            )}
          </Show>
          <div class="k2b-image-editor__zoom">
            <IconButton
              size="sm"
              variant="ghost"
              label={t().zoomOut}
              disabled={zoom() <= 0.5}
              onClick={() => setClampedZoom(zoom() / 1.25)}
            >
              <i class="ti ti-minus" aria-hidden="true" />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={resetZoom}>
              {t().fit}
            </Button>
            <output aria-label={t().zoom}>{Math.round(zoom() * 100)} %</output>
            <IconButton size="sm" variant="ghost" label={t().zoomIn} disabled={zoom() >= 4} onClick={() => setClampedZoom(zoom() * 1.25)}>
              <i class="ti ti-plus" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <aside class="k2b-image-editor__panel">
          <div class="k2b-image-editor__tools">
            <Select
              label={t().tool}
              options={tools().map((option) => ({ id: option.value, label: option.label, icon: option.icon }))}
              value={tool()}
              onValueChange={(value) => {
                const next = tools().find((option) => option.value === value);
                if (next) switchTool(next.value);
              }}
            />
          </div>
          <div class="k2b-image-editor__controls" aria-busy={loading()} inert={loading() || loadError()}>
            <Show when={tool() === "crop"}>
              <Show when={props.features.crop}>
                <Select
                  label={t().aspect}
                  options={aspects().map((a, index) => ({
                    id: String(index),
                    label: typeof a === "object" ? a.label : a === "free" ? t().free : a === "original" ? t().original : a,
                  }))}
                  value={String(aspectIndex())}
                  disabled={cropOptions()?.locked || !preview()}
                  onValueChange={(value) => {
                    if (value === null) return;
                    const chosen = aspects()[Number(value)];
                    if (chosen)
                      change((s) => {
                        const next = { ...s, cropAspect: chosen, cropAspectSwapped: false };
                        return { ...next, crop: getInitialImageCropRect(size(), aspectFor(next)) };
                      });
                  }}
                />
                <Show when={!cropOptions()?.locked}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!preview() || aspect() === "free"}
                    onClick={() => {
                      change((s) => {
                        const next = { ...s, cropAspectSwapped: !s.cropAspectSwapped };
                        return { ...next, crop: getInitialImageCropRect(size(), aspectFor(next)) };
                      });
                    }}
                  >
                    {t().swap}
                  </Button>
                </Show>
                <p id={helpId} class="k2b-image-editor__hint">
                  {t().cropHint}
                </p>
              </Show>
              <Show when={props.features.rotate}>
                <div class="k2b-image-editor__rotations">
                  <IconButton variant="secondary" label={t().rotateLeft} onClick={() => rotate(false)}>
                    <i class="ti ti-rotate-2" aria-hidden="true" />
                  </IconButton>
                  <IconButton variant="secondary" label={t().rotateRight} onClick={() => rotate(true)}>
                    <i class="ti ti-rotate-clockwise-2" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    variant="secondary"
                    label={t().flipX}
                    aria-pressed={state().flipX}
                    onClick={() => change((s) => ({ ...s, flipX: !s.flipX }))}
                  >
                    <i class="ti ti-flip-horizontal" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    variant="secondary"
                    label={t().flipY}
                    aria-pressed={state().flipY}
                    onClick={() => change((s) => ({ ...s, flipY: !s.flipY }))}
                  >
                    <i class="ti ti-flip-vertical" aria-hidden="true" />
                  </IconButton>
                </div>
              </Show>
              <Show when={props.features.straighten}>
                <Slider
                  label={t().straighten}
                  value={state().straighten}
                  min={-45}
                  max={45}
                  step={0.5}
                  center
                  defaultValue={0}
                  formatValue={(v) => `${v}°`}
                  onValueChange={(v) => updateSlider((s) => ({ ...s, straighten: v }))}
                  onValueCommit={finishDraft}
                />
                <p class="k2b-image-editor__hint">{t().straightenHint}</p>
              </Show>
            </Show>
            <Show when={tool() === "adjust"}>
              <For each={adjustments}>
                {(key) => (
                  <Slider
                    label={t()[key]}
                    value={sliderValue(key)}
                    min={key === "vignette" || key === "grain" ? 0 : -100}
                    max={100}
                    step={1}
                    center={key !== "vignette" && key !== "grain"}
                    defaultValue={0}
                    onValueChange={(value) => sliderChange(key, value)}
                    onValueCommit={finishDraft}
                  />
                )}
              </For>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => change((s) => ({ ...s, adjustments: initialImageEditorState().adjustments }))}
              >
                {t().resetAdjust}
              </Button>
            </Show>
            <Show when={tool() === "looks"}>
              <ChoiceTiles
                label={t().looks}
                value={state().look}
                options={lookOptions.map((look) => ({
                  value: look.value,
                  label: t()[look.label],
                  visual: <LookThumbnail image={preview()} look={look.value} />,
                }))}
                onValueChange={(look) => change((s) => ({ ...s, look }))}
              />
              <Slider
                label={t().strength}
                value={state().lookStrength * 100}
                min={0}
                max={100}
                onValueChange={(v) => updateSlider((s) => ({ ...s, lookStrength: v / 100 }))}
                onValueCommit={finishDraft}
              />
            </Show>
            <Show when={tool() === "annotate"}>
              <Select
                label={t().annotate}
                options={markTools().map((value) => ({ id: value, label: t()[value] }))}
                value={markTool()}
                onValueChange={(next) => {
                  const chosen = annotationTools.find((value) => value === next);
                  if (chosen) {
                    finishText();
                    setMarkTool(chosen);
                  }
                }}
              />
              <ColorChoices
                label={t().color}
                options={[
                  { value: "#111827", label: t().black, color: "#111827" },
                  { value: "#ef4444", label: t().red, color: "#ef4444" },
                  { value: "#f59e0b", label: t().amber, color: "#f59e0b" },
                  { value: "#22c55e", label: t().green, color: "#22c55e" },
                  { value: "#3b82f6", label: t().blue, color: "#3b82f6" },
                  { value: "#ffffff", label: t().white, color: "#ffffff" },
                ]}
                value={color()}
                onValueChange={setColor}
              />
              <Slider label={t().width} value={width()} min={1} max={30} step={1} onValueChange={setWidth} />
              <Show when={markTool() === "text"}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!preview()}
                  onClick={() => {
                    finishText();
                    setInlineText({ point: { x: 0.5, y: 0.5 }, value: "" });
                  }}
                >
                  {t().addText}
                </Button>
              </Show>
              <p class="k2b-image-editor__hint">{markTool() === "text" ? t().textHint : t().drawHint}</p>
            </Show>
            <Show when={tool() === "redact"}>
              <i class="ti ti-square-filled" aria-hidden="true" />
              <p class="k2b-image-editor__hint">{t().redactHint}</p>
            </Show>
            <Show when={tool() === "export"}>
              <Select
                label={t().format}
                options={[
                  { id: "same", label: t().same },
                  ...availableFormats().map((value) => ({
                    id: value,
                    label: value === "image/jpeg" ? "JPEG" : value === "image/png" ? "PNG" : "WebP",
                  })),
                ]}
                value={output().format ?? "same"}
                onValueChange={(format) => {
                  const selected = availableFormats().find((value) => value === format);
                  if (selected || format === "same") setOutput((v) => ({ ...v, format: selected ?? "same" }));
                }}
              />
              <Show when={exportFeatures()?.quality && !losslessOutput()}>
                <Slider
                  label={t().quality}
                  min={40}
                  max={100}
                  value={(output().quality ?? 0.9) * 100}
                  onValueChange={(v) => setOutput((o) => ({ ...o, quality: v / 100 }))}
                />
              </Show>
              <Show when={losslessOutput()}>
                <p class="k2b-image-editor__hint">{t().lossless}</p>
              </Show>
              <Show when={exportFeatures()?.resize}>
                <NumberInput
                  label={t().size}
                  value={output().maxLongEdge ?? Math.max(preview()?.sourceSize.width ?? 1, preview()?.sourceSize.height ?? 1)}
                  min={1}
                  step={1}
                  onValueChange={(value) => {
                    if (value && value > 0) setOutput((o) => ({ ...o, maxLongEdge: value }));
                  }}
                />
                <Button size="sm" variant="ghost" onClick={() => setOutput((o) => ({ ...o, maxLongEdge: undefined }))}>
                  {t().sourceSize}
                </Button>
              </Show>
              <p class="k2b-image-editor__hint">{dimensions() ? `${dimensions()!.width} × ${dimensions()!.height} px` : ""}</p>
            </Show>
          </div>
        </aside>
      </div>
    </section>
  );
}

function LookThumbnail(props: {
  image: Awaited<ReturnType<typeof loadImageEditorPreview>> | undefined;
  look: ImageEditorLook;
}): JSX.Element {
  let canvas: HTMLCanvasElement | undefined;
  let scratch: HTMLCanvasElement | undefined;
  createEffect(() => {
    const image = props.image;
    const look = props.look;
    if (!image || !canvas) return;
    scratch ??= document.createElement("canvas");
    const scale = 96 / Math.max(image.sourceSize.width, image.sourceSize.height);
    canvas.width = Math.max(1, Math.round(image.sourceSize.width * scale));
    canvas.height = Math.max(1, Math.round(image.sourceSize.height * scale));
    renderImageEditor(image.image, image.sourceSize, { ...initialImageEditorState(), look }, canvas, scratch);
  });
  onCleanup(() => {
    if (canvas) canvas.width = canvas.height = 0;
    if (scratch) scratch.width = scratch.height = 0;
  });
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      style={{ display: "block", "max-width": "4rem", "max-height": "4rem", width: "auto", height: "auto" }}
    />
  );
}
