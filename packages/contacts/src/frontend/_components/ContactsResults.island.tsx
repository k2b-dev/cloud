import { documentNavigate, type LinkNavigateEvent, navigate } from "@k2b/ssr/nav";
import { query as queries, timed } from "@k2b/stdlib/solid";
import { Button, FilterChip, type FilterChipSection, Pagination, ScrollArea, Tag, TextInput } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactPresenceFilter, ContactSort, ContactTag } from "../../service";
import { buildContactsQueryHref, readContactsQueryOptions } from "../contacts-query";
import { readErrorMessage } from "./api";
import { openContactDuplicatesDialog } from "./ContactDuplicatesDialog";
import ContactsBulkActions from "./ContactsBulkActions";
import ContactsList from "./ContactsList";
import { listenForContactFavoriteChanges } from "./contacts-favorites";
import { listenForContactsLiveInvalidation, requiresContactsResultsRefresh } from "./contacts-live";
import { createContactsResultsNavigation, selectContactsResultsSnapshot } from "./contacts-results-navigation";
import {
  buildContactsPageHref,
  buildContactsPaginationBaseHref,
  buildContactsSearchHref,
  contactsResultHref,
  contactsResultSignature,
} from "./contacts-search";
import { syncContactDetailFromUrl } from "./context";

type Props = {
  bookId?: string;
  initialSearch: string;
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
  searchPlaceholder: string;
  tags?: ContactTag[];
  activeTagId?: string | null;
  filtersBasePath?: string;
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

const filterHref = (href: string, search: string, tagId?: string) => {
  const url = new URL(href, "http://contacts.local");
  if (search.trim()) url.searchParams.set("search", search.trim());
  else url.searchParams.delete("search");
  if (tagId) url.searchParams.set("tag_id", tagId);
  else url.searchParams.delete("tag_id");
  url.searchParams.delete("page");
  url.searchParams.delete("contact");
  url.searchParams.delete("contactBook");
  return `${url.pathname}${url.search}`;
};

const SORT_OPTIONS: FilterChipSection[] = [
  {
    options: [
      { value: "name", label: "Name", icon: "ti ti-sort-ascending-letters" },
      { value: "updated", label: "Recently updated", icon: "ti ti-history" },
      { value: "created", label: "Recently created", icon: "ti ti-clock-plus" },
      { value: "company", label: "Company", icon: "ti ti-building" },
    ],
  },
];

const REACH_OPTIONS: FilterChipSection[] = [
  {
    label: "Email",
    options: [
      { value: "email:all", label: "Any email" },
      { value: "email:yes", label: "Has email", icon: "ti ti-mail-check" },
      { value: "email:no", label: "No email", icon: "ti ti-mail-off" },
    ],
  },
  {
    label: "Phone",
    options: [
      { value: "phone:all", label: "Any phone" },
      { value: "phone:yes", label: "Has phone", icon: "ti ti-phone-check" },
      { value: "phone:no", label: "No phone", icon: "ti ti-phone-off" },
    ],
  },
];

const fetchContactsResults = async (props: Pick<Props, "bookId" | "perPage">, href: string, signal: AbortSignal) => {
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
  if (!response.ok) throw new Error(await readErrorMessage(response, "Could not update contacts"));
  return await response.json();
};

const loadContactsResults = async (
  props: Pick<Props, "bookId" | "perPage">,
  source: string,
  signal: AbortSignal,
): Promise<ContactsResultsSnapshot> => {
  let href = source;
  let payload = await fetchContactsResults(props, href, signal);
  const totalPages = Math.max(1, payload.pagination.total_pages);
  if (payload.pagination.page > totalPages) {
    href = buildContactsPageHref(source, totalPages);
    payload = await fetchContactsResults(props, href, signal);
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
  const [query, setQuery] = createSignal(props.initialSearch);
  const [focused, setFocused] = createSignal(false);
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [failedSource, setFailedSource] = createSignal<string | null>(null);

  const results = queries.create<string, ContactsResultsSnapshot, unknown>({
    source,
    initial: { source: initialSource, data: initialSnapshot },
    load: async (href, { abortSignal }) => {
      setFailedSource(null);
      try {
        return await loadContactsResults(props, href, abortSignal);
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

  const debounce = timed.debounce((value: string) => {
    void navigateHref(buildContactsSearchHref(pathWithQuery(), value));
  }, 200);

  createEffect(() => {
    if (!focused() && !debounce.isPending() && !results.loading()) {
      setQuery(new URL(currentHref(), "http://contacts.local").searchParams.get("search") ?? "");
    }
  });

  createEffect(() => {
    const loaded = results.data();
    if (!loaded || loaded.source !== source() || results.stale()) return;
    const applied = navigation.apply(loaded.source, loaded.href, () => {
      const visibleIds = new Set(loaded.contacts.map((contact) => contact.id));
      setSelectedIds((selected) => selected.filter((id) => visibleIds.has(id)));
      setQuery(new URL(loaded.href, window.location.origin).searchParams.get("search") ?? "");
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
      debounce.cancel();
      window.removeEventListener("popstate", handlePopState);
      navigation.dispose();
    });
  });

  const commitImmediately = (value: string) => {
    debounce.cancel();
    navigation.supersede();
    void navigateHref(buildContactsSearchHref(pathWithQuery(), value));
  };

  const updateOptions = (patch: Parameters<typeof buildContactsQueryHref>[1]) => {
    const href = buildContactsQueryHref(currentHref(), patch);
    if (!props.bookId && patch.favorites !== undefined) {
      documentNavigate(href, { replace: true });
      return;
    }
    void navigateHref(href);
  };

  const clearSelection = () => {
    setSelectedIds([]);
    setSelectionMode(false);
  };
  const toggleSelection = (contactId: string) => {
    setSelectedIds((current) => (current.includes(contactId) ? current.filter((id) => id !== contactId) : [...current, contactId]));
  };
  const selectVisible = () => setSelectedIds(current()?.contacts.map((contact) => contact.id) ?? []);
  const refreshResults = () => results.invalidate({ type: "contacts.changed" });

  const committedSearch = () => new URL(currentHref(), "http://contacts.local").searchParams.get("search") ?? "";
  const formAction = () => new URL(props.initialHref, "http://contacts.local").pathname;
  const resultCopy = () =>
    !current()
      ? "Loading contacts…"
      : committedSearch().trim()
        ? `${current()!.total} result${current()!.total === 1 ? "" : "s"} for “${committedSearch().trim()}”`
        : `${current()!.total} contact${current()!.total === 1 ? "" : "s"}`;

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="shrink-0 px-3 pb-3 sm:px-4">
        <p class="mb-2 text-xs text-dimmed" aria-live="polite">
          <span class="tabular-nums text-secondary">{resultCopy()}</span>
        </p>
        <form
          role="search"
          action={formAction()}
          method="get"
          onSubmit={(event) => {
            event.preventDefault();
            commitImmediately(query());
          }}
          onFocusIn={() => setFocused(true)}
          onFocusOut={() => setFocused(false)}
        >
          <TextInput
            name="search"
            type="search"
            aria-label="Filter contacts"
            placeholder={props.searchPlaceholder}
            icon="ti ti-search"
            activeIcon="ti ti-search"
            value={query}
            onValueChange={(value) => {
              navigation.supersede();
              setQuery(value);
              debounce.debouncedFn(value);
            }}
            clearable
            clearLabel="Clear search"
            onClear={() => {
              setQuery("");
              commitImmediately("");
            }}
            suffix={
              debounce.isPending() || results.loading() || results.refreshing() ? (
                <i class="ti ti-loader-2 animate-spin text-dimmed" aria-hidden="true" />
              ) : undefined
            }
          />
          <Show when={props.activeTagId}>{(tagId) => <input type="hidden" name="tag_id" value={tagId()} />}</Show>
          <Show when={readContactsQueryOptions(currentHref()).sort !== "name"}>
            <input type="hidden" name="sort" value={readContactsQueryOptions(currentHref()).sort} />
          </Show>
          <Show when={readContactsQueryOptions(currentHref()).email !== "all"}>
            <input type="hidden" name="email" value={readContactsQueryOptions(currentHref()).email} />
          </Show>
          <Show when={readContactsQueryOptions(currentHref()).phone !== "all"}>
            <input type="hidden" name="phone" value={readContactsQueryOptions(currentHref()).phone} />
          </Show>
          <Show when={readContactsQueryOptions(currentHref()).favorites}>
            <input type="hidden" name="favorites" value="true" />
          </Show>
        </form>
        <Show when={(props.tags?.length ?? 0) > 0 && props.filtersBasePath}>
          <nav aria-label="Filter contacts by tag" class="mt-2 flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5">
            <a
              href={filterHref(currentHref(), query())}
              aria-current={!props.activeTagId ? "page" : undefined}
              class="inline-flex shrink-0 transition-opacity hover:opacity-80"
            >
              <Tag selected={!props.activeTagId} size="lg">
                All
              </Tag>
            </a>
            {props.tags?.map((tag) => (
              <a
                href={filterHref(currentHref(), query(), tag.id)}
                aria-current={props.activeTagId === tag.id ? "page" : undefined}
                title={props.showBookNames ? `${tag.name} · ${props.bookNames[tag.bookId] ?? "Contact book"}` : undefined}
                class="inline-flex shrink-0 transition-opacity hover:opacity-80"
              >
                <Tag color={tag.color} icon="ti ti-point" selected={props.activeTagId === tag.id} size="lg">
                  {tag.name}
                </Tag>
              </a>
            ))}
          </nav>
        </Show>
        <div class="no-scrollbar mt-2 flex items-center gap-2 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
          <FilterChip
            label="Sort"
            icon="ti ti-arrows-sort"
            options={SORT_OPTIONS}
            value={[readContactsQueryOptions(currentHref()).sort]}
            defaultValue={["name"]}
            isActive={readContactsQueryOptions(currentHref()).sort !== "name"}
            onValueChange={(value) => updateOptions({ sort: (value[0] ?? "name") as ContactSort })}
          />
          <FilterChip
            label="Contact info"
            icon="ti ti-address-book"
            options={REACH_OPTIONS}
            value={[`email:${readContactsQueryOptions(currentHref()).email}`, `phone:${readContactsQueryOptions(currentHref()).phone}`]}
            defaultValue={["email:all", "phone:all"]}
            isActive={readContactsQueryOptions(currentHref()).email !== "all" || readContactsQueryOptions(currentHref()).phone !== "all"}
            onValueChange={(value) =>
              updateOptions({
                email: (value.find((entry) => entry.startsWith("email:"))?.slice(6) ?? "all") as ContactPresenceFilter,
                phone: (value.find((entry) => entry.startsWith("phone:"))?.slice(6) ?? "all") as ContactPresenceFilter,
              })
            }
          />
          <Show when={props.canWrite && props.bookId}>
            <span class="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const changed = await openContactDuplicatesDialog(props.bookId!);
                  if (changed) documentNavigate(currentHref(), { replace: true });
                }}
              >
                <i class="ti ti-users-group" /> Duplicates
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={selectionMode()}
                onClick={() => (selectionMode() ? clearSelection() : setSelectionMode(true))}
              >
                <i class="ti ti-list-check" /> Select
              </Button>
            </span>
          </Show>
        </div>
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

      <ScrollArea class="flex-1 px-3 pb-3 sm:px-4" scrollPreserveKey="contacts-main-list">
        <Show when={results.error()}>
          {(error) => (
            <div class="mb-2 flex items-center justify-between gap-2 text-xs text-red-600" role="alert">
              <span>{error().message}</span>
              <Button type="button" variant="ghost" size="xs" disabled={results.refreshing()} onClick={() => void results.refresh()}>
                Retry
              </Button>
            </div>
          )}
        </Show>
        <Show when={current()} fallback={<p class="py-8 text-center text-sm text-dimmed">Loading contacts…</p>}>
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
                emptyTitle={committedSearch().trim() ? "No matching contacts" : "No contacts yet"}
                emptyDescription={
                  committedSearch().trim()
                    ? "Try a different name, company, email address, or phone number."
                    : "Create the first contact from the action above."
                }
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
