import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Avatar,
  Button,
  DetailPanel,
  Dropdown,
  dialogCore,
  IconButton,
  PanelDialog,
  PanelHeader,
  Paper,
  Placeholder,
  panelDialogOptions,
  prompts,
  Tag,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { setLastNotebookId, setPinnedNotebookIds as writePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";
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
  shared: boolean;
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
};
type CreatedNotebook = { id: string };

const errorMessage = async (response: Pick<Response, "json">, fallback: string) => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Keep the stable fallback.
  }
  return fallback;
};

const activityDescription = (item: ActivityItem, t: ReturnType<(typeof notebooksPageMessages)["resolve"]>["t"]): string => {
  const target = item.note ? `“${item.note.title}”` : item.notebook.name;
  switch (item.action) {
    case "note.created":
      return t.activityCreatedNote({ target, notebook: item.notebook.name });
    case "note.deleted":
      return t.activityDeletedNote({ notebook: item.notebook.name });
    case "note.restored":
      return t.activityRestoredNote({ target, notebook: item.notebook.name });
    case "note.edited":
      return t.activityEditedNote({ target, notebook: item.notebook.name });
    case "comment.created":
      return t.activityCommentedNote({ target, notebook: item.notebook.name });
    case "comment.updated":
      return t.activityUpdatedComment({ target, notebook: item.notebook.name });
    case "comment.deleted":
      return t.activityDeletedComment({ target, notebook: item.notebook.name });
    case "notebook.created":
      return t.activityCreatedNotebook({ notebook: item.notebook.name });
    case "notebook.updated":
      return t.activityUpdatedNotebook({ notebook: item.notebook.name });
    default:
      return t.activityUnknown({ action: item.action.replaceAll(".", " "), notebook: item.notebook.name });
  }
};

const activityHref = (item: ActivityItem): string =>
  item.note ? `/app/notebooks/${item.notebook.id}/notes/${item.note.id}` : `/app/notebooks/${item.notebook.id}`;

const activityAvatarSource = (item: ActivityItem): string | undefined =>
  item.actor.kind === "user" && item.actor.id && item.actor.avatarHash
    ? `/api/accounts/users/${encodeURIComponent(item.actor.id)}/avatar?rev=${encodeURIComponent(item.actor.avatarHash)}`
    : undefined;

const activityAvatarIcon = (item: ActivityItem): string | undefined => {
  if (item.actor.kind === "service_account") return "ti ti-api";
  if (item.actor.kind === "system") return "ti ti-settings-automation";
  return undefined;
};

const activityEventIcon = (action: string): string => {
  switch (action) {
    case "note.created":
      return "ti ti-plus";
    case "note.deleted":
      return "ti ti-trash";
    case "note.restored":
      return "ti ti-history";
    case "note.edited":
      return "ti ti-pencil";
    case "comment.created":
      return "ti ti-message-plus";
    case "comment.updated":
      return "ti ti-message-pencil";
    case "comment.deleted":
      return "ti ti-message-x";
    case "notebook.created":
      return "ti ti-notebook";
    case "notebook.updated":
      return "ti ti-settings";
    default:
      return "ti ti-activity";
  }
};

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
  const activityError = () => activityResults.error()?.message ?? initialActivityError();

  const openNotebook = (notebook: CreatedNotebook) => {
    setLastNotebookId(notebook.id);
    navigateTo(`/app/notebooks/${notebook.id}`);
  };

  const createNotebookMutation = mutations.create<CreatedNotebook, { name: string; description?: string }>({
    mutation: async (input) => {
      const response = await apiClient.index.$post({ json: { name: input.name, description: input.description || undefined } });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFailed));
      return response.json();
    },
    onSuccess: openNotebook,
    onError: (error) => prompts.error(error.message),
  });

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

  const createBlank = async () => {
    const result = await prompts.form({
      title: t().newNotebook,
      icon: "ti ti-notebook",
      fields: {
        name: { type: "text", label: t().name, required: true, placeholder: t().notebookName },
        description: { type: "text", label: t().description, multiline: true, placeholder: t().optionalDescription },
      },
      confirmText: t().create,
    });
    if (!result) return;
    createNotebookMutation.mutate({
      name: String(result.name).trim(),
      description: String(result.description ?? "").trim(),
    });
  };

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

  const activityFeed = () => (
    <Show
      when={!activityError()}
      fallback={
        <Placeholder
          state="error"
          title={t().couldNotLoadActivity}
          description={activityError() ?? undefined}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setInitialActivityError(null);
                void activityResults.refresh();
              }}
            >
              <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
            </Button>
          }
        />
      }
    >
      <Show
        when={activityItems().length > 0}
        fallback={
          <Placeholder
            state={activityResults.loading() ? "loading" : "empty"}
            title={activityResults.loading() ? t().loadingActivity : t().noActivity}
            description={activityResults.loading() ? undefined : t().activityEmptyDescription}
            icon="ti ti-history"
          />
        }
      >
        <ol class="notebooks-overview-activity-list" aria-label={t().recentActivity}>
          <For each={activityItems()}>
            {(item) => (
              <li class="notebooks-overview-activity-item">
                <Avatar name={item.actor.displayName} src={activityAvatarSource(item)} icon={activityAvatarIcon(item)} size="sm" />
                <Paper as="a" href={activityHref(item)} interactive class="notebooks-overview-activity-paper">
                  <i class={`${activityEventIcon(item.action)} notebooks-overview-activity-icon app-accent-text`} aria-hidden="true" />
                  <span class="notebooks-overview-activity-meta">
                    <strong>{item.actor.displayName}</strong>
                    <span aria-hidden="true">·</span>
                    <time datetime={item.lastOccurredAt} title={dates.formatDateTime(item.lastOccurredAt, props.dateConfig)}>
                      {dates.formatDateTimeRelative(item.lastOccurredAt, props.dateConfig)}
                    </time>
                  </span>
                  <span class="notebooks-overview-activity-description">{activityDescription(item, t())}</span>
                </Paper>
              </li>
            )}
          </For>
        </ol>
        <Show when={activityResults.hasMore()}>
          <Button
            size="sm"
            variant="secondary"
            class="mx-auto mt-2"
            loading={activityResults.loadingMore()}
            loadingLabel={t().loadingMoreActivity}
            onClick={() => void activityResults.loadMore()}
          >
            {t().loadMore}
          </Button>
        </Show>
      </Show>
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
    createNotebookMutation.abort();
    createFromTemplateMutation.abort();
  });

  return (
    <AppWorkspace mobileSurface="flush" class="notebooks-overview-workspace" resizable={false}>
      <h1 class="sr-only">{t().notebooks}</h1>
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
                        <>
                          <i class={notebook.shared ? "ti ti-users" : "ti ti-lock"} aria-hidden="true" />
                          {notebook.shared ? t().shared : t().private}
                          <Show when={notebook.lastEditedAt}>
                            {(lastEditedAt) => (
                              <>
                                {" · "}
                                <time datetime={lastEditedAt()} title={dates.formatDateTime(lastEditedAt(), props.dateConfig)}>
                                  {dates.formatDateTimeRelative(lastEditedAt(), props.dateConfig)}
                                </time>
                              </>
                            )}
                          </Show>
                        </>
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
                      <AppWorkspace.SidebarItemIcon icon={pinned() ? "ti ti-flag" : notebook.icon || "ti ti-notebook"} />
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
          <div class="notebooks-overview-page">
            <PanelHeader
              as="h2"
              size="lg"
              title={t().recentlyEdited}
              subtitle={t().recentNotesDescription}
              actions={
                <Dropdown.Root
                  items={createMenuItems()}
                  position="bottom-right"
                  width="min(38rem, calc(100vw - 1rem))"
                  label={t().newNotebook}
                >
                  <Dropdown.Trigger variant="primary" disabled={createNotebookMutation.loading() || createFromTemplateMutation.loading()}>
                    <i class="ti ti-plus" aria-hidden="true" /> {t().newNotebook}
                    <i class="ti ti-chevron-down" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              }
            />
            <div class="notebooks-overview-toolbar">
              <Tag icon="ti ti-notebook" size="lg" class="notebooks-overview-scope">
                {t().allNotebooks}
              </Tag>
              <div class="notebooks-overview-actions">
                <Button type="button" variant="secondary" size="sm" onClick={() => void openSearch()}>
                  <i class="ti ti-search" aria-hidden="true" /> {t().search}
                </Button>
                <Button type="button" variant="secondary" size="sm" class="notebooks-overview-mobile-activity" onClick={openMobileActivity}>
                  <i class="ti ti-history" aria-hidden="true" /> {t().activity}
                </Button>
              </div>
            </div>
            <Paper class="notebooks-overview-list">
              <Show
                when={props.recentNotes.length > 0}
                fallback={
                  <Placeholder state="empty" title={t().noNotes} description={t().noNotesDescription} icon="ti ti-note" class="min-h-56" />
                }
              >
                <ol class="notebooks-overview-notes" aria-label={t().recentlyEdited}>
                  <For each={props.recentNotes}>
                    {(note) => (
                      <li>
                        <a href={`/app/notebooks/${note.notebookId}/notes/${note.id}`} class="notebooks-overview-note">
                          <span class="notebooks-overview-note-icon" aria-hidden="true">
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
            </Paper>
          </div>
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
