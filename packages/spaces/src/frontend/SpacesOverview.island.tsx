import { listenPopState, navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates, i18n } from "@k2b/stdlib";
import { mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Avatar,
  Button,
  ButtonLink,
  ColorInput,
  DetailPanel,
  Dropdown,
  dialogCore,
  IconButton,
  NoticeCard,
  openSpotlightSearch,
  PanelDialog,
  Paper,
  Placeholder,
  panelDialogOptions,
  prompts,
  TextInput,
  toast,
  useLocale,
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
  counts: { mine: number; today: number; upcoming: number };
  initialActivity: { items: ActivityItem[]; nextCursor: string | null };
  initialActivityError: string | null;
  dateConfig: DateContext;
};
type SpaceStarter = { id: string; name: string; description: string; icon: string; color: string };
type SpaceDraft = { name: string; description: string; color: string };

export const overviewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      taskBoard: "Task board",
      taskBoardDescription: "Plan work with lists, kanban, deadlines, and assignees.",
      eventCalendar: "Event calendar",
      eventCalendarDescription: "Coordinate dated events, all-day work, and schedules.",
      projectTracker: "Project tracker",
      projectTrackerDescription: "Track delivery across statuses, owners, and priorities.",
      blankSpace: "Blank space",
      blankSpaceDescription: "Start with only To Do and Done, then shape the workflow as needed.",
      adminNotice: "You are automatically the admin of this space. Access can be changed later in settings.",
      name: "Name",
      nameDescription: "A short name for this workspace",
      description: "Description",
      descriptionDescription: "Optional context shown on the space overview",
      color: "Color",
      colorDescription: "Used for cards, calendars, and visual identification",
      cancel: "Cancel",
      create: "Create",
      start: "Start",
      starters: "Starters",
      newSpace: "New space",
      createSpace: "Create Space",
      createFailed: "Failed to create space",
      created: "Space created",
      pinned: ({ name }: { name: string }) => `Pinned ${name}`,
      unpinned: ({ name }: { name: string }) => `Unpinned ${name}`,
      pin: ({ name }: { name: string }) => `Pin ${name}`,
      unpin: ({ name }: { name: string }) => `Unpin ${name}`,
      searchTitle: "Search Spaces",
      searchPlaceholder: "Search spaces, tasks, and events...",
      noSearchResults: "No Spaces results found.",
      searchFailed: "Spaces could not be searched. Try again.",
      space: "Space",
      activityLoadFailed: "Failed to load Spaces activity",
      couldNotLoadActivity: "Could not load activity",
      retry: "Retry",
      loadingActivity: "Loading activity",
      noActivity: "No activity yet",
      noActivityDescription: "Space and item changes will appear here.",
      recentActivity: "Recent Spaces activity",
      loadingMoreActivity: "Loading more activity",
      loadMore: "Load more",
      activity: "Activity",
      activityDescription: "Recent changes across your Spaces.",
      nothingAssigned: "Nothing assigned to you",
      nothingToday: "Nothing due today",
      nothingUpcoming: "No upcoming work",
      allCaughtUp: "You are all caught up.",
      overviewDescription: "Open a workspace or find work across every Space you can access.",
      search: "Search",
      myWork: "My work",
      myWorkDescription: "Tasks and events that need attention across your Spaces.",
      workView: "Spaces work view",
      forMe: "For me",
      today: "Today",
      upcoming: "Upcoming",
      urgent: "Urgent",
      high: "High",
      medium: "Medium",
      low: "Low",
      activityCreatedSpace: ({ space }: { space: string }) => `Created ${space}`,
      activityUpdatedSpace: ({ space }: { space: string }) => `Updated ${space}`,
      activityCreatedTask: ({ title, space }: { title: string; space: string }) => `Created “${title}” in ${space}`,
      activityCreatedEvent: ({ title, space }: { title: string; space: string }) => `Created event “${title}” in ${space}`,
      activityUpdatedTask: ({ title, space }: { title: string; space: string }) => `Updated “${title}” in ${space}`,
      activityUpdatedEvent: ({ title, space }: { title: string; space: string }) => `Updated event “${title}” in ${space}`,
      activityCompletedTask: ({ title, space }: { title: string; space: string }) => `Completed “${title}” in ${space}`,
      activityReopenedTask: ({ title, space }: { title: string; space: string }) => `Reopened “${title}” in ${space}`,
      activityCompletedEvent: ({ title, space }: { title: string; space: string }) => `Completed event “${title}” in ${space}`,
      activityReopenedEvent: ({ title, space }: { title: string; space: string }) => `Reopened event “${title}” in ${space}`,
      activityDeletedTask: ({ title, space }: { title: string; space: string }) => `Deleted task “${title}” from ${space}`,
      activityDeletedEvent: ({ title, space }: { title: string; space: string }) => `Deleted event “${title}” from ${space}`,
      activityClaimed: ({ title, space }: { title: string; space: string }) => `Claimed “${title}” in ${space}`,
      activityReleased: ({ title, space }: { title: string; space: string }) => `Released “${title}” in ${space}`,
      activityProgress: ({ title, space }: { title: string; space: string }) => `Updated progress on “${title}” in ${space}`,
      activityMoved: ({ title, space }: { title: string; space: string }) => `Moved “${title}” in ${space}`,
      activityCommented: ({ title, space }: { title: string; space: string }) => `Commented on “${title}” in ${space}`,
      activityAssignees: ({ title, space }: { title: string; space: string }) => `Changed assignees for “${title}” in ${space}`,
      activityTags: ({ title, space }: { title: string; space: string }) => `Changed tags for “${title}” in ${space}`,
      activityCommentUpdated: ({ title, space }: { title: string; space: string }) => `Updated a comment on “${title}” in ${space}`,
      activityCommentDeleted: ({ title, space }: { title: string; space: string }) => `Deleted a comment from “${title}” in ${space}`,
      activityChecklistCreated: ({ title, space }: { title: string; space: string }) => `Added a subtask to “${title}” in ${space}`,
      activityChecklistUpdated: ({ title, space }: { title: string; space: string }) => `Updated a subtask on “${title}” in ${space}`,
      activityChecklistCompleted: ({ title, space }: { title: string; space: string }) => `Completed a subtask on “${title}” in ${space}`,
      activityChecklistReopened: ({ title, space }: { title: string; space: string }) => `Reopened a subtask on “${title}” in ${space}`,
      activityChecklistDeleted: ({ title, space }: { title: string; space: string }) => `Deleted a subtask from “${title}” in ${space}`,
      activityOther: ({ action, space }: { action: string; space: string }) => `${action} in ${space}`,
    },
    de: {
      taskBoard: "Aufgabenboard",
      taskBoardDescription: "Aufgaben in Listen oder auf einem Kanban-Board mit Fristen und Zuständigkeiten planen.",
      eventCalendar: "Veranstaltungskalender",
      eventCalendarDescription: "Termine, ganztägige Ereignisse und Zeitpläne koordinieren.",
      projectTracker: "Projektübersicht",
      projectTrackerDescription: "Projektfortschritt nach Status, Zuständigkeit und Priorität verfolgen.",
      blankSpace: "Leerer Space",
      blankSpaceDescription: "Mit den Status „Offen“ und „Erledigt“ beginnen und den Ablauf später anpassen.",
      adminNotice: "Du verwaltest diesen Space zunächst selbst. Den Zugriff kannst du später in den Einstellungen ändern.",
      name: "Name",
      nameDescription: "Kurzer Name für diesen Arbeitsbereich",
      description: "Beschreibung",
      descriptionDescription: "Optionale Informationen für die Space-Übersicht",
      color: "Farbe",
      colorDescription: "Kennzeichnet Karten, Kalendereinträge und den Space",
      cancel: "Abbrechen",
      create: "Erstellen",
      start: "Neu beginnen",
      starters: "Vorlagen",
      newSpace: "Neuer Space",
      createSpace: "Space erstellen",
      createFailed: "Der Space konnte nicht erstellt werden",
      created: "Space erstellt",
      pinned: ({ name }) => `${name} angeheftet`,
      unpinned: ({ name }) => `${name} nicht mehr angeheftet`,
      pin: ({ name }) => `${name} anheften`,
      unpin: ({ name }) => `${name} lösen`,
      searchTitle: "Spaces durchsuchen",
      searchPlaceholder: "Spaces, Aufgaben und Termine durchsuchen...",
      noSearchResults: "Keine Ergebnisse in Spaces gefunden.",
      searchFailed: "Spaces konnte nicht durchsucht werden. Versuche es erneut.",
      space: "Space",
      activityLoadFailed: "Die Aktivitäten konnten nicht geladen werden",
      couldNotLoadActivity: "Aktivitäten konnten nicht geladen werden",
      retry: "Erneut versuchen",
      loadingActivity: "Aktivitäten werden geladen",
      noActivity: "Noch keine Aktivitäten",
      noActivityDescription: "Änderungen an Spaces und Einträgen erscheinen hier.",
      recentActivity: "Letzte Aktivitäten in Spaces",
      loadingMoreActivity: "Weitere Aktivitäten werden geladen",
      loadMore: "Mehr laden",
      activity: "Aktivitäten",
      activityDescription: "Letzte Änderungen in deinen Spaces.",
      nothingAssigned: "Dir ist nichts zugewiesen",
      nothingToday: "Heute ist nichts fällig",
      nothingUpcoming: "Keine anstehenden Aufgaben oder Termine",
      allCaughtUp: "Alles erledigt.",
      overviewDescription: "Öffne einen Arbeitsbereich oder finde Aufgaben und Termine in deinen Spaces.",
      search: "Suchen",
      myWork: "Meine Arbeit",
      myWorkDescription: "Aufgaben und Termine, die deine Aufmerksamkeit erfordern.",
      workView: "Ansicht für meine Arbeit",
      forMe: "Für mich",
      today: "Heute",
      upcoming: "Anstehend",
      urgent: "Dringend",
      high: "Hoch",
      medium: "Mittel",
      low: "Niedrig",
      activityCreatedSpace: ({ space }) => `${space} erstellt`,
      activityUpdatedSpace: ({ space }) => `${space} aktualisiert`,
      activityCreatedTask: ({ title, space }) => `„${title}“ in ${space} erstellt`,
      activityCreatedEvent: ({ title, space }) => `Termin „${title}“ in ${space} erstellt`,
      activityUpdatedTask: ({ title, space }) => `„${title}“ in ${space} aktualisiert`,
      activityUpdatedEvent: ({ title, space }) => `Termin „${title}“ in ${space} aktualisiert`,
      activityCompletedTask: ({ title, space }) => `„${title}“ in ${space} erledigt`,
      activityReopenedTask: ({ title, space }) => `„${title}“ in ${space} wieder geöffnet`,
      activityCompletedEvent: ({ title, space }) => `Termin „${title}“ in ${space} abgeschlossen`,
      activityReopenedEvent: ({ title, space }) => `Termin „${title}“ in ${space} wieder geöffnet`,
      activityDeletedTask: ({ title, space }) => `Aufgabe „${title}“ aus ${space} gelöscht`,
      activityDeletedEvent: ({ title, space }) => `Termin „${title}“ aus ${space} gelöscht`,
      activityClaimed: ({ title, space }) => `„${title}“ in ${space} übernommen`,
      activityReleased: ({ title, space }) => `„${title}“ in ${space} freigegeben`,
      activityProgress: ({ title, space }) => `Fortschritt zu „${title}“ in ${space} festgehalten`,
      activityMoved: ({ title, space }) => `„${title}“ in ${space} verschoben`,
      activityCommented: ({ title, space }) => `„${title}“ in ${space} kommentiert`,
      activityAssignees: ({ title, space }) => `Zuständigkeit für „${title}“ in ${space} geändert`,
      activityTags: ({ title, space }) => `Tags für „${title}“ in ${space} geändert`,
      activityCommentUpdated: ({ title, space }) => `Kommentar zu „${title}“ in ${space} aktualisiert`,
      activityCommentDeleted: ({ title, space }) => `Kommentar zu „${title}“ in ${space} gelöscht`,
      activityChecklistCreated: ({ title, space }) => `Unteraufgabe zu „${title}“ in ${space} hinzugefügt`,
      activityChecklistUpdated: ({ title, space }) => `Unteraufgabe zu „${title}“ in ${space} aktualisiert`,
      activityChecklistCompleted: ({ title, space }) => `Unteraufgabe zu „${title}“ in ${space} erledigt`,
      activityChecklistReopened: ({ title, space }) => `Unteraufgabe zu „${title}“ in ${space} wieder geöffnet`,
      activityChecklistDeleted: ({ title, space }) => `Unteraufgabe aus „${title}“ in ${space} gelöscht`,
      activityOther: ({ action, space }) => `${action} in ${space}`,
    },
  },
});

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
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
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
        {t.adminNotice}
      </NoticeCard>
      <TextInput
        label={t.name}
        description={t.nameDescription}
        placeholder={props.starter.name}
        icon="ti ti-typography"
        value={name}
        onValueChange={setName}
        required
      />
      <TextInput
        label={t.description}
        description={t.descriptionDescription}
        placeholder={props.starter.description}
        icon="ti ti-align-left"
        value={description}
        onValueChange={setDescription}
        multiline
        lines={3}
      />
      <ColorInput label={t.color} description={t.colorDescription} value={color} onValueChange={setColor} />
      <div class="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm">
          {t.create}
        </Button>
      </div>
    </form>
  );
}

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
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const localizeStarter = (starter: SpaceStarter): SpaceStarter => ({
    ...starter,
    name:
      starter.id === "tasks"
        ? t.taskBoard
        : starter.id === "calendar"
          ? t.eventCalendar
          : starter.id === "project"
            ? t.projectTracker
            : t.blankSpace,
    description:
      starter.id === "tasks"
        ? t.taskBoardDescription
        : starter.id === "calendar"
          ? t.eventCalendarDescription
          : starter.id === "project"
            ? t.projectTrackerDescription
            : t.blankSpaceDescription,
  });
  const localizedStarters = starters.map(localizeStarter);
  const localizedBlankStarter = localizeStarter(blankStarter);
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
      if (!response.ok) throw new Error(await readResponseError(response, t.createFailed));
      return { space: await response.json(), starter };
    },
    onSuccess: ({ space, starter }) => {
      toast.success(t.created);
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
        title: starter.id === "blank" ? t.newSpace : starter.name,
        icon: starter.icon,
      });
      if (draft) void createSpaceMutation.mutate({ starter, draft });
    } finally {
      setDialogPending(false);
    }
  };
  const createMenuItems = () => [
    {
      sectionLabel: t.start,
      items: [
        {
          label: localizedBlankStarter.name,
          description: localizedBlankStarter.description,
          icon: localizedBlankStarter.icon,
          action: () => void createSpace(localizedBlankStarter),
        },
      ],
    },
    {
      sectionLabel: t.starters,
      items: localizedStarters.map((starter) => ({
        label: starter.name,
        description: starter.description,
        icon: starter.icon,
        action: () => void createSpace(starter),
      })),
    },
  ];

  const workViews = ["mine", "today", "upcoming"] as const;
  const viewHref = (next: OverviewView) => (next === "mine" ? "/app/spaces" : `/app/spaces?view=${next}`);
  onMount(() => {
    onCleanup(
      listenPopState(({ url }) => {
        const value = url.searchParams.get("view");
        setView(value === "today" || value === "upcoming" ? value : "mine");
      }),
    );
  });
  const togglePin = (space: Space) =>
    setPinned((current) => {
      const isPinned = current.includes(space.id);
      const next = isPinned ? current.filter((id) => id !== space.id) : [space.id, ...current];
      setPinnedSpaceIds(next);
      setPinAnnouncement(isPinned ? t.unpinned({ name: space.name }) : t.pinned({ name: space.name }));
      return next;
    });

  const openSearch = async () => {
    const selected = await openSpotlightSearch<{ href: string }>({
      title: t.searchTitle,
      icon: "ti ti-search",
      placeholder: t.searchPlaceholder,
      minQueryLength: 1,
      noResultsText: t.noSearchResults,
      resolve: async ({ query, abortSignal }) => {
        const term = query.trim();
        const normalized = term.toLowerCase();
        const spaces = props.spaces
          .filter((space) => `${space.name} ${space.description ?? ""}`.toLowerCase().includes(normalized))
          .slice(0, 8)
          .map((space) => ({
            value: { href: `/app/spaces/${space.id}` },
            label: space.name,
            desc: space.description ?? t.space,
            icon: "ti ti-layout-kanban",
          }));
        const response = await apiClient.overview.search.$get({ query: { q: term, limit: "20" } }, { init: { signal: abortSignal } });
        if (!response.ok) throw new Error(t.searchFailed);
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
          state="empty"
          title={view() === "mine" ? t.nothingAssigned : view() === "today" ? t.nothingToday : t.nothingUpcoming}
          description={t.allCaughtUp}
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
                <p>{t.overviewDescription}</p>
              </div>
              <div class="spaces-overview-actions">
                <Button variant="secondary" size="sm" onClick={() => void openSearch()}>
                  <i class="ti ti-search" aria-hidden="true" /> {t.search}
                </Button>
                <Button variant="secondary" size="sm" class="spaces-overview-mobile-activity" onClick={openMobileActivity}>
                  <i class="ti ti-history" aria-hidden="true" /> {t.activity}
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
                        label={isPinned() ? t.unpin({ name: space.name }) : t.pin({ name: space.name })}
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
              <Dropdown.Root items={createMenuItems()} position="bottom-right" width="min(38rem, calc(100vw - 1rem))" label={t.createSpace}>
                <Dropdown.Trigger variant="secondary" size="sm" disabled={createSpaceMutation.loading()}>
                  <i class="ti ti-plus app-accent-text" aria-hidden="true" /> {t.newSpace}
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
                <h2 id="spaces-work-title">{t.myWork}</h2>
                <p>{t.myWorkDescription}</p>
              </div>
            </div>
            <nav aria-label={t.workView} class="flex gap-2 overflow-x-auto">
              <For each={workViews}>
                {(next) => (
                  <ButtonLink
                    href={viewHref(next)}
                    navigation="enhanced"
                    variant={view() === next ? "subtle" : "text"}
                    size="sm"
                    aria-current={view() === next ? "page" : undefined}
                    onNavigate={(event) => {
                      if (view() === next) return;
                      setView(next);
                      event.push(viewHref(next), { scroll: "preserve" });
                    }}
                  >
                    {next === "mine" ? t.forMe : next === "today" ? t.today : t.upcoming}
                    <span class="spaces-overview-tab-count">{props.counts[next]}</span>
                  </ButtonLink>
                )}
              </For>
            </nav>
            {workList()}
          </section>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="spaces-overview-activity" open width="lg" resizable={false} class="spaces-overview-activity">
          <DetailPanel>
            <DetailPanel.Header title={t.activity} subtitle={t.activityDescription} />
            <DetailPanel.Body scrollPreserveKey="spaces-overview-activity">{activityFeed()}</DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
