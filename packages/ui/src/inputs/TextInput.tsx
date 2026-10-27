import { createSignal, type JSX, Show, splitProps } from "solid-js";
import { isServer } from "solid-js/web";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { Completion } from "./completion";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { useInputMessages } from "./input-messages";
import { MarkdownEditor } from "./markdown/MarkdownEditor";

export type TextInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "onInput" | "prefix" | "suffix" | "type" | "value" | keyof ValueFieldProps<string>
> &
  ValueFieldProps<string> & {
    minLength?: number;
    maxLength?: number;
    type?: "text" | "search" | "email" | "url" | "tel";
    variant?: "default" | "ai" | "compact";
    /** Set false for a plain field without a leading icon. */
    icon?: string | false;
    activeIcon?: string;
    /** ID of a consumer-owned visible error; caller owns its announcement. Native controls only. */
    externalErrorId?: string;
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
  const inputMessages = useInputMessages();
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
    "externalErrorId",
    "icon",
    "id",
    "label",
    "lines",
    "markdown",
    "minLength",
    "maxLength",
    "onKeyDown",
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
  // HTML IDs are single nonempty tokens; numeric starts and punctuation are valid.
  const externalErrorId = () => {
    const id = local.externalErrorId;
    return id && !/[\t\n\f\r ]/.test(id) ? id : undefined;
  };
  const controlMeta = {
    ...meta,
    get errorId() {
      return externalErrorId() ?? meta.errorId;
    },
  };
  const [passwordVisible, setPasswordVisible] = createSignal(false);
  const multiline = () => Boolean(local.multiline || local.markdown);
  const compact = () => local.variant === "compact";
  const icon = () =>
    local.icon === false
      ? ""
      : (local.icon ?? (local.variant === "ai" ? "ti ti-sparkles" : local.markdown ? "ti ti-markdown" : "ti ti-cursor-text"));
  // A custom icon stays while typing (a search field keeps its magnifier); only the default icon switches to the pencil.
  const activeIcon = () => local.activeIcon ?? (local.icon || undefined) ?? (local.variant === "ai" ? "ti ti-sparkles" : "ti ti-pencil");
  // Names, addresses and passwords are typed exactly: phone keyboards must not capitalize or "correct" them.
  const verbatim = () =>
    local.password || local.type === "email" || local.type === "url" || /\b(username|email|url)\b/.test(String(rest.autocomplete ?? ""));
  const input = (next: string) => local.onValueChange?.(next);
  const commit = (next: string) => local.onValueCommit?.(next);
  const submitOnEnter = (event: KeyboardEvent) => {
    if (local.onSubmit && event.key === "Enter" && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      local.onSubmit();
    }
  };
  /** The caller's key handler runs first; Enter submits unless it handled the key. */
  const keyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (event) => {
    const handler = local.onKeyDown;
    if (typeof handler === "function") handler(event);
    else if (Array.isArray(handler)) handler[0](handler[1], event);
    if (!event.defaultPrevented) submitOnEnter(event);
  };
  const clear: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    // Clearing removes the button. Return to the field before notifying the caller, whose handler
    // may deliberately navigate or move focus somewhere else.
    event.currentTarget.ownerDocument.getElementById(meta.controlId)?.focus();
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
          error={externalErrorId() ? undefined : error()}
          meta={meta}
          required={local.required}
          disabled={rest.disabled}
        >
          <div
            class="k2b-input-shell k2b-text-input"
            data-variant={compact() ? "compact" : undefined}
            data-invalid={error() ? "true" : undefined}
            data-ai={local.variant === "ai" ? "true" : undefined}
            data-multiline={multiline() ? "true" : undefined}
            data-monospace={local.monospace ? "true" : undefined}
            style={multiline() ? { "--k2b-editor-lines": String(local.lines ?? 3) } : undefined}
          >
            <Show when={!compact() && local.icon !== false}>
              <span class="k2b-input-shell__icon k2b-text-input__icon" aria-hidden="true">
                <i class={icon()} />
                <i class={activeIcon()} />
              </span>
            </Show>
            <Show when={local.prefix}>
              <span class="k2b-input-shell__affix">{local.prefix}</span>
            </Show>
            <Show
              when={multiline()}
              fallback={
                <input
                  autocapitalize={verbatim() ? "none" : undefined}
                  autocorrect={verbatim() ? "off" : undefined}
                  spellcheck={verbatim() ? false : undefined}
                  {...rest}
                  id={meta.controlId}
                  class="k2b-input"
                  size={rest.size ?? (compact() ? 9 : undefined)}
                  type={local.password && !passwordVisible() ? "password" : (local.type ?? "text")}
                  value={value()}
                  minlength={local.minLength}
                  maxlength={local.maxLength}
                  required={local.required}
                  {...fieldControlAria(controlMeta, local)}
                  onInput={(event) => {
                    input(event.currentTarget.value);
                  }}
                  onChange={(event) => commit(event.currentTarget.value)}
                  onKeyDown={keyDown}
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
                {...fieldControlAria(controlMeta, local)}
                onInput={(event) => {
                  input(event.currentTarget.value);
                }}
                onChange={(event) => commit(event.currentTarget.value)}
                onKeyDown={submitOnEnter}
              >
                {/* HTML consumes one leading newline in textarea content. */}
                {isServer ? `\n${value()}` : undefined}
              </textarea>
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
                aria-label={passwordVisible() ? inputMessages().hidePassword : inputMessages().showPassword}
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
