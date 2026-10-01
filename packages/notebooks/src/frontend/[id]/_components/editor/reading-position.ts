import type { EditorView } from "@codemirror/view";

const lineBox = (view: EditorView, from: number) => {
  const line = view.state.doc.lineAt(Math.min(from, view.state.doc.length));
  const top = view.coordsAtPos(line.from, 1)?.top;
  const bottom = view.coordsAtPos(line.to, -1)?.bottom;
  return top === undefined || bottom === undefined ? null : { top, height: Math.max(1, bottom - top) };
};

/**
 * Showing or hiding a side region rewraps every line of the note. Call this
 * before the region changes and the returned function right after it, before
 * the next paint: the text at the top of the scroll port stays there, and the
 * selection and focus are untouched.
 */
export const keepReadingPosition = (view: EditorView, scroller: HTMLElement): (() => void) => {
  // The editor learns about scrolling from scroll events, which arrive with
  // the next frame and are ignored until it knows it is visible. Until it
  // measures, the port's top edge may show only a placeholder gap to it, with
  // no line to anchor on. The layout read below runs the requested measure
  // first, so the anchor is the text that is actually there.
  view.requestMeasure();
  const portTop = scroller.getBoundingClientRect().top;
  const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: portTop + 1 }, false);
  const from = view.state.doc.lineAt(pos).from;
  const before = lineBox(view, from);
  // Nothing above the port's top edge can move while the note starts below it.
  const within = before && before.top < portTop ? (portTop - before.top) / before.height : null;
  return () => {
    // The editor takes in the new width now instead of a frame late. A
    // focused one, also one that just got focus from the navigation, scrolls
    // by itself while it measures, to keep the top of the line at the edge in
    // place; correcting before that would count the rewrap twice. The layout
    // read below runs this measure, and the correction only adds the rest.
    view.requestMeasure();
    if (within === null) return;
    const after = lineBox(view, from);
    if (!after) return;
    const delta = after.top + within * after.height - scroller.getBoundingClientRect().top;
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  };
};
