import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import {
  type ActivityEntry,
  ActivityList,
  AppWorkspace,
  Button,
  DetailPanel,
  Dropdown,
  dialogCore,
  IconButton,
  LoadMore,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { setPinnedNotebookIds as writePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";
import { describeOverviewActivity, notebookActivityIcon } from "./activity-messages";
import { createNotebookCreation } from "./create-notebook-dialog";
import { notebooksPageMessages } from "./messages";
import { createNoteCommands } from "./note-commands";

type TemplateSummary = { id: string; name: string; description: string; icon: string };
type OverviewNotebook = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  noteCount: number;
  lastEditedAt: string | null;
};
type RecentNote = {
  id: string;
  notebookId: string;
  notebookName: string;
  notebookIcon: string | null;
  title: string;
  updatedAt: string;
};
type ActivityItem = {
  id: string;
  notebook: { id: string; name: string; icon: string | null };
  note: { id: string; title: string } | null;
  noteVersionId: string | null;
  actor: {
    kind: "user" | "service_account" | "system";
    id: string | null;
    displayName: string;
    avatarHash: string | null;
  };
  action: string;
  metadata: Record<string, unknown>;
  occurrenceCount: number;
  createdAt: string;
  lastOccurredAt: string;
};
type ActivityPage = { items: ActivityItem[]; nextCursor: string | null };
type Props = {
  notebooks: OverviewNotebook[];
  templates: TemplateSummary[];
  recentNotes: RecentNote[];
  initialActivity: ActivityPage;
  initialActivityError: string | null;
  initialPinnedNotebookIds: string[];
  dateConfig: DateContext;
  /** The server's time, so the server and the first browser render show the same activity times. */
  now: string;
};
type CreatedNotebook = { id: string };

/** The object list needs room for a title and a meta line; the overview does not resize. */
const OVERVIEW_LAYOUT = { version: 2 as const, sidebarWidth: 304 };

const errorMessage = async (response: Pick<Response, "json">, fallback: string) => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Keep the stable fallback.
  }
  return fallback;
};

const activityDescription = (item: ActivityItem, locale: string): string =>
  describeOverviewActivity(item.action, {
    locale,
    target: item.note ? (locale.startsWith("de") ? `„${item.note.title}“` : `“${item.note.title}”`) : item.notebook.name,
    notebook: item.notebook.name,
  });

const activityHref = (item: ActivityItem): string =>
  item.note ? `/app/notebooks/${item.notebook.id}/notes/${item.note.id}` : `/app/notebooks/${item.notebook.id}`;

export default function NotebooksOverview(props: Props) {
  createNoteCommands();
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const formatCount = (count: number) => count.toLocaleString(locale());
  const [pinnedNotebookIds, setPinnedNotebookIds] = createSignal(props.initialPinnedNotebookIds);
  const [pinAnnouncement, setPinAnnouncement] = createSignal("");
  const [initialActivityError, setInitialActivityError] = createSignal(props.initialActivityError);
  const orderedNotebooks = createMemo(() =>
    [...props.notebooks].sort((left, right) => {
      const leftIndex = pinnedNotebookIds().indexOf(left.id);
      const rightIndex = pinnedNotebookIds().indexOf(right.id);
      if (leftIndex === -1 && rightIndex === -1) return 0;
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }),
  );
  const notebookIsPinned = (notebookId: string) => pinnedNotebookIds().includes(notebookId);
  // A column of identical default icons says nothing; show icons only when at least one notebook chose its own.
  const showNotebookIcons = createMemo(() => props.notebooks.some((notebook) => notebook.icon));

  const toggleNotebookPin = (notebook: OverviewNotebook) => {
    setPinnedNotebookIds((current) => {
      const pinned = current.includes(notebook.id);
      const next = pinned ? current.filter((id) => id !== notebook.id) : [notebook.id, ...current];
      writePinnedNotebookIds(next);
      setPinAnnouncement(pinned ? t().unpinned({ name: notebook.name }) : t().pinned({ name: notebook.name }));
      return next;
    });
  };

  const activityResults = queries.createInfinite<string, ActivityPage, string>({
    source: () => "all-notebooks",
    initial: { source: "all-notebooks", pages: [props.initialActivity] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get({ query: { limit: "30", cursor } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, t().activityLoadFailed));
      const page = await response.json();
      setInitialActivityError(null);
      return { items: page.data, nextCursor: page.nextCursor };
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const activityItems = createMemo(() => activityResults.pages().flatMap((page) => page.items));
  // A failed older page keeps the loaded rows and says so at the list's end, where "Load more" was; any other failure
  // stands above the list (or alone without rows) with "Reload".
  const [failedPage, setFailedPage] = createSignal<Error | null>(null);
  const loadMoreActivity = async () => {
    const before = activityResults.error();
    await activityResults.loadMore();
    const after = activityResults.error();
    setFailedPage(after !== before ? after : null);
  };
  const pageError = () => {
    const failed = activityResults.error();
    return failed && failed === failedPage() ? failed.message : null;
  };
  const activityError = () => (pageError() ? null : (activityResults.error()?.message ?? initialActivityError()));

  const openNotebook = (notebook: CreatedNotebook) => navigateTo(`/app/notebooks/${notebook.id}`);

  const notebookCreation = createNotebookCreation(t);

  const createFromTemplateMutation = mutations.create<CreatedNotebook, { templateId: string; name?: string }>({
    mutation: async (input) => {
      const response = await apiClient.templates[":templateId"].$post({
        param: { templateId: input.templateId },
        json: { name: input.name?.trim() || undefined },
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFromTemplateFailed));
      return response.json();
    },
    onSuccess: openNotebook,
    onError: (error) => prompts.error(error.message),
  });

  const createBlank = notebookCreation.createBlank;

  const createFromTemplate = async (template: TemplateSummary) => {
    const result = await prompts.form({
      title: template.name,
      icon: template.icon,
      fields: { name: { type: "text", label: t().name, placeholder: template.name } },
      confirmText: t().create,
    });
    if (!result) return;
    createFromTemplateMutation.mutate({
      templateId: template.id,
      name: String(result.name ?? "").trim() || undefined,
    });
  };

  const createMenuItems = () => [
    {
      sectionLabel: t().start,
      items: [
        {
          label: t().blankNotebook,
          description: t().blankNotebookDescription,
          icon: "ti ti-plus",
          action: () => void createBlank(),
        },
      ],
    },
    {
      sectionLabel: t().templates,
      items: props.templates.map((template) => ({
        label: template.name,
        description: template.description,
        icon: template.icon,
        action: () => void createFromTemplate(template),
      })),
    },
  ];

  // The row links to the note or notebook; the actor and avatar start the sentence, "automatic" for the system.
  const activityEntries = (): ActivityEntry[] =>
    activityItems().map((item) => ({
      id: item.id,
      at: item.lastOccurredAt,
      icon: notebookActivityIcon(item.action),
      text: activityDescription(item, locale()),
      href: activityHref(item),
      actor: item.actor.kind === "system" ? null : item.actor.displayName,
      avatar: {
        name: item.actor.displayName,
        kind:
          item.actor.kind === "service_account"
            ? "service"
            : item.actor.kind === "user"
              ? item.actor.id
                ? "person"
                : "deleted"
              : "system",
        src:
          item.actor.kind === "user" && item.actor.id && item.actor.avatarHash
            ? `/api/accounts/users/${encodeURIComponent(item.actor.id)}/avatar?rev=${encodeURIComponent(item.actor.avatarHash)}`
            : undefined,
      },
    }));
  const reloadActivity = () => {
    setInitialActivityError(null);
    void activityResults.refresh();
  };
  const activityFeed = () => (
    <Show
      when={activityItems().length > 0}
      fallback={
        <Show
          when={activityError()}
          fallback={
            <Show when={activityResults.loading()} fallback={<ActivityList.Empty text={t().activityEmptyDescription} />}>
              <ActivityList.Loading label={t().loadingActivity} />
            </Show>
          }
        >
          {(message) => <ActivityList.Error text={`${t().couldNotLoadActivity}: ${message()}`} onReload={reloadActivity} />}
        </Show>
      }
    >
      <Show when={activityError()}>
        {(message) => (
          <div class="notebooks-overview-activity-alert">
            <ActivityList.Error text={`${t().couldNotLoadActivity}: ${message()}`} onReload={reloadActivity} />
          </div>
        )}
      </Show>
      <ActivityList
        entries={activityEntries()}
        now={props.now}
        dateConfig={props.dateConfig}
        label={t().recentActivity}
        more={activityResults.hasMore()}
      />
      <LoadMore
        hasMore={activityResults.hasMore()}
        onLoadMore={loadMoreActivity}
        auto={false}
        loading={activityResults.loadingMore()}
        error={pageError()}
        label={t().loadMore}
        loadingLabel={t().loadingMoreActivity}
      />
    </Show>
  );

  const openMobileActivity = () => {
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title={t().activity} subtitle={t().activityDescription} close={close} />
          <PanelDialog.Body>{activityFeed()}</PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogOptions,
    );
  };

  const openSearch = () => openGlobalSearch({ scope: { appId: "notebooks", label: t().notebooks, icon: "ti ti-notebook" } });

  onCleanup(() => {
    createFromTemplateMutation.abort();
  });

  return (
    <AppWorkspace mobileSurface="flush" flat class="notebooks-overview-workspace" resizable={false} layoutState={() => OVERVIEW_LAYOUT}>
      <h1 class="sr-only">{t().notebooks}</h1>
      {/* K6: the head names the place and holds Search and the one filled action, which opens the menu of ways to start. */}
      <AppWorkspace.Head
        views={<h2 class="notebooks-overview-title">{t().recentlyEdited}</h2>}
        actions={
          <>
            <Button type="button" variant="ghost" size="sm" class="notebooks-overview-head-action" onClick={() => void openSearch()}>
              <i class="ti ti-search" aria-hidden="true" /> <span class="notebooks-overview-head-label">{t().search}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="notebooks-overview-head-action notebooks-overview-mobile-activity"
              onClick={openMobileActivity}
            >
              <i class="ti ti-history" aria-hidden="true" /> <span class="notebooks-overview-head-label">{t().activity}</span>
            </Button>
          </>
        }
        primary={{ label: t().newNotebook, icon: "ti ti-plus", popup: "menu" }}
      />
      <Dropdown.Root
        items={createMenuItems()}
        align="end"
        width="min(38rem, calc(100vw - 1rem))"
        label={t().newNotebook}
        disabled={notebookCreation.loading() || createFromTemplateMutation.loading()}
        attach={() => document.querySelector<HTMLElement>(".notebooks-overview-workspace [data-workspace-primary]")}
      />
      <AppWorkspace.Sidebar label={t().notebooks} mobile="stacked" resizable={false}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey={false}>
            <AppWorkspace.SidebarSection title={t().notebooks} count={props.notebooks.length}>
              <For each={orderedNotebooks()}>
                {(notebook) => {
                  const pinned = () => notebookIsPinned(notebook.id);
                  return (
                    <AppWorkspace.SidebarItem
                      variant="object"
                      href={`/app/notebooks/${notebook.id}`}
                      title={notebook.description || notebook.name}
                      class="notebooks-overview-notebook"
                      data={{ pinned: pinned() ? "true" : undefined }}
                      description={
                        <Show when={notebook.lastEditedAt}>
                          {(lastEditedAt) => (
                            <time datetime={lastEditedAt()} title={dates.formatDateTime(lastEditedAt(), props.dateConfig)}>
                              {dates.formatDateTimeRelative(lastEditedAt(), props.dateConfig)}
                            </time>
                          )}
                        </Show>
                      }
                      actions={
                        <AppWorkspace.SidebarItemActions visibility="hover">
                          <IconButton
                            label={pinned() ? t().unpin({ name: notebook.name }) : t().pin({ name: notebook.name })}
                            tooltip={pinned() ? t().unpin({ name: notebook.name }) : t().pin({ name: notebook.name })}
                            size="xs"
                            variant="text"
                            aria-pressed={pinned()}
                            onClick={() => toggleNotebookPin(notebook)}
                          >
                            <i class={`ti ${pinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
                          </IconButton>
                        </AppWorkspace.SidebarItemActions>
                      }
                    >
                      <Show when={showNotebookIcons() || pinned()}>
                        <AppWorkspace.SidebarItemIcon icon={pinned() ? "ti ti-flag" : notebook.icon || "ti ti-notebook"} />
                      </Show>
                      <AppWorkspace.SidebarItemLabel>{notebook.name}</AppWorkspace.SidebarItemLabel>
                      <AppWorkspace.SidebarItemMeta>
                        <span class="notebooks-overview-count" data-zero={notebook.noteCount === 0 ? "true" : undefined}>
                          <span aria-hidden="true">{formatCount(notebook.noteCount)}</span>
                          <span class="sr-only">{t().noteCount({ count: notebook.noteCount })}</span>
                        </span>
                      </AppWorkspace.SidebarItemMeta>
                    </AppWorkspace.SidebarItem>
                  );
                }}
              </For>
            </AppWorkspace.SidebarSection>
            <span class="sr-only" aria-live="polite">
              {pinAnnouncement()}
            </span>
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="notebooks-overview-main">
          <Show
            when={props.recentNotes.length > 0}
            fallback={
              <Placeholder state="empty" title={t().noNotes} description={t().noNotesDescription} icon="ti ti-note" class="min-h-56" />
            }
          >
            <ol class="notebooks-overview-notes k2b-divided" aria-label={t().recentlyEdited}>
              <For each={props.recentNotes}>
                {(note) => (
                  <li>
                    <a href={`/app/notebooks/${note.notebookId}/notes/${note.id}`} class="notebooks-overview-note focus-ui">
                      <span class="notebooks-overview-note-icon k2b-icon-tile app-accent-text" aria-hidden="true">
                        <i class={note.notebookIcon || "ti ti-note"} />
                      </span>
                      <span class="notebooks-overview-note-copy">
                        <span class="notebooks-overview-note-title">{note.title}</span>
                        <span class="notebooks-overview-note-meta">
                          <i class="ti ti-notebook" aria-hidden="true" /> {note.notebookName}
                        </span>
                      </span>
                      <time
                        class="notebooks-overview-note-time"
                        datetime={note.updatedAt}
                        title={dates.formatDateTime(note.updatedAt, props.dateConfig)}
                      >
                        {dates.formatDateTimeRelative(note.updatedAt, props.dateConfig)}
                      </time>
                      <i class="ti ti-chevron-right notebooks-overview-note-chevron" aria-hidden="true" />
                    </a>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </AppWorkspace.Main>

        <AppWorkspace.Detail id="notebooks-overview-activity" open width="md" resizable={false} class="notebooks-overview-activity">
          <DetailPanel>
            <DetailPanel.Header title={t().activity} subtitle={t().activityDescription} />
            <DetailPanel.Body scrollPreserveKey="notebooks-overview-activity">{activityFeed()}</DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
