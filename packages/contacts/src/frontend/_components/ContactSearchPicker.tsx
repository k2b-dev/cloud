import { query as queries, timed } from "@k2b/stdlib/solid";
import { Button, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact } from "../../service";
import { resolveContactName } from "../../shared";
import { detailMessages } from "./detail-messages";
import { currentDebouncedSourceValue, type SourceTagged } from "./lazy-query-source";

type Props = {
  /** Restricts results to one book — picker never crosses book boundaries. */
  bookId: string;
  /** Hide these contacts (e.g. self, current parent) from results. */
  excludeIds?: string[];
  /** Called when the user clicks a result. */
  onSelect: (contact: Contact) => void;
  placeholder?: string;
  /** Override the default empty/initial placeholder list size. */
  perPage?: number;
};

/**
 * Compact contact picker: search input + clickable result list. Used by the
 * editor's "Belongs to" field and the detail panel's "Add member" dialog.
 *
 * The query is debounced server-side so typing remains responsive on books
 * with thousands of contacts.
 */
export default function ContactSearchPicker(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const [query, setQuery] = createSignal("");
  const [committedQuery, setCommittedQuery] = createSignal("");

  const source = () =>
    JSON.stringify({ bookId: props.bookId, query: committedQuery(), perPage: props.perPage ?? 20, excludeIds: props.excludeIds ?? [] });
  const results = queries.create<string, SourceTagged<Contact[]>>({
    source,
    load: async (source, ctx) => {
      const {
        bookId,
        query: search,
        perPage,
        excludeIds,
      } = JSON.parse(source) as {
        bookId: string;
        query: string;
        perPage: number;
        excludeIds: string[];
      };
      const res = await apiClient.books[":bookId"].contacts.$get(
        {
          param: { bookId },
          query: { q: search || undefined, per_page: String(perPage) },
        },
        { init: { signal: ctx.abortSignal } },
      );
      if (!res.ok) throw new Error(t().searchContactsFailed);
      const payload = await res.json();
      const items = payload.data;
      const excludeSet = new Set(excludeIds);
      return { source, value: items.filter((c) => !excludeSet.has(c.id)) };
    },
  });
  const currentResults = () => currentDebouncedSourceValue(query(), committedQuery(), source(), results.data());
  const visibleError = () => (query() === committedQuery() ? results.error() : null);

  const { debouncedFn: commitSearch } = timed.debounce(setCommittedQuery, 200);

  let firstEffect = true;
  createEffect(() => {
    const q = query();
    if (firstEffect) {
      firstEffect = false;
      return;
    }
    commitSearch(q);
  });

  const subtitle = (contact: Contact) => {
    const parts = [contact.companyName, contact.jobTitle].filter(Boolean) as string[];
    return parts.join(" · ");
  };

  return (
    <div class="flex flex-col gap-2">
      <TextInput
        aria-label={t().searchContacts}
        placeholder={props.placeholder ?? t().searchContactsHint}
        icon="ti ti-search"
        value={query}
        onValueChange={setQuery}
      />
      <div class="-mx-1 flex max-h-72 flex-col overflow-y-auto px-1">
        <Show when={visibleError()}>
          <div class="flex items-center justify-between gap-2 px-2 py-2 text-xs text-red-600 dark:text-red-400" role="alert">
            <span>{t().searchContactsFailed}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void results.refresh()}>
              {t().retry}
            </Button>
          </div>
        </Show>
        <Show
          when={(currentResults() ?? []).length > 0}
          fallback={
            <Show when={!visibleError()}>
              <p class="px-2 py-6 text-center text-xs text-dimmed">
                {results.loading() || query() !== committedQuery() ? t().searching : t().noMatches}
              </p>
            </Show>
          }
        >
          <For each={currentResults() ?? []}>
            {(contact) => (
              <button
                type="button"
                onClick={() => props.onSelect(contact)}
                class="flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium dark:bg-zinc-700">
                  {resolveContactName(contact).charAt(0).toUpperCase()}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm text-primary">{resolveContactName(contact)}</div>
                  <Show when={subtitle(contact)}>
                    <div class="truncate text-xs text-dimmed">{subtitle(contact)}</div>
                  </Show>
                </div>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
