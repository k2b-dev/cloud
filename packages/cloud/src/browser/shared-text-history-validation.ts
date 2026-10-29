import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";

type NativeFrame = Y.UndoManager["undoStack"][number];
type Span = { from: number; to: number };
type Piece = Span & { original: number | null };

export class SharedTextNativeHistoryError extends Error {
  readonly code = "shared_text_history_target";
  constructor(readonly reason: "dependency" | "unavailable") {
    super("The input history target is unavailable");
  }
}

const intersect = (set: NativeFrame["insertions"], item: Y.Item): Span[] =>
  (set.clients.get(item.id.client) ?? []).flatMap((run) => {
    const from = Math.max(run.clock, item.id.clock) - item.id.clock;
    const to = Math.min(run.clock + run.len, item.id.clock + item.length) - item.id.clock;
    return from < to ? [{ from, to }] : [];
  });
const subtract = (wanted: Span[], excluded: Span[]): Span[] =>
  wanted.flatMap((span) => {
    const result: Span[] = [];
    let from = span.from;
    for (const cut of excluded) {
      if (cut.to <= from || cut.from >= span.to) continue;
      if (cut.from > from) result.push({ from, to: cut.from });
      from = Math.max(from, cut.to);
    }
    if (from < span.to) result.push({ from, to: span.to });
    return result;
  });

type Region = Span & { key: string | undefined };
const regions = (source: string, original: (position: number) => number | null): Region[] =>
  T.findTables(source).flatMap((table) =>
    table.lines.flatMap((line, row) =>
      line.cells.map((_cell, column) => {
        const left = line.leadingPipe ? line.pipes[column]! + 1 : column === 0 ? line.from : line.pipes[column - 1]! + 1;
        const right = (line.leadingPipe ? line.pipes[column + 1] : line.pipes[column]) ?? line.to;
        const separator = table.lines[1]!.cells[column];
        const hyphen = separator ? original(separator.from + separator.text.indexOf("-")) : null;
        const header = original(table.lines[0]!.to);
        const rowIdentity = row < 2 ? row : original(line.from - 1);
        // Extra physical cells have no separator hyphen. Their surviving left
        // delimiter distinguishes them even when columns are inserted/removed.
        // An unknown identity is never evidence that two targets are the same.
        const columnIdentity = separator ? hyphen : original(left - 1);
        return {
          from: left,
          to: right,
          key:
            header === null || rowIdentity === null || columnIdentity === null
              ? undefined
              : `${header}:${rowIdentity}:${separator ? "column" : "extra"}:${columnIdentity}`,
        };
      }),
    ),
  );
const locate = (regions: Region[], position: number, end: number) => {
  let low = 0,
    high = regions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (regions[middle]!.to <= position) low = middle + 1;
    else high = middle;
  }
  const region = regions[low];
  return region && region.from <= position ? { key: region.key, to: region.to } : { key: null, to: region?.from ?? end };
};

/** Project root plain-text native effects without a second manager or live mutation.
 * Identity sets and linked Item/content fields are exported Yjs contracts. Native
 * restoration occupies the original deleted item's gap; redone items already
 * have their effect and are not copied again. Unknown content refuses safely.
 */
export const validateNativeHistory = (
  text: Y.Text,
  frame: NativeFrame,
  liveInsertions: NativeFrame["insertions"],
  baseline: Uint8Array | null,
) => {
  const known = baseline ? Y.decodeStateVector(baseline) : new Map<number, number>();
  const chunks: string[] = [];
  const pieces: Piece[] = [];
  const protectedSpans: { before: number; after: number; length: number }[] = [];
  let before = 0,
    after = 0;
  const append = (value: string, original: number | null) => {
    if (!value.length) return;
    chunks.push(value);
    pieces.push({ from: after, to: after + value.length, original });
    after += value.length;
  };
  for (const item of Y.getTypeChildren(text)) {
    // Adopted frames lack correspondence captured by this controller. Native
    // Undo follows pre-existing redone chains for insertions; projecting only
    // the original IDs would omit their live effects. Leave such frames intact.
    if (baseline === null && item.redone !== null && intersect(frame.insertions, item).length)
      throw new SharedTextNativeHistoryError("unavailable");
    if (item.deleted) {
      const restore = subtract(intersect(frame.deletions, item), intersect(frame.insertions, item));
      if (!restore.length || item.redone !== null) continue;
      const content = item.content;
      if (!(content instanceof Y.ContentString)) throw new SharedTextNativeHistoryError("unavailable");
      for (const span of restore) append(content.str.slice(span.from, span.to), null);
      continue;
    }
    if (!item.countable) continue;
    const content = item.content;
    if (!(content instanceof Y.ContentString)) throw new SharedTextNativeHistoryError("unavailable");
    const keep = subtract([{ from: 0, to: item.length }], intersect(liveInsertions, item));
    for (const span of keep) {
      const newer = Math.max(span.from, (known.get(item.id.client) ?? 0) - item.id.clock);
      if (newer < span.to) protectedSpans.push({ before: before + newer, after: after + newer - span.from, length: span.to - newer });
      append(content.str.slice(span.from, span.to), before + span.from);
    }
    before += item.length;
  }
  const source = text.toString();
  const candidate = chunks.join("");
  if (before !== source.length) throw new SharedTextNativeHistoryError("unavailable");
  const original = (position: number) => {
    let low = 0,
      high = pieces.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pieces[middle]!.to <= position) low = middle + 1;
      else high = middle;
    }
    const piece = pieces[low];
    return piece?.original != null ? piece.original + position - piece.from : null;
  };
  const beforeRegions = regions(source, (position) => position);
  const afterRegions = regions(candidate, original);
  for (const span of protectedSpans) {
    let offset = 0;
    while (offset < span.length) {
      const oldAt = span.before + offset,
        newAt = span.after + offset;
      const oldTarget = locate(beforeRegions, oldAt, source.length);
      const newTarget = locate(afterRegions, newAt, candidate.length);
      if (oldTarget.key === undefined || newTarget.key === undefined || oldTarget.key !== newTarget.key)
        throw new SharedTextNativeHistoryError("dependency");
      const length = Math.min(span.length - offset, oldTarget.to - oldAt, newTarget.to - newAt);
      if (length <= 0) throw new SharedTextNativeHistoryError("unavailable");
      offset += length;
    }
  }
  return candidate;
};
