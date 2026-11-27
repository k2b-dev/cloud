/**
 * Command behaviour for v2: a search field over a list that stays open, no popup. The focus stays in the search
 * field while the arrows move the highlight (`aria-activedescendant`); Enter or a press runs the highlighted entry.
 * Core filters (or keeps every entry with `filter: false`, for matches a server found), reports loading and failure,
 * and asks for the next page. No ui-sdk type crosses these exports.
 */
import { command as commandPrimitive } from "@ui-sdk/core/command";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";
import { type BehaviorMessages, useBehaviorMessages } from "./messages";

export type CommandOptions = {
  /** The search text. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** An entry ran (Enter or a press), with its value. */
  onAction?: (value: string) => void;
  /** `false` keeps every entry, for matches a server already found for the text. */
  filter?: false;
  /** Whether the entries are loading or failed; the list is `aria-busy` while loading. */
  status?: "idle" | "loading" | "error";
  /** The highlight or scrolling reached the last entry: the next page can load. */
  onLoadMore?: () => void;
  /** Whether the arrows wrap from the last entry to the first. */
  loop?: boolean;
};

export type CommandParts = {
  Root: SlotComponent;
  /** The search field; it keeps the focus. Name it with `aria-label`. */
  Input: SlotComponent;
  /** The listbox of entries. */
  List: SlotComponent;
  /** One entry: `value`, `label` (what the search reads), `disabled`. */
  Item: SlotComponent;
  Group: SlotComponent;
  GroupLabel: SlotComponent;
};

/** Core's list announcements are English only ("3 results"); these come from the render locale. */
const announce =
  (t: () => BehaviorMessages) =>
  (change: { type: string; count?: number; loading?: boolean }): string | null =>
    change.type !== "results"
      ? null
      : change.loading
        ? t().loading
        : change.count
          ? t().listResults({ count: change.count })
          : t().listEmpty;

/** A search over a list that stays open: the inline form of a select, as a filter's lookup is. */
export function useCommand(options: () => CommandOptions): CommandParts {
  const announcement = announce(useBehaviorMessages());
  const handle = usePrimitive(commandPrimitive, () => ({ ...options(), autoHighlight: false, announcement }));
  return {
    Root: slotComponent(handle, "root", "div"),
    Input: slotComponent(handle, "input", "input"),
    List: slotComponent(handle, "list", "div"),
    Item: slotComponent(handle, "item", "div"),
    Group: slotComponent(handle, "group", "div"),
    GroupLabel: slotComponent(handle, "group-label", "div"),
  };
}
