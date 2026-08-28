import { IconButton, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { suggestContacts } from "./contact-capabilities";
import { mailComposerMessages } from "./mail-composer-messages";
import { commitMailRecipient, shouldCommitMailRecipient } from "./mail-recipient";

type RecipientSuggestion = { label: string; address: string; context: string | null };

export default function MailRecipientInput(props: {
  value: () => string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const errorId = `${props.placeholder.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-recipient-error`;
  const [query, setQuery] = createSignal("");
  const [suggestions, setSuggestions] = createSignal<RecipientSuggestion[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [editingIndex, setEditingIndex] = createSignal<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  let input: HTMLInputElement | undefined;
  let pillButtons: HTMLButtonElement[] = [];

  const add = (raw: string) => {
    const next = commitMailRecipient(props.value(), raw, editingIndex());
    if (!next) {
      setValidationError(t().enterValidEmail);
      return;
    }
    props.onChange(next);
    setEditingIndex(null);
    setQuery("");
    setSuggestions([]);
    setValidationError(null);
  };

  const focusInput = () =>
    queueMicrotask(() => {
      input?.focus();
      const caret = input?.value.length ?? 0;
      input?.setSelectionRange(caret, caret);
    });

  const edit = (index: number) => {
    const recipient = props.value()[index];
    if (recipient === undefined || props.disabled) return;
    setEditingIndex(index);
    setQuery(recipient);
    setSuggestions([]);
    setValidationError(null);
    focusInput();
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setQuery("");
    setSuggestions([]);
    setValidationError(null);
    focusInput();
  };

  const focusPill = (index: number) => {
    const target = pillButtons[index];
    if (target?.isConnected) target.focus();
    else focusInput();
  };

  const remove = (index: number, focusAfter = false) => {
    const next = props.value().filter((_, candidateIndex) => candidateIndex !== index);
    props.onChange(next);
    if (editingIndex() === index) {
      setEditingIndex(null);
      setQuery("");
    }
    if (focusAfter) queueMicrotask(() => focusPill(Math.min(index, next.length - 1)));
  };

  const handlePillKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusPill(Math.max(0, index - 1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      focusPill(index + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusPill(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusInput();
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      edit(index);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      remove(index, true);
    }
  };

  createEffect(() => {
    const value = query().trim();
    if (timer) clearTimeout(timer);
    controller?.abort();
    if (value.length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer = setTimeout(async () => {
      const request = new AbortController();
      controller = request;
      try {
        const result = await suggestContacts({ query: value, limit: 8 }, request.signal);
        if (disposed || controller !== request) return;
        const seen = new Set<string>();
        setSuggestions(
          result.data.flatMap((contact) => {
            const context = [contact.companyName, contact.jobTitle, contact.phones[0]?.phone].filter(Boolean).join(" · ") || null;
            return contact.emails.flatMap(({ email }) => {
              const address = email.toLowerCase();
              if (seen.has(address)) return [];
              seen.add(address);
              return [{ label: contact.displayName, address, context }];
            });
          }),
        );
      } catch (error) {
        if (!disposed && controller === request && !(error instanceof DOMException && error.name === "AbortError")) {
          setSuggestions([]);
        }
      } finally {
        if (!disposed && controller === request) {
          controller = null;
          setLoading(false);
        }
      }
    }, 180);
  });

  onCleanup(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
    controller = null;
  });

  return (
    <div class="relative min-w-0">
      <div
        class="no-scrollbar mail-recipient-control mail-recipient-input flex h-[var(--ui-control-md)] w-full flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden px-2 py-1"
        data-disabled={props.disabled ? "true" : undefined}
        data-invalid={validationError() ? "true" : undefined}
        data-editing={editingIndex() === null ? undefined : "true"}
      >
        <i class="ti ti-at shrink-0 text-dimmed" aria-hidden="true" />
        <For each={props.value()}>
          {(recipient, index) => (
            <Show
              when={editingIndex() === index()}
              fallback={
                <span class="chip mail-recipient-pill-shell h-7 max-w-56 shrink-0 py-0">
                  <button
                    ref={(element) => {
                      pillButtons[index()] = element;
                    }}
                    type="button"
                    class="mail-recipient-pill min-w-0 flex-1 truncate rounded text-left"
                    aria-label={t().editRecipient({ recipient })}
                    title={t().editRecipientHint({ recipient })}
                    disabled={props.disabled}
                    onClick={() => edit(index())}
                    onKeyDown={(event) => handlePillKeyDown(event, index())}
                  >
                    {recipient}
                  </button>
                  <IconButton
                    type="button"
                    class="!h-5 !w-5 !p-0"
                    label={t().removeRecipient({ recipient })}
                    disabled={props.disabled}
                    onClick={() => remove(index())}
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
                </span>
              }
            >
              <input
                ref={input}
                class="mail-recipient-edit h-7 min-w-40 max-w-72 rounded-[var(--ui-radius-control)] px-2 text-xs outline-none"
                value={query()}
                disabled={props.disabled}
                aria-label={t().editRecipient({ recipient })}
                aria-invalid={Boolean(validationError())}
                aria-describedby={validationError() ? errorId : undefined}
                autocomplete="off"
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setValidationError(null);
                }}
                onKeyDown={(event) => {
                  if (shouldCommitMailRecipient(query(), event.key)) {
                    event.preventDefault();
                    add(query().replace(/,$/, ""));
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEdit();
                  }
                }}
                onBlur={() => {
                  if (query().trim()) add(query());
                  else cancelEdit();
                }}
              />
            </Show>
          )}
        </For>
        <Show when={editingIndex() === null}>
          <input
            ref={input}
            class="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none"
            value={query()}
            placeholder={props.value().length === 0 ? props.placeholder : t().addAnotherRecipient}
            disabled={props.disabled}
            aria-label={props.placeholder}
            aria-invalid={Boolean(validationError())}
            aria-describedby={validationError() ? errorId : undefined}
            autocomplete="off"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setValidationError(null);
            }}
            onKeyDown={(event) => {
              if (shouldCommitMailRecipient(query(), event.key)) {
                event.preventDefault();
                add(query().replace(/,$/, ""));
              } else if ((event.key === "ArrowLeft" || event.key === "Backspace") && !query() && props.value().length > 0) {
                event.preventDefault();
                focusPill(props.value().length - 1);
              }
            }}
            onBlur={() => {
              if (query().includes("@")) add(query());
            }}
          />
        </Show>
        <Show when={loading()}>
          <i class="ti ti-loader-2 animate-spin text-dimmed" aria-hidden="true" />
        </Show>
      </div>
      <Show when={validationError()}>
        {(message) => (
          <p id={errorId} class="mt-1 text-xs text-red-600 dark:text-red-300">
            {message()}
          </p>
        )}
      </Show>
      <Show when={suggestions().length > 0}>
        <div class="mail-recipient-suggestions absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto p-1" role="listbox">
          <For each={suggestions()}>
            {(suggestion) => (
              <button
                type="button"
                class="flex w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left hover:bg-[var(--ui-hover)]"
                role="option"
                aria-selected="false"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add(`${suggestion.label} <${suggestion.address}>`)}
              >
                <i class="ti ti-user text-dimmed" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-primary">{suggestion.label}</span>
                  <span class="block truncate text-xs text-dimmed">{suggestion.address}</span>
                  <Show when={suggestion.context}>
                    {(context) => <span class="block truncate text-[10px] text-dimmed">{context()}</span>}
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
