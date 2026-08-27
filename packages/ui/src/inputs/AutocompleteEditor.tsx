import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import {
  buildSuggestContext,
  type Completion,
  createCompletionBehaviorState,
  detectQuery,
  displayLabel,
  plainTextHighlight,
  type QueryContext,
  renderWithOverlay,
  resolveSuggestions,
  type Suggestion,
} from "./completion";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type AutocompleteEditorProps = ValueFieldProps<string> & {
  onSubmit?: () => void;
  completions?: readonly Completion[];
  restoreExpansionOnBackspace?: boolean;
  highlight?: (text: string) => string;
  singleLine?: boolean;
  lines?: number;
  fill?: boolean;
  placeholder?: string;
  spellcheck?: boolean;
  name?: string;
  maxLength?: number;
  textareaRef?: (element: HTMLTextAreaElement) => void;
  variant?: "default" | "paper";
};

type CompletionState = {
  context: QueryContext;
  suggestions: readonly Suggestion[];
  selectedIndex: number;
};

export function AutocompleteEditor(props: AutocompleteEditorProps): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  let textarea: HTMLTextAreaElement | undefined;
  let preview: HTMLDivElement | undefined;
  let dropdown: HTMLDivElement | undefined;
  let currentAbort: AbortController | null = null;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayFrame: number | undefined;
  let overlayInitialized = false;
  let renderPendingOverlay: (() => void) | undefined;
  const completionBehavior = createCompletionBehaviorState();

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
  const useOverlay = createMemo(() => Boolean(props.highlight));
  const activeSuggestion = (): Suggestion | null => {
    const current = state();
    return current?.suggestions[current.selectedIndex] ?? null;
  };

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

  const suggestionGhost = (current: CompletionState, suggestion: Suggestion): { at: number; text: string } | undefined => {
    const edit = suggestion.textEdit;
    if (!edit) {
      return {
        at: current.context.end,
        text: suggestion.text.slice(current.context.text.length),
      };
    }
    if (edit.end !== current.context.end) return undefined;
    const replacing = localValue().slice(edit.start, edit.end);
    if (!edit.text.toLowerCase().startsWith(replacing.toLowerCase())) {
      return undefined;
    }
    return { at: edit.end, text: edit.text.slice(replacing.length) };
  };

  createEffect(() => {
    if (!preview) {
      if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame);
      overlayFrame = undefined;
      renderPendingOverlay = undefined;
      overlayInitialized = false;
      return;
    }
    const value = localValue();
    const highlighter = props.highlight ?? plainTextHighlight;
    const current = state();
    const active = activeSuggestion();
    const ghost = current && active ? suggestionGhost(current, active) : undefined;
    const anchor = current ? { at: current.context.start } : undefined;
    renderPendingOverlay = () => {
      if (!preview) return;
      preview.innerHTML = renderWithOverlay(value, highlighter, { ghost, anchor });
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

  const closeDropdown = (): void => {
    if (dropdown?.matches(":popover-open")) dropdown.hidePopover();
    setDropdownOpen(false);
  };

  const clearCompletion = (): void => {
    currentAbort?.abort();
    currentAbort = null;
    if (currentTimer) clearTimeout(currentTimer);
    currentTimer = null;
    setState(null);
    setLoading(false);
    setCompletionError(null);
    closeDropdown();
  };

  const positionDropdown = (): void => {
    if (!dropdown?.isConnected || !textarea?.isConnected) return;
    const anchor = preview?.querySelector<HTMLElement>("[data-completion-anchor]");
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
    const currentText = localValue();
    const normalized = context.text.toLowerCase();
    const usable = suggestions.filter((suggestion) => {
      if (suggestion.textEdit) {
        const { start, end, text } = suggestion.textEdit;
        return (
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end >= start &&
          end <= currentText.length &&
          currentText.slice(start, end) !== text
        );
      }
      return suggestion.text.toLowerCase().startsWith(normalized) && suggestion.text.length > context.text.length;
    });
    if (usable.length === 0) {
      clearCompletion();
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

  const runAsync = async (context: QueryContext, promise: Promise<readonly Suggestion[]>, signal: AbortSignal): Promise<void> => {
    try {
      const suggestions = await promise;
      if (signal.aborted) return;
      setLoading(false);
      applySuggestionList(context, suggestions);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      setLoading(false);
      setCompletionError(error instanceof Error ? error.message : messages().suggestionsCouldNotLoad);
      setDropdownOpen(true);
      queueMicrotask(positionDropdown);
    }
  };

  const startResolution = (context: QueryContext, signal: AbortSignal): void => {
    if (signal.aborted || !textarea) return;
    setCompletionError(null);
    setLoading(true);
    setDropdownOpen(true);
    queueMicrotask(positionDropdown);
    try {
      const result = resolveSuggestions(context.completion, context.query, buildSuggestContext(textarea, context), signal);
      if (result.kind === "sync") {
        setLoading(false);
        applySuggestionList(context, result.data);
      } else {
        void runAsync(context, result.promise, signal);
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      setLoading(false);
      setCompletionError(error instanceof Error ? error.message : messages().suggestionsCouldNotLoad);
      setDropdownOpen(true);
      queueMicrotask(positionDropdown);
    }
  };

  const recomputeCompletion = (): void => {
    if (!textarea) return;
    const context = detectQuery(textarea, props.completions);
    if (!context) {
      clearCompletion();
      return;
    }
    currentAbort?.abort();
    if (currentTimer) clearTimeout(currentTimer);
    currentTimer = null;
    currentAbort = new AbortController();
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
      startResolution(context, currentAbort.signal);
    } else {
      setLoading(false);
      if (!state()) closeDropdown();
      const signal = currentAbort.signal;
      currentTimer = setTimeout(() => {
        currentTimer = null;
        startResolution(context, signal);
      }, delay);
    }
  };

  const retryCompletion = (): void => {
    if (!textarea) return;
    const context = detectQuery(textarea, props.completions);
    if (!context) return clearCompletion();
    currentAbort?.abort();
    if (currentTimer) clearTimeout(currentTimer);
    currentTimer = null;
    currentAbort = new AbortController();
    startResolution(context, currentAbort.signal);
  };

  const activateSuggestion = (index = state()?.selectedIndex ?? -1): boolean => {
    const current = state();
    const active = current?.suggestions[index];
    if (!textarea || !current || !active) return false;
    if (!active.textEdit && active.text === current.context.text) {
      clearCompletion();
      return false;
    }
    const applied = completionBehavior.applySuggestion(textarea, current.context, active, {
      trackExpansion: props.restoreExpansionOnBackspace ?? true,
    });
    clearCompletion();
    if (applied) queueMicrotask(recomputeCompletion);
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

  onMount(() => {
    const selectionChange = (): void => {
      if (document.activeElement === textarea) recomputeCompletion();
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
      currentAbort?.abort();
      if (currentTimer) clearTimeout(currentTimer);
      if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame);
      overlayFrame = undefined;
      renderPendingOverlay = undefined;
      completionBehavior.reset();
    });
  });

  const onInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }): void => {
    if (event.inputType.startsWith("insert") && completionBehavior.tryExpand(event.currentTarget, props.completions)) {
      return;
    }
    setLocalValue(event.currentTarget.value);
    props.onValueChange?.(event.currentTarget.value);
    recomputeCompletion();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!textarea || event.isComposing) return;
    if (
      (props.restoreExpansionOnBackspace ?? true) &&
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
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (current && dropdownCompletion && dropdownOpen()) {
        event.preventDefault();
        activateSuggestion();
        return;
      }
      if (props.singleLine) {
        event.preventDefault();
        props.onSubmit?.();
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !props.singleLine && props.onSubmit) {
      event.preventDefault();
      props.onSubmit();
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
        clearCompletion();
      } else if ((props.completions?.length ?? 0) > 0) {
        event.preventDefault();
        textarea.blur();
      }
    }
  };

  const surfaceStyle = (): JSX.CSSProperties => ({
    "--k2b-editor-lines": String(props.lines ?? 3),
  });

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={props.error}
      fill={props.fill && !props.singleLine}
      meta={meta}
      required={props.required}
      disabled={props.disabled}
    >
      <div
        class="k2b-autocomplete"
        data-overlay={useOverlay() ? "true" : undefined}
        data-single-line={props.singleLine ? "true" : undefined}
        data-fill={props.fill && !props.singleLine ? "true" : undefined}
        data-disabled={props.disabled ? "true" : undefined}
        data-invalid={error() ? "true" : undefined}
        data-variant={props.variant === "paper" ? "paper" : undefined}
        style={surfaceStyle()}
      >
        <div class="k2b-autocomplete__surface">
          <Show when={!localValue() && props.placeholder}>
            <div class="k2b-autocomplete__placeholder" aria-hidden="true">
              {props.placeholder}
            </div>
          </Show>
          <div ref={preview} class="k2b-autocomplete__preview" aria-hidden="true" />
          <textarea
            ref={(element) => {
              textarea = element;
              props.textareaRef?.(element);
            }}
            id={meta.controlId}
            name={props.name}
            class="k2b-autocomplete__input"
            onInput={onInput}
            onChange={(event) => props.onValueCommit?.(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onScroll={(event) => {
              if (preview) {
                preview.scrollTop = event.currentTarget.scrollTop;
                preview.scrollLeft = event.currentTarget.scrollLeft;
              }
              if (dropdown?.matches(":popover-open")) positionDropdown();
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
            spellcheck={props.spellcheck ?? false}
            maxLength={props.maxLength}
            rows={props.singleLine ? 1 : (props.lines ?? 3)}
            {...fieldControlAria(meta, props)}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={dropdownOpen() ? listboxId : undefined}
            aria-activedescendant={dropdownOpen() && state() ? optionId(state()!.selectedIndex) : undefined}
          />
        </div>
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
                    data-loading={loading() ? "true" : undefined}
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

export type { Completion, SuggestContext, Suggestion } from "./completion";
export { abbreviations } from "./completion";
