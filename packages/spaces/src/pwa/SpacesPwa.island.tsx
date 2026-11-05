import { liveConnection } from "@k2b/cloud/browser/live";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { type LinkNavigateEvent, listenPopState, navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import {
  APP_WORKSPACE_SWITCHER_SEARCH_FROM,
  AppWorkspace,
  ButtonLink,
  Dropdown,
  type DropdownItem,
  IconButton,
  Placeholder,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { SpaceItemAssignee, SpaceItemTemplate } from "@/contracts";
import { SpaceLiveEventSchema } from "@/live-events";
import type { OverviewView, OverviewWork } from "@/overview-contracts";
import { OverviewViewSchema } from "@/overview-contracts";
import { buildSpaceHref } from "@/routes";
import { createRetryToasts } from "../frontend/lib/feedback";
import { type Outgoing, outbox, sendCreate } from "./create";
import MyTasks, { type WorkItem } from "./MyTasks";
import { myTasksMessages } from "./messages";
import { createOnline } from "./online";
import { listOf, listTaskHref, NO_FILTER, type PwaList, pwaListHref, type SpaceListFilter, taskAddress, taskHref } from "./paths";
import { AddBar, firstOpenStatus, type QuickAddTarget } from "./QuickAdd";
import { refreshOnReturn } from "./refresh-on-return";
import SpaceList from "./SpaceList";
import type { PwaRow, PwaSpace, PwaSpaceEntry } from "./space";
import TaskDetail, { type TaskDetailState } from "./TaskDetail";
import type { PwaTask } from "./task";

type Props = {
  userId: string;
  /** The list the address names: "My tasks" in a view, or one Space with its filter. */
  initialList: PwaList;
  /** "My tasks" in the address's view, or in "For me" beside a Space. */
  initialWork: OverviewWork;
  /** Every Space the title switches to. */
  spaces: PwaSpaceEntry[];
  /** The server's read of the Space the address names; null when it cannot be opened. */
  initialSpace?: PwaSpace | null;
  dateConfig: DateContext;
  /** The task the address names, read by the server. */
  initialTask?: PwaTask;
  /** The person, as a new task from "My tasks" assigns them. */
  me: SpaceItemAssignee;
};

const LAST_SPACE = "spaces-pwa:last-space";
const readLastSpace = () => {
  try {
    return localStorage.getItem(LAST_SPACE) ?? undefined;
  } catch {
    return undefined;
  }
};
const rememberSpace = (shortId: string) => {
  try {
    localStorage.setItem(LAST_SPACE, shortId);
  } catch {
    // Without device storage the chip starts at the first Space the person may add to.
  }
};
type Shape = Omit<PwaSpace, "groups" | "filter">;
const readShape = async (spaceShortId: string): Promise<Shape | null> => {
  const response = await fetch(`/pwa/spaces/${encodeURIComponent(spaceShortId)}?shape=1`, {
    headers: { Accept: "application/json" },
  }).catch(() => null);
  return response?.ok ? ((await response.json()) as Shape) : null;
};

/** The address of the selection: the list alone, or one task. */
type Selection = { spaceShortId: string; shortId: string } | null;
/** What a row hands the task while it loads: its title, Space and date. */
type Opening = WorkItem;

const viewOf = (value: string | null): OverviewView => {
  const parsed = OverviewViewSchema.safeParse(value ?? "mine");
  return parsed.success ? parsed.data : "mine";
};
const sameList = (a: PwaList, b: PwaList) => pwaListHref(a) === pwaListHref(b);

const readTask = async (spaceShortId: string, shortId: string, signal: AbortSignal): Promise<PwaTask | "gone"> => {
  const response = await fetch(taskHref(spaceShortId, shortId), { headers: { Accept: "application/json" }, signal });
  if (response.status === 404) return "gone";
  if (!response.ok) throw new Error(`Task request failed with ${response.status}`);
  return (await response.json()) as PwaTask;
};

/**
 * Spaces in the mobile app: the person's tasks or one Space as a list of its statuses and, from a row, one task. The
 * list's title switches between "My tasks" and every Space, as a sheet on a phone and a menu beside it on a tablet.
 * Below 64rem one level fills the page, the task with a step back; from 64rem the list stands beside the task. A row
 * opens its task in place: the row's title, Space and date show at once, the rest follows from the task's own
 * address, which history keeps, so reload, Back and rotating show the same list and task.
 */
export default function SpacesPwa(props: Props) {
  const retryToast = createRetryToasts();
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const online = createOnline();
  const [list, setList] = createSignal<PwaList>(props.initialList);
  const [searching, setSearching] = createSignal(false);
  /** "My tasks" was replaced by a Space since the page loaded, so its server list is no longer current. */
  const [mineStale, setMineStale] = createSignal(props.initialList.kind !== "mine");
  createEffect(on(list, (current) => current.kind === "space" && setMineStale(true), { defer: true }));
  const [revision, setRevision] = createSignal(0);
  const [selection, setSelection] = createSignal<Selection>(
    props.initialTask ? { spaceShortId: props.initialTask.spaceShortId, shortId: props.initialTask.shortId } : null,
  );
  const [opening, setOpening] = createSignal<Opening>();
  /** The Space the list shows as read last, for its head; null once it cannot be opened. */
  const [space, setSpace] = createSignal<PwaSpace | null | undefined>(props.initialSpace);
  const view = () => {
    const current = list();
    return current.kind === "mine" ? current.view : "mine";
  };
  const spaceList = () => {
    const current = list();
    return current.kind === "space" ? current : undefined;
  };
  const entryOf = (shortId: string) => props.spaces.find((entry) => entry.shortId === shortId);

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
    const next = listOf(url, viewOf);
    if (!sameList(next, list())) {
      if (next.kind !== "space" || next.spaceShortId !== spaceList()?.spaceShortId) setSpace(undefined);
      setSearching(false);
      setList(next);
    }
    setOpening(undefined);
    setSelection(taskAddress(url.pathname));
  };
  onMount(() => onCleanup(listenPopState(({ url }) => follow(url))));

  /** Another list: the title's switcher, a reset filter, or "To My tasks". The list is the page's place, so it is a step. */
  const showList = (next: PwaList, options: { replace?: boolean } = {}) => {
    if (next.kind !== "space" || next.spaceShortId !== spaceList()?.spaceShortId) setSpace(undefined);
    if (next.kind !== list().kind || pwaListHref(next) !== pwaListHref(list()))
      setSearching(next.kind === "space" && next.filter.search.length > 0);
    setList(next);
    setSelection(null);
    setOpening(undefined);
    navigate(pwaListHref(next), { replace: options.replace, scroll: "manual", viewTransition: false, state: null });
  };

  /** A narrower or wider Space list is the same place: the address keeps it, beside an open task too, for a reload. */
  const setFilter = (filter: SpaceListFilter) => {
    const current = spaceList();
    if (!current) return;
    const next: PwaList = { ...current, filter };
    setList(next);
    const target = selection();
    navigate(target ? listTaskHref(target.spaceShortId, target.shortId, next) : pwaListHref(next), {
      replace: true,
      scroll: "manual",
      viewTransition: false,
    });
  };

  const open = (target: { spaceShortId: string; shortId: string }, item: Opening, event: LinkNavigateEvent) => {
    const fromList = selection() === null;
    setOpening(item);
    setSelection(target);
    event.push(listTaskHref(target.spaceShortId, target.shortId, list()), { scroll: "manual", state: { spacesFromList: fromList } });
  };
  const openWork = (item: WorkItem, event: LinkNavigateEvent) =>
    open({ spaceShortId: item.spaceShortId, shortId: item.shortId }, item, event);
  const openRow = (row: PwaRow, event: LinkNavigateEvent) => {
    const current = spaceList()!;
    const known = space() ?? undefined;
    const entry = entryOf(current.spaceShortId);
    open(
      { spaceShortId: current.spaceShortId, shortId: row.shortId },
      {
        shortId: row.shortId,
        spaceShortId: current.spaceShortId,
        spaceName: known?.name ?? entry?.name ?? "",
        spaceColor: known?.color ?? entry?.color ?? null,
        title: row.title,
        priority: null,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        deadline: row.deadline,
        deadlineAllDay: row.deadlineAllDay,
        canWrite: known?.canWrite ?? true,
      },
      event,
    );
  };

  const back = (event: LinkNavigateEvent) => {
    const state: unknown = history.state;
    if (state && typeof state === "object" && "spacesFromList" in state && state.spacesFromList === true) {
      history.back();
      return;
    }
    setSelection(null);
    event.replaceWith(pwaListHref(list()), { scroll: "manual", state: null });
  };

  const detailCompleted = () => setRevision((value) => value + 1);
  const completedChange = (shortId: string) => {
    if (selection()?.shortId === shortId) void retryRefresh();
  };

  const taskSpace = () => {
    const current = detail();
    if (!current || current.kind === "gone") return undefined;
    if (current.kind === "ready") return { name: current.task.spaceName, color: current.task.spaceColor };
    return current.item ? { name: current.item.spaceName, color: current.item.spaceColor ?? undefined } : undefined;
  };

  // The list's head: "My tasks" with its mark, or the Space with its colour.
  const head = createMemo(() => {
    const current = spaceList();
    if (!current) return { name: t().myTasks, color: undefined };
    const known = space();
    const entry = entryOf(current.spaceShortId);
    return { name: known?.name ?? entry?.name ?? t().spacesSection, color: known?.color ?? entry?.color };
  });
  const mineTotal = () => props.initialWork.counts.mine;
  const switcherItems = (): DropdownItem[] => [
    {
      label: t().myTasks,
      icon: "ti ti-user-check",
      description: props.spaces.length ? t().openInAllSpaces({ count: mineTotal() }) : undefined,
      choice: "radio",
      checked: () => list().kind === "mine",
      href: pwaListHref({ kind: "mine", view: "mine" }),
      action: () => showList({ kind: "mine", view: view() }),
    },
    {
      sectionLabel: t().spacesSection,
      items: props.spaces.length
        ? props.spaces.map((entry) => ({
            label: entry.name,
            color: entry.color,
            choice: "radio" as const,
            checked: () => spaceList()?.spaceShortId === entry.shortId,
            description: [
              entry.pinned ? t().pinned : null,
              !entry.canWrite ? t().readOnlyShort : entry.openCount ? t().openCount({ count: entry.openCount }) : t().noTasksYet,
            ]
              .filter(Boolean)
              .join(" · "),
            href: pwaListHref({ kind: "space", spaceShortId: entry.shortId, filter: NO_FILTER }),
            action: () => showList({ kind: "space", spaceShortId: entry.shortId, filter: NO_FILTER }),
          }))
        : [{ label: t().noSpace, icon: "ti ti-layout-kanban", description: t().noSpaceEntry, disabled: true as const }],
    },
  ];

  // ------------------------------------------------------------- adding tasks
  const writable = () => props.spaces.filter((entry) => entry.canWrite);
  const [composing, setComposing] = createSignal<{ template?: SpaceItemTemplate } | null>(null);
  // The field loads when it first opens, with its pickers; the list does not carry it.
  const [composer, setComposer] = createSignal<typeof import("./Composer").default>();
  const [outgoing, setOutgoing] = createSignal<Outgoing[]>([]);
  // Tasks not yet confirmed come back after a reload or a restart, with their request key, to be sent again.
  onMount(() => setOutgoing(outbox.read(props.userId)));
  createEffect(on(outgoing, (entries) => outbox.write(props.userId, entries), { defer: true }));
  /** In "My tasks": the Space a new task goes to, the last one used on this device. */
  const [mineSpace, setMineSpace] = createSignal<string>();
  const [mineShape, setMineShape] = createSignal<Shape | null>();
  const chooseMineSpace = async (shortId: string) => {
    setMineSpace(shortId);
    setMineShape(undefined);
    const shape = await readShape(shortId);
    if (mineSpace() === shortId) setMineShape(shape);
  };
  const target = (): QuickAddTarget | undefined => {
    if (spaceList()) {
      const known = space();
      return known && known.canWrite
        ? { shortId: known.shortId, name: known.name, color: known.color, statuses: known.statuses, templates: known.templates }
        : undefined;
    }
    const shape = mineShape();
    return shape ? { shortId: shape.shortId, name: shape.name, color: shape.color, statuses: shape.statuses, templates: [] } : undefined;
  };
  /** Whether this list offers "New task": a Space the person may change, or "My tasks" with such a Space. */
  const canAdd = () => (spaceList() ? Boolean(space()?.canWrite) : writable().length > 0);
  const blocked = () => {
    if (!online()) return t().offlineChanges;
    const known = space();
    if (spaceList() && known && !firstOpenStatus(known.statuses)) return t().noOpenStatus;
    return undefined;
  };
  const openComposer = async (template?: SpaceItemTemplate) => {
    if (!composer()) {
      const module = await importOnDemand(() => import("./Composer"));
      if (!module) return;
      setComposer(() => module.default);
    }
    if (!spaceList()) {
      const last = readLastSpace();
      const start = writable().find((entry) => entry.shortId === last) ?? writable()[0];
      // A Space whose statuses could not be read is read again on every opening.
      if (start && (start.shortId !== mineSpace() || mineShape() === null)) void chooseMineSpace(start.shortId);
    }
    setComposing({ template });
  };
  createEffect(on(list, () => setComposing(null), { defer: true }));
  // Tasks the server kept leave the list of outgoing ones when another list shows.
  createEffect(on(list, () => setOutgoing((current) => current.filter((entry) => entry.state !== "created")), { defer: true }));

  const patchOutgoing = (key: string, next: Partial<Outgoing>) =>
    setOutgoing((current) => current.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)));
  const send = async (entry: Outgoing) => {
    patchOutgoing(entry.key, { state: "saving", reason: undefined });
    const name = entryOf(entry.spaceShortId)?.name ?? space()?.name ?? "";
    const outcome = await sendCreate(entry.spaceShortId, entry.body, t().createRefused({ space: name }));
    if (outcome.kind === "unconfirmed") return patchOutgoing(entry.key, { state: "unconfirmed" });
    if (outcome.kind === "refused") return patchOutgoing(entry.key, { state: "refused", reason: outcome.reason });
    patchOutgoing(entry.key, { state: "created", created: outcome.item });
    setRevision((value) => value + 1);
    if (!spaceList()) {
      // "My tasks" shows the task under "For me" once it is read again; the notice leads to it at once.
      setOutgoing((current) => current.filter((candidate) => candidate.key !== entry.key));
      const notice = toast.success(t().createdIn({ space: name }), {
        action: {
          label: t().open,
          onClick: () => {
            notice.dismiss();
            navigate(taskHref(entry.spaceShortId, outcome.item.id));
          },
        },
      });
    }
  };
  const submit = (task: { spaceShortId: string; body: Outgoing["body"] }) => {
    rememberSpace(task.spaceShortId);
    const entry: Outgoing = {
      key: task.body.requestKey,
      spaceShortId: task.spaceShortId,
      statusId: task.body.columnId,
      title: task.body.title,
      body: task.body,
      state: "saving",
    };
    setOutgoing((current) => [...current, entry]);
    void send(entry);
  };
  const resend = (key: string) => {
    const entry = outgoing().find((candidate) => candidate.key === key);
    if (entry && entry.state === "unconfirmed") void send(entry);
  };
  /** A Space list read again after a create: the new row is there, or the filter hides it and a notice says so. */
  const settleOutgoing = (key: string, hidden: boolean) => {
    const entry = outgoing().find((candidate) => candidate.key === key);
    if (!entry?.created) return;
    if (!hidden) return setOutgoing((current) => current.filter((candidate) => candidate.key !== key));
    const created = entry.created;
    const notice = toast.success(t().createdHidden, {
      action: {
        label: t().open,
        onClick: () => {
          notice.dismiss();
          navigate(listTaskHref(entry.spaceShortId, created.id, list()));
        },
      },
    });
  };

  const copyLink = async () => {
    const current = spaceList();
    if (!current) return;
    try {
      await navigator.clipboard.writeText(new URL(buildSpaceHref(current.spaceShortId), window.location.origin).href);
      toast.success(t().linkCopied);
    } catch {
      toast.error(t().linkCopyFailed);
    }
  };
  const listActions = () => (
    <>
      <IconButton label={t().searchTasks} aria-pressed={searching()} onClick={() => toggleSearch()}>
        <i class="ti ti-search" aria-hidden="true" />
      </IconButton>
      <Show when={spaceList()}>
        {(current) => (
          <Dropdown
            phone="sheet"
            variant="touch"
            position="bottom-right"
            label={t().moreAbout({ name: head().name })}
            items={[
              {
                label: t().openInSpaces,
                icon: "ti ti-external-link",
                description: t().openSpaceWebHint,
                href: buildSpaceHref(current().spaceShortId),
              },
              { label: t().copyLink, icon: "ti ti-link", immediate: true, action: () => void copyLink() },
            ]}
          >
            <Dropdown.Trigger iconOnly label={t().moreAbout({ name: head().name })}>
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown>
        )}
      </Show>
    </>
  );
  const toggleSearch = () => {
    const current = spaceList();
    if (searching() && current?.filter.search) setFilter({ ...current.filter, search: "" });
    setSearching((value) => !value);
  };
  const closeSearch = () => {
    const current = spaceList();
    if (current?.filter.search) setFilter({ ...current.filter, search: "" });
    setSearching(false);
  };

  return (
    <AppWorkspace flat mobileSurface="flush" resizable={false} class="spaces-pwa-workspace">
      <AppWorkspace.Content>
        <AppWorkspace.Main level={selection() ? "task" : "list"} onLevelNavigate={back}>
          <AppWorkspace.MainPane
            id="list"
            label={head().name}
            lead={
              <Show when={head().color} fallback={<i class="ti ti-user-check spaces-pwa__lead-icon" aria-hidden="true" />}>
                {(color) => (
                  <span class="spaces-pwa__dot spaces-pwa__dot--head" style={{ "background-color": color() }} aria-hidden="true" />
                )}
              </Show>
            }
            switcher={{
              label: t().switchSpace,
              items: switcherItems(),
              search: props.spaces.length >= APP_WORKSPACE_SWITCHER_SEARCH_FROM ? { label: t().findSpace } : undefined,
            }}
            actions={listActions()}
            href={pwaListHref(list())}
            scroll={false}
            defaultSize={384}
            minSize={384}
            maxSize={384}
          >
            <div class="spaces-pwa-pane">
              <div class="spaces-pwa-pane__scroll" data-scroll-preserve="spaces-pwa-list">
                <Switch>
                  <Match when={spaceList()}>
                    {(current) => (
                      <Show when={current().spaceShortId} keyed>
                        {(spaceShortId) => (
                          <SpaceList
                            userId={props.userId}
                            spaceShortId={spaceShortId}
                            entry={entryOf(spaceShortId)}
                            initial={space() === undefined ? undefined : space()}
                            filter={current().filter}
                            dateConfig={props.dateConfig}
                            online={online()}
                            searching={searching()}
                            selected={selection()?.shortId}
                            revision={revision()}
                            onFilterChange={setFilter}
                            onSearchClose={closeSearch}
                            onSpace={setSpace}
                            outgoing={outgoing().filter((entry) => entry.spaceShortId === spaceShortId)}
                            onResend={resend}
                            onSettle={settleOutgoing}
                            taskHref={(row) => listTaskHref(spaceShortId, row.shortId, current())}
                            onOpen={openRow}
                            onCompletedChange={completedChange}
                          />
                        )}
                      </Show>
                    )}
                  </Match>
                  <Match when={!props.spaces.length}>
                    <div class="spaces-pwa spaces-pwa-space__state">
                      <Placeholder
                        icon="ti ti-layout-kanban"
                        title={t().noSpace}
                        description={t().noSpaceHint}
                        action={
                          <ButtonLink variant="secondary" href={buildSpaceHref()}>
                            <i class="ti ti-external-link" aria-hidden="true" />
                            {t().openSpacesWeb}
                          </ButtonLink>
                        }
                      />
                    </div>
                  </Match>
                  <Match when={list().kind === "mine"}>
                    <MyTasks
                      userId={props.userId}
                      initialView={view()}
                      initialWork={props.initialWork}
                      dateConfig={props.dateConfig}
                      selected={selection()?.shortId}
                      taskHref={(item, current) => taskHref(item.spaceShortId, item.shortId, current)}
                      listHref={(next) => pwaListHref({ kind: "mine", view: next })}
                      view={view()}
                      viewHref={(next) => {
                        const current = selection();
                        return current ? taskHref(current.spaceShortId, current.shortId, next) : pwaListHref({ kind: "mine", view: next });
                      }}
                      refreshOnMount={mineStale()}
                      online={online()}
                      searching={searching()}
                      onSearchClose={() => setSearching(false)}
                      onOpen={openWork}
                      onViewChange={(next) => setList({ kind: "mine", view: next })}
                      onCompletedChange={completedChange}
                      revision={revision()}
                    />
                  </Match>
                </Switch>
              </div>
              {/* The bottom edge, under the thumb: "New task", or the quick add above the keyboard. */}
              <Show
                when={composer() && composing()}
                fallback={
                  <Show
                    when={canAdd() && !searching()}
                    fallback={
                      <Show when={!online()}>
                        <div class="spaces-pwa-pane__bottom" data-k2b-shell-bottom>
                          <p class="spaces-pwa__offline" role="status">
                            <i class="ti ti-wifi-off" aria-hidden="true" />
                            {t().offlineChanges}
                          </p>
                        </div>
                      </Show>
                    }
                  >
                    <AddBar
                      target={spaceList() ? target() : undefined}
                      blocked={blocked()}
                      onOpen={(template) => void openComposer(template)}
                    />
                  </Show>
                }
              >
                {(open) => (
                  <Dynamic
                    component={composer()}
                    userId={props.userId}
                    me={props.me}
                    target={target()}
                    spaces={spaceList() ? undefined : writable()}
                    onSpaceChange={(shortId: string) => void chooseMineSpace(shortId)}
                    targetShortId={mineSpace()}
                    targetFailed={!spaceList() && mineShape() === null}
                    onRetryTarget={() => {
                      const shortId = mineSpace();
                      if (shortId) void chooseMineSpace(shortId);
                    }}
                    template={open().template}
                    online={online()}
                    dateConfig={props.dateConfig}
                    outbox={spaceList() ? undefined : outgoing()}
                    onResend={resend}
                    onSubmit={submit}
                    onClose={() => setComposing(null)}
                  />
                )}
              </Show>
            </div>
          </AppWorkspace.MainPane>
          <AppWorkspace.MainPane
            id="task"
            label={taskSpace()?.name ?? t().task}
            lead={
              <Show when={taskSpace()?.color}>
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
                      listHref={pwaListHref(list())}
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
