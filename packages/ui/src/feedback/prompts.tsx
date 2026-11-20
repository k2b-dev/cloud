import { mutation, timed } from "@k2b/stdlib/solid";
import { createEffect, createMemo, createSignal, createUniqueId, type JSX, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { resolveSelectMessages } from "../inputs/select-messages";
import { KeyedFor } from "../internal/keyed-for";
import { optionDescription } from "../internal/option-description";
import { resolveUiMessages } from "../intl/messages";
import { captureDialogOpen, type DialogRender, dialogCore, type OpenDialogOptions } from "./dialog-core";
import { openError, type PromptContent, promptFormUnavailable, providePhraseField, sharedPrompts } from "./prompt-confirm";
import { loadedPromptForm, loadPromptForm } from "./prompt-form-loader";
import { DialogHeader, promptButtonVariant, promptTone } from "./prompt-header";
import { resolvePromptMessages } from "./prompt-messages";
import { openPrompt } from "./prompt-sheet";

export { createFormState } from "./prompt-form-state";
export { DialogHeader } from "./prompt-header";

export interface DialogOptions {
  signal?: AbortSignal;
  title?: string;
  ariaLabel?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string | false;
  variant?: "danger" | "primary" | "success" | "warning";
  /** `full` fills the available viewport and becomes edge-to-edge on narrow screens. */
  size?: "small" | "medium" | "large" | "wide" | "full";
  surface?: "default" | "bare";
  header?: false;
  cancelBehavior?: OpenDialogOptions["cancelBehavior"];
  /** Back closes the prompt like Cancel, as in a phone app; see `OpenDialogOptions.history`. */
  history?: boolean;
  /** Animate content height changes. Defaults to false, or true for form, prompt and promptNumber. */
  followContent?: boolean;
}

export type SuccessDialogOptions = Omit<DialogOptions, "variant"> & {
  /** A finished success, such as an issued document: the header draws its check once when the dialog opens. */
  celebrate?: boolean;
};

export interface ConfirmOptions extends DialogOptions {
  confirmationPhrase?: string;
}

export type PromptSearchItem<T = unknown> = {
  /**
   * Stable identity of the result, such as its record ID. With it, a newer answer that contains the same result keeps
   * its row, so a click in progress still lands. Without it, each answer replaces the rows.
   */
  id?: string;
  label: string;
  desc?: string;
  /**
   * Shown in place of `desc`, such as a colored `Tag`. A function, so each place gets its own element. It shows only
   * with a `desc`, which stays the text that screen readers use.
   */
  descriptionVisual?: () => JSX.Element;
  icon?: string;
  previewUrl?: string;
  value?: T;
};

export type PromptSearchInput = {
  query: string;
  abortSignal: AbortSignal;
};

export type PromptSearchOptions = DialogOptions & {
  placeholder?: string;
  icon?: string;
  initialQuery?: string;
  minQueryLength?: number;
  debounceMs?: number;
  emptyText?: string;
  noResultsText?: string;
};

export type PromptFieldBase<T = any> = {
  label?: string | false;
  description?: string;
  placeholder?: string;
  required?: boolean;
  default?: T;
  validate?: (value: T | undefined) => string | null;
};

export type FieldSchema =
  | (PromptFieldBase<string> & {
      type: "text";
      multiline?: boolean;
      lines?: number;
      maxLength?: number;
      minLength?: number;
      icon?: string;
      activeIcon?: string;
      password?: boolean;
      markdown?: boolean;
    })
  | (PromptFieldBase<number> & {
      type: "number";
      min?: number;
      max?: number;
      step?: number;
    })
  | (PromptFieldBase<string> & {
      type: "image";
      round?: boolean;
      ariaLabel?: string;
      accept?: string;
    })
  | (PromptFieldBase<string> & {
      type: "pin";
      length?: number;
      stretch?: boolean;
    })
  | (PromptFieldBase<string> & {
      type: "select";
      options: string[] | { id: string; label?: string; description?: string; icon?: string }[];
      icon?: string;
      activeIcon?: string;
      clearable?: boolean;
    })
  | (PromptFieldBase<string[]> & {
      type: "tags";
      maxTags?: number;
      minTags?: number;
      icon?: string;
      activeIcon?: string;
    })
  | (PromptFieldBase<boolean> & {
      type: "boolean";
    })
  | (PromptFieldBase<string> & {
      type: "datetime";
      dateOnly?: boolean;
      /** A date whose time is optional, as `DateTimePicker`'s `optionalTime`. */
      optionalTime?: boolean;
    })
  | {
      type: "info";
      content: string | JSX.Element | (() => JSX.Element);
    };

type InferFieldType<T extends FieldSchema> = T extends { type: "text" }
  ? string
  : T extends { type: "number" }
    ? number
    : T extends { type: "image" }
      ? string
      : T extends { type: "pin" }
        ? string
        : T extends { type: "select" }
          ? string
          : T extends { type: "tags" }
            ? string[]
            : T extends { type: "boolean" }
              ? boolean
              : T extends { type: "datetime" }
                ? string
                : T extends { type: "currency" }
                  ? number
                  : T extends { type: "info" }
                    ? never
                    : never;

export type InferFormValues<T extends Record<string, FieldSchema>> = {
  [K in keyof T as T[K] extends { type: "info" } ? never : K]: T[K] extends { required: true }
    ? InferFieldType<T[K]>
    : InferFieldType<T[K]> | undefined;
};

export type PromptFormValue = string | number | boolean | string[] | undefined;
export type PromptFormOptions<T extends Record<string, FieldSchema>> = {
  signal?: AbortSignal;
  title?: string;
  ariaLabel?: string;
  icon?: string;
  /** Hold and animate content height changes. Defaults to true. */
  followContent?: boolean;
  fields: T;
  confirmText?: string;
  cancelText?: string | false;
  variant?: "danger" | "primary" | "success" | "warning";
  size?: DialogOptions["size"];
  cancelBehavior?: DialogOptions["cancelBehavior"];
};

// Results without an ID keep today's behavior: each object is its own identity, so a new answer replaces the row.
const anonymousRows = new WeakMap<object, string>();
let anonymousRow = 0;
const searchRowIdentity = (item: PromptSearchItem<unknown>): string => {
  if (item.id !== undefined) return `id:${item.id}`;
  const known = anonymousRows.get(item);
  if (known !== undefined) return known;
  const key = `object:${anonymousRow++}`;
  anonymousRows.set(item, key);
  return key;
};

type CloudSearchResolver<T> = (input: PromptSearchInput) => Promise<PromptSearchItem<T>[]> | PromptSearchItem<T>[];

const openSearchPrompt = <T extends unknown = unknown>(resolver: CloudSearchResolver<T>, options?: PromptSearchOptions) =>
  dialogCore.open<PromptSearchItem<T>>(
    (close) => {
      const [query, setQuery] = createSignal(options?.initialQuery ?? "");
      const [items, setItems] = createSignal<PromptSearchItem<T>[]>([]);
      const [activeIndex, setActiveIndex] = createSignal(0);
      const [hasLoaded, setHasLoaded] = createSignal(false);
      const [failedPreviews, setFailedPreviews] = createStore<Record<number, true>>({});
      const [activeSearchQuery, setActiveSearchQuery] = createSignal("");
      const rowRefs = new Map<number, HTMLButtonElement>();
      const searchId = `k2b-prompt-search-${createUniqueId()}`;
      const listboxId = `${searchId}-listbox`;
      const optionId = (index: number) => `${searchId}-option-${index}`;

      const minQueryLength = options?.minQueryLength ?? 0;
      const debounceMs = options?.debounceMs ?? 180;
      const searchMutation = mutation.create<{ query: string; items: PromptSearchItem<T>[] }, string, { requestQuery: string }>({
        // The newest query wins over a search still in flight.
        concurrency: "replace",
        onBefore: (requestQuery) => ({ requestQuery }),
        mutation: async (requestQuery, context) => {
          const result = await resolver({
            query: requestQuery,
            abortSignal: context.abortSignal,
          });
          return { query: requestQuery, items: (result ?? []).slice() };
        },
        onSuccess: (result, context) => {
          if (!context || context.requestQuery !== activeSearchQuery()) return;
          setItems(result.items);
          setActiveIndex(0);
          setHasLoaded(true);
        },
        onError: (error, context) => {
          if (!context || context.requestQuery !== activeSearchQuery() || error.name === "AbortError") return;
          setItems([]);
          setActiveIndex(0);
          setHasLoaded(true);
        },
      });
      const searchError = createMemo(() => {
        const error = searchMutation.error();
        if (!error || error.name === "AbortError") return null;
        return error.message || resolvePromptMessages().searchFailed;
      });
      const shouldShowResults = createMemo(() => {
        if (query().trim().length < minQueryLength) return false;
        return hasLoaded() || searchError() !== null || items().length > 0;
      });
      const emptyStateText = createMemo(() => {
        if (!hasLoaded()) return options?.emptyText ?? resolveSelectMessages().typeToSearch;
        return options?.noResultsText ?? resolveUiMessages().noResults;
      });
      const { debouncedFn: debounceSearch, cancel: cancelDebounce } = timed.debounce((nextQuery: string) => {
        setActiveSearchQuery(nextQuery);
        searchMutation.abort();
        void searchMutation.mutate(nextQuery);
      }, debounceMs);

      const execute = (item?: PromptSearchItem<T>) => {
        if (!item) return;
        close(item);
      };
      const moveSelection = (delta: -1 | 1) => {
        const list = items();
        if (list.length === 0) return;
        setActiveIndex((activeIndex() + delta + list.length) % list.length);
      };

      createEffect(() => {
        const list = items();
        const maxIndex = list.length - 1;
        if (maxIndex < 0) {
          setActiveIndex(0);
          return;
        }
        if (activeIndex() > maxIndex) setActiveIndex(maxIndex);
        rowRefs.get(activeIndex())?.scrollIntoView({ block: "nearest" });
      });
      createEffect(() => {
        const nextQuery = query().trim();
        setFailedPreviews({});
        if (nextQuery.length < minQueryLength) {
          cancelDebounce();
          searchMutation.abort();
          setItems([]);
          setActiveIndex(0);
          setHasLoaded(false);
          setActiveSearchQuery("");
          return;
        }
        debounceSearch(nextQuery);
      });
      onCleanup(() => {
        cancelDebounce();
        searchMutation.abort();
      });

      return (
        <div class="k2b-prompt-search-shell">
          <Show when={options?.title}>{(title) => <p class="k2b-prompt-search-shell__title">{title()}</p>}</Show>
          <div class="k2b-prompt-search">
            <label class="k2b-prompt-search__input">
              <i class={options?.icon ?? "ti ti-search"} aria-hidden="true" />
              <input
                id={searchId}
                type="search"
                role="combobox"
                aria-label={options?.ariaLabel ?? options?.title ?? resolveUiMessages().search}
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded={shouldShowResults()}
                aria-activedescendant={shouldShowResults() && items().length > 0 ? optionId(activeIndex()) : undefined}
                aria-busy={searchMutation.loading()}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveSelection(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveSelection(-1);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    execute(items()[activeIndex()]);
                  }
                }}
                placeholder={options?.placeholder ?? resolveUiMessages().search}
                spellcheck={false}
                autocapitalize="off"
                autocomplete="off"
                autocorrect="off"
              />
              <Show when={searchMutation.loading()}>
                <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
              </Show>
            </label>
            <div
              class="k2b-prompt-search__collapse"
              style={{
                height: shouldShowResults() ? "var(--k2b-search-body-max)" : "0px",
                opacity: shouldShowResults() ? "1" : "0",
              }}
            >
              <div class="k2b-prompt-search__results" onWheel={(event) => event.stopPropagation()}>
                <Show when={searchError()}>
                  {(message) => (
                    <div class="k2b-prompt-search__error" role="status" aria-live="polite">
                      {message()}
                    </div>
                  )}
                </Show>
                <Show
                  when={items().length > 0}
                  fallback={
                    <p role="status" aria-live="polite">
                      {emptyStateText()}
                    </p>
                  }
                >
                  <div id={listboxId} class="k2b-prompt-search__list" role="listbox" aria-label={resolveUiMessages().searchResults}>
                    <KeyedFor each={items()} by={searchRowIdentity}>
                      {(item, index) => (
                        <button
                          ref={(element) => {
                            if (!element) rowRefs.delete(index());
                            else rowRefs.set(index(), element);
                          }}
                          type="button"
                          id={optionId(index())}
                          role="option"
                          aria-selected={activeIndex() === index()}
                          data-active={activeIndex() === index() ? "true" : undefined}
                          data-has-description={item().desc ? "true" : undefined}
                          onMouseEnter={() => setActiveIndex(index())}
                          onClick={() => execute(item())}
                        >
                          {/* Cloud keeps the preview box mounted once a row declares an image, so a
                              failed load swaps in the fallback glyph instead of collapsing the row. */}
                          <Show when={item().previewUrl?.startsWith("/") || item().icon}>
                            <span class="k2b-prompt-search__preview">
                              <Show
                                when={item().previewUrl?.startsWith("/") && !failedPreviews[index()]}
                                fallback={<i class={item().icon ?? "ti ti-file"} aria-hidden="true" />}
                              >
                                <img src={item().previewUrl} alt="" onError={() => setFailedPreviews(index(), true)} />
                              </Show>
                            </span>
                          </Show>
                          <span class="k2b-prompt-search__copy">
                            <strong>{item().label}</strong>
                            {optionDescription(() => ({ description: item().desc, descriptionVisual: item().descriptionVisual }))}
                          </span>
                        </button>
                      )}
                    </KeyedFor>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </div>
      );
    },
    {
      panelClassName: "k2b-dialog k2b-dialog--search is-bare",
      contentClassName: "k2b-dialog__viewport is-search",
      initialFocus: "first-input",
      signal: options?.signal,
      cancelBehavior: options?.cancelBehavior,
      history: options?.history,
      followContent: options?.followContent,
      ariaLabel: options?.ariaLabel ?? options?.title ?? resolveUiMessages().search,
    },
  );

const promptText = (content: string, defaultValue?: string, options?: DialogOptions) =>
  prompts
    .form({
      ...options,
      fields: {
        message: { type: "info", content: () => <div class="k2b-prompt-copy">{content}</div> },
        value: {
          type: "text",
          label: false,
          default: defaultValue || "",
        },
      },
    })
    .then((result) => result?.value ?? null);

const promptNumber = (
  content: string,
  defaultValue?: number,
  options?: DialogOptions & {
    min?: number;
    max?: number;
  },
) =>
  prompts
    .form({
      ...options,
      fields: {
        message: { type: "info", content: () => <div class="k2b-prompt-copy">{content}</div> },
        value: {
          type: "number",
          label: false,
          default: defaultValue || 0,
          min: options?.min,
          max: options?.max,
        },
      },
    })
    .then((result) => result?.value ?? null);

const openAlert = (content: PromptContent, options?: DialogOptions, celebrate?: boolean): Promise<void | undefined> =>
  openPrompt<void>(
    (close) => (
      <div class="k2b-dialog__panel">
        <DialogHeader
          title={options?.title || resolveUiMessages().info}
          icon={options?.icon}
          tone={promptTone(options?.variant)}
          celebrate={celebrate}
          close={() => close()}
        />
        <div class="k2b-dialog__body">{content}</div>
        <footer class="k2b-dialog__actions">
          <button type="button" class="k2b-button" data-variant={promptButtonVariant(options?.variant)} onClick={() => close()}>
            {options?.confirmText || resolveUiMessages().ok}
          </button>
        </footer>
      </div>
    ),
    options,
    resolveUiMessages().info,
  );

providePhraseField({
  loaded: () => loadedPromptForm()?.TextInput,
  load: () => loadPromptForm().then((module) => module.TextInput),
});

// The browser loads the form when it is idle after the island starts, so the first form opens at once and without a
// half-drawn frame. Without idle callbacks (WebKit), the first press or key does it, before the click it starts. No
// timer starts at import: an app's test that steps through its own timers must not meet one of the library's.
if (typeof window !== "undefined") {
  const preload = () => void loadPromptForm().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(preload, { timeout: 2000 });
  else {
    const intents = ["pointerdown", "keydown", "focusin"] as const;
    const onIntent = () => {
      for (const type of intents) window.removeEventListener(type, onIntent, true);
      preload();
    };
    for (const type of intents) window.addEventListener(type, onIntent, true);
  }
}

// The same object as `sharedPrompts`, which `PanelDialog` uses for its discard question: replacing `prompts.confirm`
// (for example in a test) therefore reaches every confirmation.
export const prompts = Object.assign(sharedPrompts, {
  alert: (content: PromptContent, options?: DialogOptions): Promise<void | undefined> => openAlert(content, options),

  success: (content: PromptContent, options?: SuccessDialogOptions): Promise<void | undefined> => {
    const { celebrate, ...rest } = options ?? {};
    return openAlert(content, { ...rest, variant: "success", title: rest.title ?? resolveUiMessages().success }, celebrate);
  },

  prompt: promptText,
  promptNumber,

  form: async <T extends Record<string, FieldSchema>>(config: PromptFormOptions<T>): Promise<InferFormValues<T> | null> => {
    // Once the fields are there, the form opens in the same task as the call, like every other prompt. While they load,
    // it keeps the palette, page and opener of this call.
    const open = captureDialogOpen();
    const form = loadedPromptForm() ?? (await loadPromptForm().catch(() => undefined));
    if (!form) {
      await promptFormUnavailable(config.signal);
      return null;
    }
    const { PromptFormDialog } = form;
    return (
      (await openPrompt<InferFormValues<T> | null>(
        (close) => <PromptFormDialog config={config} close={(value) => close(value)} />,
        { ...config, followContent: config.followContent ?? true },
        resolvePromptMessages().form,
        true,
        undefined,
        open,
      )) ?? null
    );
  },

  /**
   * Open custom content with a typed close callback and the dialog render context.
   * Register a dismiss handler to guard Escape, backdrop clicks and the supplied header's close button,
   * for example while saving. Explicit close(result) bypasses the guard. Without a handler, dismissal
   * keeps its existing behavior, including a header close button independent of cancelBehavior.
   */
  dialog: <T extends unknown = unknown>(component: DialogRender<T>, options?: DialogOptions): Promise<T | undefined> =>
    openPrompt<T>(
      (close, context) => {
        // A dismiss handler the component sets guards the header's close button as well as Escape and the backdrop.
        let dismiss = () => close(undefined);
        const body = component(close, {
          ...context,
          setDismissHandler: (handler) => {
            context.setDismissHandler(handler);
            dismiss = () => void context.requestDismiss();
          },
        });
        if (options?.surface === "bare" && options.header === false) return body;
        return (
          <div class="k2b-dialog__panel k2b-dialog__stack">
            <Show when={options?.header !== false}>
              <DialogHeader title={options?.title} icon={options?.icon} tone={promptTone(options?.variant)} close={() => dismiss()} />
            </Show>
            <div class="k2b-dialog__content">{body}</div>
          </div>
        );
      },
      options,
      resolveUiMessages().dialog,
      // Without its header a custom dialog draws its own chrome and keeps the dialog frame.
      options?.header !== false,
    ),

  search: openSearchPrompt,

  error: (content: string | HTMLElement, options?: DialogOptions) => openError(content, options),
});
