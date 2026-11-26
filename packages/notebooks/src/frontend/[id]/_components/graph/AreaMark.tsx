/**
 * A note's area as the graph colours it: a dot in the area's colour.
 * k2b-ui gap: v2 has no data-coloured mark yet (`Mark`, #4208); until it lands the graph keeps its own dot.
 */
export default function AreaMark(props: { slot: number }) {
  return <span class="notebook-graph-area-mark" style={{ background: `var(--notebook-graph-area-${props.slot})` }} aria-hidden="true" />;
}

/** A note's sign in its area's colour, as the graph draws the note. Same k2b-ui gap as `AreaMark`. */
export function NoteSign(props: { slot: number }) {
  return (
    <i class="ti ti-file-text notebook-graph-note-sign" style={{ color: `var(--notebook-graph-area-${props.slot})` }} aria-hidden="true" />
  );
}
