import { liveConnection } from "@k2b/cloud/browser/live";
import { type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { createEffect, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { SpaceLiveEventSchema } from "@/live-events";
import type { OverviewView, OverviewWork } from "@/overview-contracts";
import { OverviewViewSchema } from "@/overview-contracts";
import { createRetryToasts } from "../frontend/lib/feedback";
import MyTasks, { type WorkItem } from "./MyTasks";
import { myTasksMessages } from "./messages";
import { listHref, taskAddress, taskHref } from "./paths";
import { refreshOnReturn } from "./refresh-on-return";
import TaskDetail, { type TaskDetailState } from "./TaskDetail";
import type { PwaTask } from "./task";

type Props = {
  userId: string;
  initialView: OverviewView;
  initialWork: OverviewWork;
  dateConfig: DateContext;
  /** The task the address names, read by the server. */
  initialTask?: PwaTask;
};

/** The address of the selection: the list alone, or one task. */
type Selection = { spaceShortId: string; shortId: string } | null;

const readTask = async (spaceShortId: string, shortId: string, signal: AbortSignal): Promise<PwaTask | "gone"> => {
  const response = await fetch(taskHref(spaceShortId, shortId), { headers: { Accept: "application/json" }, signal });
  if (response.status === 404) return "gone";
  if (!response.ok) throw new Error(`Task request failed with ${response.status}`);
  return (await response.json()) as PwaTask;
};

/**
 * Spaces in the mobile app: the person's tasks and, from a row, one task. Below 64rem one of the two fills the page,
 * the task with a step back; from 64rem the list stands beside the task. A row opens its task in place: the row's
 * title, Space and date show at once, the rest follows from the task's own address, which history keeps, so reload,
 * Back and rotating show the same task.
 */
export default function SpacesPwa(props: Props) {
  const retryToast = createRetryToasts();
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const [view, setView] = createSignal(props.initialView);
  const [revision, setRevision] = createSignal(0);
  const [selection, setSelection] = createSignal<Selection>(
    props.initialTask ? { spaceShortId: props.initialTask.spaceShortId, shortId: props.initialTask.shortId } : null,
  );
  const [opening, setOpening] = createSignal<WorkItem>();
  const address = () => {
    const target = selection();
    return target ? taskHref(target.spaceShortId, target.shortId) : null;
  };
  const task = query.create<string | null, { address: string | null; task: PwaTask | "gone" }>({
    source: address,
    enabled: () => selection() !== null,
    initial: props.initialTask ? { source: address(), data: { address: address(), task: props.initialTask } } : undefined,
    load: async (address, { abortSignal }) => {
      const target = address && taskAddress(address);
      if (!target) throw new Error("No task selected");
      return { address, task: await readTask(target.spaceShortId, target.shortId, abortSignal) };
    },
  });
  const detail = (): TaskDetailState | undefined => {
    if (!selection()) return undefined;
    const data = task.data();
    if (data?.address === address()) {
      return data.task === "gone" ? { kind: "gone" } : { kind: "ready", task: data.task };
    }
    return task.error() ? { kind: "failed", item: opening() } : { kind: "loading", item: opening() };
  };
  const refreshTask = () => task.invalidate();
  // Query errors include source-driven reads, such as reopening the last task with a retained snapshot.
  const retryRefresh = () => refreshTask().catch(() => undefined);
  createEffect(
    on(task.error, (error) => {
      if (error) retryToast(t().taskLoadFailed, t().retry, () => void retryRefresh(), { untilClosed: true });
    }),
  );
  refreshOnReturn(() => {
    if (selection()) void retryRefresh();
  });
  createEffect(() => {
    const space = selection()?.spaceShortId;
    if (!space) return;
    let initial = true;
    const subscription = liveConnection("/api/spaces/live").subscribe(
      "space",
      { space },
      {
        cursor: null,
        parse: (data) => SpaceLiveEventSchema.parse(data),
        apply: async (events) => {
          if (events.some(({ data }) => !("itemId" in data) || data.itemId === selection()?.shortId)) await refreshTask();
        },
        resync: refreshTask,
        // No SSR cursor: close the gap between the initial snapshot and subscription once it is confirmed.
        caughtUp: (ready) => {
          if (ready && initial) {
            initial = false;
            void retryRefresh();
          }
        },
        revoked: () => {
          void retryRefresh();
        },
        unavailable: () => {
          // Keep drafts and focus; only an explicit reload restarts a terminal subscription.
          retryToast(t().liveUpdatesUnavailable, t().reload, () => window.location.reload(), { untilClosed: true });
          void retryRefresh();
        },
      },
    );
    onCleanup(() => subscription.close());
  });

  /** What the address names; Back and Forward land here without a request to the page. */
  const follow = (url: URL) => {
    const parsed = OverviewViewSchema.safeParse(url.searchParams.get("view") ?? "mine");
    if (parsed.success) setView(parsed.data);
    const target = taskAddress(url.pathname);
    setOpening(undefined);
    setSelection(target);
  };

  const open = (item: WorkItem, event: LinkNavigateEvent) => {
    const target = { spaceShortId: item.spaceShortId, shortId: item.shortId };
    const fromList = selection() === null;
    setOpening(item);
    setSelection(target);
    event.push(taskHref(item.spaceShortId, item.shortId, view()), { scroll: "manual", state: { spacesFromList: fromList } });
  };

  const back = (event: LinkNavigateEvent) => {
    const state: unknown = history.state;
    if (state && typeof state === "object" && "spacesFromList" in state && state.spacesFromList === true) {
      history.back();
      return;
    }
    setSelection(null);
    event.replaceWith(listHref(view()), { scroll: "manual", state: null });
  };

  onMount(() => onCleanup(listenPopState(({ url }) => follow(url))));

  const detailCompleted = () => setRevision((value) => value + 1);
  const completedChange = (shortId: string) => {
    if (selection()?.shortId === shortId) void retryRefresh();
  };

  const spaceOf = () => {
    const current = detail();
    if (!current || current.kind === "gone") return undefined;
    if (current.kind === "ready") return { name: current.task.spaceName, color: current.task.spaceColor };
    return current.item ? { name: current.item.spaceName, color: current.item.spaceColor ?? undefined } : undefined;
  };

  return (
    <AppWorkspace flat mobileSurface="flush" resizable={false} class="spaces-pwa-workspace">
      <AppWorkspace.Content>
        <AppWorkspace.Main level={selection() ? "task" : "list"} onLevelNavigate={back}>
          <AppWorkspace.MainPane id="list" label="Spaces" href={listHref(view())} defaultSize={352} minSize={352} maxSize={352}>
            <MyTasks
              userId={props.userId}
              initialView={props.initialView}
              initialWork={props.initialWork}
              dateConfig={props.dateConfig}
              selected={selection()?.shortId}
              taskHref={(item, current) => taskHref(item.spaceShortId, item.shortId, current)}
              listHref={listHref}
              view={view()}
              viewHref={(next) => {
                const current = selection();
                return current ? taskHref(current.spaceShortId, current.shortId, next) : listHref(next);
              }}
              onOpen={open}
              onViewChange={setView}
              onCompletedChange={completedChange}
              revision={revision()}
            />
          </AppWorkspace.MainPane>
          <AppWorkspace.MainPane
            id="task"
            label={spaceOf()?.name ?? t().task}
            lead={
              <Show when={spaceOf()?.color}>
                {(color) => (
                  <span class="spaces-pwa__dot spaces-pwa__dot--head" style={{ "background-color": color() }} aria-hidden="true" />
                )}
              </Show>
            }
          >
            <Switch>
              <Match when={!selection()}>
                <Placeholder icon="ti ti-checkbox" title={t().noTask} description={t().noTaskHint} />
              </Match>
              <Match when={detail()}>
                {(state) => (
                  <Show when={selection()?.shortId} keyed>
                    <TaskDetail
                      state={state()}
                      userId={props.userId}
                      dateConfig={props.dateConfig}
                      listHref={listHref(view())}
                      onRetry={() => void retryRefresh()}
                      onCompletedChange={detailCompleted}
                      onRefresh={refreshTask}
                    />
                  </Show>
                )}
              </Match>
            </Switch>
          </AppWorkspace.MainPane>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
