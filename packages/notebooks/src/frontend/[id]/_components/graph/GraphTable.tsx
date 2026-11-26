import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { type Column, Table } from "@k2b/ui/v2";
import { createMemo } from "solid-js";
import AreaMark, { NoteSign } from "./AreaMark";
import type { GraphView } from "./graph-controller";
import type { GraphNote } from "./model";
import { sortByChange } from "./timeline";

/** A title of at most this many characters, cut after its last whole word. */
const TITLE_CHARACTERS = 24;
const shortTitle = (title: string) => {
  if (title.length <= TITLE_CHARACTERS) return title;
  const cut = title.slice(0, TITLE_CHARACTERS);
  const word = cut.lastIndexOf(" ");
  return `${(word > 8 ? cut.slice(0, word) : cut).trimEnd()}…`;
};

/**
 * The same notes, links and filters as the graph, as a table as wide as the pane: the note opens from its row, and
 * "Geändert" sorts. Links name up to three notes and count the rest.
 */
export default function GraphTable(props: { view: GraphView; now: string }) {
  const locale = useLocale();
  const g = () => props.view;
  const t = () => g().t();
  const changed = (note: GraphNote) => dates.formatDateTimeRelative(note.updatedAt, { base: props.now, locale: locale() });
  const rows = createMemo(() => {
    const shown = g().query().trim() ? g().hits() : g().notes();
    const sort = g().state().sort;
    return sort ? sortByChange(shown, sort === "changed" ? "desc" : "asc") : shown;
  });
  // The count and the first note it links: one line that ends at a word, never in one.
  const related = (ids: ReadonlySet<string>) => {
    const notes = [...ids].flatMap((id) => {
      const note = g().visibleIds().has(id) ? g().model.byId.get(id) : undefined;
      return note ? [note] : [];
    });
    notes.sort((a, b) => a.order - b.order);
    if (notes.length === 0) return "–";
    const first = shortTitle(notes[0]!.title || t().untitled);
    // the count says how many; the ellipsis that there are more than the one named
    return notes.length > 1 ? `${notes.length}: ${first} …` : `1: ${first}`;
  };
  const sortNext = () => (g().state().sort === "changed" ? "changed-asc" : "changed");
  const columns = (): Column<GraphNote>[] => [
    {
      title: t().graphColumnNote,
      cell: (note) => (
        <>
          <NoteSign slot={note.area.slot} /> {note.title || t().untitled}
        </>
      ),
      width: { min: 200, default: 280 },
    },
    {
      title: t().graphColumnArea,
      cell: (note) => (
        <>
          <AreaMark slot={note.area.slot} /> {note.area.index === 0 ? t().graphTopLevel : note.area.title || t().untitled}
        </>
      ),
      drop: true,
    },
    { title: t().graphLinksTo, cell: (note) => related(note.out) },
    { title: t().graphLinkedFrom, cell: (note) => related(note.in) },
    {
      title: t().graphColumnChanged,
      cell: (note) => changed(note),
      align: "end",
      sort: { onSort: () => g().update({ sort: sortNext() }) },
    },
  ];
  return (
    <Table
      label={t().graphListLabel}
      columns={columns()}
      rows={rows()}
      rowKey={(note) => note.id}
      current={g().currentId() ?? undefined}
      sort={g().state().sort ? { column: 4, direction: g().state().sort === "changed" ? "descending" : "ascending" } : undefined}
      open={(note) => ({ href: g().noteHref(note.id) })}
      phone={(note) => ({
        lines: [note.title || t().untitled, related(note.out)],
        time: changed(note),
        marks: <AreaMark slot={note.area.slot} />,
      })}
    />
  );
}
