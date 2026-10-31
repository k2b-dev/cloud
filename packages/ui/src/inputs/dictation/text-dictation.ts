/**
 * Dictation into plain text, such as a textarea: a mark where the next words land and the ranges dictation inserted.
 * Both follow edits the person makes anywhere else, so typing elsewhere never moves the dictated text.
 */
export type TextDictationState = {
  mark: number;
  /** Inserted ranges, as UTF-16 offsets into the current text, in order. */
  ranges: readonly (readonly [number, number])[];
  /** Whether the next insert is the first of a session, which adjusts the space before it. */
  fresh: boolean;
};

export const beginTextDictation = (mark: number): TextDictationState => ({ mark, ranges: [], fresh: true });

/** Where `offset` lands after `previous` became `next`; `after` keeps it behind text inserted exactly at it. */
export const mapTextOffset = (previous: string, next: string, offset: number, after: boolean): number => {
  if (previous === next) return offset;
  const limit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < limit && previous[start] === next[start]) start++;
  let tail = 0;
  while (tail < limit - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const oldEnd = previous.length - tail;
  const newEnd = next.length - tail;
  // Before the change, or exactly at its start and asked to stay before it.
  if (offset < start || (offset === start && !after)) return offset;
  if (offset >= oldEnd) return offset + (newEnd - oldEnd);
  // Inside a replaced stretch: to its new start or end.
  return after ? newEnd : start;
};

/** Follow an edit that dictation did not make. Ranges that the edit removed entirely disappear. */
export const mapTextDictation = (state: TextDictationState, previous: string, next: string): TextDictationState => {
  if (previous === next) return state;
  const ranges: [number, number][] = [];
  for (const [from, to] of state.ranges) {
    const start = mapTextOffset(previous, next, from, true);
    const end = Math.max(start, mapTextOffset(previous, next, to, false));
    if (end > start) ranges.push([start, end]);
  }
  return { ...state, mark: mapTextOffset(previous, next, state.mark, true), ranges };
};

const space = /\s/;

/** Append `text` at the mark. The first words of a session get one space from earlier text, never two. */
export const insertTextDictation = (state: TextDictationState, value: string, text: string): { state: TextDictationState; value: string } => {
  const mark = Math.min(state.mark, value.length);
  let chunk = text;
  if (state.fresh) {
    const before = value[mark - 1];
    if (before === undefined || space.test(before)) chunk = chunk.replace(/^[^\S\n]+/, "");
    else if (chunk && !space.test(chunk[0]!)) chunk = ` ${chunk}`;
  }
  if (!chunk) return { state: { ...state, fresh: state.fresh && !text }, value };
  const length = chunk.length;
  const ranges: [number, number][] = [];
  let joined = false;
  for (const [from, to] of state.ranges) {
    if (to === mark && !joined) {
      ranges.push([from, to + length]);
      joined = true;
    } else if (from >= mark) ranges.push([from + length, to + length]);
    else ranges.push([from, to]);
  }
  if (!joined) {
    ranges.push([mark, mark + length]);
    ranges.sort((a, b) => a[0] - b[0]);
  }
  return {
    state: { mark: mark + length, ranges, fresh: false },
    value: value.slice(0, mark) + chunk + value.slice(mark),
  };
};

/** Remove every dictated range; text that was there before stays. */
export const discardTextDictation = (state: TextDictationState, value: string): { value: string; caret: number } => {
  let next = value;
  let caret = state.mark;
  for (const [from, to] of [...state.ranges].sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, from) + next.slice(to);
    if (caret >= to) caret -= to - from;
    else if (caret > from) caret = from;
  }
  return { value: next, caret: Math.min(caret, next.length) };
};

/**
 * Split highlight segments of a field's text at the newest dictated words and the mark, for an overlay that tints the
 * fresh words and shows where the next ones land. A mark arrives as an empty segment.
 */
export const splitDictationSegments = <T extends { text: string }>(
  segments: readonly T[],
  fresh: readonly (readonly [number, number])[],
  mark: number | undefined,
): (T & { fresh?: boolean; mark?: boolean })[] => {
  const result: (T & { fresh?: boolean; mark?: boolean })[] = [];
  let offset = 0;
  let marked = mark === undefined;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    const cuts = new Set([offset, end]);
    for (const [from, to] of fresh) {
      if (from > offset && from < end) cuts.add(from);
      if (to > offset && to < end) cuts.add(to);
    }
    if (!marked && mark! > offset && mark! < end) cuts.add(mark!);
    const points = [...cuts].sort((a, b) => a - b);
    for (let index = 0; index < points.length; index++) {
      const from = points[index]!;
      if (!marked && mark === from) {
        result.push({ ...segment, text: "", mark: true });
        marked = true;
      }
      const to = points[index + 1];
      if (to === undefined) break;
      const isFresh = fresh.some(([start, stop]) => start <= from && to <= stop);
      result.push({ ...segment, text: segment.text.slice(from - offset, to - offset), ...(isFresh ? { fresh: true } : {}) });
    }
    offset = end;
  }
  if (!marked) result.push({ ...(segments[segments.length - 1] ?? ({ text: "" } as T)), text: "", mark: true });
  return result;
};
