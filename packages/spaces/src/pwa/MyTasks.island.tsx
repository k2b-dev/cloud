import { navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, SegmentedControl, toast, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { OverviewView, OverviewWork } from "@/overview-contracts";
import { spacesMessages } from "@/service/messages";
import { isOwnClaim } from "../frontend/[id]/_components/shared/claim/claim";
import { createRetryToasts } from "../frontend/lib/feedback";
import { readResponseError } from "../frontend/lib/response";
import { overviewMessages } from "../frontend/overview-messages";
import { myTasksMessages } from "./messages";

type WorkItem = OverviewWork["items"][number];
type Props = { userId: string; initialView: OverviewView; initialWork: OverviewWork; dateConfig: DateContext };

const VIEWS = ["mine", "today", "upcoming"] as const;
const viewHref = (view: OverviewView) => (view === "mine" ? "/pwa/spaces" : `/pwa/spaces?view=${view}`);

/** The overview carries no all-day flag; an all-day event runs from one local midnight to a later one. */
const isAllDay = (start: Date, end: Date | null, dateConfig: DateContext) =>
  end !== null &&
  end > start &&
  start.getTime() === dates.startOfDay(start, dateConfig).getTime() &&
  end.getTime() === dates.startOfDay(end, dateConfig).getTime();

/**
 * "My tasks" in the mobile app: the overview's views as a segmented control, and one flat row per task or event.
 * A task is checked off with its own button: the row leaves at once, and the list is read again once the server
 * saved it, so it always ends with the server's view. A refusal or a failure brings the row back.
 */
export default function MyTasks(props: Props) {
  const locale = useLocale();
  const o = overviewMessages.resolve([locale()]).t;
  const t = myTasksMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  const [view, setView] = createSignal<OverviewView>(props.initialView);
  /** Rows checked off here whose list has not been read again yet. */
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  const leave = (item: WorkItem, gone: boolean) =>
    setLeaving((current) => {
      const next = new Set(current);
      if (gone) next.add(item.shortId);
      else next.delete(item.shortId);
      return next;
    });
  /** Rows brought back by Undo until the list is read again, each at its former place. */
  const [returning, setReturning] = createSignal<ReadonlyMap<string, { item: WorkItem; index: number }>>(new Map());
  // The server renders the check buttons before this island runs; until then a tap would do nothing.
  const [ready, setReady] = createSignal(false);
  onMount(() => setReady(true));

  const work = queries.create<OverviewView, OverviewWork>({
    source: view,
    initial: { source: props.initialView, data: props.initialWork },
    load: async (view, { abortSignal }) => {
      const response = await apiClient.overview.work.$get({ query: { view } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(o.workLoadFailed);
      return response.json();
    },
  });
  const active = () => (work.data()?.view === view() ? work.data() : undefined);
  const items = () => {
    const data = active();
    if (!data) return [];
    const list = data.items.filter((item) => !leaving().has(item.shortId));
    for (const { item, index } of returning().values()) {
      if (!list.some((row) => row.shortId === item.shortId)) list.splice(Math.min(index, list.length), 0, item);
    }
    return list;
  };
  const counts = () => work.data()?.counts ?? props.initialWork.counts;

  const select = (next: OverviewView) => {
    if (next === view()) return;
    setView(next);
    // The view is the page's state, not a step back; the address keeps it for a reload.
    navigate(viewHref(next), { replace: true, scroll: "manual", viewTransition: false });
  };

  const refresh = async (): Promise<void> => {
    try {
      await work.invalidate();
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) retryToast(t.refreshFailed, o.retry, refresh);
    }
  };

  /** The task's current claim, read only after a refusal; null when it has none or cannot be read. */
  const currentClaim = async (item: WorkItem) => {
    const response = await apiClient[":id"].items[":itemId"]
      .$get({ param: { id: item.spaceShortId, itemId: item.shortId } })
      .catch(() => null);
    return response?.ok ? ((await response.json()).claim ?? null) : null;
  };

  /** A refusal that a retry cannot change: say why, and show the server's current list. */
  const refused = async (message: string): Promise<false> => {
    toast.error(message);
    await refresh();
    return false;
  };

  /** Sets the item's completion; true when the server saved it. Each refusal is reported here. */
  const save = async (item: WorkItem, completed: boolean, claimId?: string): Promise<boolean> => {
    const failed = () =>
      completed
        ? retryToast(t.completeFailed({ title: item.title }), o.retry, () => complete(item))
        : retryToast(t.reopenFailed({ title: item.title }), o.retry, () => reopen(item));
    const response = await apiClient[":id"].items[":itemId"].completed
      .$post({ param: { id: item.spaceShortId, itemId: item.shortId }, json: { completed, claimId } })
      // Offline or unreachable: the same Retry as a failed answer.
      .catch(() => null);
    if (!response) {
      failed();
      return false;
    }
    if (response.ok) return true;
    if (response.status === 409 && completed && !claimId) {
      // A claimed task: the person's own claim completes it, as on the web; someone else's is named.
      const claim = await currentClaim(item);
      if (claim && isOwnClaim(claim, props.userId)) return save(item, completed, claim.id);
      if (claim) return refused(t.claimed({ title: item.title, name: claim.displayName }));
    }
    if (response.status === 403) return refused(t.notAllowed({ space: item.spaceName }));
    if (response.status === 404) return refused(t.gone({ title: item.title }));
    // Unfinished blockers; the server already words the reason in the person's language.
    if (response.status === 409) return refused(await readResponseError(response, spacesMessages(locale()).completeBlockersFirst));
    failed();
    return false;
  };

  /** The row leaves at once with Undo; it comes back when the server refuses or cannot be reached. */
  const complete = async (item: WorkItem): Promise<void> => {
    if (leaving().has(item.shortId)) return;
    const index = items().indexOf(item);
    leave(item, true);
    const saving = save(item, true);
    let undone = false;
    const notice = toast.success(t.done, {
      action: {
        label: t.undo,
        onClick: () => {
          undone = true;
          notice.dismiss();
          void undo(item, index, saving);
        },
      },
    });
    if (!(await saving)) {
      notice.dismiss();
      leave(item, false);
      return;
    }
    // Undo reads the list itself once the task is open again.
    if (undone) return;
    await refresh();
    leave(item, false);
  };

  /** The row comes back at once; a completion the server already saved is reopened there too. */
  const undo = async (item: WorkItem, index: number, saving: Promise<boolean>): Promise<void> => {
    setReturning((current) => new Map(current).set(item.shortId, { item, index }));
    leave(item, false);
    try {
      if (await saving) await reopen(item);
    } finally {
      setReturning((current) => {
        const next = new Map(current);
        next.delete(item.shortId);
        return next;
      });
    }
  };

  const reopen = async (item: WorkItem): Promise<void> => {
    await save(item, false);
    await refresh();
  };

  const schedule = (item: WorkItem): { text: string; datetime: string; icon: string; overdue: boolean } | null => {
    if (item.startsAt) {
      const start = new Date(item.startsAt);
      const end = item.endsAt ? new Date(item.endsAt) : null;
      const time = dates.formatTime(start, props.dateConfig);
      const range = isAllDay(start, end, props.dateConfig)
        ? t.allDay
        : end && dates.isSameDay(start, end, props.dateConfig)
          ? `${time}–${dates.formatTime(end, props.dateConfig)}`
          : time;
      const text = dates.isToday(start, props.dateConfig) ? range : `${dates.formatDate(start, props.dateConfig)}, ${range}`;
      return { text, datetime: item.startsAt, icon: "ti ti-clock", overdue: false };
    }
    if (!item.deadline) return null;
    const deadline = new Date(item.deadline);
    return {
      // Today's deadline by its time; others by their day, with "Yesterday" or the weekday for the last week.
      text: dates.isToday(deadline, props.dateConfig)
        ? dates.formatTime(deadline, props.dateConfig)
        : dates.formatDateRelative(deadline, props.dateConfig),
      datetime: item.deadline,
      icon: "ti ti-calendar-due",
      overdue: deadline.getTime() < Date.now(),
    };
  };

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

  return (
    <div class="spaces-pwa">
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
          <For each={items()}>
            {(item) => {
              const when = () => schedule(item);
              return (
                <li class="spaces-pwa__row">
                  <Show
                    when={!item.startsAt}
                    fallback={
                      <span class="spaces-pwa__event" role="img" aria-label={t.event}>
                        <i class="ti ti-calendar-event" aria-hidden="true" />
                      </span>
                    }
                  >
                    <IconButton
                      class="spaces-pwa__check"
                      label={t.complete({ title: item.title })}
                      tooltip={false}
                      disabled={!ready()}
                      onClick={() => void complete(item)}
                    >
                      <i class="ti ti-circle" aria-hidden="true" />
                    </IconButton>
                  </Show>
                  <div class="spaces-pwa__copy">
                    <span class="spaces-pwa__title">{item.title}</span>
                    <span class="spaces-pwa__meta">
                      <span class="spaces-pwa__space">
                        <span
                          class="spaces-pwa__dot"
                          style={{ "background-color": item.spaceColor ?? "var(--k2b-text-muted)" }}
                          aria-hidden="true"
                        />
                        {item.spaceName}
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
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={hidden()}>{(count) => <p class="spaces-pwa__more">{t.more({ count: count().toLocaleString(locale()) })}</p>}</Show>
      </Show>
    </div>
  );
}
