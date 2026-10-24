import { type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { OverviewView, OverviewWork } from "@/overview-contracts";
import { OverviewViewSchema } from "@/overview-contracts";
import MyTasks, { type WorkItem } from "./MyTasks";
import { myTasksMessages } from "./messages";
import { listHref, taskAddress, taskHref } from "./paths";
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
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const [view, setView] = createSignal(props.initialView);
  const [revision, setRevision] = createSignal(0);
  const [selection, setSelection] = createSignal<Selection>(
    props.initialTask ? { spaceShortId: props.initialTask.spaceShortId, shortId: props.initialTask.shortId } : null,
  );
  const [detail, setDetail] = createSignal<TaskDetailState | undefined>(
    props.initialTask ? { kind: "ready", task: props.initialTask } : undefined,
  );
  let request: AbortController | undefined;

  const load = (target: NonNullable<Selection>, item: WorkItem | undefined) => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    setDetail({ kind: "loading", item });
    readTask(target.spaceShortId, target.shortId, controller.signal).then(
      (task) => {
        if (request !== controller) return;
        setDetail(task === "gone" ? { kind: "gone" } : { kind: "ready", task });
      },
      (error: unknown) => {
        if (request !== controller || (error instanceof Error && error.name === "AbortError")) return;
        setDetail({ kind: "failed", item });
      },
    );
  };

  /** What the address names; Back and Forward land here without a request to the page. */
  const follow = (url: URL) => {
    const parsed = OverviewViewSchema.safeParse(url.searchParams.get("view") ?? "mine");
    if (parsed.success) setView(parsed.data);
    const target = taskAddress(url.pathname);
    // Whatever was loading belongs to the entry history just left.
    request?.abort();
    request = undefined;
    setSelection(target);
    if (!target) return setDetail(undefined);
    const current = detail();
    if (current?.kind === "ready" && current.task.shortId === target.shortId) return;
    load(target, undefined);
  };

  const open = (item: WorkItem, event: LinkNavigateEvent) => {
    const target = { spaceShortId: item.spaceShortId, shortId: item.shortId };
    setSelection(target);
    load(target, item);
    event.push(taskHref(item.spaceShortId, item.shortId, view()), { scroll: "manual" });
  };

  const back = (event: LinkNavigateEvent) => {
    request?.abort();
    setSelection(null);
    setDetail(undefined);
    event.push(listHref(view()), { scroll: "manual" });
  };

  onMount(() => onCleanup(listenPopState(({ url }) => follow(url))));

  const retry = () => {
    const target = selection();
    const current = detail();
    if (target) load(target, current?.kind === "failed" || current?.kind === "loading" ? current.item : undefined);
  };

  /** The detail completed or reopened its task: the list reads its work again. */
  const detailCompleted = (shortId: string, done: boolean) => {
    setRevision((value) => value + 1);
    completedChange(shortId, done);
  };

  const completedChange = (shortId: string, done: boolean) => {
    const current = detail();
    if (current?.kind === "ready" && current.task.shortId === shortId)
      setDetail({ kind: "ready", task: { ...current.task, completed: done } });
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
                      onRetry={retry}
                      onCompletedChange={detailCompleted}
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
