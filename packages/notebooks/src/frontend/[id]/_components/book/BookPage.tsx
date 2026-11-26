import { useLocale } from "@k2b/ui";
import { Canvas, Pane, Workspace } from "@k2b/ui/v2";
import type { NoteAuthors } from "../../../../lib/activity-actions";
import BookHead from "./BookHead.island";
import type { BookNavigatorProps } from "./BookNavigatorBody";
import BookReader from "./BookReader";
import BookSidebar from "./BookSidebar.island";
import type { BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export type BookPageProps = BookNavigatorProps & {
  fullWidth: boolean;
  html: string | null;
  noteTitle: string | null;
  canWrite: boolean;
  locked: boolean;
  historyIncomplete: boolean;
  cursor: string | null;
  openComments?: number;
  /** Who wrote the note and who changed it last, when known. */
  authors?: NoteAuthors | null;
  /** When the note last changed. */
  updatedAt?: string | null;
  /** The server's time, the base of "vor 4 Min" on both sides. */
  now: string;
};

/**
 * Book on v2, rendered on the server: the frame, its sidebar column and the note's article are markup that the reader
 * reads before any script runs, and a reload or an anchor lands on the article at once. Only the navigation, the head
 * and the reading surface's live parts (moving between notes, diagrams, charts) are islands. The sidebar can be
 * hidden on a wide screen, and the page keeps that for the next one (the app's workspace cookie).
 */
export default function BookPage(props: BookPageProps) {
  const locale = useLocale();
  const book = () => bookMessages.resolve([locale()]).t;
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
    authors: props.authors ?? null,
    updatedAt: props.updatedAt ?? null,
  };
  const navigator: BookNavigatorProps = {
    userId: props.userId,
    notebookId: props.notebookId,
    notebookName: props.notebookName,
    notebookIcon: props.notebookIcon,
    selectedNoteId: props.selectedNoteId,
    navigation: props.navigation,
    tags: props.tags,
    currentHref: props.currentHref,
    canWrite: props.canWrite,
    locked: props.locked,
  };
  return (
    <Workspace
      collapsible
      // k2b-ui gap: Nav tree (link + fold, lazy levels) – Book's v1 navigation body stands in the slot.
      sidebar={<BookSidebar {...navigator} />}
      head={<BookHead notebookId={props.notebookId} fullWidth={props.fullWidth} initial={initial} now={props.now} />}
    >
      <Pane label={props.notebookName}>
        {/* k2b-ui gap: a Canvas cannot fill its pane; the reading surface keeps its own scroller (reading position,
            full width), so the app's stylesheet lets this one Canvas take the pane's height (app.css). */}
        <Canvas label={book().book}>
          <BookReader notebookId={props.notebookId} html={props.html} fullWidth={props.fullWidth} initial={initial} />
        </Canvas>
      </Pane>
    </Workspace>
  );
}
