import { mutation, timed } from "@k2b/stdlib/solid";
import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Checkbox } from "../inputs/Checkbox";
import { PinInput } from "../inputs/ChoiceInputs";
import { DatePicker, DateTimePicker } from "../inputs/DatePicker";
import { ImageInput } from "../inputs/FileInputs";
import { NumberInput } from "../inputs/NumberInput";
import { Select } from "../inputs/Select";
import { TagsInput } from "../inputs/TagsInput";
import { TextInput } from "../inputs/TextInput";
import { resolveUiMessages } from "../intl/messages";
import { dialogCore, type OpenDialogOptions } from "./dialog-core";

export interface DialogOptions {
  title?: string;
  ariaLabel?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string | false;
  variant?: "danger" | "primary" | "success";
  size?: "small" | "medium" | "large" | "wide";
  surface?: "default" | "bare";
  header?: false;
  cancelBehavior?: OpenDialogOptions["cancelBehavior"];
}

export interface ConfirmOptions extends DialogOptions {
  confirmationPhrase?: string;
}

type PromptContent = string | HTMLElement | JSX.Element;

export type PromptSearchItem<T = unknown> = {
  label: string;
  desc?: string;
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

type InferFormValues<T extends Record<string, FieldSchema>> = {
  [K in keyof T as T[K] extends { type: "info" } ? never : K]: T[K] extends { required: true }
    ? InferFieldType<T[K]>
    : InferFieldType<T[K]> | undefined;
};

type PromptFormValue = string | number | boolean | string[] | undefined;
type PromptFormOptions<T extends Record<string, FieldSchema>> = {
  title?: string;
  ariaLabel?: string;
  icon?: string;
  fields: T;
  confirmText?: string;
  cancelText?: string | false;
  variant?: "danger" | "primary" | "success";
  size?: DialogOptions["size"];
  cancelBehavior?: DialogOptions["cancelBehavior"];
};

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export const createFormState = <T extends Record<string, FieldSchema>>(schema: T) => {
  const messages = resolveUiMessages();
  const [values, setValues] = createStore<Record<string, PromptFormValue>>({});
  const [errors, setErrors] = createStore<Record<string, string | undefined>>({});

  for (const [key, field] of Object.entries(schema)) {
    if (field.type !== "info" && "default" in field) setValues(key, field.default as PromptFormValue);
  }

  const validateField = (key: string, value: PromptFormValue): string | null => {
    const field = schema[key];
    if (!field || field.type === "info") return null;
    if (field.type === "boolean" && field.required && value !== true) return messages.required;
    if (field.required && isEmpty(value)) return messages.required;
    if ("validate" in field && field.validate) {
      const customError = (field.validate as (next: never) => string | null)(value as never);
      if (customError) return customError;
    }
    if (field.type === "text" && typeof value === "string" && value.length > 0) {
      if (field.minLength !== undefined && value.length < field.minLength) return `minimum ${field.minLength} characters`;
      if (field.maxLength !== undefined && value.length > field.maxLength) return `maximum ${field.maxLength} characters`;
    }
    if (field.type === "tags" && Array.isArray(value) && value.length > 0) {
      if (field.minTags !== undefined && value.length < field.minTags) return `minimum ${field.minTags} tags`;
      if (field.maxTags !== undefined && value.length > field.maxTags) return `maximum ${field.maxTags} tags`;
    }
    return null;
  };

  const updateField = (key: string, value: PromptFormValue) => {
    setValues(key, value);
    setErrors(key, validateField(key, value) ?? undefined);
  };

  const validateAll = (): boolean => {
    let valid = true;
    for (const [key, field] of Object.entries(schema)) {
      if (field.type === "info") continue;
      const error = validateField(key, values[key]);
      setErrors(key, error ?? undefined);
      if (error) valid = false;
    }
    return valid;
  };

  const reset = () => {
    for (const [key, field] of Object.entries(schema)) {
      if (field.type === "info") continue;
      setValues(key, "default" in field ? (field.default as PromptFormValue) : undefined);
      setErrors(key, undefined);
    }
  };

  return { values, errors, updateField, validateAll, reset };
};

export const DialogHeader = (props: { close: () => void; title?: string; icon?: string }): JSX.Element => (
  <header class="k2b-dialog__header">
    <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
    <Show when={props.title} fallback={<span class="k2b-dialog__header-spacer" />}>
      {(title) => <h2>{title()}</h2>}
    </Show>
    <button type="button" class="k2b-dialog__close" aria-label={resolveUiMessages().closeDialog} onClick={props.close}>
      <i class="ti ti-x" aria-hidden="true" />
    </button>
  </header>
);

const panelClass = (options?: Pick<DialogOptions, "size" | "surface" | "variant">): string => {
  const size = options?.size ?? "medium";
  const variant = options?.variant && options.variant !== "primary" ? ` k2b-dialog--${options.variant}` : "";
  return `k2b-dialog k2b-dialog--${size}${variant}${options?.surface === "bare" ? " is-bare" : ""}`;
};

const contentClass = (surface?: DialogOptions["surface"]): string =>
  surface === "bare" ? "k2b-dialog__viewport is-bare" : "k2b-dialog__viewport";

const renderInfo = (content: Extract<FieldSchema, { type: "info" }>["content"]): JSX.Element => {
  if (typeof content === "string") return <p>{content}</p>;
  if (typeof content === "function") return content();
  return content;
};

const PromptControl = (props: {
  field: Exclude<FieldSchema, { type: "info" }>;
  value: () => PromptFormValue;
  update: (value: PromptFormValue) => void;
  error: () => string | undefined;
  submit: () => void;
}): JSX.Element => {
  const label = props.field.label || undefined;

  switch (props.field.type) {
    case "text":
      return (
        <TextInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={String(props.value() ?? "")}
          onValueChange={(value) => props.update(value ?? undefined)}
          onSubmit={props.submit}
          multiline={props.field.multiline}
          lines={props.field.lines}
          icon={props.field.icon}
          activeIcon={props.field.activeIcon}
          password={props.field.password}
          markdown={props.field.markdown}
          minLength={props.field.minLength}
          maxLength={props.field.maxLength}
        />
      );
    case "number":
      return (
        <NumberInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={typeof props.value() === "number" ? (props.value() as number) : null}
          onValueChange={(value) => props.update(value ?? undefined)}
          min={props.field.min}
          max={props.field.max}
          step={props.field.step}
        />
      );
    case "image":
      return (
        <ImageInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          error={props.error}
          value={() => (typeof props.value() === "string" ? (props.value() as string) : null)}
          onValueChange={(value) => props.update(value ?? undefined)}
          round={props.field.round}
          aria-label={props.field.ariaLabel}
          accept={props.field.accept}
        />
      );
    case "pin":
      return (
        <PinInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          error={props.error}
          value={() => String(props.value() ?? "")}
          onValueChange={props.update}
          length={props.field.length}
          stretch={props.field.stretch}
        />
      );
    case "select":
      return (
        <Select
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={() => (typeof props.value() === "string" ? (props.value() as string) : null)}
          onValueChange={(value) => props.update(value ?? undefined)}
          options={props.field.options}
          icon={props.field.icon}
          activeIcon={props.field.activeIcon}
          clearable={props.field.clearable}
        />
      );
    case "tags":
      return (
        <TagsInput
          label={label}
          description={props.field.description}
          required={props.field.required}
          placeholder={props.field.placeholder}
          error={props.error}
          value={() => (Array.isArray(props.value()) ? (props.value() as string[]) : [])}
          onValueChange={props.update}
          maxTags={props.field.maxTags}
          icon={props.field.icon}
          activeIcon={props.field.activeIcon}
        />
      );
    case "boolean":
      return (
        <Checkbox
          label={label}
          description={props.field.description}
          required={props.field.required}
          error={props.error}
          value={() => Boolean(props.value())}
          onValueChange={props.update}
        />
      );
    case "datetime": {
      const pickerProps = {
        label,
        description: props.field.description,
        required: props.field.required,
        placeholder: props.field.placeholder,
        error: props.error,
        value: () => (typeof props.value() === "string" ? (props.value() as string) : null),
        onValueChange: (value: string | null) => props.update(value ?? ""),
        clearable: true,
      };
      return props.field.dateOnly ? <DatePicker {...pickerProps} /> : <DateTimePicker {...pickerProps} />;
    }
  }
};

const PromptFormDialog = <T extends Record<string, FieldSchema>>(props: {
  config: PromptFormOptions<T>;
  close: (value: InferFormValues<T> | null) => void;
}): JSX.Element => {
  const state = createFormState(props.config.fields);
  const submit = () => {
    if (state.validateAll()) props.close(state.values as InferFormValues<T>);
  };
  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    submit();
  };

  return (
    <form class="k2b-dialog__panel" onSubmit={handleSubmit}>
      <DialogHeader title={props.config.title} icon={props.config.icon} close={() => props.close(null)} />
      <div class="k2b-dialog__body k2b-prompt-form">
        <For each={Object.entries(props.config.fields)}>
          {([key, field]) => {
            if (field.type === "info") return <div class="k2b-prompt-form__info">{renderInfo(field.content)}</div>;
            return (
              <PromptControl
                field={field}
                value={() => state.values[key]}
                update={(value) => state.updateField(key, value)}
                error={() => state.errors[key]}
                submit={submit}
              />
            );
          }}
        </For>
      </div>
      <footer class="k2b-dialog__actions">
        <Show when={props.config.cancelText !== false}>
          <button type="button" class="k2b-button" data-variant="secondary" onClick={() => props.close(null)}>
            {props.config.cancelText || resolveUiMessages().cancel}
          </button>
        </Show>
        <button type="submit" class="k2b-button" data-variant={props.config.variant ?? "primary"}>
          {props.config.confirmText ?? resolveUiMessages().save}
        </button>
      </footer>
    </form>
  );
};

type CloudSearchResolver<T> = (input: PromptSearchInput) => Promise<PromptSearchItem<T>[]> | PromptSearchItem<T>[];

const openSearchPrompt = <T = unknown>(resolver: CloudSearchResolver<T>, options?: PromptSearchOptions) =>
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
        return error.message || resolveUiMessages().searchFailed;
      });
      const shouldShowResults = createMemo(() => {
        if (query().trim().length < minQueryLength) return false;
        return hasLoaded() || searchError() !== null || items().length > 0;
      });
      const emptyStateText = createMemo(() => {
        if (!hasLoaded()) return options?.emptyText ?? resolveUiMessages().typeToSearch;
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
                    <For each={items()}>
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
                          data-has-description={item.desc ? "true" : undefined}
                          onMouseEnter={() => setActiveIndex(index())}
                          onClick={() => execute(item)}
                        >
                          {/* Cloud keeps the preview box mounted once a row declares an image, so a
                              failed load swaps in the fallback glyph instead of collapsing the row. */}
                          <Show when={item.previewUrl?.startsWith("/") || item.icon}>
                            <span class="k2b-prompt-search__preview">
                              <Show
                                when={item.previewUrl?.startsWith("/") && !failedPreviews[index()]}
                                fallback={<i class={item.icon ?? "ti ti-file"} aria-hidden="true" />}
                              >
                                <img src={item.previewUrl} alt="" onError={() => setFailedPreviews(index(), true)} />
                              </Show>
                            </span>
                          </Show>
                          <span class="k2b-prompt-search__copy">
                            <strong>{item.label}</strong>
                            <Show when={item.desc}>{(description) => <small>{description()}</small>}</Show>
                          </span>
                        </button>
                      )}
                    </For>
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
      cancelBehavior: options?.cancelBehavior,
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

export const prompts = {
  alert: (content: PromptContent, options?: DialogOptions): Promise<void | undefined> =>
    dialogCore.open<void>(
      (close) => (
        <div class="k2b-dialog__panel">
          <DialogHeader title={options?.title || resolveUiMessages().info} icon={options?.icon} close={() => close()} />
          <div class="k2b-dialog__body">{content}</div>
          <footer class="k2b-dialog__actions">
            <button type="button" class="k2b-button" data-variant={options?.variant ?? "primary"} onClick={() => close()}>
              {options?.confirmText || resolveUiMessages().ok}
            </button>
          </footer>
        </div>
      ),
      {
        panelClassName: panelClass(options),
        contentClassName: contentClass(options?.surface),
        cancelBehavior: options?.cancelBehavior,
        ariaLabel: options?.ariaLabel ?? options?.title ?? resolveUiMessages().info,
      },
    ),

  success: (content: PromptContent, options?: Omit<DialogOptions, "variant">): Promise<void | undefined> =>
    prompts.alert(content, {
      ...options,
      variant: "success",
      title: options?.title ?? resolveUiMessages().success,
      icon: options?.icon ?? "ti ti-check",
    }),

  confirm: (content: PromptContent, options?: ConfirmOptions): Promise<boolean | undefined> => {
    const confirmationPhrase = options?.confirmationPhrase;
    if (confirmationPhrase !== undefined && (confirmationPhrase.trim().length === 0 || /[\r\n\t]/.test(confirmationPhrase))) {
      throw new Error("confirmationPhrase must be non-empty, visible, and single-line");
    }
    let confirmationInput: HTMLInputElement | undefined;

    return dialogCore.open<boolean>(
      (close) => {
        if (!confirmationPhrase) {
          return (
            <div class="k2b-dialog__panel">
              <DialogHeader title={options?.title} icon={options?.icon} close={() => close(false)} />
              <div class="k2b-dialog__body">{content}</div>
              <footer class="k2b-dialog__actions">
                <button type="button" class="k2b-button" data-variant="secondary" onClick={() => close(false)}>
                  {options?.cancelText || resolveUiMessages().cancel}
                </button>
                <button type="button" class="k2b-button" data-variant={options?.variant ?? "primary"} onClick={() => close(true)}>
                  {options?.confirmText || resolveUiMessages().confirm}
                </button>
              </footer>
            </div>
          );
        }

        const [confirmationValue, setConfirmationValue] = createSignal("");
        const canConfirm = () => confirmationValue() === confirmationPhrase;
        const submit = (event: SubmitEvent) => {
          event.preventDefault();
          if (canConfirm()) close(true);
        };

        return (
          <form class="k2b-dialog__panel" onSubmit={submit}>
            <DialogHeader title={options?.title} icon={options?.icon} close={() => close(false)} />
            <div class="k2b-dialog__body k2b-prompt-form">
              <div class="k2b-prompt-copy">{content}</div>
              <TextInput
                ref={(element) => {
                  confirmationInput = element;
                }}
                label={
                  <>
                    Type <code class="k2b-confirmation-phrase">{confirmationPhrase}</code> to confirm
                  </>
                }
                value={confirmationValue}
                onValueChange={setConfirmationValue}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                monospace
                required
              />
            </div>
            <footer class="k2b-dialog__actions">
              <button type="button" class="k2b-button" data-variant="secondary" onClick={() => close(false)}>
                {options?.cancelText || resolveUiMessages().cancel}
              </button>
              <button type="submit" class="k2b-button" data-variant={options?.variant ?? "primary"} disabled={!canConfirm()}>
                {options?.confirmText || resolveUiMessages().confirm}
              </button>
            </footer>
          </form>
        );
      },
      {
        panelClassName: panelClass(options),
        contentClassName: contentClass(options?.surface),
        initialFocus: confirmationPhrase ? () => confirmationInput ?? null : undefined,
        cancelBehavior: options?.cancelBehavior,
        ariaLabel: options?.ariaLabel ?? options?.title ?? resolveUiMessages().confirmation,
      },
    );
  },

  prompt: promptText,
  promptNumber,

  form: async <T extends Record<string, FieldSchema>>(config: PromptFormOptions<T>): Promise<InferFormValues<T> | null> =>
    (await dialogCore.open<InferFormValues<T> | null>((close) => <PromptFormDialog config={config} close={(value) => close(value)} />, {
      panelClassName: panelClass(config),
      contentClassName: contentClass(),
      cancelBehavior: config.cancelBehavior,
      ariaLabel: config.ariaLabel ?? config.title ?? resolveUiMessages().form,
    })) ?? null,

  dialog: <T = unknown>(component: (close: (result?: T) => void) => JSX.Element, options?: DialogOptions): Promise<T | undefined> =>
    dialogCore.open<T>(
      (close) => {
        const body = component(close);
        if (options?.surface === "bare" && options.header === false) return body;
        return (
          <div class="k2b-dialog__panel k2b-dialog__stack">
            <Show when={options?.header !== false}>
              <DialogHeader title={options?.title} icon={options?.icon} close={() => close(undefined)} />
            </Show>
            {body}
          </div>
        );
      },
      {
        panelClassName: panelClass(options),
        contentClassName: contentClass(options?.surface),
        cancelBehavior: options?.cancelBehavior,
        ariaLabel: options?.ariaLabel ?? options?.title ?? resolveUiMessages().dialog,
      },
    ),

  search: openSearchPrompt,

  error: (content: string | HTMLElement, options?: DialogOptions) =>
    dialogCore.open(
      (close) => (
        <div class="k2b-dialog__panel">
          <DialogHeader title={options?.title ?? resolveUiMessages().error} icon={options?.icon ?? "ti ti-alert-circle"} close={close} />
          <div class="k2b-dialog__body">{content}</div>
          <footer class="k2b-dialog__actions">
            <button type="button" class="k2b-button" onClick={() => close()}>
              {options?.confirmText || resolveUiMessages().close}
            </button>
          </footer>
        </div>
      ),
      {
        panelClassName: panelClass({ ...options, variant: "danger" }),
        contentClassName: contentClass(options?.surface),
        cancelBehavior: options?.cancelBehavior,
        ariaLabel: options?.ariaLabel ?? options?.title ?? resolveUiMessages().error,
      },
    ),
};
