import { createMemo, For, type JSX } from "solid-js";

/** A half-open `[start, end)` range of Unicode code points. */
export type MatchRange = readonly [number, number];
export type MatchTextProps = {
  text: string;
  /** Code point ranges to mark, as search engines such as Filegate return them; not UTF-16 offsets. */
  ranges?: readonly MatchRange[];
};

/** Splits text into marked and plain parts. Ranges are clipped to the text, sorted, and merged when they touch. */
export function matchParts(text: string, ranges: readonly MatchRange[] = []): { text: string; hit: boolean }[] {
  const points = Array.from(text);
  const merged: [number, number][] = [];
  for (const [rawStart, rawEnd] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(0, Math.min(points.length, Math.trunc(rawStart)));
    const end = Math.max(start, Math.min(points.length, Math.trunc(rawEnd)));
    if (end === start) continue;
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) parts.push({ text: points.slice(at, start).join(""), hit: false });
    parts.push({ text: points.slice(start, end).join(""), hit: true });
    at = end;
  }
  if (at < points.length || !parts.length) parts.push({ text: points.slice(at).join(""), hit: false });
  return parts;
}

/**
 * Text with its search matches marked, for result names and paths. It renders inline text and `mark` elements
 * only, so the host's element keeps truncating and styling the whole text. The marks change only the fill, never
 * the text's width, and screen readers read the text unchanged.
 * @example <span class="name"><MatchText text="Rechnung Oktober.pdf" ranges={[[0, 8]]} /></span>
 */
export function MatchText(props: MatchTextProps): JSX.Element {
  const parts = createMemo(() => matchParts(props.text, props.ranges));
  return <For each={parts()}>{(part) => (part.hit ? <mark class="k2b-match-text__hit">{part.text}</mark> : part.text)}</For>;
}
export default MatchText;
