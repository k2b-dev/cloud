import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import { type MaybeAccessor, resolveMaybeAccessor } from "./field-contract";

export type ChoiceSliderOption = {
  value: string;
  label: string;
  /** One short line shown below the label line while this stop is active. */
  description?: string;
  /** Makes the stop unavailable. The text replaces the description when someone reaches the stop. */
  disabledReason?: string;
  /** Spoken value; defaults to the label and the description or reason. */
  valueText?: string;
};

export type ChoiceSliderProps = {
  options: readonly ChoiceSliderOption[];
  /** The chosen stop. `null` shows no thumb, for a choice that is none of the stops. */
  value: MaybeAccessor<string | null>;
  /** A person released the thumb on a stop or moved to one with the keyboard. */
  onValueChange?: (value: string) => void;
  /** The stop the slider shows while someone drags or arrows through it; `null` when it shows `value` again. */
  onActiveChange?: (value: string | null) => void;
  /** Line text while no stop is chosen. */
  description?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  id?: string;
  class?: string;
  disabled?: boolean;
  /** `lg` gives a 44 px track and a 28 px thumb for touch sheets. */
  size?: "md" | "lg";
};

const position = (index: number, count: number) => (count < 2 ? 0 : (index / (count - 1)) * 100);

/**
 * A slider over a few named stops. The fixed line above the track always shows
 * the active stop's description, or why a stop cannot be chosen; its height
 * never changes. Unavailable stops stay visible and are skipped.
 */
export function ChoiceSlider(props: ChoiceSliderProps): JSX.Element {
  const [preview, setPreview] = createSignal<number | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  let track: HTMLDivElement | undefined;
  let drag: { pointerId: number; blocked: number | null; startX: number } | null = null;

  const count = () => props.options.length;
  const chosen = createMemo(() => {
    const value = resolveMaybeAccessor(props.value);
    return value === null ? -1 : props.options.findIndex((option) => option.value === value);
  });
  const shown = () => preview() ?? chosen();
  const option = () => props.options[shown()];
  const available = (index: number) => props.options[index] !== undefined && !props.options[index]?.disabledReason;
  const warning = () => notice() ?? (preview() === null ? (option()?.disabledReason ?? null) : null);
  const line = () => warning() ?? option()?.description ?? (shown() < 0 ? props.description : undefined) ?? "";

  createEffect(
    on(chosen, () => {
      setPreview(null);
      setNotice(null);
    }),
  );
  createEffect(on(preview, (index) => props.onActiveChange?.(index === null ? null : (props.options[index]?.value ?? null)), { defer: true }));

  const valueText = () => {
    const current = option();
    if (!current) return props.description ?? "";
    return current.valueText ?? [current.label, warning() ?? current.description].filter(Boolean).join(", ");
  };

  const nearestAvailable = (at: number) => {
    let best: number | null = null;
    for (let index = 0; index < count(); index += 1) {
      if (available(index) && (best === null || Math.abs(index - at) < Math.abs(best - at))) best = index;
    }
    return best;
  };

  const commit = (index: number) => {
    const next = props.options[index];
    setPreview(null);
    if (next && index !== chosen()) props.onValueChange?.(next.value);
  };

  const step = (direction: 1 | -1) => {
    const from = shown() < 0 ? (direction > 0 ? -1 : count()) : shown();
    for (let index = from + direction; index >= 0 && index < count(); index += direction) {
      if (available(index)) {
        setNotice(null);
        commit(index);
        return;
      }
    }
    const neighbour = props.options[from + direction];
    if (neighbour?.disabledReason) setNotice(neighbour.disabledReason);
  };

  const edge = (end: boolean) => {
    const indexes = props.options.map((_, index) => index).filter(available);
    const target = end ? indexes.at(-1) : indexes[0];
    if (target !== undefined) {
      setNotice(null);
      commit(target);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (props.disabled) return;
    const keys: Record<string, () => void> = {
      ArrowRight: () => step(1),
      ArrowUp: () => step(1),
      PageUp: () => step(1),
      ArrowLeft: () => step(-1),
      ArrowDown: () => step(-1),
      PageDown: () => step(-1),
      Home: () => edge(false),
      End: () => edge(true),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const at = (clientX: number) => {
    const rect = track?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (count() - 1);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (props.disabled || count() < 2 || event.button !== 0) return;
    event.preventDefault();
    track?.focus({ preventScroll: true });
    track?.setPointerCapture?.(event.pointerId);
    const near = Math.round(at(event.clientX));
    const pressed = props.options[near];
    if (pressed?.disabledReason) {
      drag = { pointerId: event.pointerId, blocked: near, startX: event.clientX };
      setNotice(pressed.disabledReason);
      return;
    }
    drag = { pointerId: event.pointerId, blocked: null, startX: event.clientX };
    setNotice(null);
    setPreview(nearestAvailable(at(event.clientX)));
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.blocked !== null && Math.abs(event.clientX - drag.startX) <= 2) return;
    drag.blocked = null;
    const next = nearestAvailable(at(event.clientX));
    if (next !== null) {
      setNotice(null);
      setPreview(next);
    }
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    const index = preview();
    if (event.type === "pointercancel" || index === null) {
      setPreview(null);
      return;
    }
    commit(index);
  };

  return (
    <div class={["k2b-choice-slider", props.class].filter(Boolean).join(" ")} data-size={props.size ?? "md"}>
      <p class="k2b-choice-slider__line" data-tone={warning() ? "warning" : undefined} aria-live="polite">
        <Show when={warning()}>
          <i class="ti ti-alert-triangle" aria-hidden="true" />
        </Show>
        <span>{line()}</span>
      </p>
      <Show when={count() >= 2}>
        <div
          ref={track}
          id={props.id}
          class="k2b-choice-slider__track"
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          aria-valuemin={1}
          aria-valuemax={count()}
          aria-valuenow={Math.max(0, shown()) + 1}
          aria-valuetext={valueText()}
          aria-disabled={props.disabled ? "true" : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
        >
          <For each={props.options.slice(1)}>
            {(_, index) => (
              <span
                class="k2b-choice-slider__segment"
                data-on={shown() > index() ? "" : undefined}
                style={{
                  left: `calc(${position(index(), count())}% + 8px)`,
                  width: `calc(${position(index() + 1, count()) - position(index(), count())}% - 16px)`,
                }}
              />
            )}
          </For>
          <For each={props.options}>
            {(stop, index) => (
              <span
                class="k2b-choice-slider__stop"
                data-on={shown() > index() ? "" : undefined}
                data-unavailable={stop.disabledReason ? "" : undefined}
                data-current={index() === shown() ? "" : undefined}
                style={{ left: `${position(index(), count())}%` }}
              />
            )}
          </For>
          <span
            class="k2b-choice-slider__thumb"
            data-tone={warning() && preview() === null && option()?.disabledReason ? "warning" : undefined}
            hidden={shown() < 0}
            style={{ left: `${position(Math.max(0, shown()), count())}%` }}
          />
        </div>
      </Show>
    </div>
  );
}
