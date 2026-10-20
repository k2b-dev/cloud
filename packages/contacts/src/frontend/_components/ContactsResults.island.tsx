import { documentNavigate, type LinkNavigateEvent, navigate } from "@k2b/ssr/nav";
import { query as queries } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, Pagination, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactTag } from "../../service";
import { contactsFiltered, readContactsQueryOptions } from "../contacts-query";
import { readErrorMessage } from "./api";
import { publishContactsHeadState, subscribeToContactsHeadChanges } from "./contacts-head-events";
import ContactsBulkActions from "./ContactsBulkActions";
import ContactsList from "./ContactsList";
import CreateBookAction from "./CreateBookAction";
import { type ContactsScope, contactsEmptyState } from "./contacts-empty-state";
import { listenForContactFavoriteChanges } from "./contacts-favorites";
import { listenForContactsLiveInvalidation, requiresContactsResultsRefresh } from "./contacts-live";
import { createContactsResultsNavigation, selectContactsResultsSnapshot } from "./contacts-results-navigation";
import { buildContactsPageHref, buildContactsPaginationBaseHref, contactsResultHref, contactsResultSignature } from "./contacts-search";
import { syncContactDetailFromUrl } from "./context";
import { resultsMessages } from "./results-messages";

type Props = {
  scope: ContactsScope;
  bookId?: string;
  initialHref: string;
  initialContacts: Contact[];
  initialTotal: number;
  initialPage: number;
  initialTotalPages: number;
  perPage: number;
  bookNames: Record<string, string>;
  showBookNames?: boolean;
  initialSelectedContactId: string | null;
  initialSelectedBookId: string | null;
  tags?: ContactTag[];
  initialFavoriteKeys: string[];
  canWrite: boolean;
  writableBooks: Array<{ id: string; name: string }>;
};

type ContactsResultsSnapshot = {
  source: string;
  href: string;
  contacts: Contact[];
  favoriteKeys: string[];
  total: number;
  page: number;
  totalPages: number;
};

const pathWithQuery = () => `${window.location.pathname}${window.location.search}`;

const fetchContactsResults = async (props: Pick<Props, "bookId" | "perPage">, href: string, signal: AbortSignal, errorFallback: string) => {
  const url = new URL(href, window.location.origin);
  const options = readContactsQueryOptions(href);
  const queryParams = {
    q: url.searchParams.get("search") || undefined,
    tag_id: url.searchParams.get("tag_id") || undefined,
    page: url.searchParams.get("page") ?? "1",
    per_page: String(props.perPage),
    sort: options.sort === "name" ? undefined : options.sort,
    email: options.email === "all" ? undefined : options.email,
    phone: options.phone === "all" ? undefined : options.phone,
    favorites: options.favorites ? ("true" as const) : undefined,
  };
  const response = props.bookId
    ? await apiClient.books[":bookId"].contacts.$get(
        {
          param: { bookId: props.bookId },
          query: queryParams,
        },
        { init: { signal } },
      )
    : await apiClient.search.$get({ query: queryParams }, { init: { signal } });
  if (!response.ok) throw new Error(await readErrorMessage(response, errorFallback));
  return await response.json();
};

const loadContactsResults = async (
  props: Pick<Props, "bookId" | "perPage">,
  source: string,
  signal: AbortSignal,
  errorFallback: string,
): Promise<ContactsResultsSnapshot> => {
  let href = source;
  let payload = await fetchContactsResults(props, href, signal, errorFallback);
  const totalPages = Math.max(1, payload.pagination.total_pages);
  if (payload.pagination.page > totalPages) {
    href = buildContactsPageHref(source, totalPages);
    payload = await fetchContactsResults(props, href, signal, errorFallback);
  }
  return {
    source,
    href,
    contacts: payload.data,
    favoriteKeys: payload.favoriteKeys,
    total: payload.pagination.total,
    page: payload.pagination.page,
    totalPages: Math.max(1, payload.pagination.total_pages),
  };
};

export default function ContactsResults(props: Props) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const initialSource = contactsResultHref(props.initialHref);
  const initialSnapshot: ContactsResultsSnapshot = {
    source: initialSource,
    href: initialSource,
    contacts: props.initialContacts,
    favoriteKeys: props.initialFavoriteKeys,
    total: props.initialTotal,
    page: props.initialPage,
    totalPages: props.initialTotalPages,
  };
  const [source, setSource] = createSignal(initialSource);
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [failedSource, setFailedSource] = createSignal<string | null>(null);

  const results = queries.create<string, ContactsResultsSnapshot, unknown>({
    source,
    initial: { source: initialSource, data: initialSnapshot },
    load: async (href, { abortSignal }) => {
      setFailedSource(null);
      try {
        return await loadContactsResults(props, href, abortSignal, t().couldNotUpdateContacts);
      } catch (error) {
        if (!abortSignal.aborted) setFailedSource(href);
        throw error;
      }
    },
    subscribe: ({ invalidate }) => {
      const stopLiveInvalidations = listenForContactsLiveInvalidation("results", (event) => {
        if (requiresContactsResultsRefresh(event)) return invalidate(event);
      });
      const stopFavoriteChanges = listenForContactFavoriteChanges(() => {
        if (readContactsQueryOptions(currentHref()).favorites) void invalidate({ type: "favorite.changed" }).catch(() => undefined);
      });
      return () => {
        stopLiveInvalidations();
        stopFavoriteChanges();
      };
    },
  });

  const navigation = createContactsResultsNavigation({
    initialSource,
    initialHref: initialSource,
    setSource,
  });

  const current = (): ContactsResultsSnapshot | undefined => {
    return selectContactsResultsSnapshot({
      loaded: results.data(),
      source: source(),
      committedSource: navigation.committedSource(),
      canRenderCommitted: navigation.canRenderCommitted(),
    });
  };
  const currentHref = () => current()?.href ?? source();

  // The scope comes from SSR and never changes inside this island, so the action is created once.
  const createBookAction = props.scope === "noBooks" ? <CreateBookAction /> : undefined;
  const emptyState = () => {
    const href = currentHref();
    const url = new URL(href, "http://contacts.local");
    return contactsEmptyState(
      {
        ...readContactsQueryOptions(href),
        scope: props.scope,
        canWrite: props.bookId ? props.canWrite : props.writableBooks.length > 0,
        search: url.searchParams.get("search") ?? "",
        tagId: url.searchParams.get("tag_id"),
      },
      t(),
    );
  };

  const commitHistory = (href: string) => {
    navigate(href, { replace: true, scroll: "preserve" });
    syncContactDetailFromUrl();
  };

  const navigateHref = (
    href: string,
    options: { retainCommitted?: boolean; onApply?: (href: string) => void; onFallback?: (href: string) => void } = {},
  ) => {
    setFailedSource(null);
    return navigation.navigate(contactsResultHref(href), {
      onApply: options.onApply ?? commitHistory,
      onFallback: options.onFallback ?? ((fallbackHref) => documentNavigate(fallbackHref, { replace: true })),
      retainCommitted: options.retainCommitted,
    });
  };

  createEffect(() => {
    const loaded = results.data();
    if (!loaded || loaded.source !== source() || results.stale()) return;
    const applied = navigation.apply(loaded.source, loaded.href, () => {
      const visibleIds = new Set(loaded.contacts.map((contact) => contact.id));
      setSelectedIds((selected) => selected.filter((id) => visibleIds.has(id)));
    });
    if (applied) return;

    const visibleIds = new Set(loaded.contacts.map((contact) => contact.id));
    setSelectedIds((selected) => selected.filter((id) => visibleIds.has(id)));
  });

  createEffect(() => {
    const failed = failedSource();
    if (results.error() && failed && source() === failed) navigation.fail(failed);
  });

  const handlePopState = () => {
    const href = contactsResultHref(pathWithQuery());
    if (contactsResultSignature(href) === contactsResultSignature(navigation.committedHref())) return;
    void navigateHref(href, {
      retainCommitted: false,
      onApply: () => syncContactDetailFromUrl(),
      onFallback: (fallbackHref) => documentNavigate(fallbackHref, { replace: true }),
    });
  };
  onMount(() => {
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => {
      window.removeEventListener("popstate", handlePopState);
      navigation.dispose();
    });
  });

  const clearSelection = () => {
    setSelectedIds([]);
    setSelectionMode(false);
  };
  const toggleSelection = (contactId: string) => {
    setSelectedIds((current) => (current.includes(contactId) ? current.filter((id) => id !== contactId) : [...current, contactId]));
  };
  const selectVisible = () => setSelectedIds(current()?.contacts.map((contact) => contact.id) ?? []);
  const refreshResults = () => results.invalidate({ type: "contacts.changed" });

  const publishHead = () =>
    publishContactsHeadState({
      source: currentHref(),
      requestedSource: source(),
      busy: results.loading() || results.refreshing(),
      total: current()?.total ?? props.initialTotal,
      filtered: contactsFiltered(currentHref()),
      selectionMode: selectionMode(),
    });
  createEffect(publishHead);
  onMount(() => {
    onCleanup(
      subscribeToContactsHeadChanges(
        (change) => {
          void navigateHref(change.href);
        },
        () => {
          if (!props.bookId || !props.canWrite) return;
          if (selectionMode()) clearSelection();
          else setSelectionMode(true);
        },
        publishHead,
        navigation.supersede,
      ),
    );
    publishHead();
  });

  const committedSearch = () => new URL(currentHref(), "http://contacts.local").searchParams.get("search") ?? "";
  const resultCopy = () =>
    !current()
      ? t().loadingContacts
      : committedSearch().trim()
        ? t().resultCount({ total: current()!.total, search: committedSearch().trim() })
        : t().contactCount({ total: current()!.total });

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <p class="sr-only" aria-live="polite">
        {resultCopy()}
      </p>
      <div class="contacts-results-actions">
        <Show when={selectionMode() && props.bookId}>
          <ContactsBulkActions
            bookId={props.bookId!}
            selectedIds={selectedIds}
            visibleIds={() => current()?.contacts.map((contact) => contact.id) ?? []}
            tags={props.tags ?? []}
            writableBooks={props.writableBooks}
            onSelectVisible={selectVisible}
            onClear={clearSelection}
            onChanged={refreshResults}
          />
        </Show>
      </div>

      <ScrollArea
        aria-busy={results.loading() || results.refreshing()}
        class="flex-1 px-3 pb-3 sm:px-4"
        scrollPreserveKey="contacts-main-list"
      >
        <Show when={results.error()}>
          {(error) => (
            <div class="mb-2 flex items-center justify-between gap-2">
              <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
                {error().message}
              </InlineGuidance>
              <Button type="button" variant="ghost" size="xs" disabled={results.refreshing()} onClick={() => void results.refresh()}>
                {t().retry}
              </Button>
            </div>
          )}
        </Show>
        <Show
          when={current()}
          fallback={
            <>
              <ul class="contacts-list-skeleton" aria-hidden="true">
                {Array.from({ length: 8 }, () => (
                  <li class="contacts-list-skeleton__row">
                    <span class="contacts-list-skeleton__avatar" />
                    <span class="contacts-list-skeleton__lines">
                      <span />
                      <span />
                    </span>
                  </li>
                ))}
              </ul>
              <span class="sr-only">{t().loadingContacts}</span>
            </>
          }
        >
          {(snapshot) => (
            <>
              <ContactsList
                contacts={snapshot().contacts}
                bookNames={props.bookNames}
                showBookNames={props.showBookNames}
                initialSelectedContactId={props.initialSelectedContactId}
                initialSelectedBookId={props.initialSelectedBookId}
                detailBaseHref={snapshot().href}
                initialFavoriteKeys={snapshot().favoriteKeys}
                selectionMode={selectionMode()}
                selectedIds={selectedIds()}
                onToggleSelection={toggleSelection}
                emptyTitle={emptyState().title}
                emptyDescription={emptyState().description}
                emptyAction={emptyState().action === "createBook" ? createBookAction : undefined}
              />
              <Show when={snapshot().totalPages > 1}>
                <div class="pt-3">
                  <Pagination
                    currentPage={snapshot().page}
                    totalPages={snapshot().totalPages}
                    baseUrl={buildContactsPaginationBaseHref(snapshot().href)}
                    onNavigate={async (event: LinkNavigateEvent) => {
                      await navigateHref(event.href, {
                        onApply: (href) => {
                          event.push(href);
                          syncContactDetailFromUrl();
                        },
                        onFallback: (href) => event.fallback(href),
                      });
                    }}
                  />
                </div>
              </Show>
            </>
          )}
        </Show>
      </ScrollArea>
    </div>
  );
}
