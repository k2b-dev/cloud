import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Avatar,
  Button,
  ButtonLink,
  ColorInput,
  DetailPanel,
  dialogCore,
  Dropdown,
  IconButton,
  NoticeCard,
  openSpotlightSearch,
  PanelDialog,
  panelDialogOptions,
  Paper,
  Placeholder,
  prompts,
  StatCell,
  StatGrid,
  Tabs,
  TextInput,
  toast,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Space } from "@/contracts";
import { setLastSpaceId, setPinnedSpaceIds, type ViewType, writeSpaceSettings } from "./[id]/_components/settings/SpaceSettingsStore";
import { readResponseError } from "./lib/response";

type OverviewView = "mine" | "today" | "upcoming";
type WorkItem = {
  id: string;
  shortId: string;
  spaceId: string;
  spaceShortId: string;
  spaceName: string;
  spaceColor: string | null;
  title: string;
  priority: "low" | "medium" | "high" | "urgent" | null;
  startsAt?: string | null;
  endsAt?: string | null;
  deadline: string | null;
};
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
  spaces: Space[];
  initialView: OverviewView;
  initialPinnedSpaceIds: string[];
  mine: WorkItem[];
  today: WorkItem[];
  upcoming: WorkItem[];
  counts: { mine: number; today: number; upcoming: number; open: number; urgent: number };
  initialActivity: { items: ActivityItem[]; nextCursor: string | null };
  initialActivityError: string | null;
  dateConfig: DateContext;
};
type SpaceStarter = { id: string; name: string; description: string; icon: string; color: string };
type SpaceDraft = { name: string; description: string; color: string };

const starterView: Record<string, ViewType> = { blank: "list", tasks: "kanban", calendar: "calendar", project: "table" };
const starters: SpaceStarter[] = [
  {
    id: "tasks",
    name: "Task board",
    description: "Plan work with lists, kanban, deadlines, and assignees.",
    icon: "ti ti-list-check",
    color: "#3b82f6",
  },
  {
    id: "calendar",
    name: "Event calendar",
    description: "Coordinate dated events, all-day work, and schedules.",
    icon: "ti ti-calendar-event",
    color: "#8b5cf6",
  },
  {
    id: "project",
    name: "Project tracker",
    description: "Track delivery across statuses, owners, and priorities.",
    icon: "ti ti-flag",
    color: "#10b981",
  },
];
const blankStarter: SpaceStarter = {
  id: "blank",
  name: "Blank space",
  description: "Start with only To Do and Done, then shape the workflow as needed.",
  icon: "ti ti-plus",
  color: "#3b82f6",
};

function CreateSpaceForm(props: { starter: SpaceStarter; close: (value: SpaceDraft | null) => void }) {
  const [name, setName] = createSignal(props.starter.id === "blank" ? "" : props.starter.name);
  const [description, setDescription] = createSignal(props.starter.id === "blank" ? "" : props.starter.description);
  const [color, setColor] = createSignal(props.starter.color);
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name().trim()) props.close({ name: name().trim(), description: description().trim(), color: color() });
      }}
    >
      <NoticeCard tone="info" icon={false}>
        You are automatically the admin of this space. Access can be changed later in settings.
      </NoticeCard>
      <TextInput
        label="Name"
        description="A short name for this workspace"
        placeholder={props.starter.name}
        icon="ti ti-typography"
        value={name}
        onValueChange={setName}
        required
      />
      <TextInput
        label="Description"
        description="Optional context shown on the space overview"
        placeholder={props.starter.description}
        icon="ti ti-align-left"
        value={description}
        onValueChange={setDescription}
        multiline
        lines={3}
      />
      <ColorInput label="Color" description="Used for cards, calendars, and visual identification" value={color} onValueChange={setColor} />
      <div class="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Create
        </Button>
      </div>
    </form>
  );
}

const activityDescription = (entry: ActivityItem) => {
  const title = entry.item?.title ?? String(entry.metadata.itemTitle ?? entry.space.name);
  const labels: Record<string, string> = {
    "space.created": `Created ${entry.space.name}`,
    "space.updated": `Updated ${entry.space.name}`,
    "task.created": `Created “${title}” in ${entry.space.name}`,
    "event.created": `Created event “${title}” in ${entry.space.name}`,
    "task.updated": `Updated “${title}” in ${entry.space.name}`,
    "event.updated": `Updated event “${title}” in ${entry.space.name}`,
    "task.completed": `Completed “${title}” in ${entry.space.name}`,
    "task.reopened": `Reopened “${title}” in ${entry.space.name}`,
    "event.completed": `Completed event “${title}” in ${entry.space.name}`,
    "event.reopened": `Reopened event “${title}” in ${entry.space.name}`,
    "task.deleted": `Deleted task “${title}” from ${entry.space.name}`,
    "event.deleted": `Deleted event “${title}” from ${entry.space.name}`,
    "item.moved": `Moved “${title}” in ${entry.space.name}`,
    "comment.created": `Commented on “${title}” in ${entry.space.name}`,
    "item.assignees.updated": `Changed assignees for “${title}” in ${entry.space.name}`,
    "item.tags.updated": `Changed tags for “${title}” in ${entry.space.name}`,
    "comment.updated": `Updated a comment on “${title}” in ${entry.space.name}`,
    "comment.deleted": `Deleted a comment from “${title}” in ${entry.space.name}`,
  };
  return labels[entry.action] ?? `${entry.action.replaceAll(".", " ")} in ${entry.space.name}`;
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
  const [view, setView] = createSignal<OverviewView>(props.initialView);
  const [pinned, setPinned] = createSignal(props.initialPinnedSpaceIds);
  const [pinAnnouncement, setPinAnnouncement] = createSignal("");
  const [dialogPending, setDialogPending] = createSignal(false);
  const [initialActivityError, setInitialActivityError] = createSignal(props.initialActivityError);
  const orderedSpaces = createMemo(() =>
    [...props.spaces].sort((left, right) => {
      const a = pinned().indexOf(left.id);
      const b = pinned().indexOf(right.id);
      if (a === -1 && b === -1) return 0;
      if (a === -1) return 1;
      if (b === -1) return -1;
      return a - b;
    }),
  );
  const workItems = () => (view() === "mine" ? props.mine : view() === "today" ? props.today : props.upcoming);

  const activity = queries.createInfinite<string, ActivityPage, string>({
    source: () => "spaces",
    initial: { source: "spaces", pages: [{ data: props.initialActivity.items, nextCursor: props.initialActivity.nextCursor }] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get(
        { query: { limit: "30", ...(cursor ? { cursor } : {}) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to load Spaces activity"));
      setInitialActivityError(null);
      return response.json();
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const activityItems = createMemo(() => activity.pages().flatMap((page) => page.data));
  const activityError = () => activity.error()?.message ?? initialActivityError();

  const createSpaceMutation = mutations.create<{ space: Space; starter: SpaceStarter }, { starter: SpaceStarter; draft: SpaceDraft }>({
    mutation: async ({ starter, draft }) => {
      const response = await apiClient.index.$post({
        json: {
          name: draft.name,
          description: draft.description || undefined,
          color: draft.color,
          starter: starter.id as "blank" | "tasks" | "calendar" | "project",
        },
      });
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to create space"));
      return { space: await response.json(), starter };
    },
    onSuccess: ({ space, starter }) => {
      toast.success("Space created");
      setLastSpaceId(space.id);
      writeSpaceSettings(space.id, { view: starterView[starter.id] });
      navigateTo(`/app/spaces/${space.id}`);
    },
    onError: (error) => prompts.error(error.message),
  });
  const createSpace = async (starter: SpaceStarter) => {
    if (dialogPending() || createSpaceMutation.loading()) return;
    setDialogPending(true);
    try {
      const draft = await prompts.dialog<SpaceDraft | null>((close) => <CreateSpaceForm starter={starter} close={close} />, {
        title: starter.id === "blank" ? "New space" : starter.name,
        icon: starter.icon,
      });
      if (draft) void createSpaceMutation.mutate({ starter, draft });
    } finally {
      setDialogPending(false);
    }
  };
  const createMenuItems = () => [
    {
      sectionLabel: "Start",
      items: [
        {
          label: "Blank space",
          description: blankStarter.description,
          icon: blankStarter.icon,
          action: () => void createSpace(blankStarter),
        },
      ],
    },
    {
      sectionLabel: "Starters",
      items: starters.map((starter) => ({
        label: starter.name,
        description: starter.description,
        icon: starter.icon,
        action: () => void createSpace(starter),
      })),
    },
  ];

  const selectView = (next: OverviewView) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "mine") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.pushState({}, "", url);
  };
  onMount(() => {
    const restore = () => {
      const value = new URL(window.location.href).searchParams.get("view");
      setView(value === "today" || value === "upcoming" ? value : "mine");
    };
    window.addEventListener("popstate", restore);
    onCleanup(() => window.removeEventListener("popstate", restore));
  });
  const togglePin = (space: Space) =>
    setPinned((current) => {
      const isPinned = current.includes(space.id);
      const next = isPinned ? current.filter((id) => id !== space.id) : [space.id, ...current];
      setPinnedSpaceIds(next);
      setPinAnnouncement(`${isPinned ? "Unpinned" : "Pinned"} ${space.name}`);
      return next;
    });

  const openSearch = async () => {
    const selected = await openSpotlightSearch<{ href: string }>({
      title: "Search Spaces",
      icon: "ti ti-search",
      placeholder: "Search spaces, tasks, and events...",
      minQueryLength: 1,
      noResultsText: "No Spaces results found.",
      resolve: async ({ query, abortSignal }) => {
        const term = query.trim();
        const normalized = term.toLowerCase();
        const spaces = props.spaces
          .filter((space) => `${space.name} ${space.description ?? ""}`.toLowerCase().includes(normalized))
          .slice(0, 8)
          .map((space) => ({
            value: { href: `/app/spaces/${space.id}` },
            label: space.name,
            desc: space.description ?? "Space",
            icon: "ti ti-layout-kanban",
          }));
        const response = await apiClient.overview.search.$get({ query: { q: term, limit: "20" } }, { init: { signal: abortSignal } });
        if (!response.ok) throw new Error("Spaces could not be searched. Try again.");
        const hits = await response.json();
        return [
          ...spaces,
          ...hits.map((hit) => ({
            value: { href: `/app/spaces/${hit.space.id}?item=${hit.item.id}` },
            label: `${hit.item.title} · ${hit.space.name}`,
            desc: hit.item.description ?? undefined,
            icon: hit.item.startsAt && hit.item.endsAt ? "ti ti-calendar-event" : "ti ti-checkbox",
          })),
        ];
      },
    });
    if (selected?.value) navigateTo(selected.value.href);
  };

  const activityFeed = () => (
    <Show
      when={!activityError()}
      fallback={
        <Placeholder
          state="error"
          title="Could not load activity"
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
              <i class="ti ti-refresh" aria-hidden="true" /> Retry
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
            title={activity.loading() ? "Loading activity" : "No activity yet"}
            description={activity.loading() ? undefined : "Space and item changes will appear here."}
            icon="ti ti-history"
          />
        }
      >
        <ol class="spaces-overview-activity-list" aria-label="Recent Spaces activity">
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
                <Paper
                  as="a"
                  href={entry.item ? `/app/spaces/${entry.space.id}?item=${entry.item.id}` : `/app/spaces/${entry.space.id}`}
                  interactive
                  class="spaces-overview-activity-paper"
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
                </Paper>
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
            loadingLabel="Loading more activity"
            onClick={() => void activity.loadMore()}
          >
            Load more
          </Button>
        </Show>
      </Show>
    </Show>
  );
  const openMobileActivity = () =>
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title="Activity" subtitle="Recent changes across your Spaces." close={close} />
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
          state="empty"
          title={view() === "mine" ? "Nothing assigned to you" : view() === "today" ? "Nothing due today" : "No upcoming work"}
          description="You are all caught up."
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
                <span class={`spaces-overview-priority is-${item.priority}`}>{item.priority}</span>
              </Show>
              <Show when={item.startsAt || item.deadline}>
                <time datetime={item.startsAt ?? item.deadline ?? undefined}>
                  {dates.formatDateTimeRelative(item.startsAt ?? item.deadline!, props.dateConfig)}
                </time>
              </Show>
              <i class="ti ti-chevron-right text-dimmed" aria-hidden="true" />
            </a>
          )}
        </For>
      </div>
    </Show>
  );

  onCleanup(() => createSpaceMutation.abort());
  return (
    <AppWorkspace class="spaces-overview-workspace" resizable={false}>
      <h1 class="sr-only">Spaces</h1>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="spaces-overview-main">
          <header class="spaces-overview-spaces">
            <div class="spaces-overview-heading">
              <div>
                <h2>Spaces</h2>
                <p>Open a workspace or find work across every Space you can access.</p>
              </div>
              <div class="spaces-overview-actions">
                <Button variant="secondary" size="sm" onClick={() => void openSearch()}>
                  <i class="ti ti-search" aria-hidden="true" /> Search
                </Button>
                <Button variant="secondary" size="sm" class="spaces-overview-mobile-activity" onClick={openMobileActivity}>
                  <i class="ti ti-history" aria-hidden="true" /> Activity
                </Button>
              </div>
            </div>
            <nav class="spaces-overview-space-list" aria-label="Spaces">
              <For each={orderedSpaces()}>
                {(space) => {
                  const isPinned = () => pinned().includes(space.id);
                  return (
                    <span class="spaces-overview-space-item" data-pinned={isPinned() ? "true" : undefined}>
                      <ButtonLink
                        href={`/app/spaces/${space.id}`}
                        variant="secondary"
                        size="sm"
                        class="spaces-overview-space-button"
                        title={space.description || space.name}
                      >
                        <span class="spaces-overview-space-dot" style={{ "background-color": space.color }} />
                        <i class={`ti ${isPinned() ? "ti-flag" : "ti-layout-kanban"} app-accent-text`} aria-hidden="true" />
                        <span class="spaces-overview-space-name">{space.name}</span>
                      </ButtonLink>
                      <IconButton
                        label={`${isPinned() ? "Unpin" : "Pin"} ${space.name}`}
                        size="xs"
                        variant="text"
                        class="spaces-overview-space-pin"
                        aria-pressed={isPinned()}
                        onClick={() => togglePin(space)}
                      >
                        <i class={`ti ${isPinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
                      </IconButton>
                    </span>
                  );
                }}
              </For>
              <Dropdown.Root items={createMenuItems()} position="bottom-right" width="min(38rem, calc(100vw - 1rem))" label="Create Space">
                <Dropdown.Trigger variant="secondary" size="sm" disabled={createSpaceMutation.loading()}>
                  <i class="ti ti-plus app-accent-text" aria-hidden="true" /> New space
                  <i class="ti ti-chevron-down" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </nav>
            <span class="sr-only" aria-live="polite">
              {pinAnnouncement()}
            </span>
          </header>
          <section class="spaces-overview-focus" aria-labelledby="spaces-work-title">
            <div class="spaces-overview-heading">
              <div>
                <h2 id="spaces-work-title">My work</h2>
                <p>Tasks and events that need attention across your Spaces.</p>
              </div>
            </div>
            <StatGrid columns={3} size="sm" class="spaces-overview-stats">
              <StatCell label="Open work" value={props.counts.open} />
              <StatCell label="Assigned to me" value={props.counts.mine} />
              <StatCell
                label="Urgent"
                value={props.counts.urgent}
                accent={props.counts.urgent > 0 ? { tone: "amber", icon: "ti ti-alert-circle" } : undefined}
              />
            </StatGrid>
            <Tabs<OverviewView> ariaLabel="Spaces work view" value={view} onValueChange={selectView}>
              <Tabs.Item
                value="mine"
                label={
                  <>
                    For me <span class="spaces-overview-tab-count">{props.counts.mine}</span>
                  </>
                }
              >
                {workList()}
              </Tabs.Item>
              <Tabs.Item
                value="today"
                label={
                  <>
                    Today <span class="spaces-overview-tab-count">{props.counts.today}</span>
                  </>
                }
              >
                {workList()}
              </Tabs.Item>
              <Tabs.Item
                value="upcoming"
                label={
                  <>
                    Upcoming <span class="spaces-overview-tab-count">{props.counts.upcoming}</span>
                  </>
                }
              >
                {workList()}
              </Tabs.Item>
            </Tabs>
          </section>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="spaces-overview-activity" open width="lg" resizable={false} class="spaces-overview-activity">
          <DetailPanel>
            <DetailPanel.Header title="Activity" subtitle="Recent changes across your Spaces." />
            <DetailPanel.Body scrollPreserveKey="spaces-overview-activity">{activityFeed()}</DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
