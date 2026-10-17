import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * The note page's arrangement: CodeMirror grows inside the page's scroll area
 * and insets the text by 1rem, also on a phone. The reading column centers in
 * the rest.
 */
const noteScrollerTheme = EditorView.theme({
  ".cm-editor": { minHeight: "100%" },
  ".cm-scroller": { width: "100%", minHeight: "100%", padding: "1rem" },
  // The page scrolls, not CodeMirror. Clipping sideways makes the scroller no
  // scroll container, so CodeMirror cannot shift the text sideways to follow
  // a caret behind spaces that hang past the column (see `richFontCSS`).
  "&.cm-editor .cm-scroller": { overflowX: "clip", overflowY: "visible" },
});

/**
 * CodeMirror swaps the rendered lines in several DOM steps: it removes the old
 * lines, builds the new ones, and only then resizes the gaps around them. A
 * layout between those steps sees a note that is shorter by the rendered
 * lines, and the page scroller clamps its position to that height. WebKit runs
 * such a layout when a widget parses an SVG `viewBox` or path while the page
 * has a size container, which every app area is. The content keeps the height
 * CodeMirror knows from its height map, so no layout in between can move the
 * page.
 */
const keepKnownHeight = ViewPlugin.fromClass(
  class {
    private readonly measure = {
      key: this,
      read: (view: EditorView) => view.contentHeight,
      write: (height: number, view: EditorView) => {
        const minHeight = `${height}px`;
        if (view.contentDOM.style.minHeight !== minHeight) view.contentDOM.style.minHeight = minHeight;
      },
    };

    constructor(view: EditorView) {
      view.requestMeasure(this.measure);
    }

    // CodeMirror rewrites the content's style attribute when its attributes change, so every update checks again.
    update(update: ViewUpdate) {
      update.view.requestMeasure(this.measure);
    }
  },
);

/** The page scrolls the note; CodeMirror only renders it. */
export const noteScroller = [noteScrollerTheme, keepKnownHeight];
