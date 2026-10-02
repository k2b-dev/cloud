import { createEffect, createMemo, createSignal, type JSX, Show, splitProps } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { decimalSeparator, useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";
import type { ChoiceAppearance } from "./Select";

export type NumberInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "max" | "min" | "onChange" | "onInput" | "prefix" | "step" | "type" | "value" | keyof ValueFieldProps<number | null>
> &
  ValueFieldProps<number | null> & {
    max?: number;
    min?: number;
    /** Stepper increment and commit grid; defaults to `1`. A fractional step also sets the default `decimalPlaces`. */
    step?: number;
    /** Accepted fraction digits. Defaults to the fraction digits of `step` (`0.01` → `2`, `1` → `0`); an explicit value wins. */
    decimalPlaces?: number;
    allowNegative?: boolean;
    clearable?: boolean;
    onClear?: () => void;
    clearLabel?: string;
    increaseLabel?: string;
    decreaseLabel?: string;
    /** Explicit locale for the decimal separator; defaults to the inherited render locale. */
    locale?: string;
    showSteppers?: boolean;
    disableSteppers?: boolean;
    icon?: string;
    activeIcon?: string;
    prefix?: JSX.Element;
    suffix?: JSX.Element;
    /**
     * `plain` edits the value in place for property rows: no box and no steppers
     * or clear button. The field sizes to its text, Enter commits, Escape
     * restores the current value, and clearing the text clears the value. Focus
     * stays in the field.
     */
    appearance?: ChoiceAppearance;
    /**
     * Text for a set value while a plain field is not being edited, such as
     * `90` as "1 h 30 min". It also names the value for assistive technology.
     * The suffix then shows only while editing.
     */
    formatValue?: (value: number) => string;
  };

function fractionDigits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent));
}

export function NumberInput(props: NumberInputProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "activeIcon",
    "appearance",
    "allowNegative",
    "aria-describedby",
    "aria-label",
    "class",
    "clearLabel",
    "clearable",
    "decimalPlaces",
    "decreaseLabel",
    "description",
    "disableSteppers",
    "error",
    "formatValue",
    "icon",
    "id",
    "increaseLabel",
    "label",
    "locale",
    "max",
    "min",
    "onClear",
    "onKeyDown",
    "onValueCommit",
    "onValueChange",
    "prefix",
    "required",
    "showSteppers",
    "step",
    "suffix",
    "value",
  ]);
  const meta = createFieldMeta(local.id);
  const plain = () => local.appearance === "plain";
  let input: HTMLInputElement | undefined;
  const [focused, setFocused] = createSignal(false);
  const value = () => resolveMaybeAccessor(local.value);
  const error = () => resolveMaybeAccessor(local.error);
  const contextLocale = useLocale();
  const messages = useUiMessages();
  const separator = createMemo(() => decimalSeparator(local.locale ?? contextLocale()));
  // The visible text keeps the canonical number, only the decimal separator
  // follows the effective locale; grouping is never rendered while editing.
  const display = (value: number | null | undefined) => (value == null ? "" : String(value).replace(".", separator()));
  const [raw, setRaw] = createSignal(display(value()));
  const min = () => local.min ?? -Infinity;
  const max = () => local.max ?? Infinity;
  const step = () => local.step ?? 1;
  // `step` and the accepted decimals never disagree: a fractional step implies
  // its own precision unless the caller states `decimalPlaces` explicitly.
  const places = () => Math.max(0, local.decimalPlaces ?? fractionDigits(step()));

  const filter = (input: string) => {
    let output = "";
    let decimal = false;
    for (const character of input) {
      if (/\d/.test(character)) output += character;
      else if (character === "-" && output === "" && (local.allowNegative ?? true)) output += character;
      else if ((character === "." || character === "," || character === separator()) && !decimal && places() > 0) {
        output += separator();
        decimal = true;
      }
    }
    if (decimal) {
      const [integer = "", fraction = ""] = output.split(separator());
      return `${integer}${separator()}${fraction.slice(0, places())}`;
    }
    return output;
  };
  const parse = (input: string) => {
    const canonical = input.replace(separator(), ".");
    if (!canonical || canonical === "-" || canonical === ".") return null;
    const number = places() === 0 ? Number.parseInt(canonical, 10) : Number(canonical);
    return Number.isFinite(number) ? number : null;
  };
  const normalize = (value: number | null) => {
    if (value === null) return null;
    const clamped = Math.max(min(), Math.min(max(), value));
    const anchor = Number.isFinite(min()) ? min() : 0;
    const snapped = step() > 0 ? Math.round((clamped - anchor) / step()) * step() + anchor : clamped;
    const bounded = Math.max(min(), Math.min(max(), snapped));
    return places() === 0 ? Math.round(bounded) : Number(bounded.toFixed(places()));
  };
  const emit = (value: number | null) => local.onValueChange?.(value);
  const commit = (value: number | null, changeAlreadyEmitted = false) => {
    const next = normalize(value);
    setRaw(display(next));
    if (!changeAlreadyEmitted || !Object.is(next, value)) emit(next);
    local.onValueCommit?.(next);
  };
  const stepBy = (direction: number) => {
    if (rest.disabled || local.disableSteppers) return;
    const seed = value() ?? (Number.isFinite(min()) ? min() : 0);
    commit(seed + direction * step());
  };

  createEffect(() => {
    if (focused()) return;
    if (parse(raw()) !== value()) setRaw(display(value()));
  });
  // Enter already committed the current text, so leaving the field does not commit it twice.
  let committedOnEnter = false;
  const onKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (event) => {
    const handler = local.onKeyDown;
    if (typeof handler === "function") handler(event);
    else if (Array.isArray(handler)) handler[0](handler[1], event);
    if (!plain() || event.defaultPrevented) return;
    // Both keys keep focus in the field, so keyboard and screen reader users stay in place.
    if (event.key === "Enter") {
      event.preventDefault();
      commit(parse(raw()), true);
      committedOnEnter = true;
    } else if (event.key === "Escape" && parse(raw()) !== value()) {
      // Only an edit in progress swallows Escape; otherwise it reaches an enclosing panel.
      event.preventDefault();
      event.stopPropagation();
      setRaw(display(value()));
    }
  };
  const placeholderText = () => (typeof rest.placeholder === "string" ? rest.placeholder : "");
  /** What a plain field shows: the formatted value at rest, the text being edited while focused. */
  const shownText = () => {
    const current = value();
    if (!focused() && current != null && local.formatValue) return local.formatValue(current);
    return raw() || placeholderText();
  };
  const valueText = () => {
    if (rest["aria-valuetext"] !== undefined) return rest["aria-valuetext"];
    const current = focused() ? parse(raw()) : value();
    if (current == null) return undefined;
    if (local.formatValue) return local.formatValue(current);
    const unit = typeof local.suffix === "string" ? local.suffix : "";
    return unit ? `${display(current)} ${unit}` : undefined;
  };
  const control = () => (
    <input
      {...rest}
      ref={input}
      id={meta.controlId}
      class="k2b-input k2b-number-input__control"
      data-filled={raw() ? "true" : undefined}
      type="text"
      role="spinbutton"
      inputmode={places() === 0 ? "numeric" : "decimal"}
      value={raw()}
      required={local.required}
      {...fieldControlAria(meta, local)}
      aria-valuemin={Number.isFinite(min()) ? min() : undefined}
      aria-valuemax={Number.isFinite(max()) ? max() : undefined}
      aria-valuenow={(focused() ? parse(raw()) : value()) ?? undefined}
      aria-valuetext={valueText()}
      // The plain sizer sets the width; the smallest intrinsic size keeps the input from widening it.
      size={plain() ? 1 : rest.size}
      onFocus={() => setFocused(true)}
      onKeyDown={onKeyDown}
      onInput={(event) => {
        const input = event.currentTarget;
        const current = input.value;
        const selectionStart = input.selectionStart;
        const selectionEnd = input.selectionEnd;
        const next = filter(current);
        // Only write back when the filter actually dropped something —
        // re-assigning an unchanged value moves the caret to the end.
        if (current !== next) {
          input.value = next;
          if (selectionStart !== null && selectionEnd !== null) {
            input.setSelectionRange(filter(current.slice(0, selectionStart)).length, filter(current.slice(0, selectionEnd)).length);
          }
        }
        setRaw(next);
        committedOnEnter = false;
        emit(parse(next));
      }}
      onBlur={() => {
        if (!committedOnEnter) commit(parse(raw()), true);
        committedOnEnter = false;
        setFocused(false);
      }}
    />
  );

  return (
    <Field
      class={local.class}
      label={local.label}
      description={local.description}
      error={error()}
      meta={meta}
      required={local.required}
      disabled={rest.disabled}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the input inside is the keyboard target; a plain field's row only forwards a pointer click beside the text to it. */}
      <div
        class="k2b-input-shell k2b-number-input"
        data-appearance={local.appearance ?? "field"}
        data-disabled={rest.disabled ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
        onClick={(event) => {
          if (plain() && event.target !== input && !rest.disabled) input?.focus();
        }}
      >
        <Show when={local.showSteppers ?? !plain()}>
          <button
            type="button"
            class="k2b-number-input__step"
            aria-label={local.decreaseLabel ?? messages().decreaseValue}
            disabled={rest.disabled || local.disableSteppers || (value() !== null && value() !== undefined && value()! <= min())}
            onClick={() => stepBy(-1)}
          >
            <i class="ti ti-minus" aria-hidden="true" />
          </button>
        </Show>
        <div class="k2b-number-input__value">
          <Show when={local.icon}>
            <span class="k2b-input-shell__icon k2b-text-input__icon" aria-hidden="true">
              <i class={local.icon} />
              <i class={local.activeIcon ?? local.icon} />
            </span>
          </Show>
          <Show when={local.prefix}>
            <span class="k2b-input-shell__affix">{local.prefix}</span>
          </Show>
          <Show when={plain()} fallback={control()}>
            {/* The sizer shows the text in the input's grid cell, so the field is as wide as what it shows. At rest it is
                the visible value; while editing the input takes over. */}
            <span
              class="k2b-number-input__sizer"
              data-value={shownText()}
              data-placeholder={raw() ? undefined : "true"}
              data-editing={focused() ? "true" : undefined}
            >
              {control()}
            </span>
          </Show>
          <Show when={local.suffix && (!plain() || (raw() && (focused() || !local.formatValue)))}>
            <span class="k2b-input-shell__affix">{local.suffix}</span>
          </Show>
          <Show when={local.clearable && raw() && !rest.disabled && !rest.readOnly && !plain()}>
            <button
              type="button"
              class="k2b-input-shell__clear k2b-input-clear-action"
              aria-label={local.clearLabel ?? messages().clear}
              onClick={() => (local.onClear ? local.onClear() : commit(null))}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </button>
          </Show>
        </div>
        <Show when={local.showSteppers ?? !plain()}>
          <button
            type="button"
            class="k2b-number-input__step"
            aria-label={local.increaseLabel ?? messages().increaseValue}
            disabled={rest.disabled || local.disableSteppers || (value() !== null && value() !== undefined && value()! >= max())}
            onClick={() => stepBy(1)}
          >
            <i class="ti ti-plus" aria-hidden="true" />
          </button>
        </Show>
      </div>
    </Field>
  );
}

export default NumberInput;
