import { highlight } from "@k2b/stdlib";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../../internal/field";
import { useUiMessages } from "../../intl/messages";
import {
  abbreviations as abbreviationsCompletion,
  buildSuggestContext,
  type Completion,
  collectKnownLabels,
  createCompletionBehaviorState,
  detectQuery,
  displayLabel,
  type QueryContext,
  renderWithOverlay,
  resolveSuggestions,
  type Suggestion,
} from "../completion";
import type { ValueFieldProps } from "../field-contract";
import { resolveMaybeAccessor } from "../field-contract";
import { computeActiveFormats } from "./active-formats";
import { handleListContinuation, handleShortcut, handleSmartPaste } from "./behaviors";
import { isInCodeZone } from "./code-zone";
import Toolbar from "./Toolbar";

export type MarkdownEditorProps = ValueFieldProps<string> & {
  onSubmit?: () => void;
  placeholder?: string;
  lines?: number;
  noToolbar?: boolean;
  spellcheck?: boolean;
  name?: string;
  maxLength?: number;
  textareaRef?: (element: HTMLTextAreaElement) => void;
  abbreviations?: Record<string, string>;
  completions?: readonly Completion[];
  showStats?: boolean;
  variant?: "default" | "paper";
  fill?: boolean;
  onSave?: () => void;
  saveDisabled?: boolean;
  saving?: boolean;
  toolbarTrailing?: JSX.Element;
};

type CompletionState = {
  context: QueryContext;
  suggestions: readonly Suggestion[];
  selectedIndex: number;
};

export function MarkdownEditor(props: MarkdownEditorProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  let textarea: HTMLTextAreaElement | undefined;
  let preview: HTMLDivElement | undefined;
  let dropdown: HTMLDivElement | undefined;
  let completionAbort: AbortController | null = null;
  let completionTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayFrame: number | undefined;
  let overlayInitialized = false;
  let renderPendingOverlay: (() => void) | undefined;
  const completionBehavior = createCompletionBehaviorState();

  const [textareaSignal, setTextareaSignal] = createSignal<HTMLTextAreaElement | null>(null);
  const [activeFormats, setActiveFormats] = createSignal<Set<string>>(new Set());
  const [composing, setComposing] = createSignal(false);
  const [localValue, setLocalValue] = createSignal(resolveMaybeAccessor(props.value) ?? "");
  const error = () => resolveMaybeAccessor(props.error);
  const [state, setState] = createSignal<CompletionState | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [completionError, setCompletionError] = createSignal<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = createSignal(false);
  const completionId = createUniqueId();
  const listboxId = `${meta.controlId}-${completionId}-suggestions`;
  const optionId = (index: number): string => `${listboxId}-${index}`;
  const activeSuggestion = (): Suggestion | null => {
    const current = state();
    return current?.suggestions[current.selectedIndex] ?? null;
  };

  const mergedCompletions = createMemo<readonly Completion[] | undefined>(() => {
    const merged: Completion[] = [];
    if (props.abbreviations && Object.keys(props.abbreviations).length > 0) {
      merged.push(abbreviationsCompletion(props.abbreviations));
    }
    if (props.completions) merged.push(...props.completions);
    return merged.length > 0 ? merged : undefined;
  });
  const knownLabels = createMemo(() => collectKnownLabels(mergedCompletions()));

  createEffect(() => {
    const incoming = resolveMaybeAccessor(props.value);
    if (incoming !== undefined && incoming !== null && incoming !== untrack(localValue)) {
      setLocalValue(incoming);
    }
  });

  createEffect(() => {
    const target = localValue();
    if (!composing() && textarea && textarea.value !== target) {
      textarea.value = target;
    }
  });

  createEffect(() => {
    if (!preview) return;
    const value = localValue();
    const labels = knownLabels();
    const current = state();
    const active = activeSuggestion();
    const ghost =
      current && active
        ? {
            at: current.context.end,
            text: active.text.slice(current.context.text.length),
          }
        : undefined;
    const anchor = current && !ghost ? { at: current.context.end } : undefined;
    renderPendingOverlay = () => {
      if (!preview) return;
      preview.innerHTML = renderWithOverlay(value, (text) => highlight.markdown(text, { knownLabels: labels }), { ghost, anchor });
      if (textarea) {
        preview.scrollTop = textarea.scrollTop;
        preview.scrollLeft = textarea.scrollLeft;
      }
      if (dropdown?.matches(":popover-open")) positionDropdown();
    };
    if (!overlayInitialized) {
      overlayInitialized = true;
      renderPendingOverlay();
      renderPendingOverlay = undefined;
      return;
    }
    if (overlayFrame !== undefined) return;
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = undefined;
      const render = renderPendingOverlay;
      renderPendingOverlay = undefined;
      render?.();
    });
  });

  const updateActiveFormats = (): void => {
    if (textarea) setActiveFormats(computeActiveFormats(textarea));
  };

  const closeDropdown = (): void => {
    if (dropdown?.matches(":popover-open")) dropdown.hidePopover();
    setDropdownOpen(false);
  };

  const clearCompletion = (): void => {
    completionAbort?.abort();
    completionAbort = null;
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = null;
    setState(null);
    setLoading(false);
    setCompletionError(null);
    closeDropdown();
  };

  const positionDropdown = (): void => {
    if (!dropdown?.isConnected || !preview?.isConnected || !textarea?.isConnected) {
      return;
    }
    const anchor = preview.querySelector<HTMLElement>("[data-completion-anchor]");
    const rect = anchor?.getBoundingClientRect() ?? textarea.getBoundingClientRect();
    const maxHeight = 260;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < maxHeight && rect.top > spaceBelow;
    const width = Math.min(280, window.innerWidth - 16);
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    dropdown.style.setProperty("left", `${Math.max(8, left)}px`, "important");
    dropdown.style.setProperty("width", `${width}px`, "important");
    if (openAbove) {
      dropdown.style.setProperty("top", "auto", "important");
      dropdown.style.setProperty("bottom", `${window.innerHeight - rect.top + 4}px`, "important");
    } else {
      dropdown.style.setProperty("top", `${rect.bottom + 4}px`, "important");
      dropdown.style.setProperty("bottom", "auto", "important");
    }
    if (!dropdown.matches(":popover-open")) dropdown.showPopover();
  };

  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException
      ? error.name === "AbortError"
      : Boolean(error && typeof error === "object" && "name" in error && (error as { name: string }).name === "AbortError");

  const applySuggestionList = (context: QueryContext, suggestions: readonly Suggestion[]): void => {
    const value = localValue();
    const normalized = context.text.toLowerCase();
    const usable = suggestions.filter((suggestion) => {
      if (suggestion.textEdit) {
        const { start, end, text } = suggestion.textEdit;
        return (
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end >= start &&
          end <= value.length &&
          value.slice(start, end) !== text
        );
      }
      return suggestion.text.toLowerCase().startsWith(normalized) && suggestion.text.length > context.text.length;
    });
    if (usable.length === 0) {
      setState(null);
      closeDropdown();
      return;
    }
    const previous = activeSuggestion()?.text;
    const retained = previous ? usable.findIndex((suggestion) => suggestion.text === previous) : -1;
    setState({
      context,
      suggestions: usable,
      selectedIndex: retained >= 0 ? retained : 0,
    });
    if (context.completion.dropdown) {
      setDropdownOpen(true);
      queueMicrotask(positionDropdown);
    } else {
      closeDropdown();
    }
  };

  const runAsyncCompletion = async (context: QueryContext, promise: Promise<readonly Suggestion[]>, signal: AbortSignal): Promise<void> => {
    try {
      const suggestions = await promise;
      if (signal.aborted) return;
      setLoading(false);
      applySuggestionList(context, suggestions);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      setLoading(false);
      setState(null);
      setCompletionError(error instanceof Error ? error.message : "Suggestions could not be loaded");
      setDropdownOpen(true);
      queueMicrotask(positionDropdown);
    }
  };

  const startCompletionResolution = (context: QueryContext, signal: AbortSignal): void => {
    if (signal.aborted || !textarea) return;
    setLoading(true);
    setCompletionError(null);
    setDropdownOpen(true);
    queueMicrotask(positionDropdown);
    try {
      const result = resolveSuggestions(context.completion, context.query, buildSuggestContext(textarea, context), signal);
      if (result.kind === "sync") {
        setLoading(false);
        applySuggestionList(context, result.data);
      } else {
        void runAsyncCompletion(context, result.promise, signal);
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      setLoading(false);
      setState(null);
      setCompletionError(error instanceof Error ? error.message : "Suggestions could not be loaded");
      queueMicrotask(positionDropdown);
    }
  };

  const recomputeCompletion = (): void => {
    if (!textarea) return;
    const context = detectQuery(textarea, mergedCompletions(), {
      isExcluded: isInCodeZone,
    });
    if (!context) {
      clearCompletion();
      return;
    }
    completionAbort?.abort();
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = null;
    completionAbort = new AbortController();
    const current = state();
    if (
      current &&
      (current.context.start !== context.start ||
        current.context.end !== context.end ||
        current.context.text !== context.text ||
        current.context.completion !== context.completion)
    ) {
      setState(null);
      closeDropdown();
    }
    setCompletionError(null);
    const delay = Math.max(0, context.completion.debounceMs ?? 0);
    if (delay === 0) {
      startCompletionResolution(context, completionAbort.signal);
    } else {
      setLoading(false);
      if (!state()) closeDropdown();
      const signal = completionAbort.signal;
      completionTimer = setTimeout(() => {
        completionTimer = null;
        startCompletionResolution(context, signal);
      }, delay);
    }
  };

  const retryCompletion = (): void => {
    if (!textarea) return;
    const context = detectQuery(textarea, mergedCompletions(), {
      isExcluded: isInCodeZone,
    });
    if (!context) return clearCompletion();
    completionAbort?.abort();
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = null;
    completionAbort = new AbortController();
    startCompletionResolution(context, completionAbort.signal);
  };

  const activateSuggestion = (index = state()?.selectedIndex ?? -1): boolean => {
    const current = state();
    const active = current?.suggestions[index];
    if (!textarea || !current || !active) return false;
    if (!active.textEdit && active.text === current.context.text) {
      closeDropdown();
      setState(null);
      return false;
    }
    const applied = completionBehavior.applySuggestion(textarea, current.context, active);
    closeDropdown();
    setState(null);
    return applied;
  };

  const moveSelection = (direction: 1 | -1): void => {
    const current = state();
    if (!current || current.suggestions.length === 0) return;
    setState({
      ...current,
      selectedIndex: (current.selectedIndex + direction + current.suggestions.length) % current.suggestions.length,
    });
  };

  const stats = createMemo(() => {
    const value = localValue();
    return {
      lines: value.length === 0 ? 0 : value.split("\n").length,
      words: value.match(/\S+/g)?.length ?? 0,
      chars: value.length,
    };
  });

  onMount(() => {
    if (textarea) setTextareaSignal(textarea);
    updateActiveFormats();
    const selectionChange = (): void => {
      if (document.activeElement === textarea) {
        updateActiveFormats();
        recomputeCompletion();
      }
    };
    // Reposition an OPEN popover only. Calling `positionDropdown` blindly
    // would `showPopover()` a dropdown that is deliberately closed (a
    // ghost-only completion keeps state without a dropdown).
    const reposition = (): void => {
      if (dropdown?.matches(":popover-open")) positionDropdown();
    };
    document.addEventListener("selectionchange", selectionChange);
    window.addEventListener("resize", reposition);
    onCleanup(() => {
      document.removeEventListener("selectionchange", selectionChange);
      window.removeEventListener("resize", reposition);
      if (dropdown?.matches(":popover-open")) dropdown.hidePopover();
      completionAbort?.abort();
      if (completionTimer) clearTimeout(completionTimer);
      if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame);
      overlayFrame = undefined;
      renderPendingOverlay = undefined;
      completionBehavior.reset();
    });
  });

  const onInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }): void => {
    if (
      completionBehavior.tryExpand(event.currentTarget, mergedCompletions(), {
        isExcluded: isInCodeZone,
      })
    ) {
      return;
    }
    setLocalValue(event.currentTarget.value);
    props.onValueChange?.(event.currentTarget.value);
    updateActiveFormats();
    recomputeCompletion();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!textarea || event.isComposing) return;
    if (
      event.key === "Backspace" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      completionBehavior.tryRestore(textarea)
    ) {
      event.preventDefault();
      return;
    }
    const current = state();
    const dropdownCompletion = current?.context.completion.dropdown === true;
    if (current && dropdownCompletion && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      current &&
      dropdownCompletion &&
      dropdownOpen()
    ) {
      event.preventDefault();
      activateSuggestion();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && current) {
      event.preventDefault();
      activateSuggestion();
      return;
    }
    if (event.key === "Escape") {
      if (current) {
        event.preventDefault();
        closeDropdown();
        setState(null);
        return;
      }
      if ((mergedCompletions()?.length ?? 0) > 0) {
        event.preventDefault();
        textarea.blur();
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && props.onSubmit) {
      event.preventDefault();
      props.onSubmit();
      return;
    }
    if (handleShortcut(event, textarea)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && handleListContinuation(textarea)) {
      event.preventDefault();
    }
  };

  const saveControls = (): JSX.Element => (
    <>
      {props.toolbarTrailing}
      <Show when={props.onSave}>
        <button
          type="button"
          class="k2b-markdown-editor__tool"
          title={messages().saveShortcut}
          aria-label={messages().save}
          tabIndex={-1}
          disabled={props.disabled || props.saveDisabled || props.saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onSave?.()}
        >
          <i class={props.saving ? "ti ti-loader-2 k2b-spin" : "ti ti-device-floppy"} aria-hidden="true" />
        </button>
      </Show>
    </>
  );

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={props.error}
      fill={props.fill}
      meta={meta}
      required={props.required}
      disabled={props.disabled}
    >
      <div
        class="k2b-markdown-editor"
        role="group"
        aria-labelledby={props.label ? meta.labelId : undefined}
        aria-label={!props.label ? props["aria-label"] : undefined}
        data-disabled={props.disabled ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
        data-variant={props.variant === "paper" ? "paper" : undefined}
        data-fill={props.fill ? "true" : undefined}
        style={{
          "--k2b-editor-lines": String(props.lines ?? 6),
        }}
        onKeyDown={(event) => {
          if (props.onSave && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (!props.saveDisabled && !props.saving) props.onSave();
          }
        }}
      >
        <Show when={!props.noToolbar}>
          <Toolbar textarea={textareaSignal} activeFormats={activeFormats} disabled={props.disabled} trailing={saveControls()} />
        </Show>
        <div class="k2b-markdown-editor__surface">
          <Show when={!localValue() && props.placeholder}>
            <div class="k2b-markdown-editor__placeholder" aria-hidden="true">
              {props.placeholder}
            </div>
          </Show>
          <div ref={preview} class="k2b-markdown-editor__preview" aria-hidden="true" />
          <textarea
            ref={(element) => {
              textarea = element;
              props.textareaRef?.(element);
            }}
            id={meta.controlId}
            name={props.name}
            class="k2b-markdown-editor__input"
            onInput={onInput}
            onChange={(event) => props.onValueCommit?.(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (textarea && handleSmartPaste(event, textarea)) {
                event.preventDefault();
              }
            }}
            onScroll={(event) => {
              if (preview) {
                preview.scrollTop = event.currentTarget.scrollTop;
                preview.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onBlur={(event) => {
              const next = event.relatedTarget as HTMLElement | null;
              if (next && dropdown?.contains(next)) return;
              completionBehavior.reset();
              clearCompletion();
            }}
            disabled={props.disabled}
            required={props.required}
            spellcheck={props.spellcheck ?? true}
            maxLength={props.maxLength}
            {...fieldControlAria(meta, props)}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={dropdownOpen() ? listboxId : undefined}
            aria-activedescendant={dropdownOpen() && state() ? optionId(state()!.selectedIndex) : undefined}
          />
        </div>
        <Show when={(props.showStats ?? true) && !props.disabled}>
          <div class="k2b-markdown-editor__stats" aria-hidden="true" data-empty={stats().chars === 0 ? "true" : undefined}>
            <span>
              {stats().lines} {stats().lines === 1 ? "line" : "lines"}
            </span>
            <span>
              {stats().words} {stats().words === 1 ? "word" : "words"}
            </span>
            <span>
              {stats().chars} {stats().chars === 1 ? "char" : "chars"}
            </span>
          </div>
        </Show>
        <Show when={state() || loading() || completionError()}>
          <div
            ref={dropdown}
            popover="manual"
            class="k2b-autocomplete__options"
            role="presentation"
            aria-label={messages().completionSuggestions}
          >
            <div id={listboxId} class="k2b-autocomplete__listbox" role="listbox" aria-label={messages().suggestions}>
              <Show when={loading()}>
                <div class="k2b-autocomplete__status" role="status">
                  <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                  Loading suggestions
                </div>
              </Show>
              <Show when={completionError()}>
                {(message) => (
                  <div class="k2b-autocomplete__status" data-error="true" role="alert">
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    <span>{message()}</span>
                    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={retryCompletion}>
                      {messages().retry}
                    </button>
                  </div>
                )}
              </Show>
              <For each={state()?.suggestions ?? []}>
                {(suggestion, index) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the owning textarea handles keyboard activation through aria-activedescendant.
                  <div
                    id={optionId(index())}
                    class="k2b-autocomplete__option"
                    role="option"
                    aria-selected={index() === state()?.selectedIndex}
                    onMouseEnter={() => {
                      const current = state();
                      if (current) {
                        setState({ ...current, selectedIndex: index() });
                      }
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      activateSuggestion(index());
                      textarea?.focus();
                    }}
                  >
                    <span>{displayLabel(suggestion, state()!.context.completion)}</span>
                    <Show when={suggestion.hint}>{(hint) => <small>{hint()}</small>}</Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Field>
  );
}

export type { Completion, SuggestContext, Suggestion } from "../completion";
export { abbreviations } from "../completion";
