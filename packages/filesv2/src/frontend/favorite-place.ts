import type { MarkedEntry } from "../contracts";

/** Where a favorite sits: its storage label, then its folders. */
export const favoritePlace = (item: MarkedEntry, bases: readonly { id: string; label: string }[]) =>
  [
    bases.find((base) => base.id === item.base.id)?.label ?? item.base.name,
    ...item.entry.path.split("/").filter(Boolean).slice(0, -1),
  ].join(" / ");
