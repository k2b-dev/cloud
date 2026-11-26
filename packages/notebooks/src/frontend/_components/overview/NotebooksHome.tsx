import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { type DateContext, dates } from "@k2b/stdlib";
import { query as queries } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Digest,
  Empty,
  Failed,
  List,
  Menu,
  type MenuEntry,
  Nav,
  type NavItem,
  Pane,
  Row,
  Section,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { setPinnedNotebookIds as writePinnedNotebookIds } from "../../[id]/_components/settings/NotebookSettingsStore";
import { describeOverviewActivity, notebookActivityIcon } from "../../activity-messages";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource } from "./NewNotebookDialog";

export type TemplateSummary = { id: string; name: string; description: string; icon: string };
export type OverviewNotebook = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  noteCount: number;
  lastEditedAt: string | null;
};
export type RecentNote = {
  id: string;
  notebookId: string;
  notebookName: string;
  notebookIcon: string | null;
  title: string;
  updatedAt: string;
};
export type ActivityItem = {
  id: string;
  notebook: { id: string; name: string; icon: string | null };
  note: { id: string; title: string } | null;
  noteVersionId: string | null;
  actor: { kind: "user" | "service_account" | "system"; id: string | null; displayName: string; avatarHash: string | null };
  action: string;
  metadata: Record<string, unknown>;
  occurrenceCount: number;
  createdAt: string;
  lastOccurredAt: string;
};
export type ActivityPage = { items: ActivityItem[]; nextCursor: string | null };
export type NotebooksHomeProps = {
  notebooks: OverviewNotebook[];
  templates: TemplateSummary[];
  recentNotes: RecentNote[];
  initialActivity: ActivityPage;
  /** The first page of activity could not be read: the column says so with a way to try again. */
  initialActivityFailed: boolean;
  initialPinnedNotebookIds: string[];
  dateConfig: DateContext;
  /** The server's time, so the server and the first browser render show the same times. */
  now: string;
};

/** One page of activity; the column loads the next on request. */
const ACTIVITY_PAGE = 30;

/** A notebook's sign: its own icon, or the notebooks' one, as the v2 icon name. */
const sign = (icon: string | null) => (icon ?? "ti ti-notebook").replace(/^ti ti-/, "");

const activityHref = (item: ActivityItem) =>
  item.note ? `/app/notebooks/${item.notebook.id}/notes/${item.note.id}` : `/app/notebooks/${item.notebook.id}`;

/** The person who did it, as their face; the system and agents keep their initials. */
const actorPerson = (item: ActivityItem) => ({
  name: item.actor.displayName,
  image:
    item.actor.kind === "user" && item.actor.id && item.actor.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(item.actor.id)}/avatar?rev=${encodeURIComponent(item.actor.avatarHash)}`
      : undefined,
});

/**
 * The home of Notebooks on v2: the notebooks in the sidebar (pinned ones in their own group, each pinned or loosened
 * from its menu), the notes this person edited last, and beside them the activity across every notebook, as sentences
 * that load page by page. The head has the search and one "+" for a new notebook, blank or from a template. The
 * server reads the notebooks, the notes and the first page of activity, so the first picture has no loader.
 */
export default function NotebooksHome(props: NotebooksHomeProps) {
  createNoteCommands();
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const toast = useToast();
  const when = (at: string) => dates.formatDateTimeRelative(at, { ...props.dateConfig, base: props.now });

  // ── pinning ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const [pinnedIds, setPinnedIds] = createSignal(props.initialPinnedNotebookIds);
  const pinned = createMemo(() => pinnedIds().flatMap((id) => props.notebooks.find((notebook) => notebook.id === id) ?? []));
  const unpinned = createMemo(() => props.notebooks.filter((notebook) => !pinnedIds().includes(notebook.id)));
  const togglePin = (notebook: OverviewNotebook) => {
    const was = pinnedIds().includes(notebook.id);
    const next = was ? pinnedIds().filter((id) => id !== notebook.id) : [notebook.id, ...pinnedIds()];
    setPinnedIds(next);
    writePinnedNotebookIds(next);
    toast(was ? t().unpinned({ name: notebook.name }) : t().pinned({ name: notebook.name }));
  };
  const entry = (notebook: OverviewNotebook): NavItem => {
    const isPinned = () => pinnedIds().includes(notebook.id);
    return {
      label: notebook.name,
      icon: sign(notebook.icon),
      href: `/app/notebooks/${notebook.id}`,
      count: notebook.noteCount || undefined,
      menu: [
        {
          label: isPinned() ? t().unpinAction : t().pinAction,
          icon: isPinned() ? "pinned-off" : "pin",
          onClick: () => togglePin(notebook),
        },
      ],
    };
  };

  // ── creating ────────────────────────────────────────────────────────────────────────────────────────────────────
  const [creating, setCreating] = createSignal<NewNotebookSource | null>(null);
  const createItems = (): MenuEntry[] => [
    { label: t().blankNotebook, icon: "notebook", meta: t().blankNotebookDescription, onClick: () => setCreating({ kind: "blank" }) },
    ...(props.templates.length > 0
      ? [
          {
            title: t().templates,
            items: props.templates.map((template) => ({
              label: template.name,
              icon: sign(template.icon),
              meta: template.description,
              onClick: () => setCreating({ kind: "template", template }),
            })),
          },
        ]
      : []),
  ];

  // ── activity ────────────────────────────────────────────────────────────────────────────────────────────────────
  const activity = queries.createInfinite<string, ActivityPage, string>({
    source: () => "all-notebooks",
    initial: { source: "all-notebooks", pages: [props.initialActivity] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.activity.$get(
        { query: { limit: String(ACTIVITY_PAGE), cursor } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().activityLoadFailed);
      const page = await response.json();
      setFirstFailed(false);
      return { items: page.data, nextCursor: page.nextCursor };
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const [firstFailed, setFirstFailed] = createSignal(props.initialActivityFailed);
  const items = createMemo(() => activity.pages().flatMap((page) => page.items));
  // A failed older page keeps the loaded sentences and says so where "Mehr laden" was; a failed first page stands alone.
  const [olderFailed, setOlderFailed] = createSignal(false);
  const loadMore = async () => {
    const before = activity.error();
    await activity.loadMore();
    setOlderFailed(activity.error() !== before && activity.error() !== null);
  };
  const retryFirst = () => {
    setFirstFailed(false);
    void activity.refresh();
  };
  const sentence = (item: ActivityItem) =>
    describeOverviewActivity(item.action, {
      locale: locale(),
      target: item.note ? (locale().startsWith("de") ? `„${item.note.title}“` : `“${item.note.title}”`) : item.notebook.name,
      notebook: item.notebook.name,
    });

  const openSearch = () => openGlobalSearch({ scope: { appId: "notebooks", label: t().notebooks, icon: "ti ti-notebook" } });

  return (
    <>
      <Workspace
        sidebar={
          // k2b-ui gap: a Nav of many notebooks renders every entry; it scrolls in the sidebar until v2 lists can be
          // virtualized (lane MW).
          <Nav
            title={t().notebooks}
            icon="notebook"
            groups={[
              { items: [{ label: t().overview, icon: "layout-dashboard", href: "/app/notebooks", current: true }] },
              ...(pinned().length > 0 ? [{ label: t().pinnedGroup, items: pinned().map(entry) }] : []),
              // the app's name stands above; the list is named once and apart from it
              { label: t().allNotebooks, items: unpinned().map(entry) },
            ]}
          />
        }
        head={
          // No title that repeats the sidebar's current entry; the search and the one "+" (a symbol, so the phone keeps it).
          <Bar
            end={
              <>
                <Button icon="search" label={t().search} title={t().search} keep onClick={() => void openSearch()} />
                <Menu icon="plus" variant="primary" label={t().newNotebook} items={createItems()} />
              </>
            }
          />
        }
      >
        <Pane.Split>
          <Pane label={t().overview} scrollKey="notebooks-home">
            <Show
              when={props.notebooks.length > 0}
              fallback={
                <Empty
                  icon="notebook"
                  text={t().noNotebooksYet}
                  action={{ label: t().newNotebook, icon: "plus", onClick: () => setCreating({ kind: "blank" }) }}
                />
              }
            >
              <Section icon="clock" title={t().recentlyEdited} count={props.recentNotes.length || undefined}>
                <Show when={props.recentNotes.length > 0} fallback={<Empty icon="file-text" text={t().noNotesYet} />}>
                  <List label={t().recentlyEdited}>
                    <For each={props.recentNotes}>
                      {(note) => (
                        <Row
                          icon={sign(note.notebookIcon)}
                          lines={[note.title, note.notebookName]}
                          time={when(note.updatedAt)}
                          href={`/app/notebooks/${note.notebookId}/notes/${note.id}`}
                        />
                      )}
                    </For>
                  </List>
                </Show>
              </Section>
            </Show>
          </Pane>
          <Pane label={t().activity} side width={{ min: 320, default: 400 }} scrollKey="notebooks-home-activity">
            <Section
              icon="history"
              title={t().activity}
              more={
                activity.hasMore() && !olderFailed()
                  ? { label: activity.loadingMore() ? t().loadingMoreActivity : t().loadMore, onClick: () => void loadMore() }
                  : undefined
              }
            >
              <Show
                when={items().length > 0}
                fallback={
                  <Show when={firstFailed() || activity.error()} fallback={<Empty icon="history" text={t().activityEmptyDescription} />}>
                    <Failed text={t().activityLoadFailed} onRetry={retryFirst} />
                  </Show>
                }
              >
                {/* k2b-ui gap: the sentences grow page by page and are not virtualized yet (lane MW) */}
                <Digest label={t().activity}>
                  <For each={items()}>
                    {(item) => (
                      <Row
                        avatar={item.actor.kind === "system" ? undefined : actorPerson(item)}
                        icon={item.actor.kind === "system" ? notebookActivityIcon(item.action).replace(/^ti ti-/, "") : undefined}
                        lines={[sentence(item), `${item.notebook.name} · ${when(item.lastOccurredAt)}`]}
                        href={activityHref(item)}
                      />
                    )}
                  </For>
                </Digest>
                <Show when={olderFailed()}>
                  <Failed text={t().activityLoadFailed} onRetry={() => void loadMore()} />
                </Show>
              </Show>
            </Section>
          </Pane>
        </Pane.Split>
      </Workspace>
      <NewNotebookDialog source={creating()} onClose={() => setCreating(null)} />
    </>
  );
}
