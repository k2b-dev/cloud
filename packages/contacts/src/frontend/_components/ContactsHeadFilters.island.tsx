import { timed } from "@k2b/stdlib/solid";
import { ButtonLink, FilterChip, type FilterChipSection, FilterToggle, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ContactTag } from "../../service";
import { buildContactsQueryHref, contactsFiltered, readContactsQueryOptions, resetContactsFiltersHref } from "../contacts-query";
import { type ContactsHeadState, connectContactsHead, plainContactsClick } from "./contacts-head-events";
import { buildContactsSearchHref } from "./contacts-search";
import { type ResultsMessages, resultsMessages } from "./results-messages";

const sortOptions = (t: ResultsMessages): FilterChipSection[] => [
  {
    options: [
      { value: "name", label: t.sortName, icon: "ti ti-sort-ascending-letters" },
      { value: "updated", label: t.sortRecentlyUpdated, icon: "ti ti-history" },
      { value: "created", label: t.sortRecentlyCreated, icon: "ti ti-clock-plus" },
      { value: "company", label: t.sortCompany, icon: "ti ti-building" },
    ],
  },
];

const reachOptions = (t: ResultsMessages): FilterChipSection[] => [
  {
    label: t.emailGroup,
    options: [
      { value: "email:all", label: t.anyEmail },
      { value: "email:yes", label: t.hasEmail, icon: "ti ti-mail-check" },
      { value: "email:no", label: t.noEmail, icon: "ti ti-mail-off" },
    ],
  },
  {
    label: t.phoneGroup,
    options: [
      { value: "phone:all", label: t.anyPhone },
      { value: "phone:yes", label: t.hasPhone, icon: "ti ti-phone-check" },
      { value: "phone:no", label: t.noPhone, icon: "ti ti-phone-off" },
    ],
  },
];

export default function ContactsHeadFilters(props: {
  initialHref: string;
  initialTotal: number;
  searchPlaceholder: string;
  tags: ContactTag[];
  bookNames: Record<string, string>;
  showBookNames?: boolean;
}) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<ContactsHeadState>({
    source: props.initialHref,
    requestedSource: props.initialHref,
    total: props.initialTotal,
    busy: false,
    filtered: contactsFiltered(props.initialHref),
    selectionMode: false,
  });
  const [query, setQuery] = createSignal(new URL(props.initialHref, "http://contacts.local").searchParams.get("search") ?? "");
  const [focused, setFocused] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  let bridge: ReturnType<typeof connectContactsHead> | undefined;
  const requestedHref = () => state().requestedSource;
  const request = (href: string, resetSearch = false) => bridge?.change({ href, resetSearch });
  const search = (value: string) => {
    request(buildContactsSearchHref(requestedHref(), value));
    setPending(false);
  };
  const debounce = timed.debounce(search, 200);
  const immediateSearch = (value: string) => {
    debounce.cancel();
    setQuery(value);
    search(value);
  };
  onMount(() => {
    bridge = connectContactsHead(setState);
    onCleanup(() => {
      bridge?.dispose();
      debounce.cancel();
    });
  });
  createEffect(() => {
    if (!focused() && !pending() && !state().busy)
      setQuery(new URL(state().source, "http://contacts.local").searchParams.get("search") ?? "");
  });
  const options = () => readContactsQueryOptions(requestedHref());
  const tagId = () => new URL(requestedHref(), "http://contacts.local").searchParams.get("tag_id");
  const searchUrl = () => new URL(requestedHref(), "http://contacts.local");
  const tagHref = (id: string) => {
    const url = new URL(buildContactsSearchHref(requestedHref(), query()), "http://contacts.local");
    if (id === tagId()) url.searchParams.delete("tag_id");
    else url.searchParams.set("tag_id", id);
    return `${url.pathname}${url.search}`;
  };
  const click = (event: MouseEvent, href: string, reset = false) => {
    if (!plainContactsClick(event)) return;
    event.preventDefault();
    // Commit a pending search with a chip change, rather than letting its timer undo the choice.
    debounce.cancel();
    setPending(false);
    if (reset) setQuery("");
    request(href, reset);
  };
  const patchOptions = (patch: Parameters<typeof buildContactsQueryHref>[1]) => {
    const href = buildContactsQueryHref(buildContactsSearchHref(requestedHref(), query()), patch);
    debounce.cancel();
    setPending(false);
    request(href);
  };
  return (
    <div class="contacts-head-filters" data-contacts-head-filters>
      <form
        role="search"
        class="contacts-head-search"
        action={searchUrl().pathname}
        method="get"
        onFocusIn={() => setFocused(true)}
        onFocusOut={() => setFocused(false)}
        onSubmit={(event) => {
          event.preventDefault();
          immediateSearch(query());
        }}
      >
        <TextInput
          name="search"
          type="search"
          aria-label={t().filterContacts}
          placeholder={props.searchPlaceholder}
          icon="ti ti-search"
          activeIcon="ti ti-search"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setPending(true);
            bridge?.supersede();
            debounce.debouncedFn(value);
          }}
          clearable
          clearLabel={t().clearSearch}
          onClear={() => immediateSearch("")}
          suffix={pending() || state().busy ? <i class="ti ti-loader-2 animate-spin" aria-hidden="true" /> : undefined}
        />
        <For each={[...searchUrl().searchParams].filter(([key]) => ["tag_id", "sort", "email", "phone", "favorites"].includes(key))}>
          {([name, value]) => <input type="hidden" name={name} value={value} />}
        </For>
      </form>
      <For each={props.tags}>
        {(tag) => (
          <span class="contacts-tag-chip" style={{ "--app-contacts-tag-color": tag.color }}>
            <FilterToggle
              label={tag.name}
              icon="contacts-tag-dot"
              active={tagId() === tag.id}
              href={tagHref(tag.id)}
              title={
                props.showBookNames
                  ? t().tagInBookTitle({ tagName: tag.name, bookName: props.bookNames[tag.bookId] ?? t().contactBookFallback })
                  : undefined
              }
              onClick={(event) => click(event, tagHref(tag.id))}
            />
          </span>
        )}
      </For>
      <FilterChip
        label={t().sortLabel}
        showValue
        icon="ti ti-arrows-sort"
        options={sortOptions(t())}
        value={[options().sort]}
        defaultValue={["name"]}
        isActive={options().sort !== "name"}
        onValueChange={(value) => patchOptions({ sort: readContactsQueryOptions(`?sort=${value[0] ?? "name"}`).sort })}
      />
      <FilterChip
        label={t().contactInfoLabel}
        showValue
        icon="ti ti-address-book"
        options={reachOptions(t())}
        value={[`email:${options().email}`, `phone:${options().phone}`]}
        defaultValue={["email:all", "phone:all"]}
        isActive={options().email !== "all" || options().phone !== "all"}
        onValueChange={(value) => {
          const next = readContactsQueryOptions(
            `?email=${value.find((v) => v.startsWith("email:"))?.slice(6) ?? "all"}&phone=${value.find((v) => v.startsWith("phone:"))?.slice(6) ?? "all"}`,
          );
          patchOptions({ email: next.email, phone: next.phone });
        }}
      />
      <Show when={contactsFiltered(requestedHref())}>
        <ButtonLink
          class="contacts-head-reset"
          variant="ghost"
          size="sm"
          href={resetContactsFiltersHref(requestedHref())}
          onClick={(event) => click(event, resetContactsFiltersHref(requestedHref()), true)}
        >
          {t().resetFilters}
        </ButtonLink>
        <Show when={!pending() && !state().busy}>
          <span class="contacts-head-count">{t().headResultCount({ total: state().total })}</span>
        </Show>
      </Show>
    </div>
  );
}
