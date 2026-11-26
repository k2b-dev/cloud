import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { type Column, type MarkProps, Table } from "@k2b/ui/v2";
import { createMemo } from "solid-js";
import type { GraphView } from "./graph-controller";
import type { GraphNote } from "./model";
import { sortByChange } from "./timeline";

/** A note's sign in its area's colour, as the graph draws the note. */
const noteMark = (note: GraphNote): MarkProps => ({ icon: "file-text", color: `var(--notebook-graph-area-${note.area.slot})` });

/**
 * The same notes, links and filters as the graph, as a table as wide as the pane: the note opens from its row, and
 * "Geändert" sorts. One column carries the data: how many shown notes each note links to and is linked from.
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
  // only the links to notes the filters show, as the drawing has them
  const shownCount = (ids: ReadonlySet<string>) => {
    let count = 0;
    for (const id of ids) if (g().visibleIds().has(id)) count += 1;
    return count;
  };
  const linkCounts = (note: GraphNote) => t().graphLinkCounts({ out: shownCount(note.out), incoming: shownCount(note.in) });
  const sortNext = () => (g().state().sort === "changed" ? "changed-asc" : "changed");
  const columns = (): Column<GraphNote>[] => [
    {
      title: t().graphColumnNote,
      // the note's sign carries its area's colour, so the area column needs no second picture
      mark: noteMark,
      cell: (note) => note.title || t().untitled,
      width: { min: 200, default: 280 },
    },
    {
      title: t().graphColumnArea,
      cell: (note) => (note.area.index === 0 ? t().graphTopLevel : note.area.title || t().untitled),
      drop: true,
    },
    // k2b-ui gap: Ticks (G) – the note's links as a small bar in the soft app colour beside the counts; the counts
    // stand alone meanwhile.
    { title: t().graphColumnLinks, cell: linkCounts },
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
      sort={g().state().sort ? { column: 3, direction: g().state().sort === "changed" ? "descending" : "ascending" } : undefined}
      open={(note) => ({ href: g().noteHref(note.id) })}
      // On the phone the columns' heads are gone: the row leads with the note's sign in its area's colour, and its
      // second line says what its counts mean.
      phone={(note) => ({
        mark: noteMark(note),
        lines: [note.title || t().untitled, linkCounts(note)],
        time: changed(note),
      })}
    />
  );
}
