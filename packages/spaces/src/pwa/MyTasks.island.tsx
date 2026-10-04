import { navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, SegmentedControl, type ToastHandle, toast, useLocale } from "@k2b/ui";
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
/** Where a checked-off row stood, so Undo puts it back there and only there. */
type Place = { view: OverviewView; index: number };
/**
 * A task changed on this page. `done` is what its row shows: the person's latest choice while it is being saved, then
 * what the server kept. `saved` is the server's state as far as this page knows. `settled` counts the list reads that
 * had started when the last request ended; a read that starts later shows the server's state instead.
 */
type Change = { item: WorkItem; place?: Place; done: boolean; saved: boolean; settled?: number };
type Outcome = "saved" | "refused" | "failed";

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
  const counts = () => work.data()?.counts ?? props.initialWork.counts;

  const select = (next: OverviewView) => {
    if (next === view()) return;
    setView(next);
    // The view is the page's state, not a step back; the address keeps it for a reload.
    navigate(viewHref(next), { replace: true, scroll: "manual", viewTransition: false });
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

  /** The task's current claim, read only after a refusal; null when it has none or cannot be read. */
  const currentClaim = async (item: WorkItem) => {
    const response = await apiClient[":id"].items[":itemId"]
      .$get({ param: { id: item.spaceShortId, itemId: item.shortId } })
      .catch(() => null);
    return response?.ok ? ((await response.json()).claim ?? null) : null;
  };

  /** A refusal that a retry cannot change: say why. */
  const refused = (message: string): Outcome => {
    toast.error(message);
    return "refused";
  };

  /** Sets the item's completion. Each refusal is reported here; a failure is left to the caller. */
  const save = async (item: WorkItem, completed: boolean, claimId?: string): Promise<Outcome> => {
    const response = await apiClient[":id"].items[":itemId"].completed
      .$post({ param: { id: item.spaceShortId, itemId: item.shortId }, json: { completed, claimId } })
      // Offline or unreachable: the same Retry as a failed answer.
      .catch(() => null);
    if (!response) return "failed";
    if (response.ok) return "saved";
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
    return "failed";
  };

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
                      onClick={() => complete(item)}
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
