import { useLocale } from "@k2b/ui";
import { Bar, Button, Tabs } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { notebookWorkspaceMessages } from "../../messages";
import { commentMessages } from "../comments/messages";
import NoteViewMenu from "../NoteViewMenu";
import { commentsHref } from "./book-comments";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export type BookHeadProps = {
  notebookId: string;
  /** The server's full-width cookie value, so the first frame matches. */
  fullWidth: boolean;
  /** The note the page opened with; later notes arrive as snapshots without a new page. */
  initial: BookMetadata;
};

/**
 * Book's head, as the note's head: the note's views (Bearbeiten, Lesen, Buch) for writers or the notebook's name for
 * readers, the view menu and the note's open comments. The reader moves between notes without a new page, so the head follows each note's snapshot:
 * its views and comments always belong to the note shown. The note's own title is the article's first heading.
 */
export default function BookHead(props: BookHeadProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const book = () => bookMessages.resolve([locale()]).t;
  const comments = () => commentMessages.resolve([locale()]).t;
  const [shown, setShown] = createSignal(props.initial);
  onMount(() => {
    const onBook = (event: Event) => setShown((event as CustomEvent<BookMetadata>).detail);
    window.addEventListener(BOOK_SNAPSHOT_EVENT, onBook);
    onCleanup(() => window.removeEventListener(BOOK_SNAPSHOT_EVENT, onBook));
  });
  // Write and Read keep the address's query (the navigation's filters) and only switch the mode.
  const workspaceHref = (mode: "write" | "readonly") =>
    withPresentationMode(shown().selectedNoteId ? shown().href : `/app/notebooks/${props.notebookId}`, mode);
  const openComments = () => (shown().selectedNoteId ? (shown().openComments ?? 0) : 0);
  const entry = () => comments().bookEntry({ count: openComments() });

  return (
    <Bar
      start={
        // Readers stay in Book: only writers get the way into the workspace, as the note's head offers it. The notebook's
        // name stands in the sidebar's switcher; the head may name it only while the sidebar is hidden or a drawer,
        // which v2's Workspace does not offer a place for yet (k2b-ui gap, lane Z2). The note's title is the article's
        // first heading.
        <Show when={shown().canWrite}>
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
        <>
          <NoteViewMenu
            mode="read"
            fullWidth={props.fullWidth}
            initialRich
            host={() => document.querySelector(".notebook-book-document")}
          />
          {/* the note's open comments: their sign and number, named in words; Read opens at the first of them */}
          <Show when={openComments() > 0}>
            <Button icon="message-circle" label={entry()} title={entry()} href={commentsHref(shown().href)} keep>
              {String(openComments())}
            </Button>
          </Show>
        </>
      }
    />
  );
}
