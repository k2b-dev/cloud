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
   * keyboard and screen-reader path and helps people who cannot draw.
   */
  allowTyped?: boolean;
};

type SignatureMode = "draw" | "type";

/** Base stroke width in drawing units (CSS pixels at the time of drawing). */
const STROKE_SIZE = 3.2;
/** Points closer than this to the previous one add no shape, only path length. */
const MIN_POINT_DISTANCE = 1.2;
const EMPTY_SPACE = { width: 600, height: 200 };

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
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const error = () => resolveMaybeAccessor(props.error);
  const allowTyped = () => props.allowTyped !== false;
  const editable = () => !props.disabled && !props.readOnly;

  const initial = untrack(value);
  const [mode, setMode] = createSignal<SignatureMode>(initial?.kind === "typed" && allowTyped() ? "type" : "draw");
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
    const name = typedName().trim();
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

  // A value the parent sets (a stored signature, a reset to null) replaces the local state; our own reports echo back unchanged.
  createEffect(
    on(
      value,
      (next) => {
        if (next === lastReported || sameValue(next, lastReported)) return;
        lastReported = next;
        if (!next) {
          setDrawing((current) => ({ ...current, strokes: [] }));
          setTypedName("");
          return;
        }
        if (next.kind === "typed" && allowTyped()) {
          setMode("type");
          setTypedName(next.name);
        } else {
          setMode("draw");
          setDrawing(drawingOf(next));
        }
      },
      { defer: true },
    ),
  );

  const switchMode = (next: SignatureMode) => {
    if (!editable() || next === mode()) return;
    setMode(next);
    report(next === "draw" ? drawnValue() : typedValue(), true);
  };
  const undo = () => {
    if (!editable()) return;
    setDrawing((current) => ({ ...current, strokes: current.strokes.slice(0, -1) }));
    report(drawnValue(), true);
  };
  const clear = () => {
    if (!editable()) return;
    if (mode() === "type") {
      setTypedName("");
      nameInput?.focus();
    } else {
      setDrawing((current) => ({ ...current, strokes: [] }));
    }
    report(null, true);
  };

  let stroke: { pointerId: number; points: SignaturePoint[]; time: number } | null = null;
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
  const startStroke = (event: PointerEvent) => {
    if (!editable() || stroke || !svg || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    try {
      // Capture keeps the stroke when the pointer leaves the pad; a pointer that already ended cannot be captured.
      svg.setPointerCapture(event.pointerId);
    } catch {}
    if (drawing().strokes.length === 0) {
      // An empty pad adopts its current size, so one drawing unit is one CSS pixel while drawing.
      const box = svg.getBoundingClientRect();
      setDrawing({ width: Math.max(1, box.width), height: Math.max(1, box.height), strokes: [] });
    }
    stroke = { pointerId: event.pointerId, points: [], time: event.timeStamp };
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
    const outline = strokeOutline(stroke.points, STROKE_SIZE);
    stroke = null;
    setLive("");
    if (!outline) return;
    setDrawing((current) => ({ ...current, strokes: [...current.strokes, outline] }));
    report(drawnValue(), true);
  };

  const empty = () => (mode() === "draw" ? drawing().strokes.length === 0 && !live() : !typedName().trim());
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
        aria-describedby={fieldDescribedBy(meta, props)}
        aria-invalid={error() ? "true" : undefined}
        data-mode={mode()}
        data-empty={empty() ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
        data-disabled={props.disabled ? "true" : undefined}
        data-readonly={props.readOnly ? "true" : undefined}
      >
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
                readOnly={props.readOnly}
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
              aria-label={drawing().strokes.length > 0 ? text().drawn : text().drawArea}
              viewBox={`0 0 ${drawing().width} ${drawing().height}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={startStroke}
              onPointerMove={moveStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
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
