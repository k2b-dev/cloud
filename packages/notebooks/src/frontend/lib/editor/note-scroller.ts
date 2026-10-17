import { EditorView, ViewPlugin } from "@codemirror/view";

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
 * CodeMirror builds the lines it scrolled to in several DOM steps. A layout
 * between them sees a note shorter than its height map, and the page scroller
 * clamps its position to that height. WebKit runs such a layout when a widget
 * parses an SVG `viewBox` or path (the notice icon does) while the page has a
 * size container, which every app area is. A height set during the update
 * does not reach that layout in WebKit, so the content already holds the
 * height CodeMirror knew after the last update when the next one starts. It
 * follows the height map after each update, once CodeMirror has kept the
 * visible lines in place, so a shorter note still ends its scroll range there.
 */
const holdKnownHeight = (view: EditorView) => {
  const minHeight = `${view.contentHeight}px`;
  if (view.contentDOM.style.minHeight !== minHeight) view.contentDOM.style.minHeight = minHeight;
};

const keepKnownHeight = [
  ViewPlugin.define((view) => {
    holdKnownHeight(view);
    return { destroy: () => view.contentDOM.style.removeProperty("min-height") };
  }),
  EditorView.updateListener.of((update) => holdKnownHeight(update.view)),
];

/** The page scrolls the note; CodeMirror only renders it. */
export const noteScroller = [noteScrollerTheme, keepKnownHeight];
