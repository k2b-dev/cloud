import { createEffect, createSignal, type JSX, mergeProps, on, splitProps } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { useInputMessages } from "./input-messages";
import { filterTimeText, parseTimeText, snapTime, timeLimitError } from "./time-input";

export type TimeInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "max" | "min" | "onChange" | "onInput" | "step" | "type" | "value" | keyof ValueFieldProps<string | null>
> &
  ValueFieldProps<string | null> & {
    /** The earliest allowed time, `HH:mm`. */
    min?: string;
    /** The latest allowed time, `HH:mm`; 23:59 by default. `24:00` allows the end of the day, as for "until midnight". */
    max?: string;
    /** The minute grid a committed time snaps to, counted from `min` or midnight; 1 by default. */
    step?: number;
  };

/**
 * A 24-hour clock time field. The value is `HH:mm` or `null`. People type `9`, `930` or `9:30` with the numeric
 * keypad; Enter or leaving the field commits `09:30`. A text that is no allowed time stays for correction, says
 * why, and keeps the value.
 */
export function TimeInput(props: TimeInputProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "aria-describedby",
    "aria-label",
    "class",
    "description",
    "error",
    "id",
    "label",
    "max",
    "min",
    "onBlur",
    "onKeyDown",
    "onValueChange",
    "onValueCommit",
    "placeholder",
    "required",
    "step",
    "value",
  ]);
  const t = useInputMessages();
  const meta = createFieldMeta(local.id);
  const value = () => resolveMaybeAccessor(local.value) ?? null;
  const [text, setText] = createSignal(value() ?? "");
  const [dirty, setDirty] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  let input: HTMLInputElement | undefined;

  const shownError = () => failure() ?? resolveMaybeAccessor(local.error);
  const aria = fieldControlAria(
    meta,
    mergeProps(local, {
      get error() {
        return shownError();
      },
    }),
  );
  const limits = () => ({ min: local.min, max: local.max });
  /** The committed form of a text, or the reason it is refused. */
  const resolve = (current: string): { value: string | null } | { failure: string } => {
    const result = parseTimeText(current);
    if (result.kind === "empty") return local.required ? { failure: t().timeRequired } : { value: null };
    if (result.kind === "error") return { failure: t().notATime };
    const snapped = snapTime(result.value, local.step, local.min);
    const limit = timeLimitError(snapped, limits());
    if (limit)
      return { failure: limit.code === "earliest" ? t().earliestTime({ time: limit.time }) : t().latestTime({ time: limit.time }) };
    return { value: snapped };
  };

  // A value set from outside replaces the text, unless someone is typing.
  createEffect(
    on(value, (next) => {
      if (dirty()) return;
      setText(next ?? "");
      setFailure(undefined);
    }),
  );
  // A form that validates does not submit a refused text.
  createEffect(() => input?.setCustomValidity(failure() ?? ""));

  const commit = () => {
    const outcome = resolve(text());
    setDirty(false);
    if ("failure" in outcome) {
      setFailure(outcome.failure);
      return;
    }
    setFailure(undefined);
    setText(outcome.value ?? "");
    if (outcome.value !== value()) commitFieldValue(local, outcome.value);
  };
  const restore = () => {
    setText(value() ?? "");
    setDirty(false);
    setFailure(undefined);
  };

  const onKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (event) => {
    const handler = local.onKeyDown;
    if (typeof handler === "function") handler(event);
    else if (Array.isArray(handler)) handler[0](handler[1], event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && (dirty() || failure())) {
      commit();
      // A committed time lets Enter submit the form with it; a refused text keeps Enter.
      if (failure()) event.preventDefault();
    } else if (event.key === "Escape" && (dirty() || failure())) {
      // Only an edit in progress swallows Escape; otherwise it reaches an enclosing dialog.
      event.preventDefault();
      event.stopPropagation();
      restore();
    }
  };

  return (
    <Field
      class={local.class}
      label={local.label}
      description={local.description}
      error={shownError()}
      meta={meta}
      required={local.required}
      disabled={rest.disabled}
    >
      <div
        class="k2b-input-shell k2b-text-input k2b-time-input"
        data-disabled={rest.disabled ? "true" : undefined}
        data-invalid={shownError() ? "true" : undefined}
      >
        <input
          {...rest}
          ref={input}
          {...aria}
          id={meta.controlId}
          class="k2b-input"
          type="text"
          inputMode="numeric"
          autocomplete="off"
          spellcheck={false}
          maxLength={5}
          placeholder={local.placeholder ?? t().timeLetters}
          value={text()}
          required={local.required}
          onInput={(event) => {
            const field = event.currentTarget;
            const next = filterTimeText(field.value);
            // Only write back what the filter changed; rewriting an unchanged value moves the caret to the end.
            if (next !== field.value) field.value = next;
            setText(next);
            setDirty(true);
            // A refused text stops being red once it means an allowed time.
            if (failure() && !("failure" in resolve(next))) setFailure(undefined);
          }}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (dirty()) commit();
            const handler = local.onBlur;
            if (typeof handler === "function") handler(event);
            else if (Array.isArray(handler)) handler[0](handler[1], event);
          }}
        />
      </div>
    </Field>
  );
}
