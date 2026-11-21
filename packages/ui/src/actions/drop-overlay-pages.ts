import type { DropOverlayLevel, DropOverlayTile } from "./DropOverlay";

/** Words of the levels that `dropOverlayPages` makes; the application owns them. */
export type DropOverlayPageLabels = {
  /** Title of the first level, such as "Assign to someone else · Frequent". */
  title?: string;
  /** Title of the level behind "more", such as "Assign to someone else · More". */
  moreTitle?: string;
  /** The tile that leads on, such as `More ${count} people`. */
  more: (count: number) => string;
  /** A tile for a range of names, such as `${first} – ${last}`. */
  range: (first: string, last: string, count: number) => string;
};

/**
 * Splits a long list of tiles over levels (S7): `id` shows the first `first` tiles (11) and "More N"; behind it come
 * the rest, or, when they do not fit one level, ranges of at most `size` tiles (12) in the given order, each a
 * level of its own. Returns the level for a level id it made, else undefined, so a `DropOverlay`'s `level` can ask
 * it first.
 */
export const dropOverlayPages = (
  id: string,
  tiles: readonly DropOverlayTile[],
  labels: DropOverlayPageLabels,
  { first = 11, size = 12 }: { first?: number; size?: number } = {},
): ((level: string) => DropOverlayLevel | undefined) => {
  const head = tiles.slice(0, first);
  const rest = tiles.slice(first);
  const ranges: DropOverlayTile[][] = [];
  for (let start = 0; rest.length > size && start < rest.length; start += size) ranges.push(rest.slice(start, start + size));
  const more = `${id}:more`;
  return (level) => {
    if (level === id) {
      const lead: DropOverlayTile[] = rest.length ? [{ id: more, label: labels.more(rest.length), icon: "ti ti-dots", opens: more }] : [];
      return { title: labels.title, tiles: [...head, ...lead] };
    }
    if (level === more) {
      if (!ranges.length) return { title: labels.moreTitle, tiles: rest };
      return {
        title: labels.moreTitle,
        tiles: ranges.map((range, index) => ({
          id: `${id}:range:${index}`,
          label: labels.range(range[0]!.label, range.at(-1)!.label, range.length),
          icon: "ti ti-abc",
          opens: `${id}:range:${index}`,
        })),
      };
    }
    const index = level.startsWith(`${id}:range:`) ? Number(level.slice(`${id}:range:`.length)) : -1;
    const range = ranges[index];
    return range ? { title: labels.moreTitle, tiles: range } : undefined;
  };
};
