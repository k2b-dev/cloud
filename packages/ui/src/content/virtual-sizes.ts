/**
 * The size model of a virtual list, shared by `VirtualFeed` (chat) and the v2 lists (`List`, `Table`): every item has
 * a height, estimated until it is measured; prefix sums turn heights into offsets, and a binary search finds the item
 * at an offset. Heights belong to an item's key, so a list that changes keeps what it measured. One model, so a list
 * of any kind scales the same way.
 */

/**
 * Writes the offsets of the items `[from, to)` of `sizes` into `offsets` (`offsets[0]` is 0, `offsets[j + 1]` is the
 * bottom of item `from + j`), starting again at `dirtyFrom`, the first offset that may be stale. Returns the offsets,
 * a new array when the count of items changed.
 */
export const prefixOffsets = (sizes: Float64Array<ArrayBuffer>, from: number, to: number, offsets: Float64Array<ArrayBuffer>, dirtyFrom: number): Float64Array<ArrayBuffer> => {
  const length = to - from;
  let start = dirtyFrom;
  let out = offsets;
  if (out.length !== length + 1) {
    out = new Float64Array(length + 1);
    start = 0;
  }
  for (let j = start; j < length; j++) out[j + 1] = out[j]! + sizes[from + j]!;
  return out;
};

/** The position (from 0) among the first `count` items of `offsets` of the item whose bottom edge lies below `y`. */
export const indexAtOffset = (offsets: Float64Array<ArrayBuffer>, count: number, y: number): number => {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle + 1]! <= y) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low);
};

/**
 * The heights of a list that changed: an item keeps the height measured under its key, a new item gets its estimate.
 * Returns null when no key is known any more (a new list, which starts afresh).
 */
export const carrySizes = (
  previousKeys: readonly string[],
  previousSizes: Float64Array<ArrayBuffer>,
  nextKeys: readonly string[],
  estimate: (index: number) => number,
): Float64Array<ArrayBuffer> | null => {
  const known = new Map<string, number>();
  for (let index = 0; index < previousKeys.length; index++) known.set(previousKeys[index]!, previousSizes[index]!);
  if (!nextKeys.some((key) => known.has(key))) return null;
  const sizes = new Float64Array(nextKeys.length);
  for (let index = 0; index < nextKeys.length; index++) sizes[index] = known.get(nextKeys[index]!) ?? estimate(index);
  return sizes;
};
