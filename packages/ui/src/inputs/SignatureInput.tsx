import { createEffect, createSignal, For, type JSX, on, Show, untrack } from "solid-js";
import { IconButton } from "../actions/Button";
import { SegmentedControl } from "../actions/SegmentedControl";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import {
  drawingToSvg,
  type SignatureDrawing,
  type SignaturePoint,
  type SignatureValue,
  signatureName,
  strokeOutline,
  svgToDrawing,
  typedToSvg,
} from "./signature";
import { useSignatureMessages } from "./signature-messages";

export type SignatureInputProps = ValueFieldProps<SignatureValue | null> & {
  /** Submits the value as JSON in a hidden input of this name. */
  name?: string;
  /** Shows the signature without allowing changes. */
  readOnly?: boolean;
  /**
   * Offers typing the name instead of drawing. Defaults to `true`: typing is the
   * keyboard and screen-reader path and helps people who cannot draw. Without
   * it, a typed value is still shown and can be cleared, but not edited.
   */
  allowTyped?: boolean;
};

type SignatureMode = "draw" | "type";

/** Base stroke width in drawing units (CSS pixels at the time of drawing). */
const STROKE_SIZE = 3.2;
/** Points closer than this to the previous one add no shape, only path length. */
const MIN_POINT_DISTANCE = 1.2;
const EMPTY_SPACE = { x: 0, y: 0, width: 600, height: 200 };

const sameValue = (left: SignatureValue | null, right: SignatureValue | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.kind === right.kind &&
    left.svg === right.svg &&
    (left.kind === "typed" && right.kind === "typed" ? left.name === right.name : true));

const drawingOf = (value: SignatureValue | null): SignatureDrawing =>
  (value?.kind === "drawn" ? svgToDrawing(value.svg) : null) ?? { ...EMPTY_SPACE, strokes: [] };

let measureContext: CanvasRenderingContext2D | null | undefined;
const measureText = (text: string, font: string): number | undefined => {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return undefined;
  measureContext.font = font;
  return measureContext.measureText(text).width;
};

/**
 * A signature field: draw with a finger, pen, or mouse, or type the name. The
 * value is an SVG document plus how it was given; `signatureToPng` turns it
 * into a bitmap. Legal evidence such as timestamps or hashes stays with the app.
 */
export function SignatureInput(props: SignatureInputProps): JSX.Element {
  const messages = useUiMessages();
  const text = useSignatureMessages();
  const meta = createFieldMeta(props.id);
  const requiredId = `${meta.controlId}-required`;
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const error = () => resolveMaybeAccessor(props.error);
  const allowTyped = () => props.allowTyped !== false;
  const editable = () => !props.disabled && !props.readOnly;

  const initial = untrack(value);
  const [mode, setMode] = createSignal<SignatureMode>(initial?.kind === "typed" ? "type" : "draw");
  const [drawing, setDrawing] = createSignal<SignatureDrawing>(drawingOf(initial));
  const [typedName, setTypedName] = createSignal(initial?.kind === "typed" ? initial.name : "");
  const [live, setLive] = createSignal("");
  let svg: SVGSVGElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  let lastReported: SignatureValue | null = initial;

  const drawnValue = (): SignatureValue | null => {
    const markup = drawingToSvg(drawing());
    return markup ? { kind: "drawn", svg: markup } : null;
  };
  const typedValue = (): SignatureValue | null => {
    const name = signatureName(typedName());
    if (!name) return null;
    const family = nameInput ? getComputedStyle(nameInput).fontFamily : "cursive";
    return { kind: "typed", name, svg: typedToSvg(name, family, measureText) };
  };
  const report = (next: SignatureValue | null, commit: boolean) => {
    if (sameValue(next, lastReported)) return;
    lastReported = next;
    if (commit) commitFieldValue(props, next);
    else props.onValueChange?.(next);
  };

  let stroke: { pointerId: number; pointerType: string; points: SignaturePoint[]; time: number } | null = null;
  /** Drops the stroke in progress without keeping its ink. */
  const abortStroke = () => {
    if (!stroke) return;
    const { pointerId } = stroke;
    stroke = null;
    setLive("");
    if (svg?.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
  };
  /** After Clear or the last Undo, keyboard focus moves from the now disabled button to the pad instead of the page. */
  const keepFocus = (button: HTMLElement) => {
    if (button.matches(":focus-visible")) queueMicrotask(() => svg?.focus());
  };

  // A value the parent sets (a stored signature, another record, a reset to null) replaces both inputs, so nothing of an
  // earlier signer stays behind the mode switch. Our own reports echo back unchanged.
  createEffect(
    on(
      value,
      (next) => {
        if (next === lastReported || sameValue(next, lastReported)) return;
        lastReported = next;
        abortStroke();
        setDrawing(drawingOf(next));
        setTypedName(next?.kind === "typed" ? next.name : "");
        if (next) setMode(next.kind === "typed" ? "type" : "draw");
      },
      { defer: true },
    ),
  );
  // A field that turns disabled or read-only, or leaves drawing, ends the stroke in progress without a value.
  createEffect(() => {
    if (!editable() || mode() !== "draw") abortStroke();
  });

  const switchMode = (next: SignatureMode) => {
    if (!editable() || next === mode()) return;
    setMode(next);
    report(next === "draw" ? drawnValue() : typedValue(), true);
  };
  const undo = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    if (!editable()) return;
    setDrawing((current) => ({ ...current, strokes: current.strokes.slice(0, -1) }));
    if (drawing().strokes.length === 0) keepFocus(event.currentTarget);
    report(drawnValue(), true);
  };
  const clear = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    if (!editable()) return;
    abortStroke();
    // Clear starts over in both modes. Without the Type option, a typed value it removes gives way to drawing.
    setTypedName("");
    setDrawing((current) => ({ ...current, strokes: [] }));
    if (mode() === "type" && allowTyped()) {
      nameInput?.focus();
    } else {
      setMode("draw");
      keepFocus(event.currentTarget);
    }
    report(null, true);
  };

  const toPoint = (event: PointerEvent): { x: number; y: number } | null => {
    const matrix = svg?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };
  const addPoint = (event: PointerEvent, force = false) => {
    if (!stroke) return;
    const position = toPoint(event);
    if (!position) return;
    const previous = stroke.points[stroke.points.length - 1];
    const distance = previous ? Math.hypot(position.x - previous.x, position.y - previous.y) : 0;
    if (previous && distance < MIN_POINT_DISTANCE && !force) return;
    let pressure: number;
    if (event.pointerType === "pen" && event.pressure > 0) {
      pressure = event.pressure;
    } else {
      // Without real pressure, faster movement draws a thinner line, as ink does.
      const elapsed = Math.max(1, event.timeStamp - stroke.time);
      const target = Math.min(1, Math.max(0.3, 1.1 - (distance / elapsed) * 0.3));
      pressure = previous ? previous.pressure * 0.6 + target * 0.4 : 0.6;
    }
    stroke.time = event.timeStamp;
    stroke.points.push({ ...position, pressure });
    setLive(strokeOutline(stroke.points, STROKE_SIZE));
  };
  /**
   * The drawing space after a stroke. It stays as it is while the ink lies inside it. Ink beyond it, drawn after the
   * pad changed its shape (a rotated phone, a resized window, a drawing from another device), grows the space to the
   * whole visible pad: the stored SVG then holds everything the signer saw, and the ink on the pad does not move.
   */
  const spaceAfter = (points: readonly SignaturePoint[]): Omit<SignatureDrawing, "strokes"> => {
    const { strokes: _, ...space } = drawing();
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return space;
    const box = svg.getBoundingClientRect();
    const inverse = matrix.inverse();
    const start = new DOMPoint(box.left, box.top).matrixTransform(inverse);
    const end = new DOMPoint(box.right, box.bottom).matrixTransform(inverse);
    // Ink reaches half the widest stroke past its points; what lies outside the pad was never visible and does not count.
    const reach = STROKE_SIZE / 2;
    let left = end.x;
    let top = end.y;
    let right = start.x;
    let bottom = start.y;
    for (const point of points) {
      left = Math.min(left, Math.max(start.x, point.x - reach));
      top = Math.min(top, Math.max(start.y, point.y - reach));
      right = Math.max(right, Math.min(end.x, point.x + reach));
      bottom = Math.max(bottom, Math.min(end.y, point.y + reach));
    }
    if (left >= space.x && top >= space.y && right <= space.x + space.width && bottom <= space.y + space.height) return space;
    const x = Math.min(space.x, start.x);
    const y = Math.min(space.y, start.y);
    return {
      x,
      y,
      width: Math.max(space.x + space.width, end.x) - x,
      height: Math.max(space.y + space.height, end.y) - y,
    };
  };
  const startStroke = (event: PointerEvent) => {
    // Only the primary contact draws: not a mouse's other buttons, a pen's barrel button, or its eraser.
    if (!editable() || !svg || event.button !== 0) return;
    // A pen takes over from a touch that is still down, such as a palm resting on a tablet.
    if (stroke?.pointerType === "touch" && event.pointerType === "pen") abortStroke();
    if (stroke) return;
    event.preventDefault();
    try {
      // Capture keeps the stroke when the pointer leaves the pad; a pointer that already ended cannot be captured.
      svg.setPointerCapture(event.pointerId);
    } catch {}
    if (drawing().strokes.length === 0) {
      // An empty pad adopts its current size, so one drawing unit is one CSS pixel while drawing.
      const box = svg.getBoundingClientRect();
      setDrawing({ x: 0, y: 0, width: Math.max(1, box.width), height: Math.max(1, box.height), strokes: [] });
    }
    stroke = { pointerId: event.pointerId, pointerType: event.pointerType, points: [], time: event.timeStamp };
    addPoint(event, true);
  };
  const moveStroke = (event: PointerEvent) => {
    if (stroke?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const events = event.getCoalescedEvents?.() ?? [];
    for (const sample of events.length > 0 ? events : [event]) addPoint(sample);
  };
  const endStroke = (event: PointerEvent) => {
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    addPoint(event, false);
    const { points } = stroke;
    const outline = strokeOutline(points, STROKE_SIZE);
    stroke = null;
    setLive("");
    if (!outline) return;
    const space = spaceAfter(points);
    setDrawing((current) => ({ ...space, strokes: [...current.strokes, outline] }));
    report(drawnValue(), true);
  };
  // A cancelled pointer (an OS gesture, palm rejection) or lost capture is not a finished stroke.
  const cancelStroke = (event: PointerEvent) => {
    if (stroke?.pointerId === event.pointerId) abortStroke();
  };

  const empty = () => (mode() === "draw" ? drawing().strokes.length === 0 && !live() : !signatureName(typedName()));
  const serialized = () => {
    const current = value();
    return current ? JSON.stringify(current) : "";
  };

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={error()}
      meta={meta}
      labelFor={false}
      required={props.required}
      disabled={props.disabled}
    >
      <div
        id={meta.controlId}
        class="k2b-signature-input"
        role="group"
        aria-label={props.label ? undefined : props["aria-label"]}
        aria-labelledby={props.label ? meta.labelId : undefined}
        aria-describedby={[props.required ? requiredId : undefined, fieldDescribedBy(meta, props)].filter(Boolean).join(" ") || undefined}
        aria-invalid={error() ? "true" : undefined}
        data-mode={mode()}
        data-empty={empty() ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
        data-disabled={props.disabled ? "true" : undefined}
        data-readonly={props.readOnly ? "true" : undefined}
      >
        {/* A group cannot be marked required, so the required state is part of its description. */}
        <Show when={props.required}>
          <span id={requiredId} hidden>
            {messages().required}
          </span>
        </Show>
        <div class="k2b-signature-input__toolbar">
          <Show when={allowTyped()}>
            <SegmentedControl
              class="k2b-signature-input__modes"
              size="sm"
              ariaLabel={text().method}
              options={[
                { value: "draw", label: text().draw, icon: "ti ti-signature" },
                { value: "type", label: text().type, icon: "ti ti-keyboard" },
              ]}
              value={mode}
              onValueChange={switchMode}
              disabled={!editable()}
            />
          </Show>
          <div class="k2b-signature-input__actions">
            <IconButton
              size="sm"
              variant="ghost"
              label={text().undo}
              data-hidden={mode() === "type" ? "true" : undefined}
              disabled={!editable() || mode() !== "draw" || drawing().strokes.length === 0}
              onClick={undo}
            >
              <i class="ti ti-arrow-back-up" aria-hidden="true" />
            </IconButton>
            <IconButton size="sm" variant="ghost" label={messages().clear} disabled={!editable() || empty()} onClick={clear}>
              <i class="ti ti-eraser" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <div class="k2b-signature-input__pad">
          <span class="k2b-signature-input__line" aria-hidden="true" />
          <Show
            when={mode() === "draw"}
            fallback={
              <input
                ref={nameInput}
                class="k2b-signature-input__name"
                type="text"
                value={typedName()}
                placeholder={text().typeName}
                aria-label={text().typeName}
                aria-describedby={fieldDescribedBy(meta, props)}
                aria-invalid={error() ? "true" : undefined}
                aria-required={props.required || undefined}
                autocomplete="name"
                autocapitalize="words"
                spellcheck={false}
                disabled={props.disabled}
                readOnly={props.readOnly || !allowTyped()}
                onInput={(event) => {
                  setTypedName(event.currentTarget.value);
                  report(typedValue(), false);
                }}
                onChange={() => props.onValueCommit?.(typedValue())}
              />
            }
          >
            <span class="k2b-signature-input__placeholder" aria-hidden="true">
              <i class="ti ti-writing-sign" aria-hidden="true" />
              {text().signHere}
            </span>
            <svg
              ref={svg}
              class="k2b-signature-input__canvas"
              role="img"
              tabindex="-1"
              aria-label={drawing().strokes.length > 0 ? text().drawn : text().drawArea}
              viewBox={`${drawing().x} ${drawing().y} ${drawing().width} ${drawing().height}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={startStroke}
              onPointerMove={moveStroke}
              onPointerUp={endStroke}
              onPointerCancel={cancelStroke}
              onLostPointerCapture={(event) => {
                // A child path that held a touch's implicit capture hands it to the pad; only the pad's own loss counts.
                if (event.target === event.currentTarget) cancelStroke(event);
              }}
            >
              <g fill="currentColor">
                <For each={drawing().strokes}>{(outline) => <path d={outline} />}</For>
                <Show when={live()}>
                  <path d={live()} />
                </Show>
              </g>
            </svg>
          </Show>
        </div>
      </div>
      <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={serialized()} />}</Show>
    </Field>
  );
}

export default SignatureInput;
