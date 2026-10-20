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
