import { createEffect, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type TagsInputProps = ValueFieldProps<string[]> & {
  placeholder?: string;
  icon?: string;
  activeIcon?: string;
  maxTags?: number;
  name?: string;
};

export function TagsInput(props: TagsInputProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const announcementId = `k2b-tags-${createUniqueId()}`;
  const error = () => resolveMaybeAccessor(props.error);
  const placeholder = () => props.placeholder ?? messages().tagsPlaceholder;
  const [focused, setFocused] = createSignal(false);
  let focusStartValue: readonly string[] = [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const parseTags = (text: string): string[] => {
    const tags: string[] = [];
    const seen = new Set<string>();
    const limit = props.maxTags === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(props.maxTags));
    for (const rawTag of text.split(",")) {
      const tag = normalize(rawTag);
      if (!tag || seen.has(tag)) continue;
      if (tags.length >= limit) break;
      seen.add(tag);
      tags.push(tag);
    }
    return tags;
  };
  const value = () => parseTags((resolveMaybeAccessor(props.value) ?? []).join(","));
  const [draft, setDraft] = createSignal(value().join(", "));
  createEffect(() => {
    if (!focused()) setDraft(value().join(", "));
  });

  const announce = (previous: readonly string[], next: readonly string[]) => {
    const previousTags = new Set(previous);
    const nextTags = new Set(next);
    const added = next.filter((tag) => !previousTags.has(tag));
    const removed = previous.filter((tag) => !nextTags.has(tag));
    const announcement = document.getElementById(announcementId);
    if (announcement) {
      announcement.textContent = [
        added.length ? messages().tagsAdded({ tags: added.join(", ") }) : "",
        removed.length ? messages().tagsRemoved({ tags: removed.join(", ") }) : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
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
      <div class="k2b-tags-input" data-invalid={error() ? "true" : undefined} data-disabled={props.disabled ? "true" : undefined}>
        <span class="k2b-tags-input__icon" aria-hidden="true">
          <i class={`${props.icon ?? "ti ti-tag"} k2b-tags-input__icon-idle`} />
          <i class={`${props.activeIcon ?? "ti ti-pencil"} k2b-tags-input__icon-active`} />
        </span>
        <Show when={!focused()}>
          <span class="k2b-tags-input__values" aria-hidden="true">
            <Show when={value().length > 0} fallback={<span class="k2b-tags-input__placeholder">{placeholder()}</span>}>
              {value().map((tag) => (
                <span class="k2b-tag">{tag}</span>
              ))}
            </Show>
          </span>
        </Show>
        <input
          id={meta.controlId}
          type="text"
          {...fieldControlAria(meta, props)}
          disabled={props.disabled}
          placeholder={focused() || value().length === 0 ? placeholder() : undefined}
          value={draft()}
          onFocus={() => {
            if (props.disabled) return;
            focusStartValue = value();
            setDraft(focusStartValue.join(", "));
            setFocused(true);
          }}
          onInput={(event) => {
            if (props.disabled) return;
            const nextDraft = event.currentTarget.value;
            setDraft(nextDraft);
            props.onValueChange?.(parseTags(nextDraft));
          }}
          onBlur={() => {
            if (props.disabled) return;
            const next = parseTags(draft());
            announce(focusStartValue, next);
            props.onValueCommit?.(next);
            setFocused(false);
          }}
          onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), event.currentTarget.blur())}
        />
      </div>
      <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value().join(",")} />}</Show>
      <div id={announcementId} class="k2b-sr-only" role="status" aria-live="polite" aria-atomic="true" />
    </Field>
  );
}

export default TagsInput;
