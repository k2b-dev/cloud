/**
 * Rows in levels for v2 `Table` (`tree`): the keys of a treegrid whose rows take the focus (WAI-ARIA APG, "treegrid",
 * rows focused). Core has a tree for lists but no treegrid, so this small part is ours: which row a key moves to, and
 * which branch it opens or closes. Opening, loading and the announcements stay with the table; `announce` is core's.
 */
import { announce } from "@ui-sdk/core";
import type { BehaviorMessages } from "./messages";

/** One row as it shows now, in reading order. */
export type TreegridRow = {
  key: string;
  /** Its level, from 1. */
  level: number;
  /** The key of the row it stands under, or `null` at the top. */
  parent: string | null;
  /** It has children, also before they load. */
  branch: boolean;
  expanded: boolean;
};

/** What a key does: move the focus to a row, open or close a branch, or open the row itself (Enter). */
export type TreegridStep = { focus: string } | { expand: string } | { collapse: string } | { open: string };

/**
 * The step for `pressed` on the focused row `key`: Up and Down move one row, Home and End to the first and the last,
 * Right opens a closed branch and enters an open one, Left closes an open branch and goes to the parent otherwise,
 * Enter opens the row. Other keys, and keys with Ctrl, Alt or Cmd, do nothing here.
 */
export function treegridStep(
  rows: readonly TreegridRow[],
  key: string,
  pressed: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
): TreegridStep | undefined {
  if (pressed.ctrlKey || pressed.altKey || pressed.metaKey) return undefined;
  const at = rows.findIndex((row) => row.key === key);
  const row = rows[at];
  if (!row) return undefined;
  const to = (other: TreegridRow | undefined) => (other ? { focus: other.key } : undefined);
  switch (pressed.key) {
    case "ArrowDown":
      return to(rows[at + 1]);
    case "ArrowUp":
      return to(rows[at - 1]);
    case "Home":
      return to(rows[0]);
    case "End":
      return to(rows[rows.length - 1]);
    case "ArrowRight": {
      if (!row.branch) return undefined;
      if (!row.expanded) return { expand: key };
      const child = rows[at + 1];
      return child?.parent === key ? { focus: child.key } : undefined;
    }
    case "ArrowLeft":
      if (row.branch && row.expanded) return { collapse: key };
      return row.parent === null ? undefined : { focus: row.parent };
    case "Enter":
      return { open: key };
    default:
      return undefined;
  }
}

/** Says a change of a branch (loading, failed) in the render locale, as the tree of `Nav` does. */
export const announceBranch = (t: BehaviorMessages, type: "loading" | "load-failed", label: string) =>
  announce(type === "loading" ? t.treeLoading({ label }) : t.treeLoadFailed({ label }), { priority: type === "loading" ? "polite" : "assertive" });
