import { EditorView } from "@codemirror/view";

const lineBox = (view: EditorView, from: number) => {
  const line = view.state.doc.lineAt(Math.min(from, view.state.doc.length));
  // The drawn line's own box, read from the live layout. The boxes of its first and last characters would sit inside
  // the line height by half the gap between the type and its line, a fraction of a pixel at some sizes (14 px on
  // 22 px), which moves the text each time the correction rounds it.
  const node = view.coordsAtPos(line.from, 1) ? view.domAtPos(line.from).node : null;
  const drawn = (node instanceof Element ? node : node?.parentElement)?.closest(".cm-line");
  if (drawn && view.contentDOM.contains(drawn)) {
    const { top, height } = drawn.getBoundingClientRect();
    return { top, height: Math.max(1, height) };
  }
  // A large rewrap can leave the line outside the range the editor draws;
  // its height map still places it, with estimated heights.
  const block = view.lineBlockAt(line.from);
  return { top: view.documentTop + block.top, height: Math.max(1, block.height) };
};

/**
 * Showing or hiding a side region, or switching "Full width", rewraps every
 * line of the note. Call this before the change and the returned function
 * right after it, before the next paint: the text at the top of the scroll
 * port stays there, and the selection and focus are untouched.
 */
export const keepReadingPosition = (
  view: EditorView,
  scroller: HTMLElement,
  /** A view switch keeps a visible selection where it is: the edge line may be a grid that changes height. */
  options: { selection?: boolean } = {},
): (() => void) => {
  // The editor learns about scrolling from scroll events, which arrive with
  // the next frame and are ignored until it knows it is visible. Until it
  // measures, the port's top edge may show only a placeholder gap to it, with
  // no line to anchor on. The layout read below runs the requested measure
  // first, so the anchor is the text that is actually there.
  view.requestMeasure();
  const portTop = scroller.getBoundingClientRect().top;
  const edge = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: portTop + 1 }, false);
  const selected = options.selection ? view.state.doc.lineAt(view.state.selection.main.head).from : undefined;
  const selectedBox = selected === undefined ? undefined : lineBox(view, selected);
  const visible =
    selectedBox && selectedBox.top >= portTop - 1 && selectedBox.top + selectedBox.height <= scroller.getBoundingClientRect().bottom;
  const from = visible ? selected! : view.state.doc.lineAt(edge).from;
  const before = visible ? selectedBox : lineBox(view, from);
  // Nothing above the port's top edge can move while the note starts below it.
  const moves = view.documentTop < portTop;
  // How far the line starts above the edge, or below it. In whole pixels,
  // like the correction: a sub-pixel rest of the scroll offset is no reading
  // position, and the share would scale it with the line's new height on
  // every switch.
  const above = Math.round(portTop - before.top);
  // Within the line's first row a rewrap moves nothing above the edge, so the distance itself is kept; further down,
  // the share of the line, which keeps a long paragraph's reading place.
  const firstRow = above < view.defaultLineHeight;
  const within = firstRow ? 0 : above / before.height;
  const offset = firstRow ? -above : 0;
  return () => {
    // The editor takes in the new width now instead of a frame late. A
    // focused one, also one that just got focus from the navigation, scrolls
    // by itself while it measures, to keep the top of the line at the edge in
    // place; correcting before that would count the rewrap twice. The layout
    // read below runs this measure, and the correction only adds the rest.
    //
    // A correction onto lines the editor had not drawn lands on estimated
    // heights. The next measure draws them, so the loop corrects again until
    // the line holds still; three passes settle even a switch between the
    // reading column and the full width of a large screen.
    for (let pass = 0; pass < 3; pass++) {
      view.requestMeasure();
      if (!moves) return;
      const after = lineBox(view, from);
      // WebKit drops a fraction of a pixel from the scroll offset.
      const delta = Math.round(after.top + within * after.height - offset - scroller.getBoundingClientRect().top);
      if (delta === 0) return;
      scroller.scrollTop += delta;
    }
  };
};

/** The line at a scroll port's top edge, from 1, and how far into that line the edge falls, in line heights. */
export type ReadingPosition = { line: number; within: number };

/**
 * Where the reader scrolled the note's server preview, whose line rows match
 * the editor's lines one to one; null while it shows the top of the note.
 */
export const previewReadingPosition = (preview: HTMLElement): ReadingPosition | null => {
  const scroller = preview.querySelector<HTMLElement>(".k2b-scroll-area");
  if (!scroller || scroller.scrollTop < 1) return null;
  const portTop = scroller.getBoundingClientRect().top;
  const rows = preview.querySelectorAll<HTMLElement>(".notebook-note-preview__line");
  for (let index = 0; index < rows.length; index++) {
    const box = rows[index]!.getBoundingClientRect();
    if (box.bottom > portTop || index === rows.length - 1) {
      return { line: index + 1, within: (portTop - box.top) / Math.max(1, box.height) };
    }
  }
  return null;
};

/** Scrolls the editor so the given line sits at the port's top edge as it did in the preview, before the next paint. */
export const scrollToReadingPosition = (view: EditorView, scroller: HTMLElement, position: ReadingPosition) => {
  const from = view.state.doc.line(Math.min(position.line, view.state.doc.lines)).from;
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start" }) });
  // Reading a position runs that scroll's measure now, so the line has its real height and place.
  view.coordsAtPos(from);
  // The whole line box, as the preview row measured it, not only its text.
  const block = view.lineBlockAt(from);
  const delta = view.documentTop + block.top + position.within * block.height - scroller.getBoundingClientRect().top;
  if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
};
