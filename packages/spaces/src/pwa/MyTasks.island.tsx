import { reloadOnce } from "@k2b/cloud/browser/reload";
import { navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, SegmentedControl, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { OverviewView, OverviewWork } from "@/overview-contracts";
import { spacesApiErrorMessage, spacesMessages } from "@/service/messages";
import { createRetryToasts } from "../frontend/lib/feedback";
import { readResponseError } from "../frontend/lib/response";
import { overviewMessages } from "../frontend/overview-messages";
import { myTasksMessages } from "./messages";

type WorkItem = OverviewWork["items"][number];
type Props = { initialView: OverviewView; initialWork: OverviewWork; dateConfig: DateContext };

const VIEWS = ["mine", "today", "upcoming"] as const;
const viewHref = (view: OverviewView) => (view === "mine" ? "/pwa/spaces" : `/pwa/spaces?view=${view}`);

/** The app session ended: reload once, and the page request renews it or leads to pairing. */
const sessionEnded = (response: { status: number }) => response.status === 401 && reloadOnce("pwa-auth");

/**
 * "My tasks" in the mobile app: the overview's views as a segmented control, and one flat row per task or event.
 * A task is checked off with its own button; the list is then read again, so it always shows the server's view.
 */
export default function MyTasks(props: Props) {
  const locale = useLocale();
  const o = overviewMessages.resolve([locale()]).t;
  const t = myTasksMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  const [view, setView] = createSignal<OverviewView>(props.initialView);
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());

  const work = queries.create<OverviewView, OverviewWork>({
    source: view,
    initial: { source: props.initialView, data: props.initialWork },
    load: async (view, { abortSignal }) => {
      const response = await apiClient.overview.work.$get({ query: { view } }, { init: { signal: abortSignal } });
      if (!response.ok) {
        sessionEnded(response);
        throw new Error(o.workLoadFailed);
      }
      return response.json();
    },
  });
  const active = () => (work.data()?.view === view() ? work.data() : undefined);
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

  /** Sets the item's completion; true when the server saved it. Each refusal is reported here. */
  const save = async (item: WorkItem, completed: boolean): Promise<boolean> => {
    const failed = () =>
      completed
        ? retryToast(t.completeFailed({ title: item.title }), o.retry, () => complete(item))
        : retryToast(t.reopenFailed({ title: item.title }), o.retry, () => reopen(item));
    const response = await apiClient[":id"].items[":itemId"].completed
      .$post({ param: { id: item.spaceShortId, itemId: item.shortId }, json: { completed } })
      // Offline or unreachable: the same Retry as a failed answer.
      .catch(() => null);
    if (!response) {
      failed();
      return false;
    }
    if (response.ok) return true;
    if (sessionEnded(response)) return false;
    if (response.status === 409) {
      // Unfinished blockers or an active claim, also the person's own; the server names which.
      const reason = await readResponseError(response, spacesMessages("en").completeBlockersFirst);
      toast.error(spacesApiErrorMessage(409, locale(), reason));
      return false;
    }
    failed();
    return false;
  };

  /** The row's button stays busy until the list that no longer has the task replaces it. */
  const complete = async (item: WorkItem): Promise<void> => {
    if (pending().has(item.shortId)) return;
    setPending((current) => new Set(current).add(item.shortId));
    try {
      if (!(await save(item, true))) return;
      const notice = toast.success(t.done, {
        action: {
          label: t.undo,
          onClick: () => {
            notice.dismiss();
            void reopen(item);
          },
        },
      });
      await refresh();
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(item.shortId);
        return next;
      });
    }
  };

  const reopen = async (item: WorkItem): Promise<void> => {
    if (await save(item, false)) await refresh();
  };

  const schedule = (item: WorkItem): { text: string; datetime: string; icon: string; overdue: boolean } | null => {
    if (item.startsAt) {
      const start = new Date(item.startsAt);
      const time = dates.formatTime(start, props.dateConfig);
      const range =
        item.endsAt && dates.isSameDay(start, new Date(item.endsAt), props.dateConfig)
          ? `${time}–${dates.formatTime(item.endsAt, props.dateConfig)}`
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
        when={active()?.items.length}
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
          <For each={active()?.items}>
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
                      loadingLabel={t.completing({ title: item.title })}
                      tooltip={false}
                      loading={pending().has(item.shortId)}
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
      </Show>
    </div>
  );
}
