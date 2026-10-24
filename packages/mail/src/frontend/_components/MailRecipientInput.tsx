import { IconButton, useLocale } from "@k2b/ui";
import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { mailRecipientSuggestionsSchema } from "../../contracts";
import { suggestContacts } from "./contact-capabilities";
import { mailComposerMessages } from "./mail-composer-messages";
import { useMailContactDirectory } from "./mail-contact-directory-context";
import { commitMailRecipient, shouldCommitMailRecipient } from "./mail-recipient";

type RecipientSuggestion = { label: string; address: string; context: string | null; source: "contacts" | "mailbox" };

export default function MailRecipientInput(props: {
  value: () => string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  disabled?: boolean;
  mailboxId?: string;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const suggestTarget = useMailContactDirectory().suggest;
  const fieldId = createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const errorId = `${fieldId}-recipient-error`;
  const listboxId = `${fieldId}-recipient-suggestions`;
  const optionId = (index: number) => `${listboxId}-${index}`;
  const [query, setQuery] = createSignal("");
  const [suggestions, setSuggestionList] = createSignal<RecipientSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  /** The query the shown list answers; while a newer lookup is pending the list stays visible but not keyboard-selectable. */
  let suggestionsQuery = "";
  const setSuggestions = (next: RecipientSuggestion[], forQuery = "") => {
    setActiveIndex(-1);
    suggestionsQuery = forQuery;
    setSuggestionList(next);
  };
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

  const pick = (suggestion: RecipientSuggestion) =>
    add(suggestion.label === suggestion.address ? suggestion.address : `${suggestion.label} <${suggestion.address}>`);

  /** Closes the list and ends a pending lookup, so its answer cannot reopen the list without new input. */
  const dismissSuggestions = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
    setLoading(false);
    setSuggestions([]);
  };

  /** Arrow keys move through the open list, Enter takes the highlighted entry, Escape closes the list. */
  const handleSuggestionKey = (event: KeyboardEvent): boolean => {
    const count = suggestions().length;
    if (event.key === "Escape" && count === 0 && (timer || controller)) {
      event.preventDefault();
      dismissSuggestions();
      return true;
    }
    if (count === 0) return false;
    if (event.key !== "Escape" && suggestionsQuery !== query().trim()) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index < 0 ? (step > 0 ? 0 : count - 1) : (index + step + count) % count));
      document.getElementById(optionId(activeIndex()))?.scrollIntoView({ block: "nearest" });
      return true;
    }
    const active = suggestions()[activeIndex()];
    if (event.key === "Enter" && active) {
      event.preventDefault();
      pick(active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dismissSuggestions();
      return true;
    }
    return false;
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
    const mailboxId = props.mailboxId;
    // A highlight belongs to the list it was made in; after typing, Enter commits the typed text until new results arrive.
    setActiveIndex(-1);
    if (timer) clearTimeout(timer);
    controller?.abort();
    controller = null;
    if (value.length < 2 || (!suggestTarget && !mailboxId)) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer = setTimeout(async () => {
      timer = null;
      const request = new AbortController();
      controller = request;
      const contacts: RecipientSuggestion[] = [];
      const mailbox: RecipientSuggestion[] = [];
      const publish = () => {
        if (disposed || controller !== request) return;
        const activeAddress = suggestionsQuery === value ? suggestions()[activeIndex()]?.address : undefined;
        const seen = new Set<string>();
        const merged = [...contacts, ...mailbox].filter((item) => {
          if (seen.has(item.address)) return false;
          seen.add(item.address);
          return true;
        });
        setSuggestions(merged, value);
        if (activeAddress) setActiveIndex(merged.findIndex((item) => item.address === activeAddress));
      };
      try {
        await Promise.allSettled([
          (async () => {
            if (!suggestTarget) return;
            const result = await suggestContacts(suggestTarget, { query: value, limit: 8 }, request.signal);
            for (const contact of result.data) {
              const context = [contact.companyName, contact.jobTitle, contact.phones[0]?.phone].filter(Boolean).join(" · ") || null;
              for (const { email } of contact.emails) {
                contacts.push({ label: contact.displayName, address: email.trim().toLowerCase(), context, source: "contacts" });
              }
            }
            publish();
          })(),
          (async () => {
            if (!mailboxId) return;
            const response = await apiClient.mailboxes[":mailboxId"]["recipient-suggestions"].$get(
              { param: { mailboxId }, query: { query: value, limit: "8" } },
              { init: { signal: request.signal } },
            );
            if (!response.ok) throw new Error("Recipient suggestions unavailable");
            for (const item of mailRecipientSuggestionsSchema.parse(await response.json()).items) {
              const address = item.address.trim().toLowerCase();
              mailbox.push({ label: item.displayName ?? address, address, context: null, source: "mailbox" });
            }
            publish();
          })(),
        ]);
        publish();
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
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggestions().length > 0}
                aria-controls={suggestions().length > 0 ? listboxId : undefined}
                aria-activedescendant={activeIndex() >= 0 ? optionId(activeIndex()) : undefined}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setValidationError(null);
                }}
                onKeyDown={(event) => {
                  // An IME composition owns its keys until it ends.
                  if (event.isComposing) return;
                  if (handleSuggestionKey(event)) return;
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
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions().length > 0}
            aria-controls={suggestions().length > 0 ? listboxId : undefined}
            aria-activedescendant={activeIndex() >= 0 ? optionId(activeIndex()) : undefined}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setValidationError(null);
            }}
            onKeyDown={(event) => {
              // An IME composition owns its keys until it ends.
              if (event.isComposing) return;
              if (handleSuggestionKey(event)) return;
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
        {/* The spinner keeps its slot while idle, so the field never changes width when a lookup starts. */}
        <i
          class="ti ti-loader-2 w-4 shrink-0 text-center text-dimmed"
          classList={{ "animate-spin": loading(), invisible: !loading() }}
          aria-hidden="true"
        />
      </div>
      <Show when={validationError()}>
        {(message) => (
          <p id={errorId} class="mt-1 text-xs text-red-600 dark:text-red-300">
            {message()}
          </p>
        )}
      </Show>
      <Show when={suggestions().length > 0}>
        <div
          id={listboxId}
          class="mail-recipient-suggestions absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto p-1"
          role="listbox"
          aria-label={props.placeholder}
        >
          <For each={suggestions()}>
            {(suggestion, index) => (
              <button
                id={optionId(index())}
                type="button"
                tabIndex={-1}
                class="flex w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left hover:bg-[var(--ui-hover)] data-[active=true]:bg-[var(--ui-hover)]"
                role="option"
                aria-selected={activeIndex() === index()}
                data-active={activeIndex() === index() ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(suggestion)}
              >
                <i class={suggestion.source === "mailbox" ? "ti ti-mail text-dimmed" : "ti ti-user text-dimmed"} aria-hidden="true" />
                <Show when={suggestion.source === "mailbox"}>
                  <span class="sr-only">{t().fromThisMailbox}</span>
                </Show>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-primary">{suggestion.label}</span>
                  <Show when={suggestion.label !== suggestion.address}>
                    <span class="block truncate text-xs text-dimmed">{suggestion.address}</span>
                  </Show>
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
