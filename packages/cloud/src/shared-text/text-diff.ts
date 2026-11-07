import { type ArrayChange, diffArrays } from "diff";

type TextDiff = { index: number; deleteCount: number; insert: string };

const splitsSurrogatePair = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
};

/** One replacement retaining the shared prefix and suffix at Unicode boundaries. */
export const minimalTextDiff = (before: string, after: string): { index: number; deleteCount: number; insert: string } => {
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) index++;
  if (splitsSurrogatePair(before, index) || splitsSurrogatePair(after, index)) index--;

  let suffix = 0;
  while (
    suffix < before.length - index &&
    suffix < after.length - index &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  if (splitsSurrogatePair(before, before.length - suffix) || splitsSurrogatePair(after, after.length - suffix)) suffix--;

  return { index, deleteCount: before.length - index - suffix, insert: after.slice(index, after.length - suffix) };
};

/** Convert adjacent additions/deletions into replacements in the original text's UTF-16 offsets. */
const replacements = (parts: ArrayChange<string>[], offset: number): TextDiff[] => {
  const hunks: TextDiff[] = [];
  let index = offset;
  let pending: TextDiff | undefined;
  for (const part of parts) {
    const value = part.value.join("");
    if (!part.added && !part.removed) {
      if (pending) hunks.push(pending);
      pending = undefined;
      index += value.length;
    } else {
      pending ??= { index, deleteCount: 0, insert: "" };
      if (part.removed) {
        pending.deleteCount += value.length;
        index += value.length;
      } else pending.insert += value;
    }
  }
  if (pending) hunks.push(pending);
  return hunks;
};

/**
 * Ascending, non-overlapping hunks. Unchanged lines are matched first; only
 * changed blocks are refined into Unicode code points (never half a surrogate).
 * The log's payload budget bounds comparisons across both passes; comparing two
 * tokens of equal length costs one more unit per 64 characters, since only those
 * compare beyond their length. The square root bounds Myers's quadratic edit frontier.
 * When either budget runs out, retain the old prefix/suffix replacement for
 * that region: text correctness takes precedence over best-effort item identity.
 */
export const textDiffHunks = (before: string, after: string, maxPayloadBytes: number): TextDiff[] => {
  if (before === after) return [];
  let remaining = maxPayloadBytes;
  const exhausted = Symbol("diff budget exhausted");
  const compare = (a: string, b: string) => {
    remaining -= 1 + (a.length === b.length ? a.length >> 6 : 0);
    if (remaining < 0) throw exhausted;
    return a === b;
  };
  const diff = (a: string[], b: string[]) => {
    if (remaining <= 0) return undefined;
    try {
      return diffArrays(a, b, { comparator: compare, maxEditLength: Math.floor(Math.sqrt(maxPayloadBytes)) });
    } catch (error) {
      if (error !== exhausted) throw error;
      return undefined;
    }
  };
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  // Lines both texts share at the start and end cost no budget, so a large note with small edits still diffs.
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const offset = a.slice(0, start).reduce((length, line) => length + line.length, 0);
  const lineParts = diff(a.slice(start, a.length - end), b.slice(start, b.length - end));
  if (!lineParts) return [minimalTextDiff(before, after)];
  return replacements(lineParts, offset).flatMap((block) => {
    const oldText = before.slice(block.index, block.index + block.deleteCount);
    const trimmed = minimalTextDiff(oldText, block.insert);
    const index = block.index + trimmed.index;
    const removed = oldText.slice(trimmed.index, trimmed.index + trimmed.deleteCount);
    const charParts = remaining > 0 && removed && trimmed.insert ? diff(Array.from(removed), Array.from(trimmed.insert)) : undefined;
    return charParts ? replacements(charParts, index) : [{ ...trimmed, index }];
  });
};
