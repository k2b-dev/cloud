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

/** The nearest ancestor that scrolls vertically: the page's scroll area. */
const scrollParent = (element: HTMLElement) => {
  for (let parent = element.parentElement; parent; parent = parent.parentElement)
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return parent;
  return null;
};

/** The line block at the scroller's top edge and how far into it the edge falls, in its heights. */
type ReadingAnchor = { width: number; from: number; within: number } | { width: number; from: null };

/**
 * A sidebar, panel or window resize changes the column width on every frame and rewraps lines above the page's top
 * edge. CodeMirror keeps the text in place in a page scroller only while it has focus, which the drag took away, and
 * only from the frame after the browser painted the rewrap. Either way the note jumps on every rewrap. This measures
 * the editor in the frame the scroller resizes, before the paint, and keeps the line at the top edge where it was.
 */
const holdReadingPosition = ViewPlugin.fromClass(
  class {
    private scroller: HTMLElement | null = null;
    private anchor: ReadingAnchor | null = null;
    private readonly resize = new ResizeObserver(() => this.hold());
    private readonly capture = { key: this, read: () => this.readAnchor() };
    private readonly onScroll = () => this.view.requestMeasure(this.capture);

    constructor(private readonly view: EditorView) {}

    update({ view, docChanged, changes }: ViewUpdate) {
      if (this.anchor?.from != null && docChanged) this.anchor.from = changes.mapPos(this.anchor.from);
      if (this.scroller || !view.dom.isConnected) return;
      this.scroller = scrollParent(view.dom);
      if (!this.scroller) return;
      this.resize.observe(this.scroller);
      this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
      view.requestMeasure(this.capture);
    }

    destroy() {
      this.resize.disconnect();
      this.scroller?.removeEventListener("scroll", this.onScroll);
    }

    /** Records where the reader is, unless the width changed since: then the resize callback still needs the old place. */
    private readAnchor() {
      const width = this.view.contentDOM.getBoundingClientRect().width;
      if (!this.anchor || Math.abs(this.anchor.width - width) < 0.5) this.anchor = this.measureAnchor(width);
    }

    private measureAnchor(width: number): ReadingAnchor {
      const edge = this.scroller!.getBoundingClientRect().top - this.view.documentTop;
      // Nothing above the top edge can move while the note starts below it.
      if (edge <= 0) return { width, from: null };
      const block = this.view.lineBlockAtHeight(edge);
      return { width, from: block.from, within: (edge - block.top) / Math.max(1, block.height) };
    }

    private hold() {
      const { view, scroller, anchor } = this;
      if (!scroller || !view.dom.isConnected) return;
      const width = view.contentDOM.getBoundingClientRect().width;
      if (anchor?.from != null && Math.abs(anchor.width - width) >= 0.5) {
        // Reading the layout runs the requested measure now. A focused editor corrects part of the rewrap itself;
        // this adds only the rest. A correction onto lines it had not drawn lands on estimated heights; the next pass
        // draws them, and three passes settle.
        for (let pass = 0; pass < 3; pass++) {
          view.requestMeasure();
          // Any layout read runs the requested measure first; the block is then at its new place.
          view.lineBlockAtHeight(0);
          const block = view.lineBlockAt(Math.min(anchor.from, view.state.doc.length));
          const edge = scroller.getBoundingClientRect().top - view.documentTop;
          // WebKit drops a fraction of a pixel from the scroll offset.
          const delta = Math.round(block.top + anchor.within * block.height - edge);
          if (delta === 0) break;
          scroller.scrollTop += delta;
        }
      }
      this.anchor = this.measureAnchor(width);
    }
  },
);

/** The page scrolls the note; CodeMirror only renders it. */
export const noteScroller = [noteScrollerTheme, lockHeightWhileRendering, holdReadingPosition];
