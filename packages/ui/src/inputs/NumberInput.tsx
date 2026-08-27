import { createEffect, createMemo, createSignal, type JSX, Show, splitProps } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { decimalSeparator, useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type NumberInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "max" | "min" | "onChange" | "onInput" | "prefix" | "step" | "type" | "value" | keyof ValueFieldProps<number | null>
> &
  ValueFieldProps<number | null> & {
    max?: number;
    min?: number;
    step?: number;
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
  };

export function NumberInput(props: NumberInputProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "activeIcon",
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
    "icon",
    "id",
    "increaseLabel",
    "label",
    "locale",
    "max",
    "min",
    "onClear",
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
  const places = () => Math.max(0, local.decimalPlaces ?? 0);
  const min = () => local.min ?? -Infinity;
  const max = () => local.max ?? Infinity;
  const step = () => local.step ?? 1;

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
      <div
        class="k2b-input-shell k2b-number-input"
        data-disabled={rest.disabled ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
      >
        <Show when={local.showSteppers ?? true}>
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
          <input
            {...rest}
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
            onFocus={() => setFocused(true)}
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
              emit(parse(next));
            }}
            onBlur={() => {
              commit(parse(raw()), true);
              setFocused(false);
            }}
          />
          <Show when={local.suffix}>
            <span class="k2b-input-shell__affix">{local.suffix}</span>
          </Show>
          <Show when={local.clearable && raw() && !rest.disabled && !rest.readOnly}>
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
        <Show when={local.showSteppers ?? true}>
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
