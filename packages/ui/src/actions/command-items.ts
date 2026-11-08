import type { JSX } from "solid-js";

/**
 * One entry of a command list: the slash menu of `MarkdownEditor` and `CommandMenu` read the same entries, so a
 * composer's `/`, its "+" button, and a chip offer one list.
 */
/** Where a slash at `start` stands in `value`: the text before it and whether only whitespace precedes it, overall or on its line. */
export const commandPlace = (value: string, start: number, end: number) => {
  const before = value.slice(0, start);
  return {
    text: before + value.slice(end),
    before,
    atStart: before.trim() === "",
    lineStart: before.slice(before.lastIndexOf("\n") + 1).trim() === "",
  };
};

export type CommandItem = {
  label: string;
  /** Heading above the entry. Entries of one group stand together, in the order the groups first appear. */
  group?: string;
  /** One quiet line of what the entry does, after the label on the same line, such as "Preis aus dem Text prüfen". */
  description?: string;
  /** Quiet text at the end of the row, such as what a person can type: `/telefonat`. It is searched, too. */
  hint?: string;
  /** Tabler icon class, such as `ti ti-phone`. */
  icon?: string;
  /**
   * An image at icon size in place of the icon, such as a service's logo: a URL, or one for each theme when the logo
   * needs a light variant on dark surfaces. It is decorative; the label names the entry.
   */
  image?: string | { light: string; dark: string };
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
      /**
       * Runs when the entry is chosen, with the text it acts on. In the editor, the typed `/query` has left the text
       * first. A returned promise keeps the list open with the entry busy; any other result counts as done; a rejection shows its message on the entry,
       * which can then run again, and Escape aborts `context.signal`.
       */
      onSelect: (context: CommandContext) => unknown;
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

/**
 * Where a command list is and what it acts on: one context for the entries of every level and for `onSelect`. In
 * `SlashCommands` the text is the editor's, without the typed `/query`; in `CommandMenu` it is the text of its `target`
 * field, or empty without one.
 */
export type CommandContext = {
  /** What the person typed after `/`, or into the menu's search field. */
  query: string;
  /** The whole text without the typed `/query`. */
  text: string;
  /** The text before the slash, or before the caret in `CommandMenu`. */
  before: string;
  /** Whether the slash is the first character of the text, leading whitespace aside. */
  atStart: boolean;
  /** Whether the slash starts a line, leading whitespace aside. */
  lineStart: boolean;
  /** The selection in `text`; `start === end` is the caret. */
  selection: { start: number; end: number };
  /** The entries chosen so far on the way to this level, such as `[assign, person]` on the third. */
  path: readonly CommandItem[];
  /**
   * Puts text at the caret in place of the selection, as typing would, so undo keeps working. Without a `target`,
   * `CommandMenu` hands it to `onInsert`. Meant for `onSelect`.
   */
  insert: (text: string) => void;
  /**
   * Reports what a command did, such as "Valentin Brandt zugewiesen": after the command finished, the list gives way to
   * a short confirmation in the same place. Meant for `onSelect`; an entry source has its own loading and failure.
   */
  success: (message: string) => void;
  /**
   * Reports why a command could not do it, such as "Keine Artikelnummer im Text"; it stays until the person types on
   * or presses Escape. A command that throws or rejects reports its error itself, with a way to try again.
   */
  error: (message: string) => void;
  /**
   * Aborts when the result is no longer wanted: a new query replaces a pending list, or the person closes the list
   * with Escape before a command's promise settled.
   */
  signal: AbortSignal;
};

/**
 * The entries of a list: a list, or a function of the context that decides which entries there are in this place, at
 * once or as a promise, such as templates only at the start of the text or people from a server search. Either way the
 * list filters them by the query; give server matches the words they matched on as `keywords`.
 */
export type CommandSource =
  | readonly CommandItem[]
  | ((context: CommandContext) => readonly CommandItem[] | Promise<readonly CommandItem[]>);

/** A further list in the same place, as deep as needed. Escape, or Backspace on an empty query, goes back. */
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
  const text = [item.label, item.description, item.hint?.replace(/^\//, ""), ...(item.keywords ?? [])].filter(Boolean).join(" ");
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

/** The entries of a source in a context, filtered by its query; a promise resolves to the filtered entries. */
export const resolveCommandSource = (
  source: CommandSource,
  context: CommandContext,
): readonly CommandItem[] | Promise<readonly CommandItem[]> => {
  const result = typeof source === "function" ? source(context) : source;
  return result instanceof Promise
    ? result.then((items) => filterCommandItems(items, context.query))
    : filterCommandItems(result, context.query);
};

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
