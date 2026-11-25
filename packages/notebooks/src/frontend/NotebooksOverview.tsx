import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Empty,
  Failed,
  List,
  Loading,
  Nav,
  type NavGroup,
  Notice,
  Pane,
  type Person,
  Row,
  Section,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { setPinnedNotebookIds as writePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";
import { describeOverviewActivity } from "./activity-messages";
import { notebooksPageMessages } from "./messages";
import NewNotebookDialog, { type NotebookTemplate } from "./NewNotebookDialog";
import { createNoteCommands } from "./note-commands";
import { v2Icon } from "./v2-icon";

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
export type OverviewActivityItem = {
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
type ActivityPage = { items: OverviewActivityItem[]; nextCursor: string | null };
export type NotebooksOverviewProps = {
  notebooks: OverviewNotebook[];
  templates: NotebookTemplate[];
  recentNotes: RecentNote[];
  initialActivity: ActivityPage;
  initialActivityError: string | null;
  initialPinnedNotebookIds: string[];
  dateConfig: DateContext;
  /** The server's time, so the server and the first browser render show the same activity times. */
  now: string;
};

const errorMessage = async (response: Pick<Response, "json">, fallback: string) => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Keep the stable fallback.
  }
  return fallback;
};

const activityHref = (item: OverviewActivityItem): string =>
  item.note ? `/app/notebooks/${item.notebook.id}/notes/${item.note.id}` : `/app/notebooks/${item.notebook.id}`;

const activityPerson = (item: OverviewActivityItem, automatic: string): Person => ({
  name: item.actor.kind === "system" ? automatic : item.actor.displayName,
  image:
    item.actor.kind === "user" && item.actor.id && item.actor.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(item.actor.id)}/avatar?rev=${encodeURIComponent(item.actor.avatarHash)}`
      : undefined,
});

/**
 * The start of Notebooks on v2: the notebooks as places in the sidebar (pinned ones first), the notes edited last in
 * the main column and the activity across all notebooks beside it (under it on the phone). "Neues Notizbuch" opens one
 * dialog for a blank notebook or a template.
 */
export default function NotebooksOverview(props: NotebooksOverviewProps) {
  createNoteCommands();
  const locale = useLocale();
  const t = createMemo(() => notebooksPageMessages.resolve([locale()]).t);
  const [creating, setCreating] = createSignal(false);
  const [pinnedNotebookIds, setPinnedNotebookIds] = createSignal(props.initialPinnedNotebookIds);
  const [initialActivityError, setInitialActivityError] = createSignal(props.initialActivityError);
  const when = (at: string) => dates.formatDateTimeRelative(at, { ...props.dateConfig, base: props.now });

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
  const toggleNotebookPin = (notebook: OverviewNotebook) =>
    setPinnedNotebookIds((current) => {
      const next = current.includes(notebook.id) ? current.filter((id) => id !== notebook.id) : [notebook.id, ...current];
      writePinnedNotebookIds(next);
      return next;
    });

  // The notebooks are the places: pinned ones carry the flag and lead; each one's "…" pins or releases it.
  const navGroups = createMemo((): NavGroup[] => [
    { items: [{ label: t().allNotebooks, icon: "notebook", href: "/app/notebooks", current: true }] },
    {
      label: t().notebooks,
      action: { label: t().newNotebook, icon: "plus", onClick: () => setCreating(true) },
      items: orderedNotebooks().map((notebook) => {
        const pinned = pinnedNotebookIds().includes(notebook.id);
        return {
          label: notebook.name,
          icon: pinned ? "flag" : v2Icon(notebook.icon, "notebook"),
          href: `/app/notebooks/${notebook.id}`,
          count: notebook.noteCount,
          // k2b-ui gap: a Nav entry has no quiet second line, so a notebook's last edit time no longer stands beside
          // it; the notes edited last (main column) carry their notebook and time.
          menu: [
            {
              label: pinned ? t().unpin({ name: notebook.name }) : t().pin({ name: notebook.name }),
              icon: pinned ? "flag-off" : "flag",
              onClick: () => toggleNotebookPin(notebook),
            },
          ],
        };
      }),
    },
  ]);

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
  const reloadActivity = () => {
    setInitialActivityError(null);
    void activityResults.refresh();
  };
  const describe = (item: OverviewActivityItem) =>
    describeOverviewActivity(item.action, {
      locale: locale(),
      target: item.note ? (locale().startsWith("de") ? `„${item.note.title}“` : `“${item.note.title}”`) : item.notebook.name,
      notebook: item.notebook.name,
    });

  const openSearch = () => openGlobalSearch({ scope: { appId: "notebooks", label: t().notebooks, icon: "ti ti-notebook" } });

  return (
    <>
      <V2WorkspaceNavigation label={t().notebooks} groups={navGroups()} />
      <Workspace
        sidebar={<Nav title={t().notebooks} icon="notebook" groups={navGroups()} />}
        head={
          <Bar
            end={
              <>
                <Button icon="search" keep onClick={openSearch}>
                  {t().search}
                </Button>
                <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  {t().newNotebook}
                </Button>
              </>
            }
          />
        }
        primary={{ label: t().newNotebook, icon: "plus", onClick: () => setCreating(true) }}
      >
        <Show when={creating()}>
          <NewNotebookDialog templates={props.templates} close={() => setCreating(false)} />
        </Show>
        <Pane.Split>
          <Pane label={t().recentlyEdited} scrollKey="notebooks-recent">
            <Section icon="clock" title={t().recentlyEdited} count={props.recentNotes.length || undefined}>
              <Show when={props.recentNotes.length > 0} fallback={<Empty icon="note" text={t().noNotesDescription} />}>
                <List label={t().recentlyEdited}>
                  <For each={props.recentNotes}>
                    {(note) => (
                      <Row
                        icon={v2Icon(note.notebookIcon, "note")}
                        lines={[note.title, note.notebookName]}
                        time={when(note.updatedAt)}
                        href={`/app/notebooks/${note.notebookId}/notes/${note.id}`}
                      />
                    )}
                  </For>
                </List>
              </Show>
            </Section>
          </Pane>
          <Pane label={t().activity} side width={{ min: 320, default: 400 }} scrollKey="notebooks-activity">
            <Section
              icon="history"
              title={t().activity}
              // older entries load under the newest; the link waits while a page loads, so a second press loads nothing twice
              more={
                activityResults.hasMore()
                  ? { label: t().loadMore, onClick: () => void (activityResults.loadingMore() || activityResults.loadMore()) }
                  : undefined
              }
            >
              <Show when={activityError()}>
                {(message) =>
                  activityItems().length > 0 ? (
                    <Notice tone="bad" title={t().couldNotLoadActivity} actions={[{ label: t().reload, onClick: reloadActivity }]}>
                      {message()}
                    </Notice>
                  ) : (
                    <Failed text={`${t().couldNotLoadActivity}: ${message()}`} onRetry={reloadActivity} />
                  )
                }
              </Show>
              <Show
                when={activityItems().length > 0 || activityError()}
                fallback={<Empty icon="history" text={t().activityEmptyDescription} />}
              >
                <List label={t().recentActivity}>
                  <For each={activityItems()}>
                    {(item) => (
                      <Row
                        avatar={activityPerson(item, t().automatic)}
                        lines={[activityPerson(item, t().automatic).name, describe(item)]}
                        meta={item.occurrenceCount > 1 ? t().times({ count: item.occurrenceCount }) : undefined}
                        time={when(item.lastOccurredAt)}
                        href={activityHref(item)}
                      />
                    )}
                  </For>
                </List>
              </Show>
              <Show when={activityResults.loadingMore()}>
                <Loading rows={2} lines={2} />
              </Show>
            </Section>
          </Pane>
        </Pane.Split>
      </Workspace>
    </>
  );
}
