import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Cells,
  Chip,
  FilterBar,
  Inline,
  Input,
  ListOrder,
  Notice,
  Pane,
  type Person,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { NotesFigures } from "../../../service/notebook-figures";
import type { PageEditor, PageListEntry } from "../../../service/page-list";
import { usePageSwap } from "../../lib/page-swap";
import { buildNoteUrl } from "../../params";
import NotebookSidebarBody from "../_components/sidebar/NotebookSidebarBody";
import { useNotebookSidebar } from "../_components/sidebar/notebook-sidebar-state";
import type { NotebookContext } from "../_components/sidebar/types";
import { notesListMessages } from "./messages";
import { type NotesState, notesHref, notesListPath, notesQuery, notesViews } from "./query";

export type NotesListScreenProps = {
  ctx: NotebookContext;
  state: NotesState;
  page: number;
  pages: number;
  total: number;
  items: PageListEntry[];
  /** The notebook's key figures for the head of the list: changes per day, notes, the last change. */
  figures: NotesFigures;
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  /** The presentation the list was opened in (`book` for readers); links to notes keep it. */
  mode?: string;
  /** This page's address: Links (the graph) returns here on Close. */
  graphBack: string;
  /** The server's time, so the server and the first browser render show the same times. */
  now: string;
};

/** A face for a person who changed something: their picture where they have one, else their initials. */
const personOf = (editor: { kind: string; id: string | null; displayName?: string; name?: string; avatarHash: string | null }): Person => ({
  name: editor.name ?? editor.displayName ?? "",
  image:
    editor.kind === "user" && editor.id && editor.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(editor.id)}/avatar?rev=${encodeURIComponent(editor.avatarHash)}`
      : undefined,
});

/**
 * The notebook's notes as one table on v2: all of them or the favorites (views in the head), a tag and favorites as
 * statements, the search in the head, the order in words. Above it the notebook's key figures: how much changed in
 * the last days and by whom, its notes, its last change. Each row shows who changed the note lately. It replaces the
 * tag page; every change shows the list again from the server, which filters it with the person's access.
 */
export default function NotesListScreen(props: NotesListScreenProps) {
  const locale = useLocale();
  const t = createMemo(() => notesListMessages.resolve([locale()]).t);
  const sidebar = useNotebookSidebar({ ctx: props.ctx, graphBack: props.graphBack });
  const { showChanges, openPage } = usePageSwap();
  const notebookId = () => props.ctx.notebook.id;
  const query = createMemo(() => notesQuery(locale(), props.ctx.tags));
  const [state, setState] = createSignal<NotesState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const href = (next: NotesState, page = 1) => notesHref(notebookId(), query(), next, page, props.mode);
  const favoritesView = () => notesViews(query()).favorites;
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();
  const days = () => props.figures.days.length;

  const change = (next: NotesState) => {
    setState(next);
    void showChanges();
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (next) void openPage(href(next));
  };
  const when = (at: string) => dates.formatDateTimeRelative(at, { ...props.ctx.dateConfig, base: props.now });
  const emptyText = () =>
    changed() || state().search ? t().noMatches : state().view === "favorites" ? t().noFavoritesYet : t().noNotesYet;
  const canWrite = sidebar.canWrite;
  const timeOf = (note: PageListEntry) => when(state().sort.field === "created" ? note.createdAt : note.updatedAt);
  const tagHref = (tag: string) => href(query().set(query().reset(), "tag", tag) ?? query().reset());
  const editorsLabel = (editors: PageEditor[]) => t().changedByNames({ names: editors.map((editor) => editor.name).join(", ") });

  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree and its note menus. */}
      <WorkspaceNavigationProvider navigation={sidebar.mobileNavigation} label={props.ctx.notebook.name} />
      <Workspace
        // k2b-ui gap: Nav tree (link + fold, lazy levels, drag and drop) – the v1 sidebar body stands in the slot.
        sidebar={<NotebookSidebarBody sidebar={sidebar} current="notes" />}
        head={
          <Bar
            start={
              <Tabs
                label={t().views}
                items={[
                  { label: t().allNotes, icon: "list", href: notesListPath(notebookId()), current: state().view !== "favorites" },
                  { label: t().favorites, icon: "star", href: href(favoritesView()), current: state().view === "favorites" },
                ]}
              />
            }
            end={
              <>
                <Input
                  type="search"
                  icon="search"
                  label={t().searchNotes}
                  placeholder={t().searchNotes}
                  value={state().search ?? ""}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") search(input.value);
                    if (event.key === "Escape" && input.value) {
                      input.value = "";
                      search("");
                    }
                  }}
                />
                <Show when={canWrite}>
                  <Button
                    variant="primary"
                    icon="pencil-plus"
                    busy={sidebar.actions.loading()}
                    onClick={() => sidebar.actions.handleCreateNote()}
                  >
                    {sidebar.t().newNote}
                  </Button>
                </Show>
              </>
            }
          />
        }
        primary={
          canWrite ? { label: sidebar.t().newNote, icon: "pencil-plus", onClick: () => sidebar.actions.handleCreateNote() } : undefined
        }
      >
        <Pane
          label={t().notes}
          scrollKey={`notebooks-notes-${notebookId()}`}
          status={
            <>
              {/* k2b-ui gap: hero band + tinted object head (DP) – the notebook's hero figure with its real trend and
                  its key facts stand in Cells until the band (figure 30, the trend as a chart) exists. */}
              <Cells>
                <Cells.Cell
                  icon="pencil"
                  label={t().changes({ days: days() })}
                  value={number(props.figures.changes)}
                  meta={props.figures.people > 0 ? t().byPeople({ count: number(props.figures.people) }) : t().noChangesYet}
                  trend={{
                    values: props.figures.days,
                    label: t().changesTrend({
                      days: days(),
                      total: number(props.figures.changes),
                      today: number(props.figures.days.at(-1) ?? 0),
                    }),
                  }}
                />
                <Cells.Cell
                  icon="notes"
                  label={t().notes}
                  value={number(props.figures.notes)}
                  meta={t().newNotes({ count: number(props.figures.newNotes), days: days() })}
                />
                <Cells.Cell
                  icon="clock"
                  label={t().lastChange}
                  value={
                    <Show when={props.figures.latest} fallback={t().nothingChanged}>
                      {(latest) => (
                        <Inline>
                          <Avatar {...personOf(latest().actor)} decorative />
                          <Text>{latest().actor.displayName}</Text>
                        </Inline>
                      )}
                    </Show>
                  }
                  meta={
                    props.figures.latest
                      ? props.figures.latest.note
                        ? t().inNote({ when: when(props.figures.latest.at), title: props.figures.latest.note.title })
                        : when(props.figures.latest.at)
                      : undefined
                  }
                />
              </Cells>
              <FilterBar
                query={query()}
                state={state()}
                onChange={change}
                icons={{ favorite: "star", tag: "hash" }}
                results={t().notesCount({ count: number(props.total) })}
                end={<ListOrder query={query()} state={state()} onChange={change} />}
              />
            </>
          }
        >
          <Show when={ignored()}>
            {(text) => (
              <Notice tone="warn" title={t().ignoredParts} actions={[{ label: t().hide, onClick: () => setIgnored(null) }]}>
                {text()}
              </Notice>
            )}
          </Show>
          <Table
            label={t().notes}
            rows={props.items}
            rowKey={(note) => note.shortId}
            open={(note) => ({ href: buildNoteUrl(notebookId(), note.shortId, props.mode === "book" ? "book" : undefined) })}
            empty={
              changed() || state().search
                ? {
                    icon: "filter-off",
                    text: state().filters.tag ? `${emptyText()} ${t().tagIndexMayBeStale}` : emptyText(),
                    action: {
                      label: t().resetFilters,
                      icon: "filter-off",
                      href: notesHref(notebookId(), query(), query().reset(), 1, props.mode),
                    },
                  }
                : { icon: state().view === "favorites" ? "star" : "file-text", text: emptyText() }
            }
            phone={(note) => ({
              mark: { icon: note.lockedAt ? "lock" : "file-text", label: note.lockedAt ? t().locked : undefined },
              lines: [note.title, [...note.tags.slice(0, 2).map((tag) => `#${tag}`), note.editors[0]?.name].filter(Boolean).join(" · ")],
              time: timeOf(note),
            })}
            columns={[
              {
                title: t().note,
                mark: (note) => ({ icon: note.lockedAt ? "lock" : "file-text", label: note.lockedAt ? t().locked : undefined }),
                cell: (note) => note.title,
              },
              {
                title: t().tags,
                drop: true,
                cell: (note) => (
                  <Inline>
                    <For each={note.tags.slice(0, 3)}>
                      {(tag) => (
                        <Chip tag href={tagHref(tag)}>
                          {`#${tag}`}
                        </Chip>
                      )}
                    </For>
                  </Inline>
                ),
              },
              {
                title: t().changedBy,
                drop: true,
                // the data column: who changed the note lately, the last one first
                cell: (note) =>
                  note.editors.length > 0 ? <Avatar.Stack people={note.editors.map(personOf)} label={editorsLabel(note.editors)} /> : "",
              },
              {
                title: state().sort.field === "created" ? t().created : t().lastChanged,
                align: "end",
                cell: (note) => timeOf(note),
              },
            ]}
          />
          <Show when={props.pages > 1}>
            <Bar
              start={<Text type="meta">{t().pageOf({ page: props.page, pages: props.pages })}</Text>}
              end={
                <>
                  <Button icon="chevron-left" href={href(state(), props.page - 1)} disabled={props.page <= 1}>
                    {t().previous}
                  </Button>
                  <Button href={href(state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                    {t().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
      </Workspace>
    </>
  );
}
