import { For, type JSX, Show, splitProps } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { FieldProps, MaybeAccessor, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";

export type PinInputProps = ValueFieldProps<string> & {
  length?: number;
  name?: string;
  stretch?: boolean;
  password?: boolean;
  readOnly?: boolean;
  onSubmit?: () => void;
};

export function PinInput(props: PinInputProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const length = () => Math.max(1, props.length ?? 6);
  let inputs: HTMLInputElement[] = [];
  const digits = () => (resolveMaybeAccessor(props.value) ?? "").replace(/\D/g, "").slice(0, length());
  const error = () => resolveMaybeAccessor(props.error);
  const emit = (value: string) => {
    props.onValueChange?.(value);
    if (value.length === length()) props.onValueCommit?.(value);
  };

  const updateDigit = (index: number, input: string) => {
    if (props.disabled || props.readOnly) return;
    const digit = input.replace(/\D/g, "").slice(-1);
    const current = digits();
    emit(`${current.slice(0, index)}${digit}${current.slice(index + 1)}`);
    if (digit && index < length() - 1) {
      inputs[index + 1]?.focus();
      inputs[index + 1]?.select();
    }
  };

  const handleKeyDown = (index: number, event: KeyboardEvent) => {
    if (props.disabled || props.readOnly) return;
    if (event.key === "Enter" && props.onSubmit && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      props.onSubmit();
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inputs[index - 1]?.focus();
      inputs[index - 1]?.select();
    } else if (event.key === "ArrowRight" && index < length() - 1) {
      event.preventDefault();
      inputs[index + 1]?.focus();
      inputs[index + 1]?.select();
    } else if (event.key === "Backspace" && !digits()[index] && index > 0) {
      event.preventDefault();
      const current = digits();
      emit(`${current.slice(0, index - 1)}${current.slice(index)}`);
      inputs[index - 1]?.focus();
      inputs[index - 1]?.select();
    }
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (props.disabled || props.readOnly) return;
    const pasted = event.clipboardData?.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    event.preventDefault();
    const focused = inputs.indexOf(document.activeElement as HTMLInputElement);
    const start = focused >= 0 ? focused : 0;
    const insert = pasted.slice(0, length() - start);
    const current = digits();
    emit(`${current.slice(0, start)}${insert}${current.slice(start + insert.length)}`.slice(0, length()));
    const next = Math.min(start + insert.length, length() - 1);
    inputs[next]?.focus();
    inputs[next]?.select();
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
        class="k2b-pin-input"
        id={meta.controlId}
        data-stretch={props.stretch ? "true" : undefined}
        role="group"
        {...fieldControlAria(meta, props)}
        onPaste={handlePaste}
      >
        <For each={Array.from({ length: length() })}>
          {(_, index) => (
            <input
              ref={(element) => {
                inputs[index()] = element;
              }}
              class="k2b-control k2b-pin-input__digit"
              data-filled={digits()[index()] ? "true" : undefined}
              type={props.password ? "password" : "text"}
              inputmode="numeric"
              autocomplete="off"
              pattern="[0-9]"
              maxlength={1}
              value={digits()[index()] ?? ""}
              required={props.required}
              disabled={props.disabled}
              readOnly={props.readOnly}
              aria-label={messages().pinDigit({ index: index() + 1, total: length() })}
              onInput={(event) => updateDigit(index(), event.currentTarget.value)}
              onKeyDown={(event) => handleKeyDown(index(), event)}
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </For>
      </div>
      <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={digits()} />}</Show>
    </Field>
  );
}

export type SliderProps = FieldProps &
  Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onInput" | "onChange" | keyof FieldProps> &
  ValueFieldProps<number> & {
    value: MaybeAccessor<number>;
    formatValue?: (value: number) => string;
    showValue?: boolean;
    center?: boolean;
    defaultValue?: number;
  };

export function Slider(props: SliderProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "aria-describedby",
    "aria-label",
    "center",
    "class",
    "defaultValue",
    "description",
    "error",
    "id",
    "label",
    "onValueChange",
    "onValueCommit",
    "required",
    "showValue",
    "value",
    "formatValue",
  ]);
  const meta = createFieldMeta(local.id);
  const min = () => Number(rest.min ?? 0);
  const max = () => Number(rest.max ?? 100);
  const value = () => resolveMaybeAccessor(local.value) ?? min();
  const error = () => resolveMaybeAccessor(local.error);
  const percentage = () => {
    const span = max() - min();
    return span <= 0 ? 0 : Math.min(100, Math.max(0, ((value() - min()) / span) * 100));
  };
  const track = () => {
    const position = percentage();
    if (local.center) {
      const low = Math.min(50, position);
      const high = Math.max(50, position);
      return `linear-gradient(to right, var(--k2b-surface-muted) 0 ${low}%, var(--k2b-action) ${low}% ${high}%, var(--k2b-surface-muted) ${high}% 100%)`;
    }
    return `linear-gradient(to right, var(--k2b-action) 0 ${position}%, var(--k2b-surface-muted) ${position}% 100%)`;
  };
  const resetValue = () => local.defaultValue ?? (local.center ? (min() + max()) / 2 : min());

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
      <div class="k2b-slider">
        <input
          {...rest}
          id={meta.controlId}
          type="range"
          value={value()}
          style={{ background: track() }}
          {...fieldControlAria(meta, local)}
          onInput={(event) => local.onValueChange?.(event.currentTarget.valueAsNumber)}
          onChange={(event) => local.onValueCommit?.(event.currentTarget.valueAsNumber)}
          onDblClick={() => {
            const next = resetValue();
            commitFieldValue(local, next);
          }}
        />
        <Show when={local.showValue ?? true}>
          <output for={meta.controlId}>{local.formatValue?.(value()) ?? value()}</output>
        </Show>
      </div>
    </Field>
  );
}

export type ColorInputProps = ValueFieldProps<string> & {
  name?: string;
  compact?: boolean;
  transparent?: boolean;
  transparentValue?: MaybeAccessor<boolean>;
  onTransparentValueChange?: (value: boolean) => void;
};

export function ColorInput(props: ColorInputProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const currentColor = () => resolveMaybeAccessor(props.value) || "#3b82f6";
  const isTransparent = () => resolveMaybeAccessor(props.transparentValue) ?? false;
  const error = () => resolveMaybeAccessor(props.error);
  const compact = () => props.compact ?? !props.label;
  let picker: HTMLInputElement | undefined;

  const control = () =>
    compact() ? (
      <span class="k2b-color-input k2b-color-input--compact">
        <button
          type="button"
          class="k2b-color-input__swatch"
          style={{ "background-color": currentColor() }}
          disabled={props.disabled}
          {...fieldControlAria(meta, props)}
          onClick={() => picker?.click()}
        />
        <input
          ref={picker}
          id={meta.controlId}
          class="k2b-color-input__native"
          type="color"
          name={props.name}
          value={currentColor()}
          disabled={props.disabled}
          onInput={(event) => props.onValueChange?.(event.currentTarget.value)}
          onChange={(event) => props.onValueCommit?.(event.currentTarget.value)}
        />
      </span>
    ) : (
      <div
        class="k2b-color-input"
        data-disabled={props.disabled || isTransparent() ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
      >
        <button
          type="button"
          class="k2b-color-input__value"
          disabled={props.disabled || isTransparent()}
          {...fieldControlAria(meta, props)}
          onClick={() => picker?.click()}
        >
          <span
            class="k2b-color-input__swatch"
            data-transparent={isTransparent() ? "true" : undefined}
            style={isTransparent() ? undefined : { "background-color": currentColor() }}
          />
          <code>{isTransparent() ? "transparent" : currentColor().toUpperCase()}</code>
        </button>
        <Show when={props.transparent}>
          <button
            type="button"
            class="k2b-color-input__transparent"
            aria-label={isTransparent() ? messages().useColor : messages().useTransparent}
            aria-pressed={isTransparent()}
            disabled={props.disabled}
            onClick={() => props.onTransparentValueChange?.(!isTransparent())}
          >
            <i class="ti ti-grid-dots" aria-hidden="true" />
          </button>
        </Show>
        <input
          ref={picker}
          id={meta.controlId}
          class="k2b-color-input__native"
          type="color"
          name={props.name}
          value={currentColor()}
          disabled={props.disabled || isTransparent()}
          onInput={(event) => props.onValueChange?.(event.currentTarget.value)}
          onChange={(event) => props.onValueCommit?.(event.currentTarget.value)}
        />
      </div>
    );

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={error()}
      meta={meta}
      required={props.required}
      disabled={props.disabled}
    >
      {control()}
    </Field>
  );
}
