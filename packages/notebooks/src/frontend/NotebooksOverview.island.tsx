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
  Placeholder,
  prompts,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { setLastNotebookId, setPinnedNotebookIds as writePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";

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

const activityDescription = (item: ActivityItem): string => {
  const target = item.note ? `“${item.note.title}”` : item.notebook.name;
  switch (item.action) {
    case "note.created":
      return `Created ${target} in ${item.notebook.name}`;
    case "note.deleted":
      return `Deleted a note in ${item.notebook.name}`;
    case "note.restored":
      return `Restored ${target} in ${item.notebook.name}`;
    case "note.edited":
      return `Edited ${target} in ${item.notebook.name}`;
    case "notebook.created":
      return `Created ${item.notebook.name}`;
    case "notebook.updated":
      return `Updated ${item.notebook.name}`;
    default:
      return `${item.action.replaceAll(".", " ")} in ${item.notebook.name}`;
  }
};

const activityHref = (item: ActivityItem): string =>
  item.note ? `/app/notebooks/${item.notebook.id}/notes/${item.note.id}` : `/app/notebooks/${item.notebook.id}`;

export default function NotebooksOverview(props: Props) {
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
      setPinAnnouncement(`${pinned ? "Unpinned" : "Pinned"} ${notebook.name}`);
      return next;
    });
  };

  const activityResults = queries.createInfinite<string, ActivityPage, string>({
    source: () => "all-notebooks",
    initial: { source: "all-notebooks", pages: [props.initialActivity] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get({ query: { limit: "30", cursor } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to load notebook activity"));
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
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to create notebook"));
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
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to create notebook from template"));
      return response.json();
    },
    onSuccess: openNotebook,
    onError: (error) => prompts.error(error.message),
  });

  const createBlank = async () => {
    const result = await prompts.form({
      title: "New notebook",
      icon: "ti ti-notebook",
      fields: {
        name: { type: "text", label: "Name", required: true, placeholder: "Notebook name" },
        description: { type: "text", label: "Description", multiline: true, placeholder: "Optional description" },
      },
      confirmText: "Create",
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
      fields: { name: { type: "text", label: "Name", placeholder: template.name } },
      confirmText: "Create",
    });
    if (!result) return;
    createFromTemplateMutation.mutate({
      templateId: template.id,
      name: String(result.name ?? "").trim() || undefined,
    });
  };

  const createMenuItems = () => [
    {
      sectionLabel: "Start",
      items: [
        {
          label: "Blank notebook",
          description: "Start with the standard welcome note.",
          icon: "ti ti-plus",
          action: () => void createBlank(),
        },
      ],
    },
    {
      sectionLabel: "Templates",
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
          title="Could not load activity"
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
            state={activityResults.loading() ? "loading" : "empty"}
            title={activityResults.loading() ? "Loading activity" : "No activity yet"}
            description={activityResults.loading() ? undefined : "Notebook and note changes will appear here."}
            icon="ti ti-history"
          />
        }
      >
        <DetailPanel.Group label="Recent notebook activity">
          <For each={activityItems()}>
            {(item) => (
              <DetailPanel.Action
                href={activityHref(item)}
                title={item.actor.displayName}
                description={activityDescription(item)}
                leading={<Avatar name={item.actor.displayName} size="xs" />}
                trailing={
                  <time datetime={item.lastOccurredAt} title={dates.formatDateTime(item.lastOccurredAt, props.dateConfig)}>
                    {dates.formatDateTimeRelative(item.lastOccurredAt, props.dateConfig)}
                  </time>
                }
              />
            )}
          </For>
        </DetailPanel.Group>
        <Show when={activityResults.hasMore()}>
          <Button
            size="sm"
            variant="secondary"
            class="mx-auto mt-2"
            loading={activityResults.loadingMore()}
            loadingLabel="Loading more activity"
            onClick={() => void activityResults.loadMore()}
          >
            Load more
          </Button>
        </Show>
      </Show>
    </Show>
  );

  const openMobileActivity = () => {
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title="Activity" subtitle="Recent changes across your notebooks." icon="ti ti-history" close={close} />
          <PanelDialog.Body>{activityFeed()}</PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogOptions,
    );
  };

  const openSearch = async () => {
    const selected = await openSpotlightSearch<SearchTarget>({
      title: "Search notebooks and notes",
      icon: "ti ti-search",
      placeholder: "Search notebooks and notes...",
      minQueryLength: 1,
      noResultsText: "No notebooks or notes found.",
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
            desc: notebook.description ?? "Notebook",
            icon: notebook.icon || "ti ti-notebook",
          }));

        const response = await apiClient.search.$get(
          { query: { q: trimmed, page: "1", per_page: "20" } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error("Notebooks and notes could not be searched. Try again.");
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
      <h1 class="sr-only">Notebooks</h1>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="notebooks-overview-main">
          <header class="notebooks-overview-notebooks">
            <div class="notebooks-overview-heading">
              <div>
                <h2>Notebooks</h2>
                <p>Open a workspace, search its notes, or manage its settings.</p>
              </div>
              <div class="notebooks-overview-actions">
                <Button type="button" variant="secondary" size="sm" onClick={() => void openSearch()}>
                  <i class="ti ti-search" aria-hidden="true" /> Search
                </Button>
                <Button type="button" variant="secondary" size="sm" class="notebooks-overview-mobile-activity" onClick={openMobileActivity}>
                  <i class="ti ti-history" aria-hidden="true" /> Activity
                </Button>
              </div>
            </div>
            <nav class="notebooks-overview-notebook-list" aria-label="Notebooks">
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
                        label={`${pinned() ? "Unpin" : "Pin"} ${notebook.name}`}
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
                label="Create notebook"
              >
                <Dropdown.Trigger
                  variant="secondary"
                  size="sm"
                  disabled={createNotebookMutation.loading() || createFromTemplateMutation.loading()}
                >
                  <i class="ti ti-plus app-accent-text" aria-hidden="true" /> New notebook
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
                <h2 id="notebooks-recent-title">Recent notes</h2>
                <p>Your latest work across every notebook you can access.</p>
              </div>
            </div>
            <Show
              when={props.recentNotes.length > 0}
              fallback={
                <Placeholder
                  state="empty"
                  title="No notes yet"
                  description="Create a notebook or open one above to start writing."
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
            <DetailPanel.Header title="Activity" subtitle="Recent changes across your notebooks." icon="ti ti-history" />
            <DetailPanel.Body scrollPreserveKey="notebooks-overview-activity">{activityFeed()}</DetailPanel.Body>
          </DetailPanel>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
