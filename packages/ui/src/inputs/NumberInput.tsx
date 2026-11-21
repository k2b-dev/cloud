import { createEffect, createMemo, createSignal, type JSX, mergeProps, on, Show, splitProps } from "solid-js";
import { createFieldMeta, Field, fieldControlAria, fieldDescribedBy } from "../internal/field";
import { decimalSeparator, useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import type { FieldSuggestionProps, ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";
import { useFieldSuggestion } from "./field-suggestion-slot";
import { useInputMessages } from "./input-messages";
import type { ChoiceAppearance } from "./Select";

export type NumberInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "max" | "min" | "onChange" | "onInput" | "prefix" | "step" | "type" | "value" | keyof ValueFieldProps<number | null>
> &
  ValueFieldProps<number | null> &
  FieldSuggestionProps<number> & {
    max?: number;
    min?: number;
    /** Stepper increment and commit grid; defaults to `1`. A fractional step also sets the default `decimalPlaces`. */
    step?: number;
    /** Accepted and displayed fraction digits. Defaults to the fraction digits of `step` (`0.01` → `2`, `1` → `0`); an explicit value wins. */
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

/**
 * Reads typed or pasted text with the locale's marks: `decimal` separates the
 * fraction, the other of `.` and `,` groups thousands, one to three digits and
 * then groups of three. One mark of the other kind that cannot group (`3.14` in
 * German) still reads as the decimal separator. Text that fits neither reading
 * is `"invalid"`, never a shortened number.
 */
function parseLocalizedNumber(text: string, decimal: string): number | null | "invalid" {
  const point = decimal === "," ? "," : ".";
  const group = point === "," ? "." : ",";
  const body = text.replaceAll(decimal, point);
  if (!body) return null;
  let canonical: string;
  if (new RegExp(`^-?(\\d*|[1-9]\\d{0,2}(\\${group}\\d{3})+)(\\${point}\\d*)?$`).test(body))
    canonical = body.replaceAll(group, "").replace(point, ".");
  else if (new RegExp(`^-?\\d*\\${group}\\d*$`).test(body)) canonical = body.replace(group, ".");
  else return "invalid";
  // Separators or a minus alone; a minus anywhere but first, such as in `1.234,56-`, already failed above.
  return /\d/.test(canonical) ? Number(canonical) : "invalid";
}

// Intl rounds a number by its shortest decimal form, half away from zero: `1.005` rounds to `1.01`,
// not to the `1.00` of the binary float that `toFixed` sees. Typed text up to 15 digits is that form.
const exact = new Intl.NumberFormat("en", { useGrouping: false, minimumFractionDigits: 20, maximumFractionDigits: 20 });
/** A number's decimal form as an exact count of 10^-20 units. */
const units = (value: number) => BigInt(exact.format(value).replace(".", ""));

/** Why the field refuses its text: no reading as a number, or a minus where negatives are not allowed. */
type Refusal = "invalid" | "negative";

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
    "onSuggestionAccept",
    "onValueChange",
    "prefix",
    "required",
    "showSteppers",
    "step",
    "suffix",
    "suggestion",
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
  const inputMessages = useInputMessages();
  const separator = createMemo(() => decimalSeparator(local.locale ?? contextLocale()));
  // Without negatives the steppers and the commit stop at 0, like a typed minus is refused.
  const min = () => (local.allowNegative === false ? Math.max(local.min ?? 0, 0) : (local.min ?? -Infinity));
  const max = () => local.max ?? Infinity;
  const step = () => local.step ?? 1;
  // `step` and the accepted decimals never disagree: a fractional step implies
  // its own precision unless the caller states `decimalPlaces` explicitly.
  const places = () => Math.max(0, local.decimalPlaces ?? fractionDigits(step()));
  // ASCII digits without grouping or exponent, so the text round-trips through parse;
  // `parseLocalizedNumber` still reads typed or pasted grouping.
  const formatter = createMemo(
    () =>
      new Intl.NumberFormat("en", {
        useGrouping: false,
        minimumFractionDigits: places(),
        maximumFractionDigits: places(),
      }),
  );
  // `+ 0` shows negative zero as 0.
  const display = (value: number | null | undefined) =>
    value == null
      ? ""
      : formatter()
          .format(value + 0)
          .replace(".", separator());
  const [raw, setRaw] = createSignal(display(value()));
  /** Why the field refused its text; the text stays as typed until it reads as a number. */
  const [failure, setFailure] = createSignal<string>();
  const shownError = () => failure() ?? error();
  const example = () => {
    const decimal = separator();
    return `1${decimal === "," ? "." : ","}234${places() > 0 ? `${decimal}56` : ""}`;
  };

  // Only characters that can never belong to a number go; separators stay as typed,
  // because whether a mark groups or separates decimals is clear only from the whole text.
  // A minus stays even where negatives are not allowed, so the field can refuse it instead of flipping the sign.
  const filter = (input: string) => input.replace(new RegExp(`[^\\d.,${separator()}-]`, "g"), "");
  /** The number, `null` for empty text, or why the text is refused. */
  const parse = (input: string): number | null | Refusal => {
    const number = parseLocalizedNumber(input, separator());
    if (typeof number !== "number") return number;
    if (!Number.isFinite(number)) return "invalid";
    return input[0] === "-" && local.allowNegative === false ? "negative" : number;
  };
  /** The number the current text stands for, or `null` while it reads as none. */
  const typed = () => {
    const number = parse(raw());
    return typeof number === "string" ? null : number;
  };
  /** Clamps, snaps to the step grid and rounds to `places`, all on the decimal form. */
  const normalize = (value: number | null) => {
    if (value === null) return null;
    let decimal = Math.max(min(), Math.min(max(), value));
    if (!Number.isFinite(decimal)) return decimal;
    if (step() > 0) {
      // Snap in exact units, half away from zero: `anchor + count × step`.
      const size = units(step());
      const anchor = units(Number.isFinite(min()) ? min() : 0);
      const offset = units(decimal) - anchor;
      const remainder = offset % size;
      const away = (remainder < 0n ? -remainder : remainder) * 2n >= size ? (offset < 0n ? -1n : 1n) : 0n;
      decimal = Number(`${(offset / size + away) * size + anchor}e-20`);
    }
    return Math.max(min(), Math.min(max(), Number(formatter().format(decimal))));
  };
  const emit = (value: number | null) => local.onValueChange?.(value);
  /** The value before the current edit; text the field cannot read hands it back instead of a guess. */
  let editStart: number | null | undefined;
  const commit = (value: number | null, changeAlreadyEmitted = false) => {
    const next = normalize(value);
    editStart = undefined;
    setFailure(undefined);
    setRaw(display(next));
    if (!changeAlreadyEmitted || !Object.is(next, value)) emit(next);
    local.onValueCommit?.(next);
  };
  const affix = (part: JSX.Element) => (typeof part === "string" ? part : "");
  const suggestion = useFieldSuggestion({
    props,
    meta,
    value,
    format: (number) =>
      local.formatValue ? local.formatValue(number) : [affix(local.prefix), display(number), affix(local.suffix)].filter(Boolean).join(" "),
    apply: (number) => commit(number),
    // Accept takes the value exactly, so one off the step or outside the bounds is not offered.
    acceptable: (number) => Object.is(normalize(number), number),
  });
  /** An open suggestion reads as the number alone; prefix and suffix stay where they are. */
  const suggested = () => {
    const number = suggestion.value();
    return suggestion.view() === "open" && number !== undefined ? display(number) : undefined;
  };
  const stepBy = (direction: number) => {
    if (rest.disabled || local.disableSteppers) return;
    const seed = value() ?? (Number.isFinite(min()) ? min() : 0);
    commit(seed + direction * step());
  };

  createEffect(() => {
    if (focused() || failure()) return;
    // Synchronize display text: precision or locale can change
    // without changing the controlled number. This effect never emits changes.
    setRaw(display(value()));
  });
  // A new value from outside replaces text the field refused.
  createEffect(
    on(
      value,
      () => {
        if (focused()) return;
        editStart = undefined;
        setFailure(undefined);
      },
      { defer: true },
    ),
  );
  const refusal = (reason: Refusal) =>
    reason === "negative" ? inputMessages().noNegativeNumbers : inputMessages().notANumber({ example: example() });
  // A form that validates does not submit text the field refuses, also while it is still being typed.
  createEffect(() => {
    const number = parse(raw());
    input?.setCustomValidity(failure() ?? (typeof number === "string" ? refusal(number) : ""));
  });
  /** Commits the current text, or keeps it with an error when the field refuses it. */
  const commitText = () => {
    const number = parse(raw());
    if (typeof number === "string") setFailure(refusal(number));
    else commit(number, true);
  };
  // Enter already committed the current text, so leaving the field does not commit it twice.
  let committedOnEnter = false;
  const onKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (event) => {
    const handler = local.onKeyDown;
    if (typeof handler === "function") handler(event);
    else if (Array.isArray(handler)) handler[0](handler[1], event);
    if (event.defaultPrevented) return;
    // Enter commits before a form submits, so the form sends the normalized number, or nothing for refused text.
    // Both keys keep focus in the field, so keyboard and screen reader users stay in place.
    if (event.key === "Enter") {
      commitText();
      committedOnEnter = true;
      if (plain() || failure()) event.preventDefault();
    } else if (plain() && event.key === "Escape" && parse(raw()) !== value()) {
      // Only an edit in progress swallows Escape; otherwise it reaches an enclosing panel.
      event.preventDefault();
      event.stopPropagation();
      editStart = undefined;
      setFailure(undefined);
      setRaw(display(value()));
    }
  };
  const placeholderText = () => suggested() ?? (typeof rest.placeholder === "string" ? rest.placeholder : "");
  /** What a plain field shows: the formatted value at rest, the text being edited while focused. */
  const shownText = () => {
    const current = value();
    if (!focused() && !failure() && current != null && local.formatValue) return local.formatValue(current);
    return raw() || placeholderText();
  };
  const valueText = () => {
    if (rest["aria-valuetext"] !== undefined) return rest["aria-valuetext"];
    const current = focused() || failure() ? typed() : value();
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
      placeholder={suggested() ?? rest.placeholder}
      required={local.required}
      {...fieldControlAria(
        meta,
        mergeProps(local, {
          get error() {
            return shownError();
          },
        }),
      )}
      aria-describedby={suggestion.describe(fieldDescribedBy(meta, local))}
      aria-valuemin={Number.isFinite(min()) ? min() : undefined}
      aria-valuemax={Number.isFinite(max()) ? max() : undefined}
      aria-valuenow={(focused() || failure() ? typed() : value()) ?? undefined}
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
        if (editStart === undefined) editStart = value() ?? null;
        setRaw(next);
        committedOnEnter = false;
        const number = parse(next);
        if (typeof number !== "string") {
          setFailure(undefined);
          emit(number);
        } else {
          // Without focus (autofill) no blur follows, so the refusal shows at once.
          if (!focused()) setFailure(refusal(number));
          if (!Object.is(value() ?? null, editStart)) emit(editStart);
        }
      }}
      onBlur={() => {
        if (!committedOnEnter) commitText();
        committedOnEnter = false;
        setFocused(false);
      }}
    />
  );

  return (
    <Field
      class={suggestion.field(local.class)}
      label={local.label}
      description={local.description}
      error={shownError()}
      meta={meta}
      required={local.required}
      disabled={rest.disabled}
      labelEnd={suggestion.status}
    >
      {suggestion.under(
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the input inside is the keyboard target; a plain field's row only forwards a pointer click beside the text to it.
        <div
          class="k2b-input-shell k2b-number-input"
          data-appearance={local.appearance ?? "field"}
          data-disabled={rest.disabled ? "true" : undefined}
          data-invalid={shownError() ? "true" : undefined}
          onClick={(event) => {
            if (plain() && event.target !== input && !rest.disabled) input?.focus();
          }}
        >
          <Show when={local.showSteppers ?? !plain()}>
            <button
              type="button"
              class="k2b-number-input__step"
              aria-label={local.decreaseLabel ?? inputMessages().decreaseValue}
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
              aria-label={local.increaseLabel ?? inputMessages().increaseValue}
              disabled={rest.disabled || local.disableSteppers || (value() !== null && value() !== undefined && value()! >= max())}
              onClick={() => stepBy(1)}
            >
              <i class="ti ti-plus" aria-hidden="true" />
            </button>
          </Show>
        </div>,
      )}
    </Field>
  );
}

export default NumberInput;
