/**
 * The notebook order of one level of notes.
 *
 * A level keeps position 0 on every note until someone with write access
 * arranges it by hand; from then on its notes carry the positions 1..n and
 * new notes join at the end. Sorting by position first therefore yields the
 * hand order where one exists and the title order everywhere else.
 *
 * Titles compare in the reader's language with digit runs as numbers, so
 * "Chapter 2" precedes "Chapter 10". The public short ID breaks remaining ties,
 * so the server, the sidebar and the Book agree on every level.
 */
export type OrderedNote = { position: number; title: string };

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const compareNoteOrder = <Note extends OrderedNote>(locale: string, id: (note: Note) => string) => {
  const collator = new Intl.Collator(locale, { numeric: true });
  return (left: Note, right: Note): number =>
    left.position - right.position || collator.compare(left.title.trim(), right.title.trim()) || compareIds(id(left), id(right));
};

/** Whether someone arranged this level by hand; alphabetical levels keep position 0 throughout. */
export const isHandOrdered = (level: readonly OrderedNote[]): boolean => level.some((note) => note.position !== 0);

/** Sorts every level of a tree into notebook order without changing the input. */
export const sortNoteLevels = <Note extends OrderedNote & { children: Note[] }>(
  nodes: readonly Note[],
  compare: (left: Note, right: Note) => number,
): Note[] => [...nodes].sort(compare).map((node) => ({ ...node, children: sortNoteLevels(node.children, compare) }));
