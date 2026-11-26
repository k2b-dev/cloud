import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { type Column, Table } from "@k2b/ui/v2";
import { createMemo } from "solid-js";
import type { GraphView } from "./graph-controller";
import type { GraphNote } from "./model";
import { sortByChange } from "./timeline";

const SHOWN_TITLES = 3;

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
  const related = (ids: ReadonlySet<string>) => {
    const notes = [...ids].flatMap((id) => {
      const note = g().visibleIds().has(id) ? g().model.byId.get(id) : undefined;
      return note ? [note] : [];
    });
    notes.sort((a, b) => a.order - b.order);
    if (notes.length === 0) return "–";
    const titles = notes
      .slice(0, SHOWN_TITLES)
      .map((note) => note.title || t().untitled)
      .join(", ");
    const more = notes.length > SHOWN_TITLES ? ` ${t().graphAndMore({ count: notes.length - SHOWN_TITLES })}` : "";
    return `${notes.length}: ${titles}${more}`;
  };
  const sortNext = () => (g().state().sort === "changed" ? "changed-asc" : "changed");
  const columns = (): Column<GraphNote>[] => [
    { title: t().graphColumnNote, cell: (note) => note.title || t().untitled, width: { min: 200, default: 280 } },
    {
      title: t().graphColumnArea,
      cell: (note) => (note.area.index === 0 ? t().graphTopLevel : note.area.title || t().untitled),
      drop: true,
    },
    { title: t().graphLinksTo, cell: (note) => related(note.out), wrap: true },
    { title: t().graphLinkedFrom, cell: (note) => related(note.in), wrap: true },
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
      })}
    />
  );
}
