import { CloudAvatar } from "@k2b/cloud/account/ui";
import { liveConnection } from "@k2b/cloud/browser/live";
import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  FilterChip,
  FilterToggle,
  IconButton,
  Placeholder,
  Skeleton,
  Tag,
  TextInput,
  type ToastHandle,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { SpaceLiveEventSchema } from "@/live-events";
import { createRetryToasts } from "../frontend/lib/feedback";
import { saveCompletion } from "./completion";
import { myTasksMessages } from "./messages";
import { listHref, type SpaceListFilter, spaceHref } from "./paths";
import { refreshOnReturn } from "./refresh-on-return";
import { workSchedule } from "./schedule";
import type { PwaGroup, PwaRow, PwaSpace, PwaSpaceEntry, PwaStatus } from "./space";

type Props = {
  userId: string;
  spaceShortId: string;
  /** What the title's switcher knows of the Space, shown while it loads and after access ends. */
  entry?: PwaSpaceEntry;
  /** The server's read of the Space; null when it could not be opened, undefined when the list reads it itself. */
  initial?: PwaSpace | null;
  filter: SpaceListFilter;
  dateConfig: DateContext;
  online: boolean;
  /** The search field replaces the filter chips; the head's search button opens it. */
  searching: boolean;
  /** The short ID of the open task, marked in the list. */
  selected?: string;
  /** Raised when a task changed elsewhere on the page, such as in its detail; the list is read again. */
  revision?: number;
  /** The person narrowed or widened the list; the page keeps it in the address. */
  onFilterChange: (filter: SpaceListFilter) => void;
  onSearchClose: () => void;
  /** The Space as read last, for the head: its name and colour, or null once it cannot be opened. */
  onSpace?: (space: PwaSpace | null) => void;
  taskHref: (row: PwaRow) => string;
  onOpen: (row: PwaRow, event: LinkNavigateEvent) => void;
  /** A task was completed or reopened here. */
  onCompletedChange?: (shortId: string, done: boolean) => void;
};

type Read = { key: string; space: PwaSpace | null };

const filterKey = (filter: SpaceListFilter) => JSON.stringify([filter.mine, [...filter.tagIds].sort(), filter.search]);
const active = (filter: SpaceListFilter) => filter.mine || filter.tagIds.length > 0;

/** Reads the Space with `filter`; `load` names the pages of each status the list already shows. */
const readSpace = async (spaceShortId: string, filter: SpaceListFilter, load: ReadonlyMap<string, number>, signal: AbortSignal) => {
  const href = new URL(spaceHref(spaceShortId, filter), window.location.origin);
  for (const [statusId, pages] of load) href.searchParams.append("load", `${statusId}:${pages}`);
  const response = await fetch(href, { headers: { Accept: "application/json" }, signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Space request failed with ${response.status}`);
  return (await response.json()) as PwaSpace;
};

const readPage = async (spaceShortId: string, filter: SpaceListFilter, statusId: string, page: number): Promise<PwaGroup | null> => {
  const href = new URL(spaceHref(spaceShortId, filter), window.location.origin);
  href.searchParams.set("status", statusId);
  href.searchParams.set("page", String(page));
  const response = await fetch(href, { headers: { Accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Status request failed with ${response.status}`);
  return (await response.json()) as PwaGroup;
};

/**
 * One Space in the mobile app as a list of its statuses: each status is a group with its dot, name and count and
 * the first 30 rows, as a board column on the web shows them, then "Load more"; a done status starts folded and
 * reads its rows when unfolded. Filters and a search narrow the list and stay in the address. The list follows the
 * Space's live channel and reads again on return; rows keep their place and focus while it does. A row is checked
 * off with Undo, as in "My tasks".
 */
export default function SpaceList(props: Props) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  // The server renders the check buttons before this island runs; until then a tap would do nothing.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));

  /** Statuses the person folded or unfolded; a done status starts folded. */
  const [toggled, setToggled] = createSignal<ReadonlySet<string>>(new Set());
  /** Further pages read per status, kept until the next read of the Space covers them. */
  const [extra, setExtra] = createSignal<ReadonlyMap<string, PwaGroup>>(new Map());
  const [pageState, setPageState] = createSignal<ReadonlyMap<string, "loading" | "failed">>(new Map());
  /** Tasks being checked off or reopened here: their row shows the choice until the list shows the server's. */
  const [pending, setPending] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  const notices = new Map<string, ToastHandle>();

  const key = () => filterKey(props.filter);
  const space = query.create<string, Read>({
    source: key,
    initial: props.initial !== undefined ? { source: key(), data: { key: key(), space: props.initial } } : undefined,
    load: async (source, { abortSignal }) => ({
      key: source,
      space: await readSpace(props.spaceShortId, props.filter, loads(), abortSignal),
    }),
  });
  const current = (): Read | undefined => {
    const data = space.data();
    return data?.key === key() ? data : undefined;
  };
  /** The last Space read, kept while a new filter loads, so the head and the chips stay put. */
  const shown = (): PwaSpace | undefined => space.data()?.space ?? undefined;
  createEffect(
    on(
      () => space.data()?.space,
      (value) => value !== undefined && props.onSpace?.(value),
    ),
  );

  const statuses = (): PwaStatus[] => shown()?.statuses ?? [];
  const folded = (status: PwaStatus) => status.done !== toggled().has(status.id);
  /** Each status's rows: the read of the Space, then any further pages read since, without duplicates. */
  const groups = createMemo((): PwaGroup[] => {
    const read = current()?.space;
    if (!read) return [];
    return read.groups.map((group) => {
      const more = extra().get(group.statusId);
      if (!more || more.pages <= group.pages) return group;
      const known = new Set(group.rows.map((row) => row.shortId));
      return { ...more, rows: [...group.rows, ...more.rows.filter((row) => !known.has(row.shortId))] };
    });
  });
  /** The pages each status shows, so a fresh read covers them all. */
  const loads = (): Map<string, number> =>
    new Map(
      groups()
        .filter((group) => group.pages > 1 || (group.pages > 0 && statuses().find((status) => status.id === group.statusId)?.done))
        .map((group) => [group.statusId, group.pages]),
    );
  // A fresh read covers the extra pages it was asked for.
  createEffect(on(current, () => setExtra(new Map()), { defer: true }));

  const refresh = async () => {
    try {
      await space.invalidate();
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) retryToast(t().refreshFailed, t().retry, () => void refresh());
    }
  };
  createEffect(
    on(
      () => props.revision,
      () => void refresh(),
      { defer: true },
    ),
  );
  refreshOnReturn(() => void refresh());

  // The list follows the Space's own channel; every change reads it again, which keeps rows and focus in place.
  createEffect(() => {
    if (current()?.space === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    };
    let initial = true;
    const subscription = liveConnection("/api/spaces/live").subscribe(
      "space",
      { space: props.spaceShortId },
      {
        cursor: null,
        parse: (data) => SpaceLiveEventSchema.parse(data),
        apply: async () => soon(),
        resync: async () => soon(),
        caughtUp: (ready) => {
          if (ready && initial) {
            initial = false;
            soon();
          }
        },
        revoked: () => soon(),
        unavailable: () => soon(),
      },
    );
    onCleanup(() => {
      clearTimeout(timer);
      subscription.close();
    });
  });

  const toggle = (status: PwaStatus) => {
    setToggled((set) => {
      const next = new Set(set);
      if (next.has(status.id)) next.delete(status.id);
      else next.add(status.id);
      return next;
    });
    const group = groups().find((entry) => entry.statusId === status.id);
    if (!folded(status) && group && group.pages === 0 && group.total > 0) void loadPage(status.id, 1);
  };

  const loadPage = async (statusId: string, page: number) => {
    if (pageState().get(statusId) === "loading") return;
    setPageState((map) => new Map(map).set(statusId, "loading"));
    const result = await readPage(props.spaceShortId, props.filter, statusId, page).catch(() => undefined);
    if (result === null) {
      setPageState((map) => withoutKey(map, statusId));
      return void refresh();
    }
    if (!result) return void setPageState((map) => new Map(map).set(statusId, "failed"));
    setPageState((map) => withoutKey(map, statusId));
    setExtra((map) => {
      const before = map.get(statusId) ?? groups().find((group) => group.statusId === statusId);
      const known = new Set(before?.rows.map((row) => row.shortId));
      const rows = page === 1 ? result.rows : [...(before?.rows ?? []), ...result.rows.filter((row) => !known.has(row.shortId))];
      return new Map(map).set(statusId, { ...result, pages: page, rows });
    });
  };

  const readOnly = () => shown()?.canWrite === false;
  const locked = () => !mounted() || !props.online || readOnly();

  /** Each task sends one request at a time, so Undo never lands before the completion it reverses. */
  const inflight = new Map<string, Promise<void>>();
  const setDone = (row: PwaRow, completed: boolean): Promise<void> => {
    // The row shows the choice at once, before an earlier request for it has ended.
    setPending((map) => new Map(map).set(row.shortId, completed));
    const run = (inflight.get(row.shortId) ?? Promise.resolve()).then(() => save(row, completed));
    inflight.set(row.shortId, run);
    void run.finally(() => inflight.get(row.shortId) === run && inflight.delete(row.shortId));
    return run;
  };
  const save = async (row: PwaRow, completed: boolean) => {
    const read = shown();
    if (!read) {
      setPending((map) => withoutKey(map, row.shortId));
      return;
    }
    setPending((map) => new Map(map).set(row.shortId, completed));
    const outcome = await saveCompletion({
      item: { shortId: row.shortId, spaceShortId: props.spaceShortId, title: row.title, spaceName: read.name },
      completed,
      userId: props.userId,
      locale: locale(),
    });
    if (outcome === "saved") {
      props.onCompletedChange?.(row.shortId, completed);
      await refresh();
    } else {
      if (completed) notices.get(row.shortId)?.dismiss();
      if (outcome === "failed")
        retryToast(
          completed ? t().completeFailed({ title: row.title }) : t().reopenFailed({ title: row.title }),
          t().retry,
          () => void setDone(row, completed),
        );
    }
    setPending((map) => withoutKey(map, row.shortId));
  };

  /** The row leaves at once with Undo, as in "My tasks"; it comes back when the server refuses or cannot be reached. */
  const complete = (row: PwaRow) => {
    if (pending().has(row.shortId)) return;
    const notice = toast.success(t().done, {
      action: {
        label: t().undo,
        onClick: () => {
          notice.dismiss();
          void undo(row);
        },
      },
    });
    notices.set(row.shortId, notice);
    void setDone(row, true);
  };
  const undo = (row: PwaRow) => setDone({ ...row, completed: true }, false);

  /** A row the person just checked off leaves its open status; one they reopened leaves the done one. */
  const rowsOf = (group: PwaGroup) =>
    group.rows.filter((row) => !pending().has(row.shortId) || pending().get(row.shortId) === row.completed);

  const searching = () => props.searching || props.filter.search.length > 0;
  const tagName = (id: string) => shown()?.tags.find((tag) => tag.id === id)?.name ?? id;
  const tagList = () => {
    const names = props.filter.tagIds.map((id) => t().quoted({ text: tagName(id) }));
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} ${t().or} ${names.at(-1)}` : (names[0] ?? "");
  };
  const noMatch = () =>
    props.filter.search
      ? t().noSearchMatch({ query: props.filter.search })
      : props.filter.mine && props.filter.tagIds.length
        ? t().noMatchBoth({ tags: tagList() })
        : props.filter.mine
          ? t().noMatchMine
          : t().noMatchTags({ tags: tagList() });
  const total = () => groups().reduce((sum, group) => sum + group.total, 0);
  const hits = () =>
    groups().reduce((sum, group) => sum + (statuses().find((status) => status.id === group.statusId)?.done ? 0 : group.total), 0);
  /** With a filter or a search, statuses without a match step aside; a done status keeps its folded count. */
  const groupShown = (group: PwaGroup) => {
    const status = statuses().find((entry) => entry.id === group.statusId);
    if (!status) return false;
    if (props.filter.search) return group.total > 0;
    if (active(props.filter)) return group.total > 0 || status.done;
    return true;
  };
  const name = () => shown()?.name ?? props.entry?.name ?? "";

  const reset = () => props.onFilterChange({ ...props.filter, mine: false, tagIds: [] });

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  const [query_, setQuery] = createSignal(props.filter.search);
  createEffect(
    on(
      () => props.filter.search,
      (value) => value !== query_().trim() && setQuery(value),
      { defer: true },
    ),
  );
  const search = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => props.onFilterChange({ ...props.filter, search: value.trim() }), 250);
  };

  const row = (entry: () => PwaRow) => {
    const when = () => workSchedule({ ...entry(), deadlineAllDay: entry().deadlineAllDay }, props.dateConfig, t().allDay);
    return (
      <li
        class="spaces-pwa__row spaces-pwa-space__row"
        aria-current={entry().shortId === props.selected ? "true" : undefined}
        data-done={entry().completed || undefined}
      >
        <Show
          when={!entry().startsAt}
          fallback={
            <span class="spaces-pwa__event" role="img" aria-label={t().event}>
              <i class="ti ti-calendar-event" aria-hidden="true" />
            </span>
          }
        >
          <IconButton
            class="spaces-pwa__check"
            label={entry().completed ? t().reopenTask({ title: entry().title }) : t().complete({ title: entry().title })}
            aria-pressed={entry().completed}
            tooltip={false}
            disabled={locked()}
            onClick={() => (entry().completed ? void setDone(entry(), false) : complete(entry()))}
          >
            <i class={entry().completed ? "ti ti-circle-check" : "ti ti-circle"} aria-hidden="true" />
          </IconButton>
        </Show>
        <Link
          class="spaces-pwa__copy"
          href={props.taskHref(entry())}
          scroll="preserve"
          onNavigate={(event) => props.onOpen(entry(), event)}
        >
          <span class="spaces-pwa__title">{entry().title}</span>
          <Show when={entry().blocked || when() || entry().checklist || entry().tags.length || entry().people.length}>
            <span class="spaces-pwa__meta">
              <Show when={entry().blocked}>
                <span class="spaces-pwa__when spaces-pwa-space__blocked">
                  <i class="ti ti-hand-stop" aria-hidden="true" />
                  {t().blocked}
                </span>
              </Show>
              <Show when={when()}>
                {(info) => (
                  <time
                    class="spaces-pwa__when"
                    datetime={info().datetime}
                    data-overdue={(!entry().completed && entry().overdue) || undefined}
                  >
                    <i class={info().icon} aria-hidden="true" />
                    {info().text}
                  </time>
                )}
              </Show>
              <Show when={entry().checklist}>
                {(list) => (
                  <span class="spaces-pwa__when" role="img" aria-label={t().checklistProgress(list())}>
                    <i class="ti ti-list-check" aria-hidden="true" />
                    {list().done}/{list().total}
                  </span>
                )}
              </Show>
              <For each={entry().tags}>
                {(tag) => (
                  <Tag size="sm" color={tag.color}>
                    {tag.name}
                  </Tag>
                )}
              </For>
              <Show when={entry().people.length}>
                <span
                  class="spaces-pwa-space__people"
                  role="img"
                  aria-label={entry()
                    .people.map((person) => person.displayName)
                    .join(", ")}
                >
                  <For each={entry().people.slice(0, 3)}>
                    {(person) => (
                      <CloudAvatar
                        username={person.displayName}
                        userId={person.id}
                        avatarHash={person.avatarHash}
                        kind={person.kind}
                        size="xs"
                      />
                    )}
                  </For>
                  <Show when={entry().people.length > 3}>
                    <span class="spaces-pwa-space__more-people">+{entry().people.length - 3}</span>
                  </Show>
                </span>
              </Show>
            </span>
          </Show>
        </Link>
      </li>
    );
  };

  const groupView = (group: () => PwaGroup) => {
    const status = () => statuses().find((entry) => entry.id === group().statusId)!;
    const headId = () => `spaces-pwa-group-${group().statusId}`;
    // Keep each surviving row's DOM (and focus) when a fresh read has new object identities.
    const rowsById = createMemo(() => new Map(rowsOf(group()).map((entry) => [entry.shortId, entry])));
    const ids = createMemo(() => [...rowsById().keys()]);
    const left = () => Math.max(0, group().total - group().rows.length);
    return (
      <section class="spaces-pwa-space__group" aria-labelledby={headId()}>
        <h3 class="spaces-pwa-space__group-title">
          <button
            type="button"
            class="spaces-pwa-space__group-head"
            id={headId()}
            aria-expanded={!folded(status())}
            onClick={() => toggle(status())}
          >
            <span class="spaces-pwa-space__group-dot" style={{ "background-color": status().color }} aria-hidden="true" />
            <span class="spaces-pwa-space__group-name">{status().name}</span>
            <span class="spaces-pwa-space__group-count">{group().total.toLocaleString(locale())}</span>
            <i class={folded(status()) ? "ti ti-chevron-right" : "ti ti-chevron-down"} aria-hidden="true" />
          </button>
        </h3>
        <Show when={!folded(status())}>
          <Show when={group().rows.length || group().total === 0} fallback={<SkeletonRows count={Math.min(3, group().total)} />}>
            <ul class="spaces-pwa__list" aria-labelledby={headId()}>
              <For each={ids()}>{(id) => row(() => rowsById().get(id)!)}</For>
            </ul>
          </Show>
          <Show when={left() && group().rows.length}>
            <div class="spaces-pwa-space__more">
              <Show
                when={pageState().get(group().statusId) === "failed"}
                fallback={
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pageState().get(group().statusId) === "loading"}
                    onClick={() => void loadPage(group().statusId, group().pages + 1)}
                  >
                    {t().loadMore({ count: Math.min(left(), 30).toLocaleString(locale()) })}
                  </Button>
                }
              >
                <span class="spaces-pwa-space__more-failed" role="alert">
                  <i class="ti ti-alert-circle" aria-hidden="true" />
                  {t().loadMoreFailed}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void loadPage(group().statusId, group().pages + 1)}>
                  {t().retry}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
      </section>
    );
  };

  const groupsById = createMemo(() => new Map(groups().map((group) => [group.statusId, group])));
  const groupIds = createMemo(() =>
    groups()
      .filter(groupShown)
      .map((group) => group.statusId),
  );

  return (
    <div class="spaces-pwa spaces-pwa-space">
      <Show when={readOnly()}>
        <p class="spaces-pwa-space__note" role="status">
          <i class="ti ti-lock" aria-hidden="true" />
          {t().readOnly({ space: name() })}
        </p>
      </Show>
      <Show
        when={current()?.space !== null && space.data()?.space !== null}
        fallback={
          <div class="spaces-pwa-space__state">
            <Placeholder
              state="no-access"
              icon="ti ti-lock"
              title={name() ? t().noAccess({ space: name() }) : t().spaceUnavailable}
              description={name() ? t().noAccessHint : t().spaceUnavailableHint}
              action={
                <ButtonLink variant="secondary" href={listHref()}>
                  <i class="ti ti-user-check" aria-hidden="true" />
                  {t().toMyTasks}
                </ButtonLink>
              }
            />
          </div>
        }
      >
        <Show
          when={searching()}
          fallback={
            <Show when={!(current() && total() === 0 && !active(props.filter))}>
              <div class="spaces-pwa-space__filters" role="toolbar" aria-label={t().filters}>
                <FilterToggle
                  label={t().assignedToMe}
                  icon="ti ti-user"
                  active={props.filter.mine}
                  onClick={() => props.onFilterChange({ ...props.filter, mine: !props.filter.mine })}
                />
                <Show when={shown()?.tags.length}>
                  <FilterChip
                    label={t().tag}
                    icon="ti ti-tag"
                    showValue
                    options={[
                      {
                        options: (shown()?.tags ?? []).map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })),
                        multiple: true,
                      },
                    ]}
                    value={props.filter.tagIds}
                    onValueChange={(tagIds) => props.onFilterChange({ ...props.filter, tagIds })}
                  />
                </Show>
                <Show when={active(props.filter)}>
                  <Button variant="ghost" size="sm" onClick={reset}>
                    {t().reset}
                  </Button>
                </Show>
              </div>
            </Show>
          }
        >
          <div class="spaces-pwa-space__search" ref={(element) => queueMicrotask(() => element.querySelector("input")?.focus())}>
            <TextInput
              aria-label={t().searchLabel({ space: name() })}
              placeholder={t().searchIn({ space: name() })}
              value={query_}
              onValueChange={search}
              onKeyDown={(event) => {
                if (event.key === "Escape") props.onSearchClose();
              }}
            />
            <p class="spaces-pwa-space__hits" role="status">
              {current() && props.filter.search ? t().hits({ count: hits() }) : ""}
            </p>
          </div>
        </Show>
        <Show
          when={current()}
          fallback={
            <Show
              when={space.error()}
              fallback={
                <div class="spaces-pwa-space__groups" aria-busy="true">
                  <For each={[3, 3, 2]}>
                    {(count) => (
                      <section class="spaces-pwa-space__group">
                        <div class="spaces-pwa-space__group-head spaces-pwa-space__group-head--sk">
                          <Skeleton class="spaces-pwa-space__sk spaces-pwa-space__sk--head" />
                        </div>
                        <SkeletonRows count={count} />
                      </section>
                    )}
                  </For>
                </div>
              }
            >
              <div class="spaces-pwa-space__state">
                <Placeholder
                  state="error"
                  title={t().spaceLoadFailed({ space: name() })}
                  description={props.online ? t().filtersStay : t().spaceOffline}
                  action={
                    <Button variant="secondary" onClick={() => void space.refresh()}>
                      <i class="ti ti-reload" aria-hidden="true" />
                      {t().retry}
                    </Button>
                  }
                />
              </div>
            </Show>
          }
        >
          <Show
            when={total() > 0 && groupIds().length}
            fallback={
              <div class="spaces-pwa-space__state">
                <Show
                  when={active(props.filter) || props.filter.search}
                  fallback={<Placeholder icon="ti ti-layout-kanban" title={t().spaceEmpty({ space: name() })} />}
                >
                  <Placeholder
                    state="no-results"
                    title={noMatch()}
                    action={
                      <Show when={active(props.filter)}>
                        <Button variant="secondary" onClick={reset}>
                          <i class="ti ti-filter-off" aria-hidden="true" />
                          {t().resetFilters}
                        </Button>
                      </Show>
                    }
                  />
                </Show>
              </div>
            }
          >
            <div class="spaces-pwa-space__groups" aria-busy={space.refreshing() || undefined}>
              <For each={groupIds()}>{(id) => groupView(() => groupsById().get(id)!)}</For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function SkeletonRows(props: { count: number }) {
  return (
    <ul class="spaces-pwa__list" aria-hidden="true">
      <For each={Array.from({ length: props.count })}>
        {(_, index) => (
          <li class="spaces-pwa__row">
            <span class="spaces-pwa__event">
              <i class="ti ti-circle" aria-hidden="true" />
            </span>
            <span class="spaces-pwa__copy">
              <Skeleton class={`spaces-pwa-space__sk spaces-pwa-space__sk--w${index() % 4}`} />
              <Skeleton class="spaces-pwa-space__sk spaces-pwa-space__sk--meta" />
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

const withoutKey = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};
