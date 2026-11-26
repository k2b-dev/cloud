import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Canvas, Pane, Tabs, Text, Workspace } from "@k2b/ui/v2";
import { createSignal, mergeProps, onCleanup, onMount, Show } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { notebookWorkspaceMessages } from "../../messages";
import { commentMessages } from "../comments/messages";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "./BookNavigatorBody";
import BookReader from "./BookReader";
import { commentsHref } from "./book-comments";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export type BookWorkspaceProps = BookNavigatorProps & {
  fullWidth: boolean;
  html: string | null;
  noteTitle: string | null;
  currentHref: string;
  canWrite: boolean;
  locked: boolean;
  historyIncomplete: boolean;
  cursor: string | null;
  openComments?: number;
};

/**
 * Book on v2: its navigation in the sidebar, a head with the note's views (Bearbeiten, Lesen, Buch) and its open
 * comments, and the reading surface in a `Canvas`. The reader moves between notes without a new page; the head
 * follows each note's snapshot, so its views and comments always belong to the note shown.
 */
export default function BookWorkspace(props: BookWorkspaceProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const book = () => bookMessages.resolve([locale()]).t;
  const comments = () => commentMessages.resolve([locale()]).t;
  const navigator = useBookNavigator(mergeProps(props, { workspaceEntry: false }));
  const initial: BookMetadata = {
    href: props.currentHref,
    title: props.noteTitle,
    notebookName: props.notebookName,
    selectedNoteId: props.selectedNoteId,
    hasNotes: props.navigation.total > 0,
    tags: props.tags,
    canWrite: props.canWrite,
    locked: props.locked,
    historyIncomplete: props.historyIncomplete,
    cursor: props.cursor,
    openComments: props.openComments,
  };
  const [shown, setShown] = createSignal(initial);
  onMount(() => {
    const onBook = (event: Event) => setShown((event as CustomEvent<BookMetadata>).detail);
    window.addEventListener(BOOK_SNAPSHOT_EVENT, onBook);
    onCleanup(() => window.removeEventListener(BOOK_SNAPSHOT_EVENT, onBook));
  });
  // Write and Read keep the address's query (the navigation's filters) and only switch the mode.
  const workspaceHref = (mode: "write" | "readonly") =>
    withPresentationMode(shown().selectedNoteId ? shown().href : `/app/notebooks/${props.notebookId}`, mode);
  const openComments = () => (shown().selectedNoteId ? (shown().openComments ?? 0) : 0);

  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree. */}
      <WorkspaceNavigationProvider navigation={navigator.mobileNavigation} label={navigator.state().notebookName} />
      <Workspace
        sidebar={<BookNavigatorBody navigator={navigator} />}
        head={
          <Bar
            start={
              // Readers stay in Book: only writers get the way into the workspace, as the navigation's first entry does.
              <Show when={shown().canWrite} fallback={<Text weight="strong">{shown().title ?? shown().notebookName}</Text>}>
                <Tabs
                  label={t().view}
                  items={[
                    ...(shown().selectedNoteId && !shown().locked
                      ? [{ label: t().openAsEdit, icon: "pencil", href: workspaceHref("write") }]
                      : []),
                    { label: t().openAsRead, icon: "eye", href: workspaceHref("readonly") },
                    { label: book().book, icon: "book", current: true, href: withPresentationMode(shown().href, "book") },
                  ]}
                />
              </Show>
            }
            end={
              // the note's open comments: their sign and number, named in words; Read opens at the first of them
              <Show when={openComments() > 0}>
                <Button
                  icon="message-circle"
                  label={comments().bookEntry({ count: openComments() })}
                  title={comments().bookEntry({ count: openComments() })}
                  href={commentsHref(shown().href)}
                  keep
                >
                  {String(openComments())}
                </Button>
              </Show>
            }
          />
        }
      >
        <Pane label={shown().title ?? shown().notebookName}>
          {/* k2b-ui gap: a Canvas cannot fill its pane; the reading surface keeps its own scroller (reading position,
              full width), so the app's stylesheet lets this one Canvas take the pane's height (app.css). */}
          <Canvas label={book().book}>
            <BookReader notebookId={props.notebookId} html={props.html} fullWidth={props.fullWidth} initial={initial} />
          </Canvas>
        </Pane>
      </Workspace>
    </>
  );
}
