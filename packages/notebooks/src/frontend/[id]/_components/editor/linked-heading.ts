import { EditorView } from "@codemirror/view";
import { type Accessor, createEffect, on, onCleanup } from "solid-js";
import { renderedHeadingLine } from "../../../../lib/heading-anchors";

/** A request to open a note at one of its headings, by Book heading id. Each request is a new object. */
export type LinkedHeading = { noteId: string; id: string };

/** Book's rendering of a note: the Markdown it read and the source line of each heading it could place. */
type BookHeadings = { markdown: string; headings: ReadonlyArray<{ id: string; line: number }> };

/**
 * Opens one note editor at the heading a link names, at the line Book gives that heading id. Book owns heading ids,
 * so the editor asks it rather than reading headings itself; a heading Book cannot place opens the note at its top.
 * A jump waits for Book's answer. A newer link, an address that no longer names a heading of this note, or the
 * reader moving the caret or typing cancels it, and the view stays where it is.
 */
export const createLinkedHeadingJump = (options: {
  noteId: string;
  linkedHeading: Accessor<LinkedHeading | null>;
  view: Accessor<EditorView | undefined>;
  /** Book's rendering of the note as this editor shows it. */
  loadHeadings: (abortSignal: AbortSignal) => Promise<BookHeadings>;
  focus: boolean;
}) => {
  let request: AbortController | undefined;
  const cancel = () => {
    request?.abort();
    request = undefined;
  };

  const show = (id: string) => {
    cancel();
    const current = new AbortController();
    request = current;
    void options
      .loadHeadings(current.signal)
      .catch(() => null)
      .then((rendered) => {
        const view = options.view();
        if (current.signal.aborted || !view) return;
        request = undefined;
        const line = rendered ? renderedHeadingLine(rendered, id, view.state.doc.toString()) : null;
        const at = line === null ? 0 : view.state.doc.line(line).from;
        view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start" }) });
        if (options.focus) view.focus();
      });
  };

  // Later links, such as a second click on the same heading or Back and Forward.
  createEffect(on(options.linkedHeading, (linked) => (linked?.noteId === options.noteId ? show(linked.id) : cancel()), { defer: true }));
  onCleanup(cancel);

  return {
    extension: EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.isUserEvent("select") || tr.isUserEvent("input") || tr.isUserEvent("delete"))) cancel();
    }),
    /** Opens the heading the address names when the editor first shows. True when it names a heading of this note. */
    open: (): boolean => {
      const linked = options.linkedHeading();
      if (linked?.noteId !== options.noteId) return false;
      show(linked.id);
      return true;
    },
  };
};
