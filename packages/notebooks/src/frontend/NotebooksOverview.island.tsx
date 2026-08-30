import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Avatar,
  Button,
  ButtonLink,
  DetailPanel,
  dialogCore,
  Dropdown,
  IconButton,
  LinkCard,
  openSpotlightSearch,
  PanelDialog,
  panelDialogOptions,
  Paper,
  Placeholder,
  prompts,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { setLastNotebookId, setPinnedNotebookIds as writePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";
import { notebooksPageMessages } from "./messages";

type TemplateSummary = { id: string; name: string; description: string; icon: string };
type PublicNotebook = { id: string; name: string; description: string | null; icon: string | null };
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
  notebooks: PublicNotebook[];
  templates: TemplateSummary[];
  recentNotes: RecentNote[];
  initialActivity: ActivityPage;
  initialActivityError: string | null;
  initialPinnedNotebookIds: string[];
  dateConfig: DateContext;
};
type CreatedNotebook = { id: string };

type SearchTarget = { href: string };
type SearchResponse = {
  data: Array<{
    note: { id: string; title: string };
    notebook: { id: string; name: string; icon: string | null };
    snippet: string | null;
  }>;
};

const cleanSnippet = (snippet: string | null): string | undefined =>
  snippet?.replaceAll("\uE000", "").replaceAll("\uE001", "").replace(/\s+/g, " ").trim() || undefined;

const errorMessage = async (response: Response, fallback: string) => {
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
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
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

  const toggleNotebookPin = (notebook: PublicNotebook) => {
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

  const openSearch = async () => {
    const selected = await openSpotlightSearch<SearchTarget>({
      title: t().searchTitle,
      icon: "ti ti-search",
      placeholder: t().searchPlaceholder,
      minQueryLength: 1,
      noResultsText: t().noSearchResults,
      resolve: async ({ query, abortSignal }) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const normalized = trimmed.toLowerCase();
        const notebookItems = props.notebooks
          .filter((notebook) => `${notebook.name} ${notebook.description ?? ""}`.toLowerCase().includes(normalized))
          .slice(0, 8)
          .map((notebook) => ({
            value: { href: `/app/notebooks/${notebook.id}` },
            label: notebook.name,
            desc: notebook.description ?? t().notebook,
            icon: notebook.icon || "ti ti-notebook",
          }));

        const response = await apiClient.search.$get(
          { query: { q: trimmed, page: "1", per_page: "20" } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(t().searchFailed);
        const payload = (await response.json()) as SearchResponse;
        const noteItems = payload.data.map((hit) => ({
          value: { href: `/app/notebooks/${hit.notebook.id}/notes/${hit.note.id}` },
          label: `${hit.note.title} · ${hit.notebook.name}`,
          desc: cleanSnippet(hit.snippet),
          icon: hit.notebook.icon || "ti ti-note",
        }));
        return [...notebookItems, ...noteItems];
      },
    });
    if (selected?.value) navigateTo(selected.value.href);
  };

  onCleanup(() => {
    createNotebookMutation.abort();
    createFromTemplateMutation.abort();
  });

  return (
    <AppWorkspace class="notebooks-overview-workspace" resizable={false}>
      <h1 class="sr-only">{t().notebooks}</h1>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="notebooks-overview-main">
          <header class="notebooks-overview-notebooks">
            <div class="notebooks-overview-heading">
              <div>
                <h2>{t().notebooks}</h2>
                <p>{t().overviewDescription}</p>
              </div>
              <div class="notebooks-overview-actions">
                <Button type="button" variant="secondary" size="sm" onClick={() => void openSearch()}>
                  <i class="ti ti-search" aria-hidden="true" /> {t().search}
                </Button>
                <Button type="button" variant="secondary" size="sm" class="notebooks-overview-mobile-activity" onClick={openMobileActivity}>
                  <i class="ti ti-history" aria-hidden="true" /> {t().activity}
                </Button>
              </div>
            </div>
            <nav class="notebooks-overview-notebook-list" aria-label={t().notebooks}>
              <For each={orderedNotebooks()}>
                {(notebook) => {
                  const pinned = () => notebookIsPinned(notebook.id);
                  return (
                    <span class="notebooks-overview-notebook-item" data-pinned={pinned() ? "true" : undefined}>
                      <ButtonLink
                        href={`/app/notebooks/${notebook.id}`}
                        variant="secondary"
                        size="sm"
                        class="notebooks-overview-notebook-button"
                        title={notebook.description || notebook.name}
                      >
                        <i class={`${pinned() ? "ti ti-flag" : notebook.icon || "ti ti-notebook"} app-accent-text`} aria-hidden="true" />
                        <span class="notebooks-overview-notebook-name">{notebook.name}</span>
                      </ButtonLink>
                      <IconButton
                        label={pinned() ? t().unpin({ name: notebook.name }) : t().pin({ name: notebook.name })}
                        size="xs"
                        variant="text"
                        class="notebooks-overview-notebook-pin"
                        aria-pressed={pinned()}
                        onClick={() => toggleNotebookPin(notebook)}
                      >
                        <i class={`ti ${pinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
                      </IconButton>
                    </span>
                  );
                }}
              </For>
              <Dropdown.Root
                items={createMenuItems()}
                position="bottom-right"
                width="min(38rem, calc(100vw - 1rem))"
                label={t().newNotebook}
              >
                <Dropdown.Trigger
                  variant="secondary"
                  size="sm"
                  disabled={createNotebookMutation.loading() || createFromTemplateMutation.loading()}
                >
                  <i class="ti ti-plus app-accent-text" aria-hidden="true" /> {t().newNotebook}
                  <i class="ti ti-chevron-down" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </nav>
            <span class="sr-only" aria-live="polite">
              {pinAnnouncement()}
            </span>
          </header>

          <section class="notebooks-overview-recent" aria-labelledby="notebooks-recent-title">
            <div class="notebooks-overview-heading">
              <div>
                <h2 id="notebooks-recent-title">{t().recentNotes}</h2>
                <p>{t().recentNotesDescription}</p>
              </div>
            </div>
            <Show
              when={props.recentNotes.length > 0}
              fallback={
                <Placeholder
                  state="empty"
                  title={t().noNotes}
                  description={t().noNotesDescription}
                  icon="ti ti-note"
                  class="min-h-72"
                />
              }
            >
              <div class="notebooks-overview-note-grid">
                <For each={props.recentNotes}>
                  {(note) => (
                    <LinkCard
                      href={`/app/notebooks/${note.notebookId}/notes/${note.id}`}
                      title={note.title}
                      description={`${note.notebookName} · ${dates.formatDateTimeRelative(note.updatedAt, props.dateConfig)}`}
                      icon={note.notebookIcon || "ti ti-note"}
                      color="blue"
                    />
                  )}
                </For>
              </div>
            </Show>
          </section>
        </AppWorkspace.Main>

        <AppWorkspace.Detail id="notebooks-overview-activity" open width="lg" resizable={false} class="notebooks-overview-activity">
          <DetailPanel>
            <DetailPanel.Header title={t().activity} subtitle={t().activityDescription} />
            <DetailPanel.Body scrollPreserveKey="notebooks-overview-activity">{activityFeed()}</DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
