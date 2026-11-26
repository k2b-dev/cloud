import { openCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { listenPopState, navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Empty, Failed, List, Loading, Pane, Row, Section, Tabs, useToast, Workspace } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { formatDeadline } from "@/presentation/deadline";
import { spaceCommandMessages } from "../commands";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import SpacesNav, { useSpacesNav } from "./_components/spaces-nav";
import { listenSpacesNavigationHints, type SidebarSpace } from "./[id]/_components/sidebar/spaces-navigation";
import { subscribeToSpacesDataInvalidation } from "./[id]/_components/workspace/workspace-events";
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
  initialView: OverviewView;
  initialPinnedSpaceIds: string[];
  initialWork: OverviewWork;
  initialActivity: { items: ActivityItem[]; nextCursor: string | null };
  initialActivityError: string | null;
  dateConfig: DateContext;
  /** The server's time, so the server and the first browser render show the same activity times. */
  now: string;
};

const VIEWS = ["mine", "today", "upcoming"] as const;
const viewHref = (view: OverviewView) => (view === "mine" ? "/app/spaces" : `/app/spaces?view=${view}`);
const priorityStatus = { urgent: "bad", high: "warn" } as const;

/**
 * Spaces home on v2: the work that waits for this person in three views, and what changed lately in their Spaces
 * beside it (below it on the phone). The address holds the view; reload and back show the same.
 */
export default function SpacesOverview(props: Props) {
  createSpaceCommands({ dateConfig: props.dateConfig });
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  const toast = useToast();
  const [view, setView] = createSignal<OverviewView>(props.initialView);
  const [initialActivityError, setInitialActivityError] = createSignal(props.initialActivityError);
  const work = queries.create<OverviewView, OverviewWork>({
    source: view,
    initial: { source: props.initialView, data: props.initialWork },
    load: async (next, { abortSignal }) => {
      const response = await apiClient.overview.work.$get({ query: { view: next } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readResponseError(response, t().workLoadFailed));
      return response.json();
    },
  });
  const activeWork = () => (work.data()?.view === view() ? work.data() : undefined);
  const counts = () => work.data()?.counts ?? props.initialWork.counts;
  const nav = useSpacesNav({
    spaces: props.spaces,
    pinnedSpaceIds: props.initialPinnedSpaceIds,
    get myWorkCount() {
      return counts().mine;
    },
    current: { kind: "overview" },
    canCreate: props.canCreate ?? true,
  });

  const activity = queries.createInfinite<string, ActivityPage, string>({
    source: () => "spaces",
    initial: { source: "spaces", pages: [{ data: props.initialActivity.items, nextCursor: props.initialActivity.nextCursor }] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get(
        { query: { limit: "30", ...(cursor ? { cursor } : {}) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t().activityLoadFailed));
      setInitialActivityError(null);
      return response.json();
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const activityItems = createMemo(() => activity.pages().flatMap((page) => page.data));
  // A failed older page keeps the loaded rows and says so where "Load more" stood; any other failure stands in place of
  // the rows.
  const [failedPage, setFailedPage] = createSignal<Error | null>(null);
  const loadMoreActivity = async () => {
    const before = activity.error();
    await activity.loadMore();
    const after = activity.error();
    setFailedPage(after !== before ? after : null);
  };
  const pageError = () => {
    const failed = activity.error();
    return failed && failed === failedPage() ? failed.message : null;
  };
  const activityError = () => (pageError() ? null : (activity.error()?.message ?? initialActivityError()));
  const reloadActivity = () => {
    setInitialActivityError(null);
    void activity.refresh();
  };

  const selectView = (next: OverviewView) => {
    if (view() === next) return;
    setView(next);
    navigate(viewHref(next), { scroll: "preserve" });
  };
  onMount(() => {
    onCleanup(
      subscribeToSpacesDataInvalidation(["view"], async () => {
        await Promise.all([work.refresh(), activity.refresh()]);
      }),
    );
    onCleanup(listenSpacesNavigationHints(document, props.spaces));
    onCleanup(
      listenPopState(({ url }) => {
        const value = url.searchParams.get("view");
        setView(value === "today" || value === "upcoming" ? value : "mine");
      }),
    );
  });

  /** A failed command (the Space no longer allows it, or the request failed) says so; the person starts it again. */
  const composeTask = (): Promise<void> =>
    openCommand("spaces.task.compose", {})
      .then(() => undefined)
      .catch((error: unknown) => {
        toast(error instanceof Error && error.message ? error.message : spaceCommandMessages.resolve([locale()]).t.failed, {
          status: "bad",
          retry: composeTask,
        });
      });
  const openSearch = () => openGlobalSearch({ scope: { appId: "spaces", label: "Spaces", icon: "ti ti-layout-kanban" } });

  const viewLabel = (id: OverviewView) => (id === "mine" ? t().forMe : id === "today" ? t().today : t().upcomingView);
  const emptyText = () => (view() === "mine" ? t().nothingAssigned : view() === "today" ? t().nothingToday : t().nothingUpcoming);
  const priorityLabel = (priority: NonNullable<WorkItem["priority"]>) =>
    ({ urgent: t().urgent, high: t().high, medium: t().medium, low: t().low })[priority];
  const when = (item: WorkItem) =>
    item.startsAt
      ? `${dates.formatDateRelative(item.startsAt, props.dateConfig)}, ${dates.formatTime(item.startsAt, props.dateConfig)}`
      : item.deadline
        ? formatDeadline(item.deadline, props.dateConfig)
        : undefined;

  const activityDescription = (entry: ActivityItem) => {
    const text = t();
    const title = entry.item?.title ?? String(entry.metadata.itemTitle ?? entry.space.name);
    const params = { title, space: entry.space.name };
    const labels: Record<string, string> = {
      "space.created": text.activityCreatedSpace({ space: entry.space.name }),
      "space.updated": text.activityUpdatedSpace({ space: entry.space.name }),
      "task.created": text.activityCreatedTask(params),
      "event.created": text.activityCreatedEvent(params),
      "task.updated": text.activityUpdatedTask(params),
      "event.updated": text.activityUpdatedEvent(params),
      "task.completed": text.activityCompletedTask(params),
      "task.claimed": text.activityClaimed(params),
      "task.released": text.activityReleased(params),
      "task.taken_over": text.activityTakenOver({
        ...params,
        from: typeof entry.metadata.fromName === "string" ? entry.metadata.fromName : text.activityFormerHolder,
      }),
      "task.progress": text.activityProgress(params),
      "task.reopened": text.activityReopenedTask(params),
      "event.completed": text.activityCompletedEvent(params),
      "event.reopened": text.activityReopenedEvent(params),
      "task.deleted": text.activityDeletedTask(params),
      "event.deleted": text.activityDeletedEvent(params),
      "item.moved": text.activityMoved(params),
      "comment.created": text.activityCommented(params),
      "item.assignees.updated": text.activityAssignees(params),
      "item.tags.updated": text.activityTags(params),
      "comment.updated": text.activityCommentUpdated(params),
      "comment.deleted": text.activityCommentDeleted(params),
      "checklist.created": text.activityChecklistCreated(params),
      "checklist.updated": text.activityChecklistUpdated(params),
      "checklist.completed": text.activityChecklistCompleted(params),
      "checklist.reopened": text.activityChecklistReopened(params),
      "checklist.deleted": text.activityChecklistDeleted(params),
    };
    return labels[entry.action] ?? text.activityOther({ action: entry.action.replaceAll(".", " "), space: entry.space.name });
  };
  const activityHref = (entry: ActivityItem) =>
    entry.item ? `/app/spaces/${entry.space.id}?item=${entry.item.id}` : `/app/spaces/${entry.space.id}`;
  const avatarSrc = (entry: ActivityItem) =>
    entry.actor.kind === "user" && entry.actor.id && entry.actor.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(entry.actor.id)}/avatar?rev=${encodeURIComponent(entry.actor.avatarHash)}`
      : undefined;
  const ActivityRow = (rowProps: { entry: ActivityItem }) => {
    const entry = rowProps.entry;
    const lines: [string, string] = [activityDescription(entry), entry.actor.displayName];
    const time = dates.formatDateTimeRelative(entry.lastOccurredAt, { ...props.dateConfig, base: props.now });
    return entry.actor.kind === "user" ? (
      <Row
        avatar={{ name: entry.actor.displayName, image: avatarSrc(entry) }}
        lines={lines}
        time={time}
        meta={entry.occurrenceCount > 1 ? `×${entry.occurrenceCount}` : undefined}
        href={activityHref(entry)}
      />
    ) : (
      <Row
        icon={entry.actor.kind === "system" ? "settings" : "robot"}
        lines={lines}
        time={time}
        meta={entry.occurrenceCount > 1 ? `×${entry.occurrenceCount}` : undefined}
        href={activityHref(entry)}
      />
    );
  };

  return (
    <Workspace
      sidebar={<SpacesNav nav={nav} />}
      head={
        <Bar
          start={
            <Tabs
              label={t().workView}
              items={VIEWS.map((id) => ({
                label: viewLabel(id),
                count: counts()[id],
                href: viewHref(id),
                current: view() === id,
                onNavigate: () => selectView(id),
              }))}
            />
          }
          end={
            <>
              <Button variant="ghost" icon="search" label={t().searchTitle} keep onClick={() => void openSearch()} />
              <Button variant="primary" icon="plus" onClick={() => void composeTask()}>
                {t().newTask}
              </Button>
            </>
          }
        />
      }
      primary={{ label: t().newTask, icon: "plus", onClick: () => void composeTask() }}
    >
      <Pane.Split>
        <Pane label={t().myWork} scrollKey="spaces-overview-work">
          <Show
            when={activeWork()}
            fallback={
              <Show when={work.error()} fallback={<Loading rows={5} lines={2} />}>
                {(error) => <Failed text={`${t().workLoadFailed}: ${error().message}`} onRetry={() => void work.refresh()} />}
              </Show>
            }
          >
            {(current) => (
              <Show when={current().items.length > 0} fallback={<Empty icon="circle-check" text={`${emptyText()}. ${t().allCaughtUp}`} />}>
                <List label={viewLabel(view())}>
                  <For each={current().items}>
                    {(item) => (
                      <Row
                        // The item's kind on the colour of its Space.
                        mark={{ icon: item.startsAt ? "calendar-event" : "checkbox", color: item.spaceColor ?? undefined }}
                        lines={[item.title, item.spaceName]}
                        time={when(item)}
                        end={
                          item.priority ? (
                            item.priority === "urgent" || item.priority === "high" ? (
                              <Chip status={priorityStatus[item.priority]}>{priorityLabel(item.priority)}</Chip>
                            ) : (
                              <Chip>{priorityLabel(item.priority)}</Chip>
                            )
                          ) : undefined
                        }
                        href={`/app/spaces/${item.spaceShortId}?item=${item.shortId}`}
                      />
                    )}
                  </For>
                </List>
              </Show>
            )}
          </Show>
        </Pane>
        <Pane side label={t().activity} width={{ min: 300, default: 380 }} scrollKey="spaces-overview-activity">
          <Section icon="history" title={t().activity} summary={t().activityDescription}>
            <Show
              when={activityItems().length > 0}
              fallback={
                <Show
                  when={activityError()}
                  fallback={
                    <Show when={activity.loading()} fallback={<Empty icon="history" text={t().noActivityDescription} />}>
                      <Loading rows={6} lines={2} />
                    </Show>
                  }
                >
                  {(message) => <Failed text={`${t().couldNotLoadActivity}: ${message()}`} onRetry={reloadActivity} />}
                </Show>
              }
            >
              <Show when={activityError()}>
                {(message) => <Failed text={`${t().couldNotLoadActivity}: ${message()}`} onRetry={reloadActivity} />}
              </Show>
              <For each={activityItems()}>{(entry) => <ActivityRow entry={entry} />}</For>
              <Show when={pageError()}>{(message) => <Failed text={message()} onRetry={() => void loadMoreActivity()} />}</Show>
              <Show when={activity.hasMore() && !pageError()}>
                <Bar
                  end={
                    <Button busy={activity.loadingMore()} onClick={() => void loadMoreActivity()}>
                      {t().loadMore}
                    </Button>
                  }
                />
              </Show>
            </Show>
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
