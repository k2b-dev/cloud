import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Empty,
  FilterBar,
  Input,
  List,
  ListOrder,
  Notice,
  Pane,
  Row,
  StatusRow,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { PageListEntry } from "../../../service/page-list";
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
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  /** The presentation the list was opened in (`book` for readers); links to notes keep it. */
  mode?: string;
  /** The server's time, so the server and the first browser render show the same times. */
  now: string;
};

/**
 * The notebook's notes as one list on v2: all of them or the favorites (views in the head), a tag and favorites as
 * statements, the search in the head, the order in words. It replaces the tag page; every change shows the list again
 * from the server, which filters it with the person's access.
 */
export default function NotesListScreen(props: NotesListScreenProps) {
  const locale = useLocale();
  const t = createMemo(() => notesListMessages.resolve([locale()]).t);
  const sidebar = useNotebookSidebar({ ctx: props.ctx });
  const { showChanges, openPage } = usePageSwap();
  const notebookId = () => props.ctx.notebook.id;
  const query = createMemo(() => notesQuery(locale(), props.ctx.tags));
  const [state, setState] = createSignal<NotesState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const href = (next: NotesState, page = 1) => notesHref(notebookId(), query(), next, page, props.mode);
  const favoritesView = () => notesViews(query()).favorites;
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();

  const change = (next: NotesState) => {
    setState(next);
    setRefreshing(true);
    void showChanges();
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (next) {
      setRefreshing(true);
      void openPage(href(next));
    }
  };
  const when = (at: string) => dates.formatDateTimeRelative(at, { ...props.ctx.dateConfig, base: props.now });
  const emptyText = () =>
    changed() || state().search ? t().noMatches : state().view === "favorites" ? t().noFavoritesYet : t().noNotesYet;
  const canWrite = sidebar.canWrite;

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
              <FilterBar
                query={query()}
                state={state()}
                onChange={change}
                icons={{ favorite: "star", tag: "hash" }}
                results={t().notesCount({ count: number(props.total) })}
              />
              <StatusRow
                lead={t().notesCount({ count: number(props.total) })}
                loading={refreshing()}
                filters={<ListOrder query={query()} state={state()} onChange={change} />}
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
          <Show
            when={props.items.length > 0}
            fallback={
              changed() || state().search ? (
                <Empty
                  icon="filter-off"
                  text={state().filters.tag ? `${emptyText()} ${t().tagIndexMayBeStale}` : emptyText()}
                  action={{
                    label: t().resetFilters,
                    icon: "filter-off",
                    href: notesHref(notebookId(), query(), query().reset(), 1, props.mode),
                  }}
                />
              ) : (
                <Empty icon={state().view === "favorites" ? "star" : "file-text"} text={emptyText()} />
              )
            }
          >
            <List label={t().notes}>
              <For each={props.items}>
                {(note) => (
                  <Row
                    icon={note.lockedAt ? "lock" : "file-text"}
                    lines={note.preview ? [note.title, note.preview] : [note.title]}
                    time={when(state().sort.field === "created" ? note.createdAt : note.updatedAt)}
                    marks={
                      note.tags.length > 0 ? (
                        <For each={note.tags.slice(0, 3)}>
                          {(tag) => (
                            <Chip tag href={href(query().set(query().reset(), "tag", tag) ?? query().reset())}>
                              {`#${tag}`}
                            </Chip>
                          )}
                        </For>
                      ) : undefined
                    }
                    href={buildNoteUrl(notebookId(), note.shortId, props.mode === "book" ? "book" : undefined)}
                  />
                )}
              </For>
            </List>
          </Show>
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
