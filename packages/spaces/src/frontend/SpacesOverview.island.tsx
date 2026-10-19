import { openCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { listenPopState, navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Avatar,
  Button,
  createNavigation,
  DetailPanel,
  dialogCore,
  IconButton,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  useLocale,
  ViewTabs,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { formatDeadline } from "@/presentation/deadline";
import { spaceCommandMessages } from "../commands";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import SpacesSidebarList from "./[id]/_components/sidebar/SpacesSidebarList";
import {
  createNewSpace,
  createPinnedSpaces,
  createSpacesNavigationItems,
  listenSpacesNavigationHints,
  type SidebarSpace,
} from "./[id]/_components/sidebar/spaces-navigation";
import { subscribeToSpacesDataInvalidation } from "./[id]/_components/workspace/workspace-events";
import { createRetryToasts } from "./lib/feedback";
import { readResponseError } from "./lib/response";
import { overviewMessages } from "./overview-messages";
import { createSpaceCommands } from "./space-commands";

type WorkItem = OverviewWork["items"][number];
type ActivityItem = {
  id: string;
  space: { id: string; name: string; color: string };
  item: { id: string; title: string } | null;
  actor: { kind: "user" | "service_account" | "system"; id: string | null; displayName: string; avatarHash: string | null };
  action: string;
  metadata: Record<string, unknown>;
  occurrenceCount: number;
  createdAt: string;
  lastOccurredAt: string;
};
type ActivityPage = { data: ActivityItem[]; nextCursor: string | null };
type Props = {
  spaces: SidebarSpace[];
  canCreate?: boolean;
  sidebarHint?: boolean;
  initialView: OverviewView;
  initialPinnedSpaceIds: string[];
  initialWork: OverviewWork;
  initialActivity: { items: ActivityItem[]; nextCursor: string | null };
  initialActivityError: string | null;
  dateConfig: DateContext;
};

const activityIcon = (action: string) =>
  action.includes("completed")
    ? "ti ti-check"
    : action.includes("comment")
      ? "ti ti-message-circle"
      : action.includes("created")
        ? "ti ti-plus"
        : action.includes("deleted")
          ? "ti ti-trash"
          : action.includes("moved")
            ? "ti ti-arrows-move"
            : "ti ti-pencil";

export default function SpacesOverview(props: Props) {
  createSpaceCommands({ dateConfig: props.dateConfig });
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const activityDescription = (entry: ActivityItem) => {
    const title = entry.item?.title ?? String(entry.metadata.itemTitle ?? entry.space.name);
    const params = { title, space: entry.space.name };
    const labels: Record<string, string> = {
      "space.created": t.activityCreatedSpace({ space: entry.space.name }),
      "space.updated": t.activityUpdatedSpace({ space: entry.space.name }),
      "task.created": t.activityCreatedTask(params),
      "event.created": t.activityCreatedEvent(params),
      "task.updated": t.activityUpdatedTask(params),
      "event.updated": t.activityUpdatedEvent(params),
      "task.completed": t.activityCompletedTask(params),
      "task.claimed": t.activityClaimed(params),
      "task.released": t.activityReleased(params),
      "task.taken_over": t.activityTakenOver({
        ...params,
        from: typeof entry.metadata.fromName === "string" ? entry.metadata.fromName : t.activityFormerHolder,
      }),
      "task.progress": t.activityProgress(params),
      "task.reopened": t.activityReopenedTask(params),
      "event.completed": t.activityCompletedEvent(params),
      "event.reopened": t.activityReopenedEvent(params),
      "task.deleted": t.activityDeletedTask(params),
      "event.deleted": t.activityDeletedEvent(params),
      "item.moved": t.activityMoved(params),
      "comment.created": t.activityCommented(params),
      "item.assignees.updated": t.activityAssignees(params),
      "item.tags.updated": t.activityTags(params),
      "comment.updated": t.activityCommentUpdated(params),
      "comment.deleted": t.activityCommentDeleted(params),
      "checklist.created": t.activityChecklistCreated(params),
      "checklist.updated": t.activityChecklistUpdated(params),
      "checklist.completed": t.activityChecklistCompleted(params),
      "checklist.reopened": t.activityChecklistReopened(params),
      "checklist.deleted": t.activityChecklistDeleted(params),
    };
    return labels[entry.action] ?? t.activityOther({ action: entry.action.replaceAll(".", " "), space: entry.space.name });
  };
  const [view, setView] = createSignal<OverviewView>(props.initialView);
  const [initialActivityError, setInitialActivityError] = createSignal(props.initialActivityError);
  const canCreate = () => props.canCreate ?? true;
  const create = createNewSpace(t);
  const [pinned] = createPinnedSpaces(props.initialPinnedSpaceIds);
  const navigation = createNavigation({
    items: () =>
      createSpacesNavigationItems({
        spaces: props.spaces,
        pinnedSpaceIds: pinned(),
        current: { kind: "overview" },
        canCreate: canCreate(),
        myWorkLabel: t.myWork,
        newSpaceLabel: t.newSpace,
      }),
    onAction: async (action) => {
      if (action === "new-space") await create();
    },
  });
  const work = queries.create<OverviewView, OverviewWork>({
    source: view,
    initial: { source: props.initialView, data: props.initialWork },
    load: async (view, { abortSignal }) => {
      const response = await apiClient.overview.work.$get({ query: { view } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readResponseError(response, t.workLoadFailed));
      return response.json();
    },
  });
  const activeWork = () => (work.data()?.view === view() ? work.data() : undefined);
  const workItems = () => activeWork()?.items ?? [];
  const counts = () => work.data()?.counts ?? props.initialWork.counts;
  const priorityLabel = (priority: NonNullable<WorkItem["priority"]>) =>
    ({ urgent: t.urgent, high: t.high, medium: t.medium, low: t.low })[priority];

  const activity = queries.createInfinite<string, ActivityPage, string>({
    source: () => "spaces",
    initial: { source: "spaces", pages: [{ data: props.initialActivity.items, nextCursor: props.initialActivity.nextCursor }] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get(
        { query: { limit: "30", ...(cursor ? { cursor } : {}) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.activityLoadFailed));
      setInitialActivityError(null);
      return response.json();
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const activityItems = createMemo(() => activity.pages().flatMap((page) => page.data));
  const activityError = () => activity.error()?.message ?? initialActivityError();

  const workViewOptions = () =>
    (["mine", "today", "upcoming"] as const).map((id) => ({
      id,
      label: id === "mine" ? t.forMe : id === "today" ? t.today : t.upcomingView,
      href: `/app/spaces?view=${id}`,
      count: counts()[id],
    }));
  let tabsHost: HTMLDivElement | undefined;
  const selectView = (next: OverviewView) => {
    if (view() === next) return;
    setView(next);
    navigate(next === "mine" ? "/app/spaces" : `/app/spaces?view=${next}`, { scroll: "preserve" });
  };
  onMount(() => {
    onCleanup(
      subscribeToSpacesDataInvalidation(["view"], async () => {
        await Promise.all([work.refresh(), activity.refresh()]);
      }),
    );
    // Delegate native link clicks, including keyboard activation, without changing their semantics.
    const onTabClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor) return;
      const next = new URL(anchor.href).searchParams.get("view");
      if (next !== "mine" && next !== "today" && next !== "upcoming") return;
      event.preventDefault();
      selectView(next);
    };
    tabsHost?.addEventListener("click", onTabClick);
    onCleanup(() => tabsHost?.removeEventListener("click", onTabClick));
    onCleanup(listenSpacesNavigationHints(document, props.spaces));
    onCleanup(
      listenPopState(({ url }) => {
        const value = url.searchParams.get("view");
        setView(value === "today" || value === "upcoming" ? value : "mine");
      }),
    );
  });
  const retryToast = createRetryToasts();
  /** A failed command (the Space no longer allows it, or the request failed) says so and offers the same step again. */
  const composeTask = (): Promise<void> =>
    openCommand("spaces.task.compose", {})
      .then(() => undefined)
      .catch((error: unknown) =>
        retryToast(
          error instanceof Error && error.message ? error.message : spaceCommandMessages.resolve([locale()]).t.failed,
          t.retry,
          composeTask,
        ),
      );
  const openSearch = () => openGlobalSearch({ scope: { appId: "spaces", label: "Spaces", icon: "ti ti-layout-kanban" } });

  const activityFeed = () => (
    <Show
      when={!activityError()}
      fallback={
        <Placeholder
          state="error"
          title={t.couldNotLoadActivity}
          description={activityError() ?? undefined}
          icon="ti ti-alert-circle"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setInitialActivityError(null);
                void activity.refresh();
              }}
            >
              <i class="ti ti-refresh" aria-hidden="true" /> {t.retry}
            </Button>
          }
        />
      }
    >
      <Show
        when={activityItems().length > 0}
        fallback={
          <Placeholder
            state={activity.loading() ? "loading" : "empty"}
            title={activity.loading() ? t.loadingActivity : t.noActivity}
            description={activity.loading() ? undefined : t.noActivityDescription}
            icon="ti ti-history"
          />
        }
      >
        <ol class="spaces-overview-activity-list" aria-label={t.recentActivity}>
          <For each={activityItems()}>
            {(entry) => (
              <li class="spaces-overview-activity-item">
                <Avatar
                  name={entry.actor.displayName}
                  src={
                    entry.actor.kind === "user" && entry.actor.id && entry.actor.avatarHash
                      ? `/api/accounts/users/${encodeURIComponent(entry.actor.id)}/avatar?rev=${encodeURIComponent(entry.actor.avatarHash)}`
                      : undefined
                  }
                  icon={
                    entry.actor.kind === "service_account"
                      ? "ti ti-api"
                      : entry.actor.kind === "system"
                        ? "ti ti-settings-automation"
                        : undefined
                  }
                  size="sm"
                />
                <a
                  href={entry.item ? `/app/spaces/${entry.space.id}?item=${entry.item.id}` : `/app/spaces/${entry.space.id}`}
                  class="spaces-overview-activity-row"
                >
                  <i class={`${activityIcon(entry.action)} spaces-overview-activity-icon app-accent-text`} aria-hidden="true" />
                  <span class="spaces-overview-activity-meta">
                    <strong>{entry.actor.displayName}</strong>
                    <span aria-hidden="true">·</span>
                    <time datetime={entry.lastOccurredAt} title={dates.formatDateTime(entry.lastOccurredAt, props.dateConfig)}>
                      {dates.formatDateTimeRelative(entry.lastOccurredAt, props.dateConfig)}
                    </time>
                  </span>
                  <span class="spaces-overview-activity-description">{activityDescription(entry)}</span>
                </a>
              </li>
            )}
          </For>
        </ol>
        <Show when={activity.hasMore()}>
          <Button
            size="sm"
            variant="secondary"
            class="mx-auto mt-2"
            loading={activity.loadingMore()}
            loadingLabel={t.loadingMoreActivity}
            onClick={() => void activity.loadMore()}
          >
            {t.loadMore}
          </Button>
        </Show>
      </Show>
    </Show>
  );
  const openMobileActivity = () =>
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title={t.activity} subtitle={t.activityDescription} close={close} />
          <PanelDialog.Body>{activityFeed()}</PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogOptions,
    );

  const workList = () => (
    <Show
      when={workItems().length > 0}
      fallback={
        <Placeholder
          state={work.error() ? "error" : !activeWork() ? "loading" : "empty"}
          title={
            work.error()
              ? t.workLoadFailed
              : !activeWork()
                ? t.loadingWork
                : view() === "mine"
                  ? t.nothingAssigned
                  : view() === "today"
                    ? t.nothingToday
                    : t.nothingUpcoming
          }
          description={work.error()?.message ?? (activeWork() ? t.allCaughtUp : undefined)}
          action={
            work.error() ? (
              <Button variant="secondary" size="sm" onClick={() => void work.refresh()}>
                {t.retry}
              </Button>
            ) : undefined
          }
          icon="ti ti-circle-check"
          class="min-h-64"
        />
      }
    >
      <div class="spaces-overview-work-list">
        <For each={workItems()}>
          {(item) => (
            <a class="spaces-overview-work-row" href={`/app/spaces/${item.spaceShortId}?item=${item.shortId}`}>
              <span
                class="spaces-overview-space-mark"
                style={{ "background-color": item.spaceColor ?? "var(--ui-accent)" }}
                aria-hidden="true"
              />
              <span class="spaces-overview-work-copy">
                <strong>{item.title}</strong>
                <span>{item.spaceName}</span>
              </span>
              <Show when={item.priority}>
                <span class={`spaces-overview-priority is-${item.priority}`}>{priorityLabel(item.priority!)}</span>
              </Show>
              <Show when={item.startsAt || item.deadline}>
                <time datetime={item.startsAt ?? item.deadline ?? undefined}>
                  {item.startsAt
                    ? dates.formatDateTimeRelative(item.startsAt, props.dateConfig)
                    : formatDeadline(item.deadline!, props.dateConfig)}
                </time>
              </Show>
              <i class="ti ti-chevron-right text-dimmed" aria-hidden="true" />
            </a>
          )}
        </For>
      </div>
    </Show>
  );

  return (
    <AppWorkspace mobileSurface="flush" flat class="spaces-overview-workspace">
      <WorkspaceNavigationProvider label="Spaces" navigation={navigation} />
      <h1 class="sr-only">Spaces</h1>
      <AppWorkspace.Sidebar label="Spaces" collapsible>
        <AppWorkspace.SidebarDesktop>
          <SpacesSidebarList
            spaces={props.spaces}
            pinnedSpaceIds={props.initialPinnedSpaceIds}
            myWorkCount={counts().mine}
            current={{ kind: "overview" }}
            canCreate={canCreate()}
            hint={{ id: "spaces.overview-sidebar", open: Boolean(props.sidebarHint) && canCreate() }}
          />
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Head
        views={
          <div ref={tabsHost}>
            <ViewTabs label={t.workView} current={view()} items={workViewOptions()} />
          </div>
        }
        actions={
          <>
            <IconButton label={t.searchTitle} onClick={() => void openSearch()}>
              <i class="ti ti-search" aria-hidden="true" />
            </IconButton>
            <Button variant="secondary" size="sm" class="spaces-overview-mobile-activity" onClick={openMobileActivity}>
              <i class="ti ti-history" aria-hidden="true" /> {t.activity}
            </Button>
          </>
        }
        primary={{ label: t.newTask, icon: "ti ti-plus", onClick: () => void composeTask() }}
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main class="spaces-overview-main" width="content" aria-busy={work.loading()}>
          <div class="spaces-overview-page">
            <div class="spaces-overview-list">{workList()}</div>
          </div>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="spaces-overview-activity" open width="md" resizable={false} class="spaces-overview-activity">
          <DetailPanel>
            <DetailPanel.Header title={t.activity} subtitle={t.activityDescription} />
            <DetailPanel.Body scrollPreserveKey="spaces-overview-activity">{activityFeed()}</DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
