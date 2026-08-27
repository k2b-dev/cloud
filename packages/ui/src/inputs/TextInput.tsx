import { createSignal, type JSX, Show, splitProps } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { Completion } from "./completion";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { MarkdownEditor } from "./markdown/MarkdownEditor";

export type TextInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "onInput" | "prefix" | "suffix" | "type" | "value" | keyof ValueFieldProps<string>
> &
  ValueFieldProps<string> & {
    minLength?: number;
    maxLength?: number;
    type?: "text" | "search" | "email" | "url" | "tel";
    variant?: "default" | "ai";
    icon?: string;
    activeIcon?: string;
    prefix?: JSX.Element;
    suffix?: JSX.Element;
    clearable?: boolean;
    onClear?: () => void;
    clearLabel?: string;
    multiline?: boolean;
    monospace?: boolean;
    password?: boolean;
    markdown?: boolean;
    onSubmit?: () => void;
    lines?: number;
    abbreviations?: Record<string, string>;
    completions?: readonly Completion[];
  };

export function TextInput(props: TextInputProps): JSX.Element {
  const messages = useUiMessages();
  const [local, rest] = splitProps(props, [
    "activeIcon",
    "aria-describedby",
    "aria-label",
    "class",
    "clearLabel",
    "clearable",
    "completions",
    "description",
    "error",
    "icon",
    "id",
    "label",
    "lines",
    "markdown",
    "minLength",
    "maxLength",
    "monospace",
    "multiline",
    "onClear",
    "onValueCommit",
    "onSubmit",
    "onValueChange",
    "password",
    "prefix",
    "required",
    "suffix",
    "type",
    "value",
    "variant",
    "abbreviations",
  ]);
  const meta = createFieldMeta(local.id);
  const value = () => resolveMaybeAccessor(local.value) ?? "";
  const error = () => resolveMaybeAccessor(local.error);
  const [passwordVisible, setPasswordVisible] = createSignal(false);
  const multiline = () => Boolean(local.multiline || local.markdown);
  const icon = () => local.icon ?? (local.variant === "ai" ? "ti ti-sparkles" : local.markdown ? "ti ti-markdown" : "ti ti-cursor-text");
  const activeIcon = () => local.activeIcon ?? (local.variant === "ai" ? "ti ti-sparkles" : "ti ti-pencil");
  const input = (next: string) => local.onValueChange?.(next);
  const commit = (next: string) => local.onValueCommit?.(next);
  const clear = () => {
    if (local.onClear) {
      local.onClear();
      return;
    }
    commitFieldValue(local, "");
  };

  return (
    <Show
      when={local.markdown}
      fallback={
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
            class="k2b-input-shell k2b-text-input"
            data-invalid={error() ? "true" : undefined}
            data-ai={local.variant === "ai" ? "true" : undefined}
            data-multiline={multiline() ? "true" : undefined}
            data-monospace={local.monospace ? "true" : undefined}
            style={multiline() ? { "--k2b-editor-lines": String(local.lines ?? 3) } : undefined}
          >
            <span class="k2b-input-shell__icon k2b-text-input__icon" aria-hidden="true">
              <i class={icon()} />
              <i class={activeIcon()} />
            </span>
            <Show when={local.prefix}>
              <span class="k2b-input-shell__affix">{local.prefix}</span>
            </Show>
            <Show
              when={multiline()}
              fallback={
                <input
                  {...rest}
                  id={meta.controlId}
                  class="k2b-input"
                  type={local.password && !passwordVisible() ? "password" : (local.type ?? "text")}
                  value={value()}
                  minlength={local.minLength}
                  maxlength={local.maxLength}
                  required={local.required}
                  {...fieldControlAria(meta, local)}
                  onInput={(event) => {
                    input(event.currentTarget.value);
                  }}
                  onChange={(event) => commit(event.currentTarget.value)}
                />
              }
            >
              <textarea
                {...(rest as unknown as JSX.TextareaHTMLAttributes<HTMLTextAreaElement>)}
                id={meta.controlId}
                class="k2b-input k2b-text-input__textarea"
                value={value()}
                rows={local.lines ?? 3}
                required={local.required}
                minlength={local.minLength}
                maxlength={local.maxLength}
                {...fieldControlAria(meta, local)}
                onInput={(event) => {
                  input(event.currentTarget.value);
                }}
                onChange={(event) => commit(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (local.onSubmit && event.key === "Enter" && !event.shiftKey && !event.metaKey) {
                    event.preventDefault();
                    local.onSubmit();
                  }
                }}
              />
            </Show>
            <Show when={local.suffix}>
              <span class="k2b-input-shell__affix">{local.suffix}</span>
            </Show>
            <Show when={local.clearable && value() && !multiline() && !local.password && !rest.disabled && !rest.readOnly}>
              <button
                type="button"
                class="k2b-input-shell__clear k2b-input-clear-action"
                aria-label={local.clearLabel ?? messages().clear}
                onClick={clear}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </button>
            </Show>
            <Show when={local.password && !multiline()}>
              <button
                type="button"
                class="k2b-input-shell__clear"
                aria-label={passwordVisible() ? messages().hidePassword : messages().showPassword}
                aria-pressed={passwordVisible()}
                disabled={rest.disabled}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                <i class={passwordVisible() ? "ti ti-eye-off" : "ti ti-eye"} aria-hidden="true" />
              </button>
            </Show>
          </div>
        </Field>
      }
    >
      <MarkdownEditor
        class={local.class}
        label={local.label}
        description={local.description}
        error={error()}
        id={meta.controlId}
        name={rest.name}
        value={value()}
        onValueChange={input}
        onValueCommit={local.onValueCommit}
        onSubmit={local.onSubmit}
        placeholder={rest.placeholder}
        disabled={rest.disabled}
        required={local.required}
        lines={local.lines}
        maxLength={local.maxLength}
        spellcheck={rest.spellcheck === undefined ? undefined : rest.spellcheck === true || rest.spellcheck === "true"}
        abbreviations={local.abbreviations}
        completions={local.completions}
        aria-label={local["aria-label"]}
        aria-describedby={local["aria-describedby"]}
      />
    </Show>
  );
}

export default TextInput;
