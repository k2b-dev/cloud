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
 * CodeMirror builds the lines it scrolled to in several DOM steps and locks the
 * content's height only for the last one. A layout between the earlier steps
 * sees a note shorter than its height map, and the page scroller clamps its
 * position to that height. WebKit runs such a layout when a widget parses an
 * SVG `viewBox` or path (the notice icon does) while the page has a size
 * container, which every app area is. This holds the height for the whole DOM
 * update. WebKit's layout during the update uses the content's style from
 * before it, so the lock is resolved at once; releasing it with the update
 * keeps CodeMirror's own measuring and scroll correction as they were.
 */
const lockHeightWhileRendering = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {}

    // Plugins update right before CodeMirror's DOM update, with the height it knows from its height map.
    // CSS pixels, as in CodeMirror's own lock.
    update({ view }: ViewUpdate) {
      const content = view.contentDOM;
      content.style.minHeight = `${view.contentHeight / view.scaleY}px`;
      void getComputedStyle(content).minHeight;
      // An update that draws nothing ends without `docViewUpdate`.
      queueMicrotask(() => this.release());
    }

    docViewUpdate() {
      this.release();
    }

    destroy() {
      this.release();
    }

    private release() {
      this.view.contentDOM.style.removeProperty("min-height");
    }
  },
);

/** The page scrolls the note; CodeMirror only renders it. */
export const noteScroller = [noteScrollerTheme, lockHeightWhileRendering];
