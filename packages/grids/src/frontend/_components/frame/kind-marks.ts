import type { MarkProps } from "@k2b/ui/v2";
import { v2Icon } from "./grids-nav";

/**
 * One mark per kind of thing in a base, the same in every list, table and head of Grids: the colour is the kind's,
 * the symbol the thing's own where it has one (a table's icon), else the kind's.
 */
export const KIND_MARKS = {
  table: { icon: "table", color: "#2563eb" },
  view: { icon: "table-spark", color: "#7c3aed" },
  form: { icon: "forms", color: "#0e7490" },
  documentTemplate: { icon: "file-type-pdf", color: "#c2410c" },
  workflow: { icon: "route", color: "#15803d" },
  app: { icon: "app-window", color: "#be185d" },
} as const satisfies Record<string, MarkProps>;

export type MarkedKind = keyof typeof KIND_MARKS;

/** The mark of one thing of a kind, with its own icon (`ti ti-…` or a bare name) where it has one. */
export const kindMark = (kind: MarkedKind, icon?: string | null): MarkProps => ({
  icon: v2Icon(icon, KIND_MARKS[kind].icon),
  color: KIND_MARKS[kind].color,
});
