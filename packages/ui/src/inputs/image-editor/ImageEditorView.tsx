import { onBeforeLeave, swapPage } from "@k2b/ssr/nav";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button, IconButton } from "../../actions/Button";
import { Dropdown } from "../../actions/Dropdown";
import { Kbd } from "../../content/Kbd";
import { prompts } from "../../feedback/prompts";
import { useLocale } from "../../intl/locale";
import { Slider } from "../ChoiceInputs";
import {
  clampImageCropRect,
  getInitialImageCropRect,
  type ImageCropAspect,
  type ImageCropRect,
  type ImageCropResizeHandle,
  resizeImageCropFromCorner,
} from "../image-crop";
import { NumberInput } from "../NumberInput";
import { TextInput } from "../TextInput";
import { analyzeImageEditorAuto } from "./auto";
import { imageEditorMatrix, inverseEditorPoint, transformEditorPoint } from "./geometry";
import { exportImageEditor, ImageEditorSizeError, loadImageEditorPreview, supportedImageEditorFormats } from "./image";
import {
  annotationBounds,
  annotationNumber,
  hitAnnotation,
  isRedaction,
  layerOrder,
  moveAnnotation,
  nextAnnotationId,
  placeLayer,
  scaleAnnotation,
  stepLayer,
} from "./layers";
import { type ImageEditorMessages, useImageEditorMessages } from "./messages";
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
  ImageEditorAutoAdjustments,
  ImageEditorFormat,
  ImageEditorLook,
  ImageEditorOutput,
  ImageEditorPoint,
  ImageEditorProps,
  ImageEditorResult,
  ImageEditorSaveActions,
  ImageEditorState,
} from "./types";
import {
  clampImageEditorView,
  fitImageEditorView,
  type ImageEditorInsets,
  isMouseWheel,
  sameImageEditorView,
  type ImageEditorView as View,
  zoomImageEditorView,
} from "./viewport";

type Tool = "crop" | "adjust" | "annotate";
type MarkTool = ImageEditorAnnotationTool | "redact";
type CropHandle = ImageCropResizeHandle | "n" | "e" | "s" | "w";
const fullCrop = { x: 0, y: 0, width: 1, height: 1 };
const cropHandles: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const handlePosition: Record<CropHandle, [number, number]> = {
  nw: [0, 0],
  n: [50, 0],
  ne: [100, 0],
  e: [100, 50],
  se: [100, 100],
  s: [50, 100],
  sw: [0, 100],
  w: [0, 50],
};
const defaultAspects: readonly ImageEditorAspect[] = ["free", "original", "1:1", "4:5", "3:2", "16:9"];
const annotationTools: readonly ImageEditorAnnotationTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse", "text"];
const toolIcon: Record<MarkTool, string> = {
  pen: "ti ti-pencil",
  highlighter: "ti ti-highlight",
  arrow: "ti ti-arrow-up-right",
  rect: "ti ti-square",
  ellipse: "ti ti-circle",
  text: "ti ti-typography",
  redact: "ti ti-eye-off",
};
const toolKey: Record<MarkTool, string> = { pen: "p", highlighter: "m", arrow: "a", rect: "r", ellipse: "e", text: "t", redact: "s" };
const groups = [
  { label: "light", keys: ["brightness", "contrast"] },
  { label: "colour", keys: ["saturation", "warmth"] },
  { label: "effect", keys: ["vignette", "grain"] },
] as const;
const autoKeys = ["brightness", "contrast", "saturation", "warmth"] as const;
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
const colors = [
  { value: "#ef4444", label: "red" },
  { value: "#f59e0b", label: "amber" },
  { value: "#22c55e", label: "green" },
  { value: "#3b82f6", label: "blue" },
  { value: "#111827", label: "black" },
  { value: "#ffffff", label: "white" },
] as const;
/** Stroke widths in thousandths of the long edge; text uses four times the value as its size. */
const sizes = [
  { value: 3, label: "fine", dot: 4 },
  { value: 6, label: "medium", dot: 7 },
  { value: 11, label: "bold", dot: 11 },
  { value: 18, label: "extraBold", dot: 15 },
] as const;
const PHONE_WIDTH = 640;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
/**
 * The editors whose discard was confirmed for one navigation target. Shared because each editor guards the same
 * navigation on its own; any cancelled discard prompt clears it, so a vetoed navigation leaves every edit dirty.
 */
let leavePass: { href: string; editors: Set<symbol> } | undefined;
/** Navigation attempts (by their shared `restored` promise) that an editor stopped to ask its own question. */
const editorVetoes = new WeakSet<Promise<void>>();

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const sliderValue = (key: keyof ImageEditorAdjustments, adjustments: ImageEditorAdjustments) =>
  Math.round((adjustments[key] - (["brightness", "contrast", "saturation"].includes(key) ? 1 : 0)) * 100);
const fromSlider = (key: keyof ImageEditorAdjustments, value: number) =>
  value / 100 + (["brightness", "contrast", "saturation"].includes(key) ? 1 : 0);
const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0");

/** A new source has its own history, async lifetime, and saved identity. */
export default function ImageEditorView(props: ImageEditorProps): JSX.Element {
  return (
    <Show when={props.source} keyed>
      {(source) => <ImageEditorSession {...props} source={source} />}
    </Show>
  );
}

function layerName(t: ImageEditorMessages, marks: readonly ImageEditorAnnotation[], mark: ImageEditorAnnotation) {
  if (mark.tool === "redact") return t.redaction({ n: annotationNumber(marks, mark) });
  if (mark.tool === "text") {
    const text = mark.text ?? "";
    return t.textLayer({ text: text.length > 20 ? `${text.slice(0, 19)}…` : text });
  }
  const name = t[mark.tool];
  return marks.filter((other) => other.tool === mark.tool).length > 1 ? t.numbered({ name, n: annotationNumber(marks, mark) }) : name;
}

function ImageEditorSession(props: ImageEditorProps): JSX.Element {
  const t = useImageEditorMessages();
  const locale = useLocale();
  const ids = { help: createUniqueId(), layersHelp: createUniqueId(), layersTitle: createUniqueId(), output: createUniqueId() };
  const [history, setHistory] = createSignal(createImageEditorHistory());
  const [draft, setDraft] = createSignal<ImageEditorState>();
  const state = () => draft() ?? currentImageEditorEntry(history()).state;
  const [inlineText, setInlineText] = createSignal<{
    point: ImageEditorPoint;
    value: string;
    mark?: ImageEditorAnnotation;
    index?: number;
  }>();
  const dirty = () => imageEditorDirty(history()) || draft() !== undefined || inlineText() !== undefined;
  const f = () => props.features;
  const tools = createMemo(() =>
    [
      { value: "crop" as const, label: t().crop, icon: "ti ti-crop", key: "1", enabled: !!(f().crop || f().rotate || f().straighten) },
      {
        value: "adjust" as const,
        label: t().adjust,
        icon: "ti ti-adjustments-horizontal",
        key: "2",
        enabled: !!(f().adjust || f().filters),
      },
      { value: "annotate" as const, label: t().annotate, icon: "ti ti-pencil", key: "3", enabled: !!(f().annotate || f().redact) },
    ].filter((tool) => tool.enabled),
  );
  const [tool, setTool] = createSignal<Tool>(
    untrack(() => tools().find((x) => x.value === "adjust")?.value ?? tools()[0]?.value ?? "crop"),
  );
  const markTools = createMemo((): readonly MarkTool[] => {
    const annotate = f().annotate;
    const drawing = typeof annotate === "object" ? (annotate.tools ?? annotationTools) : annotate ? annotationTools : [];
    return [...drawing, ...(f().redact ? (["redact"] as const) : [])];
  });
  const [markTool, setMarkTool] = createSignal<MarkTool>(untrack(() => markTools()[0] ?? "pen"));
  createEffect(() => {
    const available = tools();
    if (!available.some((candidate) => candidate.value === tool())) setTool(available[0]?.value ?? "crop");
    if (!markTools().includes(markTool())) setMarkTool(markTools()[0] ?? "pen");
  });
  const cropOptions = () => {
    const crop = f().crop;
    return typeof crop === "object" ? crop : undefined;
  };
  const aspects = () => {
    const configured = cropOptions()?.aspects;
    const values = configured?.length ? configured : defaultAspects;
    const initial = cropOptions()?.defaultAspect;
    return initial && !values.includes(initial) ? [initial, ...values] : values;
  };
  const aspectFor = (edit: ImageEditorState): ImageCropAspect => {
    const value = edit.cropAspect;
    const source = preview()?.sourceSize;
    if (value === "free") return "free";
    const result =
      typeof value === "object"
        ? value
        : value === "original" && source
          ? rotatedEditorSize(source, { ...edit, rotation: 0 })
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
  const [view, setView] = createSignal<View>({ zoom: 1, x: 0, y: 0 });
  const [following, setFollowing] = createSignal(true);
  const [canvasSize, setCanvasSize] = createSignal({ width: 0, height: 0 });
  const [phone, setPhone] = createSignal(false);
  const [split, setSplit] = createSignal(false);
  const [splitAt, setSplitAt] = createSignal(0.5);
  const [peek, setPeek] = createSignal(false);
  const [peekRedaction, setPeekRedaction] = createSignal<string>();
  const [selected, setSelected] = createSignal<string>();
  const [hot, setHot] = createSignal<string>();
  const [space, setSpace] = createSignal(false);
  const [panel, setPanel] = createSignal<"output" | "keys">();
  const [stripOpen, setStripOpen] = createSignal(false);
  const [phoneSetting, setPhoneSetting] = createSignal<"look" | "strength" | keyof ImageEditorAdjustments>("look");
  const [color, setColor] = createSignal<string>(colors[0].value);
  const [size, setSize] = createSignal(1);
  const [cropDragging, setCropDragging] = createSignal(false);
  let root: HTMLElement | undefined;
  let canvasArea: HTMLDivElement | undefined;
  let chipsEl: HTMLDivElement | undefined;
  let bottomEl: HTMLDivElement | undefined;
  let paneEl: HTMLElement | undefined;
  let saveEl: HTMLDivElement | undefined;
  let stripList: HTMLUListElement | undefined;
  let layersList: HTMLUListElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let beforeCanvas: HTMLCanvasElement | undefined;
  let scratch: HTMLCanvasElement | undefined;
  // A signal, because the name chip switches between label and button when the image strip appears.
  const [chipThumb, setChipThumb] = createSignal<HTMLCanvasElement>();
  let frame = 0;
  let animation = 0;
  let autoAnimation = 0;
  let autoDone: (() => void) | undefined;
  let alive = true;
  let generation = 0;
  let saveAbort: AbortController | undefined;
  let lastSave: { commit: (result: ImageEditorResult) => Promise<void>; output?: ImageEditorOutput } | undefined;
  const pointers = new Map<number, { x: number; y: number }>();
  type Gesture =
    | { kind: "pan"; id: number; x: number; y: number; view: View; moved: boolean; peekTimer?: number }
    | { kind: "pinch"; distance: number; mid: { x: number; y: number }; view: View }
    | { kind: "stroke"; id: number; mark: ImageEditorAnnotation }
    | { kind: "text"; id: number; point: ImageEditorPoint }
    | { kind: "move"; id: number; index: number; start: ImageEditorPoint; original: ImageEditorAnnotation; moved: boolean }
    | { kind: "resize"; id: number; index: number; anchor: ImageEditorPoint; start: ImageEditorPoint; original: ImageEditorAnnotation }
    | { kind: "crop"; id: number; handle: CropHandle | "move"; x: number; y: number; rect: ImageCropRect }
    | { kind: "split"; id: number };
  let gesture: Gesture | undefined;

  // ---------- history ----------
  const commit = (next: ImageEditorState) => {
    setDraft(undefined);
    setHistory((h) => commitImageEditorState(h, next));
    setSaved(false);
  };
  /** A running Auto animation lands on its result before anything else edits, saves, or reads the state. */
  const settleAuto = () => {
    const done = autoDone;
    if (!done) return;
    cancelAnimationFrame(autoAnimation);
    done();
  };
  const finishDraft = () => {
    settleAuto();
    const next = draft();
    if (next) commit(next);
  };
  const change = (update: (current: ImageEditorState) => ImageEditorState) => {
    finishText();
    finishDraft();
    commit(update(state()));
  };
  const updateDraft = (update: (current: ImageEditorState) => ImageEditorState) => {
    settleAuto();
    setDraft(update(state()));
    setSaved(false);
  };
  // Editing continues while a save runs: the save captured its own history entry, and an unresolved upload may wait
  // for a manual check indefinitely.
  const undo = () => {
    // Undo during Auto cancels it: nothing was committed yet.
    cancelAnimationFrame(autoAnimation);
    autoDone = undefined;
    setInlineText(undefined);
    setDraft(undefined);
    setHistory(undoImageEditor);
    setSaved(false);
  };
  const redo = () => {
    cancelAnimationFrame(autoAnimation);
    autoDone = undefined;
    setInlineText(undefined);
    setDraft(undefined);
    setHistory(redoImageEditor);
    setSaved(false);
  };
  const canUndo = () => history().index > 0 || !!draft();
  const canRedo = () => history().index < history().entries.length - 1;

  // ---------- geometry ----------
  const marks = () => state().annotations;
  const selectedIndex = () => {
    const id = selected();
    return id ? marks().findIndex((mark) => mark.id === id) : -1;
  };
  /** What the canvas shows: the whole photo while cropping, the original while comparing. */
  const renderedState = (): ImageEditorState => {
    const s = state();
    const shown = tool() === "crop" && f().crop ? { ...s, crop: fullCrop } : s;
    const peeking = peekRedaction();
    return peeking ? { ...shown, annotations: shown.annotations.filter((mark) => mark.id !== peeking) } : shown;
  };
  const beforeState = (): ImageEditorState => {
    const s = renderedState();
    return { ...initialImageEditorState(), crop: s.crop, rotation: s.rotation, straighten: s.straighten, flipX: s.flipX, flipY: s.flipY };
  };
  const rotated = () => (preview() ? rotatedEditorSize(preview()!.sourceSize, state()) : (props.sourceSize ?? { width: 3, height: 2 }));
  /** The shown frame in source pixels: what 100 % maps one to one. */
  const frameSize = createMemo(() => {
    const r = rotated();
    const crop = renderedState().crop;
    return { width: Math.max(1, r.width * crop.width), height: Math.max(1, r.height * crop.height) };
  });
  const matrix = () => imageEditorMatrix(preview()!.sourceSize, renderedState(), frameSize());
  const dimensions = createMemo(() => {
    const source = preview()?.sourceSize;
    return source ? editorOutputSize(source, state(), acceptedMP() ?? props.maxOutputMegapixels, output().maxLongEdge) : undefined;
  });
  const insets = (): ImageEditorInsets => {
    const area = canvasArea?.getBoundingClientRect();
    if (!area) return { top: 16, right: 16, bottom: 16, left: 16 };
    const shown = (el: Element | undefined) => !!el && (el as HTMLElement).offsetParent !== null;
    const top = shown(chipsEl) ? chipsEl!.getBoundingClientRect().bottom - area.top + 14 : 16;
    if (phone()) {
      let edge = area.bottom - 8;
      if (shown(paneEl)) edge = Math.min(edge, paneEl!.getBoundingClientRect().top);
      if (shown(bottomEl))
        for (const group of bottomEl!.querySelectorAll(".k2b-image-editor__group"))
          if ((group as HTMLElement).offsetParent) edge = Math.min(edge, group.getBoundingClientRect().top);
      return { top, right: 10, bottom: area.bottom - edge + 12, left: 10 };
    }
    return {
      top,
      right: shown(paneEl) ? area.right - paneEl!.getBoundingClientRect().left + 16 : 16,
      bottom: shown(bottomEl) ? area.bottom - bottomEl!.getBoundingClientRect().top + 14 : 16,
      left: 16,
    };
  };
  const fitView = () => fitImageEditorView(frameSize(), canvasSize(), insets());
  const clampView = (next: View) => clampImageEditorView(next, frameSize(), canvasSize());
  const animateTo = (target: View) => {
    cancelAnimationFrame(animation);
    if (reducedMotion()) return setView(target);
    const start = view();
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / 220);
      const e = 1 - (1 - k) ** 3;
      setView({
        zoom: start.zoom + (target.zoom - start.zoom) * e,
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
      });
      if (k < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  };
  const fit = (animate = true) => {
    setFollowing(true);
    if (!canvasSize().width) return;
    animate ? animateTo(fitView()) : setView(fitView());
  };
  const manual = (next: View) => {
    cancelAnimationFrame(animation);
    setFollowing(false);
    setView(clampView(next));
  };
  const zoomBy = (factor: number) => {
    const i = insets();
    const c = canvasSize();
    const at = { x: i.left + (c.width - i.left - i.right) / 2, y: i.top + (c.height - i.top - i.bottom) / 2 };
    setFollowing(false);
    animateTo(clampView(zoomImageEditorView(view(), view().zoom * factor, at)));
  };
  const zoomTo = (zoom: number) => {
    const i = insets();
    const c = canvasSize();
    const fr = frameSize();
    setFollowing(false);
    animateTo({
      zoom,
      x: i.left + (c.width - i.left - i.right - fr.width * zoom) / 2,
      y: i.top + (c.height - i.top - i.bottom - fr.height * zoom) / 2,
    });
  };
  // A new frame (tool, crop, rotation) or a resized editor refits while the view follows the fit.
  createEffect(
    on(
      () => [frameSize().width, frameSize().height, canvasSize().width, canvasSize().height, !!preview(), phone(), tool()] as const,
      () => {
        if (!canvasSize().width) return;
        queueMicrotask(() => {
          if (following() || untrack(() => !preview())) setView(fitView());
          else setView(clampView(view()));
        });
      },
    ),
  );
  /** Canvas-relative pointer position. */
  const local = (event: { clientX: number; clientY: number }) => {
    const area = canvasArea!.getBoundingClientRect();
    return { x: event.clientX - area.left, y: event.clientY - area.top };
  };
  /** Source pixels under a canvas point. */
  const sourcePixel = (p: { x: number; y: number }) =>
    inverseEditorPoint(matrix(), { x: (p.x - view().x) / view().zoom, y: (p.y - view().y) / view().zoom });
  const sourcePoint = (p: { x: number; y: number }, limit = true): ImageEditorPoint => {
    const source = preview()!.sourceSize;
    const q = sourcePixel(p);
    const x = q.x / source.width;
    const y = q.y / source.height;
    return limit ? { x: clamp(x, 0, 1), y: clamp(y, 0, 1) } : { x, y };
  };
  const insideImage = (p: { x: number; y: number }) => {
    const fr = frameSize();
    const x = (p.x - view().x) / view().zoom;
    const y = (p.y - view().y) / view().zoom;
    return x >= 0 && y >= 0 && x <= fr.width && y <= fr.height;
  };
  /** A source rectangle as percentages of the shown image element. */
  const boxOf = (mark: ImageEditorAnnotation) => {
    const image = preview();
    if (!image) return undefined;
    const b = annotationBounds(mark, image.sourceSize);
    const m = matrix();
    const corners = [
      transformEditorPoint(m, { x: b.x, y: b.y }),
      transformEditorPoint(m, { x: b.x + b.width, y: b.y }),
      transformEditorPoint(m, { x: b.x, y: b.y + b.height }),
      transformEditorPoint(m, { x: b.x + b.width, y: b.y + b.height }),
    ];
    const fr = frameSize();
    const left = Math.min(...corners.map((c) => c.x));
    const top = Math.min(...corners.map((c) => c.y));
    return {
      left: `${(left / fr.width) * 100}%`,
      top: `${(top / fr.height) * 100}%`,
      width: `${((Math.max(...corners.map((c) => c.x)) - left) / fr.width) * 100}%`,
      height: `${((Math.max(...corners.map((c) => c.y)) - top) / fr.height) * 100}%`,
    };
  };
  const textBox = () => {
    const edit = inlineText();
    const image = preview();
    if (!edit || !image) return undefined;
    const p = transformEditorPoint(matrix(), { x: edit.point.x * image.sourceSize.width, y: edit.point.y * image.sourceSize.height });
    return { left: `${(p.x / frameSize().width) * 100}%`, top: `${(p.y / frameSize().height) * 100}%` };
  };

  // ---------- inline text ----------
  function finishText() {
    const text = inlineText();
    if (!text) return;
    settleAuto();
    setInlineText(undefined);
    const next = [...state().annotations];
    if (text.index !== undefined && text.mark) {
      if (text.value.trim() === (text.mark.text ?? "")) return;
      if (text.value.trim()) next[text.index] = { ...text.mark, text: text.value.trim() };
      else next.splice(text.index, 1);
    } else if (text.value.trim())
      next.push({
        id: nextAnnotationId(next),
        tool: "text",
        points: [text.point],
        text: text.value.trim(),
        color: color(),
        width: sizes[size()]!.value * 4,
      });
    else return;
    commit({ ...state(), annotations: next });
  }
  const editText = (index: number) => {
    const mark = marks()[index];
    if (!mark || mark.tool !== "text" || !mark.points[0]) return;
    finishText();
    setSelected(undefined);
    setInlineText({ point: mark.points[0], value: mark.text ?? "", mark, index });
  };

  // ---------- loading and painting ----------
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
            setFollowing(true);
            if (history().entries.length === 1 && f().crop) {
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
  createEffect(() => props.onDirtyChange?.(dirty()));
  const paintInto = (target: HTMLCanvasElement, edit: ImageEditorState) => {
    const image = preview();
    if (!image) return;
    scratch ??= document.createElement("canvas");
    const r = rotatedEditorSize(image.sourceSize, edit);
    // The on-screen canvas stays below the 2048 px preview so each open editor holds one large bitmap.
    const scale = Math.min(1, 1600 / Math.max(r.width * edit.crop.width, r.height * edit.crop.height));
    target.width = Math.max(1, Math.round(r.width * edit.crop.width * scale));
    target.height = Math.max(1, Math.round(r.height * edit.crop.height * scale));
    renderImageEditor(image.image, image.sourceSize, edit, target, scratch);
  };
  createEffect(() => {
    const edit = renderedState();
    if (!preview() || !canvas) return;
    cancelAnimationFrame(frame);
    const paint = () => {
      if (!canvas || !alive) return;
      try {
        paintInto(canvas, edit);
      } catch {
        setError(t().loadFailed);
      }
    };
    // Gestures may coalesce, but a committed edit (including undo) must already match its visible preview.
    if (draft()) frame = requestAnimationFrame(paint);
    else paint();
  });
  createEffect(() => {
    if (!(split() || peek()) || tool() === "crop" || !beforeCanvas || !preview()) return;
    try {
      paintInto(beforeCanvas, beforeState());
    } catch {
      setError(t().loadFailed);
    }
  });
  createEffect(() => {
    const image = preview();
    const thumb = chipThumb();
    if (!image || !thumb) return;
    const side = Math.min(image.image.width, image.image.height);
    thumb.width = thumb.height = 40;
    thumb
      .getContext("2d")
      ?.drawImage(image.image, (image.image.width - side) / 2, (image.image.height - side) / 2, side, side, 0, 0, 40, 40);
  });

  // ---------- guards, sizes, cleanup ----------
  const beforeUnload = (event: BeforeUnloadEvent) => {
    // A confirmed navigation may still end in a document load; it must not ask a second time.
    if (dirty() && !leavePass?.editors.has(leaveKey)) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  // A confirmed discard lets this editor pass the retried navigation without touching its history: if another
  // editor's prompt is cancelled, every editor stays dirty and asks again next time.
  const leaveKey = Symbol("image-editor");
  const passes = (href: string) => leavePass?.href === href && leavePass.editors.has(leaveKey);
  createEffect(on([history, draft, inlineText], () => leavePass?.editors.delete(leaveKey), { defer: true }));
  onBeforeLeave((event) => {
    const href = event.url.href;
    if (!dirty()) return;
    if (passes(href)) {
      // `restored` resolves only when a later check vetoes. Another editor's question keeps this consent for the
      // retry; any other veto ends the attempt, so the next navigation asks again.
      void event.restored.then(() => {
        if (!editorVetoes.has(event.restored)) leavePass = undefined;
      });
      return;
    }
    editorVetoes.add(event.restored);
    event.preventDefault();
    void event.restored.then(async () => {
      if (!alive) return;
      if (!(await confirmDiscard())) {
        leavePass = undefined;
        return;
      }
      if (!alive) return;
      if (leavePass?.href !== href) leavePass = { href, editors: new Set() };
      leavePass.editors.add(leaveKey);
      if (event.delta !== undefined && event.delta < 0) window.history.go(event.delta);
      else void swapPage(href);
    });
  });
  onCleanup(() => leavePass?.editors.delete(leaveKey));
  onMount(() => {
    window.addEventListener("beforeunload", beforeUnload);
    const measure = () => {
      if (!canvasArea || !root) return;
      setCanvasSize({ width: canvasArea.clientWidth, height: canvasArea.clientHeight });
      setPhone(root.clientWidth <= PHONE_WIDTH);
      if (paneEl) root.style.setProperty("--k2b-image-editor-sheet", `${paneEl.offsetHeight}px`);
      if (saveEl) {
        root.style.setProperty("--k2b-image-editor-save", `${saveEl.offsetHeight}px`);
        root.style.setProperty("--k2b-image-editor-save-width", `${saveEl.offsetWidth}px`);
      }
    };
    const observer = new ResizeObserver(measure);
    for (const el of [root, paneEl, saveEl]) if (el) observer.observe(el);
    measure();
    void supportedImageEditorFormats()
      .then((available) => {
        if (alive) setFormats(available);
      })
      .catch(() => {
        if (alive) setError(t().saveFailed);
      });
    const releaseSpace = (event: KeyboardEvent) => {
      if (event.key === " ") setSpace(false);
      if (event.key.toLowerCase() === "o") setPeek(false);
    };
    const blur = () => {
      setSpace(false);
      setPeek(false);
      setPeekRedaction(undefined);
    };
    window.addEventListener("keyup", releaseSpace);
    window.addEventListener("blur", blur);
    window.addEventListener("pointerup", blur);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keyup", releaseSpace);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointerup", blur);
    });
  });
  onCleanup(() => {
    alive = false;
    generation++;
    saveAbort?.abort();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(animation);
    cancelAnimationFrame(autoAnimation);
    for (const target of [canvas, beforeCanvas, scratch, chipThumb()]) if (target) target.width = target.height = 0;
    pointers.clear();
  });

  // ---------- saving ----------
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
  const exportFeatures = () => {
    const options = f().export;
    return typeof options === "object" ? options : undefined;
  };
  const availableFormats = () => formats().filter((format) => !exportFeatures()?.formats || exportFeatures()?.formats?.includes(format));
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
    if (!dirty() || (await confirmDiscard())) props.onCancel?.();
  };
  const retry = () => {
    if (lastSave) void save(lastSave.commit, lastSave.output, suggestedMP());
    else setLoadAttempt((n) => n + 1);
  };
  const sourceType = () => preview()?.sourceSize.type ?? (typeof props.source === "string" ? undefined : props.source.type);
  const losslessOutput = () =>
    output().format === "image/png" || ((!output().format || output().format === "same") && sourceType() === "image/png");
  const formatName = (type: string | undefined) =>
    type === "image/png"
      ? "PNG"
      : type === "image/webp"
        ? "WebP"
        : type === "image/jpeg"
          ? "JPEG"
          : (type?.split("/")[1]?.toUpperCase() ?? "");
  const outputFormatName = () => formatName(!output().format || output().format === "same" ? sourceType() : output().format);
  const title = () => props.title ?? (props.source instanceof File ? props.source.name : "");
  const bytes = () => {
    const n = props.source instanceof Blob ? props.source.size : 0;
    if (!n) return "";
    const nf = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });
    return n >= 1_000_000 ? `${nf.format(n / 1_000_000)} MB` : `${nf.format(Math.max(1, Math.round(n / 1000)))} KB`;
  };
  const px = (width: number, height: number) => `${Math.round(width)} × ${Math.round(height)} px`;

  // ---------- tools ----------
  const switchTool = (next: Tool) => {
    if (next === tool()) return;
    finishText();
    finishDraft();
    setSelected(undefined);
    setFollowing(true);
    setTool(next);
  };
  const rotate = (right: boolean) => {
    change((s) => {
      const next = right ? rotateEditorRight(s) : rotateEditorRight(rotateEditorRight(rotateEditorRight(s)));
      if (cropOptions()?.locked) {
        next.cropAspectSwapped = false;
        next.crop = getInitialImageCropRect(rotatedEditorSize(preview()!.sourceSize, next), aspectFor(next));
      } else next.cropAspectSwapped = !s.cropAspectSwapped;
      return next;
    });
  };
  const chooseAspect = (chosen: ImageEditorAspect) =>
    change((s) => {
      const next = { ...s, cropAspect: chosen, cropAspectSwapped: false };
      return { ...next, crop: getInitialImageCropRect(rotated(), aspectFor(next)) };
    });
  const cropChanged = () => {
    const s = state();
    return (
      s.crop.x !== 0 ||
      s.crop.y !== 0 ||
      s.crop.width !== 1 ||
      s.crop.height !== 1 ||
      s.rotation !== 0 ||
      s.straighten !== 0 ||
      s.flipX ||
      s.flipY
    );
  };
  const resetCrop = () =>
    change((s) => {
      let next: ImageEditorState = { ...s };
      while (next.rotation !== 0) next = rotateEditorRight(next);
      return { ...next, crop: fullCrop, straighten: 0, flipX: false, flipY: false, cropAspect: "free", cropAspectSwapped: false };
    });
  const resizeCrop = (rect: ImageCropRect, handle: CropHandle, dx: number, dy: number) => {
    const corner: ImageCropResizeHandle = handle === "n" || handle === "w" ? "nw" : handle === "s" || handle === "e" ? "se" : handle;
    const mx = handle === "n" || handle === "s" ? 0 : dx;
    const my = handle === "e" || handle === "w" ? 0 : dy;
    return resizeImageCropFromCorner(rect, rotated(), aspect(), corner, mx, my);
  };
  const cropKey = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.key === "ArrowLeft" ? -0.01 : event.key === "ArrowRight" ? 0.01 : 0;
    const dy = event.key === "ArrowUp" ? -0.01 : event.key === "ArrowDown" ? 0.01 : 0;
    const rect = state().crop;
    updateDraft((s) => ({
      ...s,
      crop: event.shiftKey
        ? resizeCrop(rect, "se", dx, dy)
        : clampImageCropRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, rotated(), aspect()),
    }));
  };

  // ---------- adjust and auto ----------
  const adjust = (key: keyof ImageEditorAdjustments, value: number) =>
    updateDraft((s) => ({ ...s, adjustments: { ...s.adjustments, [key]: fromSlider(key, value) } }));
  const isAuto = (key: keyof ImageEditorAdjustments) => {
    const auto = state().auto as Record<string, number | undefined> | undefined;
    return auto?.[key] !== undefined && Math.abs((auto[key] ?? 0) - state().adjustments[key]) < 0.0005;
  };
  const anyAuto = () => autoKeys.some(isAuto);
  const runAuto = () => {
    const image = preview();
    if (!image) return;
    finishText();
    finishDraft();
    cancelAnimationFrame(autoAnimation);
    const base = state();
    const target: ImageEditorAutoAdjustments = analyzeImageEditorAuto(image.image, image.sourceSize, base);
    const done = () => {
      autoDone = undefined;
      commit({ ...base, adjustments: { ...base.adjustments, ...target }, auto: target });
    };
    if (reducedMotion()) return done();
    autoDone = done;
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / 450);
      const e = 1 - (1 - k) ** 3;
      const adjustments = { ...base.adjustments };
      for (const key of autoKeys) {
        const to = target[key];
        if (to !== undefined) adjustments[key] = base.adjustments[key] + (to - base.adjustments[key]) * e;
      }
      setDraft({ ...base, adjustments });
      if (k < 1) autoAnimation = requestAnimationFrame(step);
      else done();
    };
    autoAnimation = requestAnimationFrame(step);
  };
  const adjustChanged = () =>
    state().look !== "original" || JSON.stringify(state().adjustments) !== JSON.stringify(initialImageEditorState().adjustments);

  // ---------- layers ----------
  const strokeFor = () => sizes[size()]!.value;
  const selectedMark = () => marks()[selectedIndex()];
  const styleTarget = () => {
    const mark = selectedMark();
    return mark && !isRedaction(mark) ? mark : undefined;
  };
  const currentColor = () => styleTarget()?.color ?? color();
  const currentSize = () => {
    const mark = styleTarget();
    if (!mark) return size();
    const width = mark.tool === "text" ? mark.width / 4 : mark.width;
    return sizes.findIndex((option) => Math.abs(option.value - width) < 0.01);
  };
  const styleOff = () => (selectedMark() ? isRedaction(selectedMark()!) : markTool() === "redact");
  const replaceMark = (index: number, mark: ImageEditorAnnotation) => {
    const next = [...marks()];
    next[index] = mark;
    return { ...state(), annotations: next };
  };
  const chooseColor = (value: string) => {
    setColor(value);
    const index = selectedIndex();
    const mark = styleTarget();
    if (mark) change(() => replaceMark(index, { ...mark, color: value }));
  };
  const chooseSize = (value: number) => {
    setSize(value);
    const index = selectedIndex();
    const mark = styleTarget();
    const width = sizes[value]!.value;
    if (mark) change(() => replaceMark(index, { ...mark, width: mark.tool === "text" ? width * 4 : width }));
  };
  const say = (message: string) => {
    const live = root?.querySelector<HTMLElement>(".k2b-image-editor__live");
    if (!live) return;
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = message));
  };
  const nameOf = (mark: ImageEditorAnnotation) => layerName(t(), marks(), mark);
  const toggleHidden = (index: number) => {
    const mark = marks()[index];
    if (!mark || isRedaction(mark)) return;
    if (!mark.hidden && selected() === mark.id) setSelected(undefined);
    change(() => replaceMark(index, { ...mark, hidden: !mark.hidden }));
  };
  const deleteLayer = (index: number) => {
    const mark = marks()[index];
    if (!mark) return;
    const order = layerOrder(marks());
    const neighbour = marks()[order[order.indexOf(index) + 1] ?? order[order.indexOf(index) - 1] ?? -1];
    if (selected() === mark.id) setSelected(undefined);
    const name = nameOf(mark);
    change((s) => ({ ...s, annotations: s.annotations.filter((_, i) => i !== index) }));
    say(name);
    return neighbour?.id;
  };
  const focusLayer = (id: string | undefined) =>
    queueMicrotask(() =>
      (id ? layersList?.querySelector<HTMLElement>(`[data-layer="${id}"] .k2b-image-editor__layer-main`) : undefined)?.focus(),
    );
  const moveLayer = (index: number, direction: 1 | -1) => {
    const mark = marks()[index];
    if (!mark) return;
    const next = stepLayer(marks(), index, direction);
    if (next === marks()) return say(isRedaction(mark) && direction < 0 ? t().layerTop : t().layerEdge);
    change((s) => ({ ...s, annotations: next }));
    const group = layerOrder(next).filter((i) => isRedaction(next[i]!) === isRedaction(mark));
    say(t().layerPlace({ name: nameOf(mark), place: group.findIndex((i) => next[i]?.id === mark.id) + 1, total: group.length }));
    focusLayer(mark.id);
  };
  const layerKeys = (event: KeyboardEvent, index: number) => {
    const rows = [...(layersList?.querySelectorAll<HTMLElement>(".k2b-image-editor__layer-main") ?? [])];
    const at = rows.indexOf(event.currentTarget as HTMLElement);
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      moveLayer(index, event.key === "ArrowUp" ? 1 : -1);
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const to =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : clamp(at + (event.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1);
      rows[to]?.focus();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      focusLayer(deleteLayer(index));
    }
  };
  const dragLayer = (event: PointerEvent, index: number) => {
    if (event.button !== 0) return;
    const grip = event.currentTarget as HTMLElement;
    const row = grip.closest<HTMLElement>(".k2b-image-editor__layer");
    const mark = marks()[index];
    if (!row || !mark || !layersList) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const group = isRedaction(mark) ? "redact" : "mark";
    const rows = [...layersList.querySelectorAll<HTMLElement>(`.k2b-image-editor__layer[data-group="${group}"]`)];
    const from = rows.indexOf(row);
    const middles = rows.map((r) => r.getBoundingClientRect().top + r.offsetHeight / 2);
    const height = row.offsetHeight + 2;
    const startY = event.clientY;
    let to = from;
    row.dataset.dragging = "";
    const move = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      const y = (middles[from] ?? 0) + dy;
      to = middles.filter((m, k) => k !== from && m < y).length;
      rows.forEach((r, k) => {
        if (r === row) return;
        const shift = from < to && k > from && k <= to ? -height : from > to && k < from && k >= to ? height : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      for (const r of rows) r.style.transform = "";
      delete row.dataset.dragging;
      if (to !== from) {
        const next = placeLayer(marks(), index, to);
        change((s) => ({ ...s, annotations: next }));
        say(t().layerPlace({ name: nameOf(mark), place: to + 1, total: rows.length }));
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  const hotMark = () => {
    const id = hot();
    return id ? marks().find((mark) => mark.id === id && mark.id !== selected() && !mark.hidden) : undefined;
  };
  const hiddenCount = () => marks().filter((mark) => mark.hidden).length;
  const hasRedactions = () => marks().some(isRedaction);

  // ---------- canvas pointers ----------
  const annotating = () => tool() === "annotate" && !!preview();
  /** A second finger cancels the one-finger edit in progress (stroke, move, resize, crop) and pinches the view. */
  const startPinch = () => {
    if (gesture?.kind === "pan") clearTimeout(gesture.peekTimer);
    else if (gesture && gesture.kind !== "pinch") setDraft(undefined);
    setCropDragging(false);
    const [a, b] = [...pointers.values()];
    if (a && b)
      gesture = {
        kind: "pinch",
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: view(),
      };
  };
  const startPointer = (event: PointerEvent) => {
    if (!preview() || loadError() || (event.target as HTMLElement).closest("button,input,textarea,[role=slider]")) return;
    const p = local(event);
    pointers.set(event.pointerId, p);
    canvasArea!.setPointerCapture(event.pointerId);
    canvasArea!.focus({ preventScroll: true });
    if (pointers.size === 2) return startPinch();
    const inside = insideImage(p);
    if (event.button === 0 && annotating() && !space() && inside) {
      finishText();
      finishDraft();
      const image = preview()!;
      const index = hitAnnotation(marks(), sourcePixel(p), 10 / view().zoom, image.sourceSize);
      const mark = marks()[index];
      if (mark?.id) {
        setSelected(mark.id);
        gesture = { kind: "move", id: event.pointerId, index, start: sourcePoint(p, false), original: mark, moved: false };
        return;
      }
      if (selected()) {
        setSelected(undefined);
        gesture = undefined;
        return;
      }
      const point = sourcePoint(p);
      if (markTool() === "text") {
        gesture = { kind: "text", id: event.pointerId, point };
        return;
      }
      const stroke: ImageEditorAnnotation = {
        id: nextAnnotationId(marks()),
        tool: markTool(),
        points: [point],
        width: markTool() === "redact" ? 6 : strokeFor(),
        color: color(),
      };
      gesture = { kind: "stroke", id: event.pointerId, mark: stroke };
      setDraft({ ...state(), annotations: [...state().annotations, stroke] });
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    const pan: Gesture = { kind: "pan", id: event.pointerId, x: p.x, y: p.y, view: view(), moved: false };
    if (event.pointerType === "touch" && inside && tool() === "adjust")
      pan.peekTimer = window.setTimeout(() => {
        if (gesture === pan && !pan.moved) setPeek(true);
      }, 380);
    gesture = pan;
    canvasArea!.dataset.panning = "";
  };
  const movePointer = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const p = local(event);
    pointers.set(event.pointerId, p);
    const g = gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const zoom = (g.view.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, g.distance);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomImageEditorView(g.view, zoom, g.mid);
      manual({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y });
    } else if (g.id !== event.pointerId) return;
    else if (g.kind === "pan") {
      if (Math.hypot(p.x - g.x, p.y - g.y) > 4) {
        g.moved = true;
        clearTimeout(g.peekTimer);
      }
      if (!peek()) manual({ ...g.view, x: g.view.x + p.x - g.x, y: g.view.y + p.y - g.y });
    } else if (g.kind === "stroke") {
      const point = sourcePoint(p);
      const first = g.mark.points[0];
      const last = g.mark.points.at(-1);
      if (last && Math.hypot((last.x - point.x) * frameSize().width, (last.y - point.y) * frameSize().height) * view().zoom < 1.5) return;
      g.mark = {
        ...g.mark,
        points: ["pen", "highlighter"].includes(g.mark.tool) ? [...g.mark.points, point] : first ? [first, point] : [point],
      };
      setDraft({ ...state(), annotations: [...currentImageEditorEntry(history()).state.annotations, g.mark] });
    } else if (g.kind === "move") {
      const q = sourcePoint(p, false);
      if (!g.moved && Math.hypot(q.x - g.start.x, q.y - g.start.y) * Math.max(frameSize().width, frameSize().height) * view().zoom < 3)
        return;
      g.moved = true;
      const base = currentImageEditorEntry(history()).state;
      const next = [...base.annotations];
      next[g.index] = moveAnnotation(g.original, q.x - g.start.x, q.y - g.start.y);
      setDraft({ ...base, annotations: next });
    } else if (g.kind === "resize") {
      const image = preview()!;
      const q = sourcePixel(p);
      let fx = Math.max(0.05, (q.x - g.anchor.x) / (g.start.x - g.anchor.x || 1));
      let fy = Math.max(0.05, (q.y - g.anchor.y) / (g.start.y - g.anchor.y || 1));
      if (event.shiftKey || g.original.tool === "text") fx = fy = Math.max(fx, fy);
      const base = currentImageEditorEntry(history()).state;
      const next = [...base.annotations];
      next[g.index] = scaleAnnotation(g.original, g.anchor, fx, fy, image.sourceSize);
      setDraft({ ...base, annotations: next });
    } else if (g.kind === "crop") {
      const bounds = (event.currentTarget as HTMLElement).querySelector(".k2b-image-editor__image")?.getBoundingClientRect();
      if (!bounds) return;
      const dx = (event.clientX - g.x) / bounds.width;
      const dy = (event.clientY - g.y) / bounds.height;
      updateDraft((s) => ({
        ...s,
        crop:
          g.handle === "move"
            ? clampImageCropRect({ ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy }, rotated(), aspect())
            : resizeCrop(g.rect, g.handle, dx, dy),
      }));
    } else if (g.kind === "split") {
      setSplitAt(clamp((p.x - view().x) / (frameSize().width * view().zoom), 0, 1));
    }
  };
  const endPointer = (event: PointerEvent, canceled = false) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    const g = gesture;
    if (canvasArea?.hasPointerCapture(event.pointerId)) canvasArea.releasePointerCapture(event.pointerId);
    if (!g) return;
    if (g.kind === "pinch") {
      if (pointers.size < 2) gesture = undefined;
      return;
    }
    if (g.id !== event.pointerId) return;
    gesture = undefined;
    if (g.kind === "pan") {
      clearTimeout(g.peekTimer);
      setPeek(false);
      delete canvasArea?.dataset.panning;
    } else if (g.kind === "text") {
      if (!canceled) setInlineText({ point: g.point, value: "" });
    } else if (g.kind === "stroke") {
      const fr = frameSize();
      const first = g.mark.points[0];
      const last = g.mark.points.at(-1);
      const length = first && last ? Math.hypot((last.x - first.x) * fr.width, (last.y - first.y) * fr.height) * view().zoom : 0;
      if (canceled || (g.mark.tool !== "pen" && g.mark.tool !== "highlighter" && length < 6)) setDraft(undefined);
      else finishDraft();
    } else if (g.kind === "move" || g.kind === "resize" || g.kind === "crop") {
      setCropDragging(false);
      if (canceled) setDraft(undefined);
      else finishDraft();
    }
  };
  const startCrop = (event: PointerEvent, handle: CropHandle | "move") => {
    if (event.button !== 0 || space()) return;
    event.stopPropagation();
    event.preventDefault();
    const p = local(event);
    pointers.set(event.pointerId, p);
    canvasArea!.setPointerCapture(event.pointerId);
    // A second finger on the crop turns the gesture into a pinch of the view, as anywhere on the canvas.
    if (pointers.size === 2) return startPinch();
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    setCropDragging(true);
    gesture = { kind: "crop", id: event.pointerId, handle, x: event.clientX, y: event.clientY, rect: state().crop };
  };
  const startResize = (event: PointerEvent, corner: ImageCropResizeHandle) => {
    const index = selectedIndex();
    const mark = marks()[index];
    const image = preview();
    if (event.button !== 0 || !mark || !image) return;
    event.stopPropagation();
    event.preventDefault();
    const p = local(event);
    pointers.set(event.pointerId, p);
    canvasArea!.setPointerCapture(event.pointerId);
    const b = annotationBounds(mark, image.sourceSize);
    const anchor = { x: corner.includes("w") ? b.x + b.width : b.x, y: corner.includes("n") ? b.y + b.height : b.y };
    gesture = { kind: "resize", id: event.pointerId, index, anchor, start: sourcePixel(p), original: mark };
  };
  const startSplit = (event: PointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    pointers.set(event.pointerId, local(event));
    canvasArea!.setPointerCapture(event.pointerId);
    gesture = { kind: "split", id: event.pointerId };
  };
  const wheel = (event: WheelEvent) => {
    if (!preview()) return;
    event.preventDefault();
    const p = local(event);
    if (event.ctrlKey || event.metaKey) manual(zoomImageEditorView(view(), view().zoom * Math.exp(-event.deltaY * 0.01), p));
    else if (isMouseWheel(event)) manual(zoomImageEditorView(view(), view().zoom * Math.exp(-Math.sign(event.deltaY) * 0.2), p));
    else manual({ ...view(), x: view().x - event.deltaX, y: view().y - event.deltaY });
  };
  const doubleClick = (event: MouseEvent) => {
    if (!preview()) return;
    const p = local(event);
    if (annotating()) {
      const index = hitAnnotation(marks(), sourcePixel(p), 10 / view().zoom, preview()!.sourceSize);
      if (marks()[index]?.tool === "text") editText(index);
      return;
    }
    if (sameImageEditorView(view(), fitView())) {
      setFollowing(false);
      animateTo(clampView(zoomImageEditorView(view(), 1, p)));
    } else fit();
  };

  // ---------- keyboard ----------
  const keyboard = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input:not([type=range]),textarea,[contenteditable=true]")) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === "Escape") {
      if (panel()) {
        event.stopPropagation();
        setPanel(undefined);
      } else if (selected()) {
        event.stopPropagation();
        setSelected(undefined);
      } else if (draft()) setDraft(undefined);
      return;
    }
    if (mod || event.altKey) return;
    if (target.closest(".k2b-image-editor__output, .k2b-image-editor__keys")) return;
    const onSlider = target.matches("input[type=range],[role=slider]");
    if (event.key === " " && !onSlider && !target.closest("button")) {
      event.preventDefault();
      setSpace(true);
      return;
    }
    if (event.shiftKey && event.code === "Digit1") return void (event.preventDefault(), fit());
    if (event.shiftKey && event.code === "Digit0") return void (event.preventDefault(), zoomTo(1));
    if (!event.shiftKey && /^Digit[1-3]$/.test(event.code) && !onSlider) {
      const next = tools().find((option) => option.key === event.code.slice(5));
      if (next) switchTool(next.value);
      return;
    }
    if (event.key === "+" || event.key === "=") return zoomBy(1.25);
    if (event.key === "-") return zoomBy(0.8);
    if (event.key === "?") return void setPanel((open) => (open === "keys" ? undefined : "keys"));
    if (key === "o" && !event.repeat && tool() !== "crop") {
      if (event.shiftKey) setSplit((on) => !on);
      else setPeek(true);
      return;
    }
    if (key === "a" && event.shiftKey && tool() === "adjust") return runAuto();
    if (tool() === "annotate") {
      const mark = selectedMark();
      if (mark && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteLayer(selectedIndex());
        return;
      }
      if (mark && event.key === "Enter" && mark.tool === "text") return editText(selectedIndex());
      if (mark && target === canvasArea && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = (event.shiftKey ? 10 : 1) / view().zoom;
        const image = preview()!;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key] ?? [0, 0];
        const q0 = sourcePixel({ x: view().x, y: view().y });
        const q1 = sourcePixel({ x: view().x + (d[0] ?? 0) * view().zoom, y: view().y + (d[1] ?? 0) * view().zoom });
        change(() =>
          replaceMark(
            selectedIndex(),
            moveAnnotation(mark, (q1.x - q0.x) / image.sourceSize.width, (q1.y - q0.y) / image.sourceSize.height),
          ),
        );
        return;
      }
      const chosen = markTools().find((option) => toolKey[option] === key);
      if (chosen && !event.shiftKey) {
        setMarkTool(chosen);
        setSelected(undefined);
        return;
      }
    }
    if (key === "r" && tool() === "crop" && f().rotate && !onSlider) return rotate(!event.shiftKey);
    if (event.key === "[" || event.key === "]") return void setSize((n) => clamp(n + (event.key === "]" ? 1 : -1), 0, sizes.length - 1));
    if (target === canvasArea && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const step = event.shiftKey ? 240 : 48;
      const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key] ?? [0, 0];
      manual({ ...view(), x: view().x + (d[0] ?? 0), y: view().y + (d[1] ?? 0) });
    }
  };

  // ---------- notes ----------
  const note = createMemo((): { tone?: "danger" | "warning"; icon: string; text: string; action?: boolean } | undefined => {
    if (error()) return { tone: "danger", icon: "ti ti-alert-circle", text: error(), action: true };
    if (props.notice) return { icon: "ti ti-lock", text: props.notice };
    const d = dimensions();
    if (d?.downscaled) return { tone: "warning", icon: "ti ti-info-circle", text: t().reduced(d) };
    if (props.redactionNotice && hasRedactions()) return { tone: "warning", icon: "ti ti-alert-triangle", text: props.redactionNotice };
    if (hiddenCount()) return { tone: "warning", icon: "ti ti-eye-off", text: t().hiddenNotice({ count: hiddenCount() }) };
    return f().export ? { icon: "ti ti-map-pin-off", text: t().metadata } : undefined;
  });
  const itemCount = () => props.items?.length ?? 0;
  const showStrip = () => itemCount() > 1 || (itemCount() > 0 && !!props.onAddItems);
  const position = () => {
    const index = props.items?.findIndex((item) => item.id === props.currentItem) ?? -1;
    return itemCount() > 1 && index >= 0 ? `${index + 1}/${itemCount()}` : "";
  };
  createEffect(
    on(
      () => [props.currentItem, stripOpen(), itemCount()] as const,
      () =>
        queueMicrotask(() => {
          const list = stripList;
          const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
          if (!list || !current) return;
          list.style.scrollBehavior = "auto";
          list.scrollLeft = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
          list.style.scrollBehavior = "";
          stripFade();
        }),
    ),
  );
  const stripFade = () => {
    const list = stripList;
    if (!list) return;
    list.dataset.fade =
      `${list.scrollLeft > 1 ? "start " : ""}${list.scrollLeft + list.clientWidth < list.scrollWidth - 1 ? "end" : ""}`.trim();
  };
  const stripKeys = (event: KeyboardEvent) => {
    const items = [...(stripList?.querySelectorAll<HTMLElement>(".k2b-image-editor__thumb") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to = { ArrowRight: Math.min(items.length - 1, at + 1), ArrowLeft: Math.max(0, at - 1), Home: 0, End: items.length - 1 }[
      event.key
    ];
    if (to === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    items.forEach((item, k) => (item.tabIndex = k === to ? 0 : -1));
    const target = items[to]!;
    target.focus({ preventScroll: true });
    const list = stripList!;
    if (target.offsetLeft < list.scrollLeft + 48) list.scrollLeft = target.offsetLeft - 48;
    else if (target.offsetLeft + target.offsetWidth > list.scrollLeft + list.clientWidth - 48)
      list.scrollLeft = target.offsetLeft + target.offsetWidth - list.clientWidth + 48;
  };

  const tip = (label: string, keys?: string) => (
    <span class="k2b-image-editor__tip">
      {label}
      <Show when={keys}>{(k) => <Kbd keys={k()} />}</Show>
    </span>
  );
  const cropAspectLabel = (value: ImageEditorAspect) =>
    typeof value === "object" ? value.label : value === "free" ? t().free : value === "original" ? t().original : value;
  const aspectGlyph = (value: ImageEditorAspect) => {
    if (value === "free") return { width: "16px", height: "12px", free: true };
    const ratio = (() => {
      if (typeof value === "object") return value.width / value.height;
      if (value === "original") return preview() ? preview()!.sourceSize.width / preview()!.sourceSize.height : 1.5;
      const [w, h] = value.split(":").map(Number);
      return (w ?? 1) / (h ?? 1);
    })();
    return { width: `${ratio >= 1 ? 18 : 18 * ratio}px`, height: `${ratio >= 1 ? 18 / ratio : 18}px`, free: false };
  };
  const stateName = () => (loadError() ? "error" : loading() ? "loading" : busy() ? "saving" : "ready");

  return (
    <section
      ref={root}
      class={`k2b-image-editor ${props.class ?? ""}`}
      aria-label={t().editor}
      onKeyDown={keyboard}
      data-dirty={dirty()}
      data-tool={tool()}
      data-state={stateName()}
      data-phone={phone() ? "" : undefined}
    >
      <div
        ref={canvasArea}
        class="k2b-image-editor__canvas"
        tabindex="0"
        role="application"
        aria-roledescription={t().preview}
        aria-label={t().canvas}
        aria-busy={loading()}
        data-pan={space() || tool() !== "annotate" ? "" : undefined}
        data-draw={!space() && tool() === "annotate" ? (markTool() === "text" ? "text" : "draw") : undefined}
        onPointerDown={startPointer}
        onPointerMove={movePointer}
        onPointerUp={(e) => endPointer(e)}
        onPointerCancel={(e) => endPointer(e, true)}
        onWheel={wheel}
        onDblClick={doubleClick}
      >
        <div class="k2b-image-editor__dots" style={{ "background-position": `${view().x}px ${view().y}px` }} aria-hidden="true" />
        <Show when={loading() && !loadError()}>
          <div
            class="k2b-image-editor__placeholder"
            style={{
              left: `${view().x}px`,
              top: `${view().y}px`,
              width: `${frameSize().width * view().zoom}px`,
              height: `${frameSize().height * view().zoom}px`,
            }}
          >
            <span class="k2b-image-editor__tag" role="status">
              {t().loading}
            </span>
          </div>
        </Show>
        <Show when={preview()}>
          <div
            class="k2b-image-editor__image"
            style={{
              left: `${view().x}px`,
              top: `${view().y}px`,
              width: `${frameSize().width * view().zoom}px`,
              height: `${frameSize().height * view().zoom}px`,
            }}
          >
            <canvas ref={canvas} aria-label={t().preview} role="img" />
            <Show when={(split() || peek()) && tool() !== "crop"}>
              <canvas
                ref={beforeCanvas}
                class="k2b-image-editor__before"
                aria-hidden="true"
                style={{ "clip-path": peek() ? "none" : `inset(0 ${(1 - splitAt()) * 100}% 0 0)` }}
              />
            </Show>
            <Show when={split() && !peek() && tool() !== "crop"}>
              <div class="k2b-image-editor__split" style={{ left: `${splitAt() * 100}%` }}>
                <span class="k2b-image-editor__tag" data-side="before">
                  {t().before}
                </span>
                <span class="k2b-image-editor__tag" data-side="after">
                  {t().after}
                </span>
                <button
                  type="button"
                  class="k2b-image-editor__split-grip"
                  role="slider"
                  aria-label={t().splitHandle}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(splitAt() * 100)}
                  onPointerDown={startSplit}
                  onKeyDown={(e) => {
                    const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                    if (!d) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setSplitAt((v) => clamp(v + d * (e.shiftKey ? 0.1 : 0.02), 0, 1));
                  }}
                >
                  <i class="ti ti-arrows-horizontal" aria-hidden="true" />
                </button>
              </div>
            </Show>
            <Show when={peek() && tool() !== "crop"}>
              <span class="k2b-image-editor__tag k2b-image-editor__peek">
                <i class="ti ti-eye" aria-hidden="true" />
                {t().before}
              </span>
            </Show>
            <Show when={tool() === "crop" && f().crop}>
              <div
                class="k2b-image-editor__crop"
                data-dragging={cropDragging() ? "" : undefined}
                style={{
                  left: `${state().crop.x * 100}%`,
                  top: `${state().crop.y * 100}%`,
                  width: `${state().crop.width * 100}%`,
                  height: `${state().crop.height * 100}%`,
                }}
              >
                <span class="k2b-image-editor__grid" aria-hidden="true" />
                <button
                  type="button"
                  class="k2b-image-editor__crop-move"
                  aria-label={t().moveCrop}
                  aria-describedby={ids.help}
                  onPointerDown={(e) => startCrop(e, "move")}
                  onKeyDown={cropKey}
                  onKeyUp={finishDraft}
                  onBlur={finishDraft}
                />
                <For each={cropHandles.filter((h) => aspect() === "free" || h.length === 2)}>
                  {(handle) => (
                    <button
                      type="button"
                      class="k2b-image-editor__handle"
                      data-handle={handle}
                      tabindex="-1"
                      aria-hidden="true"
                      style={{ left: `${handlePosition[handle][0]}%`, top: `${handlePosition[handle][1]}%` }}
                      onPointerDown={(e) => startCrop(e, handle)}
                    />
                  )}
                </For>
                <Show when={cropDragging() && preview()}>
                  <span class="k2b-image-editor__tag k2b-image-editor__crop-size">
                    {px(rotated().width * state().crop.width, rotated().height * state().crop.height)}
                  </span>
                </Show>
              </div>
            </Show>
            <Show when={tool() === "annotate" ? hotMark() : undefined}>
              {(mark) => <div class="k2b-image-editor__hot" style={boxOf(mark())} aria-hidden="true" />}
            </Show>
            <Show when={tool() === "annotate" && selectedMark() && !selectedMark()!.hidden && selectedMark()}>
              {(mark) => (
                <div class="k2b-image-editor__selection" style={boxOf(mark())}>
                  <For each={["nw", "ne", "sw", "se"] as const}>
                    {(corner) => (
                      <button
                        type="button"
                        class="k2b-image-editor__selection-handle"
                        data-corner={corner}
                        tabindex="-1"
                        aria-hidden="true"
                        onPointerDown={(e) => startResize(e, corner)}
                      />
                    )}
                  </For>
                </div>
              )}
            </Show>
            <Show when={inlineText()}>
              {(text) => (
                <div class="k2b-image-editor__text" style={textBox()}>
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
                      if (e.isComposing) return;
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setInlineText(undefined);
                        canvasArea?.focus();
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        finishText();
                        canvasArea?.focus();
                      }
                    }}
                  />
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>

      <Show when={loadError()}>
        <div class="k2b-image-editor__center" role="alert">
          <span class="k2b-image-editor__orb" aria-hidden="true">
            <i class="ti ti-photo-x" />
          </span>
          <strong>{t().loadFailed}</strong>
          <p>{t().loadFailedReason}</p>
          <div class="k2b-image-editor__center-actions">
            <Button variant="secondary" onClick={() => setLoadAttempt((n) => n + 1)}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().retry}
            </Button>
            <Show when={props.onCancel}>
              <Button variant="ghost" onClick={() => props.onCancel?.()}>
                {t().close}
              </Button>
            </Show>
          </div>
        </div>
      </Show>

      <div ref={chipsEl} class="k2b-image-editor__chips" role="group" aria-label={t().info}>
        <Show when={props.onCancel}>
          <IconButton
            class="k2b-image-editor__chip k2b-image-editor__glass"
            size="sm"
            variant="ghost"
            label={t().close}
            tooltip={tip(t().close, "escape")}
            onClick={() => void cancel()}
          >
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </Show>
        {/* With one image the name is a plain label; with a strip it opens or focuses the strip. */}
        <Dynamic
          component={itemCount() > 1 ? "button" : "span"}
          type={itemCount() > 1 ? "button" : undefined}
          class="k2b-image-editor__chip k2b-image-editor__glass k2b-image-editor__name"
          aria-expanded={phone() && itemCount() > 1 ? stripOpen() : undefined}
          title={itemCount() > 1 ? (phone() ? t().showImages : t().toStrip) : undefined}
          onClick={() => {
            if (itemCount() < 2) return;
            if (phone()) setStripOpen((open) => !open);
            else stripList?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
          }}
        >
          <canvas
            ref={(element) => {
              const previous = chipThumb();
              if (previous && previous !== element) previous.width = previous.height = 0;
              setChipThumb(element);
            }}
            class="k2b-image-editor__chip-thumb"
            aria-hidden="true"
          />
          <span class="k2b-image-editor__chip-name">{title()}</span>
          <span class="k2b-image-editor__dirty" data-on={dirty() ? "" : undefined} title={t().imageUnsaved} />
          <Show when={position()}>
            <span class="k2b-image-editor__muted">{position()}</span>
          </Show>
          <Show when={phone() && itemCount() > 1}>
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Show>
        </Dynamic>
        <span class="k2b-image-editor__chip k2b-image-editor__glass k2b-image-editor__chip--size" data-optional="">
          {preview() ? px(rotated().width * state().crop.width, rotated().height * state().crop.height) : "… × … px"}
        </span>
        <Show when={sourceType()}>
          <span class="k2b-image-editor__chip k2b-image-editor__glass" data-optional="">
            {formatName(sourceType())}
            <Show when={bytes()}>
              <span class="k2b-image-editor__muted">{bytes()}</span>
            </Show>
          </span>
        </Show>
        <For each={props.facts ?? []}>
          {(fact) => (
            // On phones a fact with an icon stays as the icon alone; one without an icon gives way.
            <span
              class="k2b-image-editor__chip k2b-image-editor__glass k2b-image-editor__fact"
              data-optional={fact.icon ? undefined : ""}
              title={fact.tooltip}
            >
              <Show when={fact.icon}>
                <i class={fact.icon} aria-hidden="true" />
              </Show>
              <span class="k2b-image-editor__fact-label">{fact.label}</span>
            </span>
          )}
        </For>
        <Show when={dimensions()?.downscaled}>
          <span class="k2b-image-editor__chip k2b-image-editor__glass" data-tone="warning" title={t().reducedTip}>
            <i class="ti ti-arrows-diagonal-minimize-2" aria-hidden="true" />
            <span data-optional="">{t().reducedChip}</span>
          </span>
        </Show>
        <Show when={saved() && !dirty()}>
          <span class="k2b-image-editor__chip k2b-image-editor__glass k2b-image-editor__saved" data-tone="success" role="status">
            <i class="ti ti-check" aria-hidden="true" />
            {t().saved}
          </span>
        </Show>
      </div>

      <Show when={phone() && stripOpen() && showStrip()}>
        <div class="k2b-image-editor__strip-top">{strip()}</div>
      </Show>

      <div ref={bottomEl} class="k2b-image-editor__bottom">
        <div class="k2b-image-editor__bar k2b-image-editor__glass" role="toolbar" aria-label={t().view}>
          <div class="k2b-image-editor__group">
            <IconButton size="sm" variant="ghost" label={t().undo} tooltip={tip(t().undo, "mod+z")} disabled={!canUndo()} onClick={undo}>
              <i class="ti ti-arrow-back-up" aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              variant="ghost"
              label={t().redo}
              tooltip={tip(t().redo, "mod+shift+z")}
              disabled={!canRedo()}
              onClick={redo}
            >
              <i class="ti ti-arrow-forward-up" aria-hidden="true" />
            </IconButton>
          </div>
          <div class="k2b-image-editor__group">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={split() && tool() !== "crop"}
              disabled={tool() === "crop" || !preview()}
              tooltip={tip(tool() === "crop" ? t().compareCrop : t().compareTip, "shift+o")}
              onClick={() => setSplit((on) => !on)}
            >
              <i class="ti ti-square-half" aria-hidden="true" />
              {t().compare}
            </Button>
          </div>
          <div class="k2b-image-editor__group k2b-image-editor__zoom">
            <IconButton
              size="sm"
              variant="ghost"
              label={t().zoomOut}
              tooltip={tip(t().zoomOut, "-")}
              disabled={!preview()}
              onClick={() => zoomBy(0.8)}
            >
              <i class="ti ti-minus" aria-hidden="true" />
            </IconButton>
            <Dropdown.Root
              items={[
                { label: t().fit, action: () => fit(), trailing: <Kbd keys="shift+1" /> },
                { label: "50 %", action: () => zoomTo(0.5) },
                { label: "100 %", action: () => zoomTo(1), trailing: <Kbd keys="shift+0" /> },
                { label: "200 %", action: () => zoomTo(2) },
                { label: t().zoomIn, action: () => zoomBy(1.25), trailing: <Kbd keys="+" /> },
                { label: t().zoomOut, action: () => zoomBy(0.8), trailing: <Kbd keys="-" /> },
              ]}
              position="top-left"
            >
              <Dropdown.Trigger size="sm" variant="ghost" class="k2b-image-editor__zoom-value" aria-label={t().zoom} disabled={!preview()}>
                {`${Math.round(view().zoom * 100)} %`}
              </Dropdown.Trigger>
            </Dropdown.Root>
            <IconButton
              size="sm"
              variant="ghost"
              label={t().zoomIn}
              tooltip={tip(t().zoomIn, "+")}
              disabled={!preview()}
              onClick={() => zoomBy(1.25)}
            >
              <i class="ti ti-plus" aria-hidden="true" />
            </IconButton>
          </div>
          <div class="k2b-image-editor__group">
            <IconButton
              size="sm"
              variant="ghost"
              label={t().fit}
              tooltip={tip(t().fit, "shift+1")}
              disabled={!preview()}
              onClick={() => fit()}
            >
              <i class="ti ti-arrows-minimize" aria-hidden="true" />
            </IconButton>
            <IconButton
              class="k2b-image-editor__keys-button"
              size="sm"
              variant="ghost"
              label={t().shortcuts}
              tooltip={tip(t().shortcuts, "shift+/")}
              aria-expanded={panel() === "keys"}
              onClick={() => setPanel((open) => (open === "keys" ? undefined : "keys"))}
            >
              <i class="ti ti-keyboard" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <Show when={!phone() && showStrip()}>{strip()}</Show>
      </div>

      <Show when={note()?.action && phone()}>
        <div class="k2b-image-editor__toast k2b-image-editor__glass">{noteView()}</div>
      </Show>

      <aside ref={paneEl} class="k2b-image-editor__pane k2b-image-editor__glass" aria-label={t().tools}>
        <div class="k2b-image-editor__tabs" role="tablist" aria-label={t().tool}>
          <For each={tools()}>
            {(option) => (
              <Button
                variant="ghost"
                class="k2b-image-editor__tab"
                role="tab"
                id={`${ids.help}-tab-${option.value}`}
                aria-selected={tool() === option.value}
                aria-controls={`${ids.help}-panel`}
                tabindex={tool() === option.value ? 0 : -1}
                tooltip={tip(option.label, option.key)}
                onClick={() => switchTool(option.value)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  const list = tools();
                  const next =
                    list[(list.findIndex((x) => x.value === tool()) + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
                  if (next) {
                    switchTool(next.value);
                    queueMicrotask(() => document.getElementById(`${ids.help}-tab-${next.value}`)?.focus());
                  }
                }}
              >
                <i class={option.icon} aria-hidden="true" />
                <span>{option.label}</span>
              </Button>
            )}
          </For>
        </div>
        <div
          class="k2b-image-editor__body"
          id={`${ids.help}-panel`}
          role="tabpanel"
          aria-labelledby={`${ids.help}-tab-${tool()}`}
          inert={loading() || loadError()}
          aria-busy={loading()}
        >
          <Show when={tool() === "crop"}>{cropPanel()}</Show>
          <Show when={tool() === "adjust"}>{adjustPanel()}</Show>
          <Show when={tool() === "annotate"}>{annotatePanel()}</Show>
        </div>
      </aside>

      <div ref={saveEl} class="k2b-image-editor__save">
        <Show when={note()}>
          <div class="k2b-image-editor__note" data-optional="">
            {noteView()}
          </div>
        </Show>
        <Show when={f().export}>
          <button
            type="button"
            class="k2b-image-editor__output-trigger"
            aria-haspopup="dialog"
            aria-expanded={panel() === "output"}
            aria-controls={ids.output}
            aria-label={`${t().output}: ${outputSummary()}`}
            disabled={!preview() || busy()}
            onClick={() => setPanel((open) => (open === "output" ? undefined : "output"))}
          >
            <i class="ti ti-settings" aria-hidden="true" />
            <b>{t().output}</b>
            <span>{outputSummary()}</span>
            <i class="ti ti-chevron-up" aria-hidden="true" />
          </button>
        </Show>
        <div class="k2b-image-editor__actions">
          {props.saveActions ? (
            props.saveActions(actions)
          ) : (
            <Button
              disabled={!preview() || loading() || busy()}
              loading={busy()}
              loadingLabel={t().saving}
              onClick={() => void save(async (result) => void (await props.onSave?.(result)))}
            >
              {t().done}
            </Button>
          )}
        </div>
      </div>

      <Show when={panel() === "output"}>{outputPanel()}</Show>
      <Show when={panel() === "keys"}>{keysPanel()}</Show>
      <p id={ids.help} class="k2b-sr-only">
        {t().cropHint}
      </p>
      <div class="k2b-image-editor__live k2b-sr-only" aria-live="polite" />
    </section>
  );

  function outputSummary() {
    const d = dimensions();
    return `${outputFormatName()}${losslessOutput() || !exportFeatures()?.quality ? "" : ` · ${Math.round((output().quality ?? 0.9) * 100)} %`}${d ? ` · ${d.width} × ${d.height}` : ""}`;
  }

  function noteView() {
    const n = note();
    if (!n) return null;
    return (
      <p class="k2b-image-editor__note-line" data-tone={n.tone} role={n.tone === "danger" ? "alert" : undefined}>
        <i class={n.icon} aria-hidden="true" />
        <span>
          <Show when={n.tone === "danger"}>
            <b>{t().saveFailedTitle} </b>
          </Show>
          {n.text}
          <Show when={n.action}>
            <span class="k2b-image-editor__note-actions">
              <Button size="sm" variant="secondary" disabled={busy()} onClick={retry}>
                {suggestedMP()
                  ? t().retrySmaller({
                      megapixels: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(suggestedMP() ?? 0),
                    })
                  : t().retry}
              </Button>
            </span>
          </Show>
        </span>
      </p>
    );
  }

  function strip() {
    return (
      <nav class="k2b-image-editor__strip k2b-image-editor__glass" aria-label={t().images}>
        <ul ref={stripList} onScroll={stripFade} onKeyDown={stripKeys}>
          <For each={props.items ?? []}>
            {(item) => (
              <li>
                <button
                  type="button"
                  class="k2b-image-editor__thumb"
                  aria-current={item.id === props.currentItem}
                  tabindex={item.id === props.currentItem ? 0 : -1}
                  aria-label={`${item.name}${item.id === props.currentItem ? `, ${t().imageCurrent}` : ""}${item.dirty ? `, ${t().imageUnsaved}` : ""}`}
                  title={item.name}
                  onClick={() => {
                    setStripOpen(false);
                    if (item.id !== props.currentItem) props.onSelectItem?.(item.id);
                  }}
                >
                  {(() => {
                    const thumbnail = item.thumbnail;
                    if (typeof thumbnail === "function") return thumbnail();
                    return thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" /> : null;
                  })()}
                  <Show when={item.dirty}>
                    <span class="k2b-image-editor__thumb-dirty" aria-hidden="true" />
                  </Show>
                </button>
              </li>
            )}
          </For>
          <Show when={props.onAddItems}>
            <li>
              <IconButton
                class="k2b-image-editor__thumb k2b-image-editor__thumb--add"
                size="sm"
                variant="ghost"
                tabindex="-1"
                label={t().addImages}
                onClick={() => props.onAddItems?.()}
              >
                <i class="ti ti-plus" aria-hidden="true" />
              </IconButton>
            </li>
          </Show>
        </ul>
      </nav>
    );
  }

  function cropPanel() {
    return (
      <div class="k2b-image-editor__tool" data-tool="crop">
        <Show when={f().crop && !cropOptions()?.locked}>
          <section class="k2b-image-editor__section" data-part="aspect">
            <h3>
              {t().aspect}
              <Button
                size="sm"
                variant="ghost"
                class="k2b-image-editor__inline-action"
                disabled={aspect() === "free" || state().cropAspect === "original" || state().cropAspect === "1:1"}
                tooltip={t().swapTip}
                onClick={() =>
                  change((s) => {
                    const next = { ...s, cropAspectSwapped: !s.cropAspectSwapped };
                    return { ...next, crop: getInitialImageCropRect(rotated(), aspectFor(next)) };
                  })
                }
              >
                <i class="ti ti-arrows-exchange" aria-hidden="true" />
                {t().swap}
              </Button>
            </h3>
            <div class="k2b-image-editor__aspects" role="radiogroup" aria-label={t().aspect}>
              <For each={aspects()}>
                {(value) => {
                  const glyph = () => aspectGlyph(value);
                  return (
                    <button
                      type="button"
                      role="radio"
                      class="k2b-image-editor__choice"
                      aria-checked={JSON.stringify(state().cropAspect) === JSON.stringify(value)}
                      disabled={!preview()}
                      onClick={() => chooseAspect(value)}
                    >
                      <span
                        class="k2b-image-editor__aspect-glyph"
                        data-free={glyph().free ? "" : undefined}
                        style={{ width: glyph().width, height: glyph().height }}
                      />
                      {cropAspectLabel(value)}
                    </button>
                  );
                }}
              </For>
            </div>
          </section>
        </Show>
        <Show when={f().rotate}>
          <section class="k2b-image-editor__section" data-part="rotate">
            <h3>{t().rotateFlip}</h3>
            <div class="k2b-image-editor__rotations">
              <Button
                variant="secondary"
                size="sm"
                aria-label={t().rotateLeft}
                tooltip={tip(t().rotateLeft, "shift+r")}
                onClick={() => rotate(false)}
              >
                <i class="ti ti-rotate-2" aria-hidden="true" />
                <span>{t().rotateLeft}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t().rotateRight}
                tooltip={tip(t().rotateRight, "r")}
                onClick={() => rotate(true)}
              >
                <i class="ti ti-rotate-clockwise-2" aria-hidden="true" />
                <span>{t().rotateRight}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t().flipX}
                aria-pressed={state().flipX}
                onClick={() => change((s) => ({ ...s, flipX: !s.flipX }))}
              >
                <i class="ti ti-flip-vertical" aria-hidden="true" />
                <span>{t().flipX}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t().flipY}
                aria-pressed={state().flipY}
                onClick={() => change((s) => ({ ...s, flipY: !s.flipY }))}
              >
                <i class="ti ti-flip-horizontal" aria-hidden="true" />
                <span>{t().flipY}</span>
              </Button>
              <IconButton
                class="k2b-image-editor__phone-only"
                size="sm"
                variant="ghost"
                label={t().resetCrop}
                disabled={!cropChanged()}
                onClick={resetCrop}
              >
                <i class="ti ti-restore" aria-hidden="true" />
              </IconButton>
            </div>
          </section>
        </Show>
        <Show when={f().straighten}>
          <section class="k2b-image-editor__section" data-part="straighten">
            <h3>
              {t().straighten}
              <span class="k2b-image-editor__value" data-changed={state().straighten !== 0 ? "" : undefined}>
                {`${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(state().straighten)}°`}
              </span>
            </h3>
            <Ruler
              value={state().straighten}
              label={t().straighten}
              valueText={t().degrees({ value: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(state().straighten) })}
              tooltip={t().straightenTip}
              onChange={(v) => updateDraft((s) => ({ ...s, straighten: v }))}
              onCommit={finishDraft}
            />
            <p class="k2b-image-editor__hint">{t().straightenHint}</p>
          </section>
        </Show>
        <p class="k2b-image-editor__hint">{t().cropHint}</p>
        <div class="k2b-image-editor__reset">
          <Button size="sm" variant="ghost" disabled={!cropChanged()} onClick={resetCrop}>
            <i class="ti ti-restore" aria-hidden="true" />
            {t().resetCrop}
          </Button>
        </div>
      </div>
    );
  }

  function adjustPanel() {
    const slider = (key: keyof ImageEditorAdjustments) => {
      const value = () => sliderValue(key, state().adjustments);
      const centered = key !== "vignette" && key !== "grain";
      return (
        <Slider
          class="k2b-image-editor__slider"
          data-changed={value() !== 0 ? "" : undefined}
          label={
            <>
              {t()[key]}
              <span class="k2b-image-editor__auto-tag" data-on={isAuto(key) ? "" : undefined} aria-hidden={!isAuto(key)}>
                {t().autoTag}
              </span>
            </>
          }
          value={value()}
          min={centered ? -100 : 0}
          max={100}
          step={1}
          center={centered}
          defaultValue={0}
          formatValue={centered ? signed : String}
          onValueChange={(v) => adjust(key, v)}
          onValueCommit={finishDraft}
        />
      );
    };
    const strength = () => (
      <Slider
        class="k2b-image-editor__slider"
        label={t().strength}
        value={Math.round(state().lookStrength * 100)}
        min={0}
        max={100}
        defaultValue={100}
        disabled={state().look === "original"}
        formatValue={(v) => `${v} %`}
        onValueChange={(v) => updateDraft((s) => ({ ...s, lookStrength: v / 100 }))}
        onValueCommit={finishDraft}
      />
    );
    const looks = (variant: "pane" | "phone") => (
      <div class="k2b-image-editor__looks" data-variant={variant} role="radiogroup" aria-label={t().look}>
        <For each={lookOptions}>
          {(look) => (
            <button
              type="button"
              role="radio"
              class="k2b-image-editor__look"
              aria-checked={state().look === look.value}
              tabindex={state().look === look.value ? 0 : -1}
              onClick={() => change((s) => ({ ...s, look: look.value, lookStrength: s.lookStrength || 1 }))}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                e.stopPropagation();
                const index = lookOptions.findIndex((x) => x.value === state().look) + (e.key === "ArrowRight" ? 1 : -1);
                const next = lookOptions[(index + lookOptions.length) % lookOptions.length];
                if (next) {
                  // The delegated event's currentTarget is gone once the handler returns.
                  const group = (e.currentTarget as HTMLElement).parentElement;
                  change((s) => ({ ...s, look: next.value, lookStrength: s.lookStrength || 1 }));
                  queueMicrotask(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
                }
              }}
            >
              <LookThumbnail image={preview()} look={look.value} state={state()} />
              <span>{t()[look.label]}</span>
            </button>
          )}
        </For>
      </div>
    );
    const autoButton = (variant: "pane" | "phone") => (
      <Button
        size="sm"
        variant="secondary"
        class="k2b-image-editor__auto"
        data-variant={variant}
        disabled={!preview()}
        tooltip={tip(t().autoTip, "shift+a")}
        onClick={runAuto}
      >
        <i class="ti ti-adjustments-check" aria-hidden="true" />
        {t().auto}
      </Button>
    );
    const settings = () => [
      {
        id: "look" as const,
        label: t().look,
        value: state().look === "original" ? "–" : t()[lookOptions.find((x) => x.value === state().look)!.label],
        changed: state().look !== "original",
      },
      ...(f().filters
        ? [
            {
              id: "strength" as const,
              label: t().strength,
              value: state().look === "original" ? "–" : `${Math.round(state().lookStrength * 100)} %`,
              changed: state().look !== "original" && state().lookStrength !== 1,
              disabled: state().look === "original",
            },
          ]
        : []),
      ...(f().adjust
        ? groups
            .flatMap((g) => g.keys)
            .map((key) => ({
              id: key,
              label: t()[key],
              value: (key === "vignette" || key === "grain" ? String : signed)(sliderValue(key, state().adjustments)),
              changed: sliderValue(key, state().adjustments) !== 0,
            }))
        : []),
    ];
    return (
      <div class="k2b-image-editor__tool" data-tool="adjust">
        <div class="k2b-image-editor__adjust-pane">
          <Show when={f().adjust}>
            <div class="k2b-image-editor__auto-row">
              {autoButton("pane")}
              <span class="k2b-image-editor__hint">{anyAuto() ? t().autoDone : t().autoHint}</span>
            </div>
          </Show>
          <Show when={f().filters}>
            <section class="k2b-image-editor__section">
              <h3>
                {t().look}
                <span class="k2b-image-editor__value" data-changed={state().look !== "original" ? "" : undefined}>
                  {t()[lookOptions.find((x) => x.value === state().look)?.label ?? "natural"]}
                </span>
              </h3>
              {looks("pane")}
              {strength()}
            </section>
          </Show>
          <Show when={f().adjust}>
            <For each={groups}>
              {(group) => (
                <section class="k2b-image-editor__section">
                  <h3>{t()[group.label]}</h3>
                  <For each={group.keys}>{(key) => slider(key)}</For>
                </section>
              )}
            </For>
          </Show>
          <div class="k2b-image-editor__reset">
            <Button
              size="sm"
              variant="ghost"
              disabled={!adjustChanged()}
              onClick={() =>
                change((s) => ({
                  ...s,
                  look: "original",
                  lookStrength: 1,
                  adjustments: initialImageEditorState().adjustments,
                  auto: undefined,
                }))
              }
            >
              <i class="ti ti-restore" aria-hidden="true" />
              {t().resetAdjust}
            </Button>
          </div>
        </div>
        <div class="k2b-image-editor__adjust-phone">
          <div class="k2b-image-editor__phone-slot">
            <Show
              when={phoneSetting() === "look"}
              fallback={phoneSetting() === "strength" ? strength() : slider(phoneSetting() as keyof ImageEditorAdjustments)}
            >
              {looks("phone")}
            </Show>
          </div>
          <div class="k2b-image-editor__phone-row">
            <Show when={f().adjust}>{autoButton("phone")}</Show>
            <div class="k2b-image-editor__settings" role="radiogroup" aria-label={t().setting}>
              <For each={settings()}>
                {(setting) => (
                  <button
                    type="button"
                    role="radio"
                    class="k2b-image-editor__setting"
                    aria-checked={phoneSetting() === setting.id}
                    data-changed={setting.changed ? "" : undefined}
                    disabled={"disabled" in setting ? setting.disabled : false}
                    onClick={() => setPhoneSetting(setting.id)}
                  >
                    {setting.label}
                    <b>{setting.value}</b>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function annotatePanel() {
    const hint = () =>
      selectedMark() ? t().selectionHint : markTool() === "redact" ? t().redactHint : markTool() === "text" ? t().textHint : t().drawHint;
    const order = () => layerOrder(marks());
    const redactions = () => order().filter((i) => isRedaction(marks()[i]!));
    const others = () => order().filter((i) => !isRedaction(marks()[i]!));
    const row = (index: number) => {
      const mark = () => marks()[index]!;
      const name = () => nameOf(mark());
      const red = () => isRedaction(mark());
      return (
        <li
          class="k2b-image-editor__layer"
          data-layer={mark().id}
          data-group={red() ? "redact" : "mark"}
          data-selected={selected() === mark().id ? "" : undefined}
          data-hidden={mark().hidden ? "" : undefined}
          onPointerEnter={() => setHot(mark().id)}
          onPointerLeave={() => setHot(undefined)}
        >
          <span class="k2b-image-editor__layer-grip" aria-hidden="true" title={t().dragLayer} onPointerDown={(e) => dragLayer(e, index)}>
            <i class="ti ti-grip-vertical" />
          </span>
          <button
            type="button"
            class="k2b-image-editor__layer-main"
            aria-pressed={selected() === mark().id}
            aria-describedby={ids.layersHelp}
            tabindex={(selected() ? selected() === mark().id : order()[0] === index) ? 0 : -1}
            onClick={() => {
              finishText();
              setSelected((current) => (current === mark().id ? undefined : mark().id));
            }}
            onKeyDown={(e) => layerKeys(e, index)}
          >
            <span
              class="k2b-image-editor__layer-icon"
              data-redaction={red() ? "" : undefined}
              data-white={!red() && mark().color.toLowerCase() === "#ffffff" ? "" : undefined}
              style={{ "--k2b-layer-color": red() ? "#09090b" : mark().color }}
            >
              <i class={toolIcon[mark().tool]} aria-hidden="true" />
            </span>
            <span class="k2b-image-editor__layer-name">{name()}</span>
            <Show when={mark().hidden}>
              <span class="k2b-sr-only">, {t().hiddenSuffix}</span>
            </Show>
          </button>
          <Show
            when={!red()}
            fallback={
              <IconButton
                size="sm"
                variant="ghost"
                class="k2b-image-editor__layer-action"
                label={t().peekLabel({ name: name() })}
                tooltip={t().peek}
                onPointerDown={() => setPeekRedaction(mark().id)}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                    e.preventDefault();
                    setPeekRedaction(mark().id);
                  }
                }}
                onKeyUp={() => setPeekRedaction(undefined)}
                onBlur={() => setPeekRedaction(undefined)}
              >
                <i class="ti ti-eye" aria-hidden="true" />
              </IconButton>
            }
          >
            <IconButton
              size="sm"
              variant="ghost"
              class="k2b-image-editor__layer-action"
              aria-pressed={!!mark().hidden}
              label={mark().hidden ? t().showLabel({ name: name() }) : t().hideLabel({ name: name() })}
              tooltip={mark().hidden ? t().show : t().hide}
              onClick={() => toggleHidden(index)}
            >
              <i class={mark().hidden ? "ti ti-eye-off" : "ti ti-eye"} aria-hidden="true" />
            </IconButton>
          </Show>
          <IconButton
            size="sm"
            variant="ghost"
            class="k2b-image-editor__layer-action"
            label={t().deleteLabel({ name: name() })}
            tooltip={t().deleteLayer}
            onClick={() => focusLayer(deleteLayer(index))}
          >
            <i class="ti ti-trash" aria-hidden="true" />
          </IconButton>
        </li>
      );
    };
    return (
      <div class="k2b-image-editor__tool" data-tool="annotate" data-mark-tool={markTool()}>
        <section class="k2b-image-editor__section" data-part="tools">
          <h3>{t().tool}</h3>
          <div class="k2b-image-editor__marks" role="radiogroup" aria-label={t().tool}>
            <For each={markTools()}>
              {(option) => (
                <button
                  type="button"
                  role="radio"
                  class="k2b-image-editor__choice"
                  data-wide={option === "redact" ? "" : undefined}
                  aria-checked={markTool() === option}
                  aria-label={option === "redact" ? `${t().redact}: ${t().redactDescription}` : t()[option]}
                  title={t()[option]}
                  onClick={() => {
                    finishText();
                    setSelected(undefined);
                    setMarkTool(option);
                  }}
                >
                  <i class={toolIcon[option]} aria-hidden="true" />
                  <span>
                    {t()[option]}
                    <Show when={option === "redact"}>
                      <small>{t().redactDescription}</small>
                    </Show>
                  </span>
                  <Kbd keys={toolKey[option]} class="k2b-image-editor__choice-key" />
                </button>
              )}
            </For>
          </div>
        </section>
        <div class="k2b-image-editor__style" data-off={styleOff() ? "" : undefined} aria-disabled={styleOff()}>
          <section class="k2b-image-editor__section">
            <h3>
              {t().color}
              <span class="k2b-image-editor__value">{styleTarget() ? t().styleFor({ name: nameOf(styleTarget()!) }) : ""}</span>
            </h3>
            <div class="k2b-image-editor__colors" role="radiogroup" aria-label={t().color}>
              <For each={colors}>
                {(option) => (
                  <button
                    type="button"
                    role="radio"
                    class="k2b-image-editor__color"
                    aria-checked={currentColor().toLowerCase() === option.value}
                    aria-label={t()[option.label]}
                    title={t()[option.label]}
                    disabled={styleOff()}
                    onClick={() => chooseColor(option.value)}
                  >
                    <span style={{ background: option.value }} />
                  </button>
                )}
              </For>
            </div>
          </section>
          <section class="k2b-image-editor__section">
            <h3>
              {t().size}
              <span class="k2b-image-editor__value">
                <Kbd keys="[" /> <Kbd keys="]" />
              </span>
            </h3>
            <div class="k2b-image-editor__sizes" role="radiogroup" aria-label={t().size}>
              <For each={sizes}>
                {(option, i) => (
                  <button
                    type="button"
                    role="radio"
                    class="k2b-image-editor__size"
                    aria-checked={currentSize() === i()}
                    aria-label={t()[option.label]}
                    title={t()[option.label]}
                    disabled={styleOff()}
                    onClick={() => chooseSize(i())}
                  >
                    <span style={{ width: `${option.dot}px`, height: `${option.dot}px` }} />
                  </button>
                )}
              </For>
            </div>
          </section>
        </div>
        <p class="k2b-image-editor__hint">{hint()}</p>
        <section class="k2b-image-editor__layers" aria-labelledby={ids.layersTitle}>
          <div class="k2b-image-editor__layers-head">
            <h3 id={ids.layersTitle}>
              {t().layers}
              <span class="k2b-image-editor__value">{marks().length}</span>
            </h3>
            <Button size="sm" variant="ghost" disabled={!marks().length} onClick={() => change((s) => ({ ...s, annotations: [] }))}>
              <i class="ti ti-trash" aria-hidden="true" />
              {t().clearLayers}
            </Button>
          </div>
          <ul ref={layersList} class="k2b-image-editor__layer-list" aria-labelledby={ids.layersTitle}>
            <Show when={redactions().length}>
              <li class="k2b-image-editor__layer-group">
                <i class="ti ti-lock" aria-hidden="true" />
                {t().redactionsOnTop}
              </li>
            </Show>
            <For each={redactions()}>{(index) => row(index)}</For>
            <Show when={redactions().length && others().length}>
              <li class="k2b-image-editor__layer-group">{t().markings}</li>
            </Show>
            <For each={others()}>{(index) => row(index)}</For>
            <Show when={!marks().length}>
              <li class="k2b-image-editor__layer-empty">{t().noLayers}</li>
            </Show>
          </ul>
          <p id={ids.layersHelp} class="k2b-sr-only">
            {t().layersHelp}
          </p>
          <Show when={props.redactionNotice && hasRedactions()}>
            <p class="k2b-image-editor__note-line k2b-image-editor__phone-only" data-tone="warning">
              <i class="ti ti-alert-triangle" aria-hidden="true" />
              <span>{props.redactionNotice}</span>
            </p>
          </Show>
        </section>
      </div>
    );
  }

  function outputPanel() {
    const formatOptions = () => [
      { value: "same" as const, label: t().same, description: formatName(sourceType()) },
      ...availableFormats().map((value) => ({
        value,
        label: formatName(value),
        description: value === "image/png" ? t().png : value === "image/webp" ? t().webp : t().jpeg,
      })),
    ];
    return (
      <div class="k2b-image-editor__output" id={ids.output} role="dialog" aria-label={t().output}>
        <h4>{t().output}</h4>
        <div class="k2b-image-editor__formats" role="radiogroup" aria-label={t().format}>
          <For each={formatOptions()}>
            {(option) => (
              <button
                type="button"
                role="radio"
                class="k2b-image-editor__choice k2b-image-editor__format"
                aria-checked={(output().format ?? "same") === option.value}
                onClick={() => setOutput((o) => ({ ...o, format: option.value }))}
              >
                {option.label}
                <small>{option.description}</small>
              </button>
            )}
          </For>
        </div>
        <Show when={exportFeatures()?.quality}>
          <Show when={!losslessOutput()} fallback={<p class="k2b-image-editor__hint k2b-image-editor__lossless">{t().lossless}</p>}>
            <Slider
              class="k2b-image-editor__slider"
              label={t().quality}
              min={40}
              max={100}
              defaultValue={90}
              value={Math.round((output().quality ?? 0.9) * 100)}
              formatValue={(v) => `${v} %`}
              onValueChange={(v) => setOutput((o) => ({ ...o, quality: v / 100 }))}
            />
          </Show>
        </Show>
        <Show when={exportFeatures()?.resize}>
          <div class="k2b-image-editor__edge">
            <NumberInput
              label={t().longEdge}
              value={output().maxLongEdge ?? Math.max(dimensions()?.width ?? 1, dimensions()?.height ?? 1)}
              min={16}
              step={1}
              onValueChange={(value) => {
                if (value && value > 0) setOutput((o) => ({ ...o, maxLongEdge: value }));
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={output().maxLongEdge === undefined}
              onClick={() => setOutput((o) => ({ ...o, maxLongEdge: undefined }))}
            >
              {t().original}
            </Button>
          </div>
        </Show>
        <p class="k2b-image-editor__hint">
          {dimensions() ? t().result(dimensions()!) : ""} {t().metadata}
        </p>
      </div>
    );
  }

  function keysPanel() {
    const rows: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
      [
        t().view,
        [
          [t().fit, "shift+1"],
          ["100 %", "shift+0"],
          [t().zoomIn, "+"],
          [t().zoomOut, "-"],
          [t().compareTip, "shift+o"],
          [t().before, "o"],
        ],
      ],
      [
        t().editor,
        [
          [t().undo, "mod+z"],
          [t().redo, "mod+shift+z"],
          [t().close, "escape"],
          [t().auto, "shift+a"],
        ],
      ],
      [
        t().tools,
        [
          [t().crop, "1"],
          [t().adjust, "2"],
          [t().annotate, "3"],
          [t().rotateRight, "r"],
        ],
      ],
      [t().annotate, markTools().map((option) => [t()[option], toolKey[option]] as const)],
    ];
    return (
      <div class="k2b-image-editor__keys" role="dialog" aria-label={t().shortcuts}>
        <h4>{t().shortcuts}</h4>
        <div class="k2b-image-editor__keys-grid">
          <For each={rows}>
            {([group, entries]) => (
              <div>
                <h5>{group}</h5>
                <For each={entries}>
                  {([label, keys]) => (
                    <p>
                      <span>{label}</span>
                      <Kbd keys={keys} />
                    </p>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    );
  }
}

/** Straighten as a ruler under a fixed centre line: drag, arrow keys, double-click resets. */
function Ruler(props: {
  value: number;
  label: string;
  valueText: string;
  tooltip: string;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const STEP = 6;
  let start: { x: number; value: number } | undefined;
  const set = (value: number) => props.onChange(clamp(Math.round(value * 2) / 2, -45, 45));
  const ticks = Array.from({ length: 91 }, (_, i) => i - 45);
  return (
    <div class="k2b-image-editor__ruler-wrap">
      <div
        class="k2b-image-editor__ruler"
        role="slider"
        tabindex="0"
        aria-label={props.label}
        aria-valuemin={-45}
        aria-valuemax={45}
        aria-valuenow={props.value}
        aria-valuetext={props.valueText}
        title={props.tooltip}
        onPointerDown={(e) => {
          start = { x: e.clientX, value: props.value };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!start) return;
          const next = start.value - (e.clientX - start.x) / STEP;
          set(Math.abs(next) < 0.5 ? 0 : next);
        }}
        onPointerUp={() => {
          start = undefined;
          props.onCommit();
        }}
        onPointerCancel={() => {
          start = undefined;
          props.onCommit();
        }}
        onDblClick={() => {
          props.onChange(0);
          props.onCommit();
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 5 : 0.5;
          const next =
            e.key === "ArrowLeft" || e.key === "ArrowDown"
              ? props.value - step
              : e.key === "ArrowRight" || e.key === "ArrowUp"
                ? props.value + step
                : e.key === "Home"
                  ? 0
                  : undefined;
          if (next === undefined) return;
          e.preventDefault();
          e.stopPropagation();
          set(next);
          props.onCommit();
        }}
      >
        <svg
          class="k2b-image-editor__ruler-strip"
          width={90 * STEP + 2}
          height="46"
          viewBox={`-1 0 ${90 * STEP + 2} 46`}
          style={{ transform: `translateX(${-(props.value + 45) * STEP}px)` }}
          aria-hidden="true"
        >
          <For each={ticks}>
            {(d) => (
              <>
                <line
                  x1={(d + 45) * STEP}
                  x2={(d + 45) * STEP}
                  y1={d % 5 === 0 ? 6 : 11}
                  y2={d % 5 === 0 ? 24 : 19}
                  data-minor={d % 5 === 0 ? undefined : ""}
                />
                <Show when={d % 15 === 0}>
                  <text x={(d + 45) * STEP} y="38">{`${d}°`}</text>
                </Show>
              </>
            )}
          </For>
        </svg>
      </div>
    </div>
  );
}

/** Look previews show the framed photo with the person's own sliders, so the choice previews the real result. */
function LookThumbnail(props: {
  image: Awaited<ReturnType<typeof loadImageEditorPreview>> | undefined;
  look: ImageEditorLook;
  state: ImageEditorState;
}): JSX.Element {
  let canvas: HTMLCanvasElement | undefined;
  let scratch: HTMLCanvasElement | undefined;
  createEffect(() => {
    const image = props.image;
    const s = props.state;
    if (!image || !canvas) return;
    scratch ??= document.createElement("canvas");
    const r = rotatedEditorSize(image.sourceSize, s);
    const w = r.width * s.crop.width;
    const h = r.height * s.crop.height;
    const scale = 120 / Math.max(w, h);
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    // Grain is invisible noise at this size. -1 cancels any look's grain (the sum clamps at 0), so opening the
    // editor never builds the shared grain tile.
    const preview = { ...s, adjustments: { ...s.adjustments, grain: -1 }, look: props.look, lookStrength: 1, annotations: [] };
    renderImageEditor(image.image, image.sourceSize, preview, canvas, scratch);
  });
  onCleanup(() => {
    if (canvas) canvas.width = canvas.height = 0;
    if (scratch) scratch.width = scratch.height = 0;
  });
  return (
    <span class="k2b-image-editor__look-thumb" aria-hidden="true">
      <canvas ref={canvas} />
    </span>
  );
}
