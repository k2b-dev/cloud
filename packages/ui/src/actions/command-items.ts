import type { JSX } from "solid-js";

/**
 * One entry of a command list: the slash menu of `MarkdownEditor` and `CommandMenu` read the same entries, so a
 * composer's `/`, its "+" button, and a chip offer one list.
 */
export type CommandItem = {
  label: string;
  /** Heading above the entry. Entries of one group stand together, in the order the groups first appear. */
  group?: string;
  /** Quiet text at the end of the row, such as what a person can type: `/telefonat`. It is searched, too. */
  hint?: string;
  /** Tabler icon class, such as `ti ti-phone`. */
  icon?: string;
  /**
   * Renders the start of the row in place of the icon, such as an avatar or a tag's color. A function, so each row
   * gets its own element.
   */
  leading?: () => JSX.Element;
  /** Further words that find the entry, such as "anruf" for "Phone call". */
  keywords?: readonly string[];
  /** Unavailable now: the entry stays in the list, greyed, with this one-line reason, and cannot be chosen. */
  disabled?: string;
  /** Stable key, when two entries share group and label. */
  id?: string;
} & (
  | {
      /** Runs when the entry is chosen. In the editor, the typed `/query` has left the text first. */
      onSelect: () => void;
      text?: never;
      next?: never;
    }
  | {
      /** Text that takes the place of the typed `/query`; `CommandMenu` hands it to `onInsert`. */
      text: string;
      onSelect?: never;
      next?: never;
    }
  | {
      /** A second list in the same popover, such as people to assign. */
      next: CommandStep;
      onSelect?: never;
      text?: never;
    }
);

/** The entries of a list, or a function that returns them for a query, for a list the application filters itself. */
export type CommandSource = readonly CommandItem[] | ((query: string) => readonly CommandItem[]);

/** A second list in the same popover. Escape, or Backspace on an empty query, goes back. */
export type CommandStep = {
  /** Names the list and is the search hint, such as "Search person". */
  label: string;
  items: CommandSource;
};

export type CommandGroup = { label?: string; entries: { item: CommandItem; index: number }[] };

const marks = /\p{M}/gu;
const fold = (text: string) => text.normalize("NFD").replace(marks, "").toLowerCase().replace(/ß/g, "ss");
// German writes ä as ae where umlauts are missing, so "zustaendig" finds "zuständig" as well as "zustandig" does.
const spellOut = (text: string) => text.normalize("NFC").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");

// Built on every search, not cached by entry: an application may change an entry in place, such as its label.
const haystackOf = (item: CommandItem): string => {
  const text = [item.label, item.hint?.replace(/^\//, ""), ...(item.keywords ?? [])].filter(Boolean).join(" ");
  return `${fold(text)} ${fold(spellOut(text))}`;
};

/**
 * The entries whose label, hint, or keywords contain every word of the query, ignoring case and accents, in their
 * order. A blank query keeps all.
 */
export const filterCommandItems = (items: readonly CommandItem[], query: string): readonly CommandItem[] => {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const haystack = haystackOf(item);
    return words.every((word) => haystack.includes(word));
  });
};

/** The entries of a source for a query: a list is filtered here, a function filters itself. */
export const resolveCommandSource = (source: CommandSource, query: string): readonly CommandItem[] =>
  typeof source === "function" ? source(query) : filterCommandItems(source, query);

/** Groups in the order they first appear; `index` is the entry's place in the order the list shows. */
export const groupCommandItems = (items: readonly CommandItem[]): CommandGroup[] => {
  const groups: CommandGroup[] = [];
  const byLabel = new Map<string | undefined, CommandGroup>();
  for (const item of items) {
    let group = byLabel.get(item.group);
    if (!group) {
      group = { label: item.group, entries: [] };
      byLabel.set(item.group, group);
      groups.push(group);
    }
    group.entries.push({ item, index: 0 });
  }
  let index = 0;
  for (const group of groups) for (const entry of group.entries) entry.index = index++;
  return groups;
};

export const commandKey = (item: CommandItem): string => item.id ?? `${item.group ?? ""}\u0000${item.label}`;
