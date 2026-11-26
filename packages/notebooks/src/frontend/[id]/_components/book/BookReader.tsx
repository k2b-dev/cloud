import { NoticeCard, Placeholder, useLocale } from "@k2b/ui";
import { notebookWorkspaceMessages } from "../../messages";
import BookCharts from "./BookCharts.island";
import BookController from "./BookController.island";
import BookMermaid from "./BookMermaid.island";
import type { BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export type BookReaderProps = {
  notebookId: string;
  /** The note as Book renders it, or none (no note chosen, or an empty notebook). */
  html: string | null;
  fullWidth: boolean;
  /** What the controller starts from; later notes arrive as snapshots without a new page. */
  initial: BookMetadata;
};

/**
 * Book's reading surface, rendered on the server inside the v2 workspace's `Canvas`: the scroller, the history
 * warning and the article stay markup; the controller, the Mermaid diagrams and the charts are islands beside them.
 * `BookController` finds them by their ids and swaps the article when the reader moves to another note, so these ids
 * and classes are its contract.
 */
export default function BookReader(props: BookReaderProps) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const noteText = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <div class="notebook-document-surface notebook-book-document" data-full-width={props.fullWidth ? "" : undefined}>
      <div class="notebook-book-main" data-scroll-preserve="notebook-book">
        {/* the live refresh says here when it fails, above the note */}
        <BookController notebookId={props.notebookId} initial={props.initial} />
        <div
          id="notebook-book-history-warning"
          hidden={!props.initial.historyIncomplete}
          role="status"
          data-print-region={props.initial.historyIncomplete && props.html !== null ? "" : undefined}
        >
          <NoticeCard tone="warning" title={noteText().historyIncompleteTitle} detail={noteText().historyIncompleteDetail} />
        </div>
        {props.html !== null ? (
          <article
            data-print-region=""
            id="notebook-book-content"
            aria-label={props.initial.title ?? undefined}
            tabIndex={-1}
            class="notebook-book-content"
            innerHTML={props.html}
          />
        ) : (
          <article id="notebook-book-content" class="notebook-book-content" tabIndex={-1}>
            <Placeholder icon="ti ti-book" description={props.initial.hasNotes ? t().selectNote : t().empty} />
          </article>
        )}
        {/* each finds the server's article when it mounts */}
        <BookMermaid rootId="notebook-book-content" />
        <BookCharts rootId="notebook-book-content" />
      </div>
    </div>
  );
}
