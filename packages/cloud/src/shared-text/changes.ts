import type { SharedTextChange } from "./types";

export const validateChanges = (text: string, changes: readonly SharedTextChange[], maxLength: number): SharedTextChange[] => {
  const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
  let length = text.length;
  const splitsCharacter = (at: number) =>
    at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
  for (let index = 0; index < sorted.length; index++) {
    const change = sorted[index]!;
    const previous = sorted[index - 1];
    if (
      !Number.isSafeInteger(change.from) ||
      !Number.isSafeInteger(change.to) ||
      change.from < 0 ||
      change.to < change.from ||
      change.to > text.length ||
      (change.recreate === true && change.to === change.from) ||
      (previous && (change.from < previous.to || change.from === previous.from))
    )
      throw new RangeError("Shared text changes must have distinct, non-overlapping original-source ranges");
    if (splitsCharacter(change.from) || splitsCharacter(change.to) || !change.insert.isWellFormed())
      throw new RangeError("Shared text changes must preserve Unicode characters");
    length += change.insert.length - (change.to - change.from);
  }
  if (length > maxLength) throw new RangeError("Shared text changes exceed maxLength");
  return sorted.filter((change) => change.recreate === true || text.slice(change.from, change.to) !== change.insert);
};
