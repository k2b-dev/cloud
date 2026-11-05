import { Link, type LinkNavigateEvent, navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, SegmentedControl, TextInput, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { OverviewView, OverviewWork } from "@/overview-contracts";
import { createRetryToasts } from "../frontend/lib/feedback";
import { overviewMessages } from "../frontend/overview-messages";
import { saveCompletion } from "./completion";
import { myTasksMessages } from "./messages";
import { refreshOnReturn } from "./refresh-on-return";
import { workSchedule } from "./schedule";

export type WorkItem = OverviewWork["items"][number];
type Props = {
  userId: string;
  initialView: OverviewView;
  initialWork: OverviewWork;
  dateConfig: DateContext;
  /** The short ID of the open task, marked in the list. */
  selected?: string;
  /** The address of a task, and of the list in a view; the open task keeps its place in the address. */
  taskHref: (item: WorkItem, view: OverviewView) => string;
  listHref: (view: OverviewView) => string;
  /** Opens a task in place; without it a row is a link that loads the task's page. */
  onOpen?: (item: WorkItem, event: LinkNavigateEvent) => void;
  /** The view the address names, such as after Back; the list follows it. */
  view?: OverviewView;
  /** The address of the page in a view, kept in place of the current one; the list's own address by default. */
  viewHref?: (view: OverviewView) => string;
  /** The person chose another view. */
  onViewChange?: (view: OverviewView) => void;
  /** Raised when a task changed elsewhere on the page, such as in its detail; the list is read again. */
  revision?: number;
  /** A task was completed or reopened here; `done` is what the server kept. */
  onCompletedChange?: (shortId: string, done: boolean) => void;
  /** The server's list is older than this mount, such as after a Space was shown in its place; it is read again. */
  refreshOnMount?: boolean;
  /** Offline, checking off stays off; the page says why. */
  online?: boolean;
  /** The search field stands in place of the views and looks through open tasks in every Space. */
  searching?: boolean;
  onSearchClose?: () => void;
};
/** Where a checked-off row stood, so Undo puts it back there and only there. */
type Place = { view: OverviewView; index: number };
/**
 * A task changed on this page. `done` is what its row shows: the person's latest choice while it is being saved, then
 * what the server kept. `saved` is the server's state as far as this page knows. `settled` counts the list reads that
 * had started when the last request ended; a read that starts later shows the server's state instead.
 */
type Change = { item: WorkItem; place?: Place; done: boolean; saved: boolean; settled?: number };

const VIEWS = ["mine", "today", "upcoming"] as const;

/**
 * "My tasks" in the mobile app: the overview's views as a segmented control, and one flat row per task or event.
 * A task is checked off with its own button: the row leaves at once, and the list is read again once the server
 * saved it, so it always ends with the server's view. A refusal or a failure shows the state the server kept.
 */
export default function MyTasks(props: Props) {
  const locale = useLocale();
  const o = overviewMessages.resolve([locale()]).t;
  const t = myTasksMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  const [view, setView] = createSignal<OverviewView>(props.initialView);
  const [changes, setChanges] = createSignal<ReadonlyMap<string, Change>>(new Map());
  const patch = (id: string, next: Partial<Change>) =>
    setChanges((current) => {
      const change = current.get(id);
      return change ? new Map(current).set(id, { ...change, ...next }) : current;
    });
  /** Tasks with requests under way; each task sends one at a time, so an earlier choice never lands after a later one. */
  const syncing = new Set<string>();
  /** The open "Done" notice of each task, closed when its completion does not happen. */
  const notices = new Map<string, ToastHandle>();
  /** List reads started so far, and the number of the read that returned each list. */
  let reads = 0;
  const readNumber = new WeakMap<OverviewWork, number>();
  // The server renders the check buttons before this island runs; until then a tap would do nothing.
  const [ready, setReady] = createSignal(false);
  onMount(() => setReady(true));

  const work = queries.create<OverviewView, OverviewWork>({
    source: view,
    initial: { source: props.initialView, data: props.initialWork },
    load: async (view, { abortSignal }) => {
      const read = ++reads;
      const response = await apiClient.overview.work.$get({ query: { view } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(o.workLoadFailed);
      const data = await response.json();
      readNumber.set(data, read);
      return data;
    },
  });
  const active = () => (work.data()?.view === view() ? work.data() : undefined);
  /** The change a row still shows: no list has been read since its last request ended. */
  const shown = (change: Change | undefined) => {
    const data = work.data();
    const read = data ? (readNumber.get(data) ?? 0) : 0;
    return change && (change.settled === undefined || change.settled >= read) ? change : undefined;
  };
  const items = () => {
    const data = active();
    if (!data) return [];
    const current = [...changes().values()].filter((change) => shown(change));
    const list = data.items.filter((item) => !current.some((change) => change.done && change.item.shortId === item.shortId));
    for (const { item, place, done } of current) {
      if (!done && place?.view === data.view && !list.some((row) => row.shortId === item.shortId)) {
        list.splice(Math.min(place.index, list.length), 0, item);
      }
    }
    return list;
  };
  // Keep each surviving row's DOM (and focus) when a fresh snapshot has new object identities.
  const itemsById = createMemo(() => new Map(items().map((item) => [item.shortId, item])));
  const rowIds = createMemo(() => [...itemsById().keys()]);
  const counts = () => work.data()?.counts ?? props.initialWork.counts;
  createEffect(
    on(
      () => props.revision,
      () => void refresh(),
      { defer: true },
    ),
  );
  // Back and Forward bring the view of their address.
  createEffect(
    on(
      () => props.view,
      (next) => {
        if (next && next !== view()) setView(next);
      },
      { defer: true },
    ),
  );

  const select = (next: OverviewView) => {
    if (next === view()) return;
    setView(next);
    props.onViewChange?.(next);
    // The view is the page's state, not a step back; the address keeps it, beside an open task, for a reload.
    navigate((props.viewHref ?? props.listHref)(next), { replace: true, scroll: "manual", viewTransition: false });
  };

  /** Reads the list again; true when it did. */
  const refresh = async (): Promise<boolean> => {
    try {
      await work.invalidate();
      return true;
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) retryToast(t.refreshFailed, o.retry, () => void refresh());
      return false;
    }
  };

  refreshOnReturn(() => {
    work.abort();
    void refresh();
  });
  onMount(() => {
    if (props.refreshOnMount) void refresh();
  });

  const save = (item: WorkItem, completed: boolean) => saveCompletion({ item, completed, userId: props.userId, locale: locale() });

  /** Brings the task's server state to the person's latest choice, one request at a time, then reads the list again. */
  const sync = async (id: string): Promise<void> => {
    for (;;) {
      const change = changes().get(id);
      if (!change) return;
      if (change.done === change.saved) {
        patch(id, { settled: reads });
        await refresh();
      } else {
        const target = change.done;
        const outcome = await save(change.item, target);
        if (outcome === "saved") {
          patch(id, { saved: target });
          props.onCompletedChange?.(id, target);
          continue;
        }
        if (target) notices.get(id)?.dismiss();
        const latest = changes().get(id) ?? change;
        if (outcome === "failed") {
          // The server kept its state, so the row shows it; Retry offers the choice again while it is still the latest.
          patch(id, { done: latest.saved, settled: reads });
          if (latest.done === target) {
            if (target) retryToast(t.completeFailed({ title: change.item.title }), o.retry, () => complete(change.item));
            else retryToast(t.reopenFailed({ title: change.item.title }), o.retry, () => undo(change.item, change.place));
          }
          return;
        }
        // Refused: the row stays as the person left it until the list shows what the server kept.
        patch(id, { settled: reads });
        if (!(await refresh()) && changes().get(id)?.settled !== undefined) patch(id, { done: latest.saved });
      }
      // A choice made while the list was read starts the next round.
      if (changes().get(id)?.settled !== undefined) return;
    }
  };

  /** Shows the choice at once and saves it; false when the row already shows it. */
  const choose = (item: WorkItem, done: boolean, place: Place | undefined): boolean => {
    const id = item.shortId;
    const change = shown(changes().get(id));
    if (change?.done === done) return false;
    // A listed task is open on the server, and Undo follows a completion it saved.
    setChanges((current) =>
      new Map(current).set(id, change ? { ...change, done, settled: undefined } : { item, place, done, saved: !done }),
    );
    if (!syncing.has(id)) {
      syncing.add(id);
      void sync(id).finally(() => syncing.delete(id));
    }
    return true;
  };

  /** The row leaves at once with Undo; it comes back when the server refuses or cannot be reached. */
  const complete = (item: WorkItem) => {
    const index = items().findIndex((row) => row.shortId === item.shortId);
    const place = index >= 0 ? { view: view(), index } : undefined;
    if (!choose(item, true, place)) return;
    const notice = toast.success(t.done, {
      action: {
        label: t.undo,
        onClick: () => {
          notice.dismiss();
          undo(item, place);
        },
      },
    });
    notices.set(item.shortId, notice);
  };

  /** The row comes back at once, in the view it left; a completion the server saved is reopened there too. */
  const undo = (item: WorkItem, place: Place | undefined) => {
    notices.get(item.shortId)?.dismiss();
    choose(item, false, place);
  };

  const schedule = (item: WorkItem) => workSchedule(item, props.dateConfig, t.allDay);

  /** Each view reads a bounded list; the rest of its count stays on the web. */
  const hidden = () => {
    const data = active();
    return data ? Math.max(0, data.counts[data.view] - data.items.length) : 0;
  };

  const empty = () =>
    view() === "mine"
      ? { title: o.nothingAssigned, description: o.allCaughtUp }
      : view() === "today"
        ? { title: o.nothingToday, description: o.allCaughtUp }
        : { title: o.nothingUpcoming, description: o.allCaughtUp };

  /** One task or event: its check, or a mark for an event, then title, Space and date as a link to the task. */
  const rowView = (item: () => WorkItem) => {
    const when = () => schedule(item());
    return (
      <li class="spaces-pwa__row" aria-current={item().shortId === props.selected ? "true" : undefined}>
        <Show
          when={!item().startsAt}
          fallback={
            <span class="spaces-pwa__event" role="img" aria-label={t.event}>
              <i class="ti ti-calendar-event" aria-hidden="true" />
            </span>
          }
        >
          <IconButton
            class="spaces-pwa__check"
            label={t.complete({ title: item().title })}
            tooltip={false}
            disabled={!ready() || props.online === false || !item().canWrite}
            onClick={() => complete(item())}
          >
            <i class="ti ti-circle" aria-hidden="true" />
          </IconButton>
        </Show>
        <Link
          class="spaces-pwa__copy"
          href={props.taskHref(item(), view())}
          scroll="preserve"
          onNavigate={props.onOpen ? (event) => props.onOpen?.(item(), event) : undefined}
        >
          <span class="spaces-pwa__title">{item().title}</span>
          <span class="spaces-pwa__meta">
            <span class="spaces-pwa__space">
              <span
                class="spaces-pwa__dot"
                style={{ "background-color": item().spaceColor ?? "var(--k2b-text-muted)" }}
                aria-hidden="true"
              />
              {item().spaceName}
            </span>
            <Show when={when()}>
              {(info) => (
                <time class="spaces-pwa__when" datetime={info().datetime} data-overdue={info().overdue || undefined}>
                  <i class={info().icon} aria-hidden="true" />
                  {info().text}
                </time>
              )}
            </Show>
          </span>
        </Link>
      </li>
    );
  };

  // The search: open tasks in every Space, read as the person types and kept until the field closes.
  const [search, setSearch] = createSignal("");
  const [term, setTerm] = createSignal("");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  const typed = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setTerm(value.trim()), 250);
  };
  createEffect(
    on(
      () => props.searching,
      (open) => {
        if (open) return;
        clearTimeout(searchTimer);
        setSearch("");
        setTerm("");
      },
      { defer: true },
    ),
  );
  const matches = queries.create<string, { term: string; items: WorkItem[] }>({
    source: term,
    enabled: () => Boolean(props.searching && term()),
    load: async (value, { abortSignal }) => {
      const response = await fetch(`${props.listHref("mine")}?q=${encodeURIComponent(value)}`, {
        headers: { Accept: "application/json" },
        signal: abortSignal,
      });
      if (!response.ok) throw new Error(t.searchFailed);
      return { term: value, items: (await response.json()) as WorkItem[] };
    },
  });
  /** Matches without the tasks checked off here since. */
  const found = () => {
    const data = matches.data();
    if (!data || data.term !== term()) return undefined;
    return data.items.filter((item) => !shown(changes().get(item.shortId))?.done);
  };
  const foundById = createMemo(() => new Map((found() ?? []).map((item) => [item.shortId, item])));
  const foundIds = createMemo(() => [...foundById().keys()]);

  return (
    <div class="spaces-pwa">
      <Show when={props.searching}>
        <div class="spaces-pwa-space__search" ref={(element) => queueMicrotask(() => element.querySelector("input")?.focus())}>
          <TextInput
            aria-label={t.searchAllLabel}
            placeholder={t.searchAll}
            value={search}
            onValueChange={typed}
            onKeyDown={(event) => {
              if (event.key === "Escape") props.onSearchClose?.();
            }}
          />
          <p class="spaces-pwa-space__hits" role="status">
            {found() ? t.hits({ count: found()!.length }) : matches.error() ? t.searchFailed : ""}
          </p>
        </div>
        <Show when={found()?.length}>
          <ul class="spaces-pwa__list" aria-label={t.tasks}>
            <For each={foundIds()}>{(id) => rowView(() => foundById().get(id)!)}</For>
          </ul>
        </Show>
      </Show>
      <Show when={!props.searching}>
        <SegmentedControl<OverviewView>
          ariaLabel={o.workView}
          value={view}
          onValueChange={select}
          options={VIEWS.map((value) => ({
            value,
            label: (
              <>
                {value === "mine" ? o.forMe : value === "today" ? o.today : o.upcoming}{" "}
                <span class="spaces-pwa__count">{counts()[value].toLocaleString(locale())}</span>
              </>
            ),
          }))}
        />
        <Show
          when={items().length}
          fallback={
            <Placeholder
              state={work.error() ? "error" : active() ? "empty" : "loading"}
              icon={work.error() ? "ti ti-alert-circle" : "ti ti-circle-check"}
              title={work.error() ? o.workLoadFailed : active() ? empty().title : o.loadingWork}
              description={work.error() ? undefined : active() ? empty().description : undefined}
              action={
                work.error() ? (
                  <Button variant="secondary" size="sm" onClick={() => void work.refresh()}>
                    {o.retry}
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <ul class="spaces-pwa__list" aria-label={t.tasks} aria-busy={work.refreshing() || undefined}>
            <For each={rowIds()}>{(id) => rowView(() => itemsById().get(id)!)}</For>
          </ul>
          <Show when={hidden()}>{(count) => <p class="spaces-pwa__more">{t.more({ count: count().toLocaleString(locale()) })}</p>}</Show>
        </Show>
      </Show>
    </div>
  );
}
