import { DataTable, type DataTableColumn, Format, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import type { GraphModel, GraphNote } from "./model";
import { sortByChange } from "./timeline";
import type { GraphListSort } from "./view-state";

type Props = {
  model: GraphModel;
  sort: GraphListSort;
  onSortChange: (sort: GraphListSort) => void;
  /** Visible notes in tree order, already narrowed by the search. */
  rows: readonly GraphNote[];
  visibleIds: ReadonlySet<string>;
  caption: string;
  currentId: string | null;
  now: string;
  noteHref: (id: string) => string;
  onOpen: (id: string) => void;
};

const SHOWN_TITLES = 3;

/** The same notes, links and filters as the graph, as a full-width table. */
export default function GraphList(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const rows = createMemo(() => (props.sort ? sortByChange(props.rows, props.sort === "changed" ? "desc" : "asc") : props.rows));
  const related = (ids: ReadonlySet<string>) => {
    const notes = [...ids].flatMap((id) => {
      const note = props.visibleIds.has(id) ? props.model.byId.get(id) : undefined;
      return note ? [note] : [];
    });
    notes.sort((a, b) => a.order - b.order);
    if (notes.length === 0) return <span class="notebook-graph__related">–</span>;
    const shown = notes.slice(0, SHOWN_TITLES);
    return (
      <span class="notebook-graph__related">
        <strong>{notes.length}</strong>
        <span class="notebook-graph__related-titles">
          {": "}
          <For each={shown}>
            {(note, index) => (
              <>
                {index() > 0 ? ", " : ""}
                <a href={props.noteHref(note.id)}>{note.title || t().untitled}</a>
              </>
            )}
          </For>
          <Show when={notes.length > shown.length}> {t().graphAndMore({ count: notes.length - shown.length })}</Show>
        </span>
      </span>
    );
  };
  const columns = (): DataTableColumn<GraphNote>[] => [
    { id: "note", header: t().graphColumnNote },
    { id: "area", header: t().graphColumnArea, class: "max-md:hidden" },
    { id: "out", header: t().graphLinksTo },
    { id: "in", header: t().graphLinkedFrom },
    // The sort must not rebuild the columns: DataTable keys them by identity, and the focused sort button would go.
    { id: "changed", header: t().graphColumnChanged, sortable: true, class: "notebook-graph__list-changed", nowrap: true },
  ];
  return (
    <div class="notebook-graph__list" data-sorted={props.sort ? "" : undefined}>
      <p class="notebook-graph__list-caption">{props.caption}</p>
      <DataTable
        surface="plain"
        class="min-h-0 flex-1"
        stickyHeader
        hoverRows
        fillHeight
        verticalAlign="middle"
        ariaLabel={t().graphListLabel}
        rows={rows()}
        sort={props.sort ? { key: "changed", direction: props.sort === "changed" ? "desc" : "asc" } : null}
        onSortChange={(next) => props.onSortChange(next.direction === "desc" ? "changed" : "changed-asc")}
        columns={columns()}
        getRowId={(note) => note.id}
        selectedRowId={props.currentId}
        onRowClick={(note) => props.onOpen(note.id)}
        cellContentClass="notebook-graph__cell"
        renderCell={({ row, col }) => {
          if (col.id === "note")
            return (
              <a
                class="notebook-graph__list-title"
                href={props.noteHref(row.id)}
                aria-current={row.id === props.currentId ? "page" : undefined}
              >
                {row.title || t().untitled}
              </a>
            );
          if (col.id === "area")
            return (
              <span class="notebook-graph__list-area" data-slot={row.area.slot}>
                <span class="notebook-graph__dot" />
                {row.area.index === 0 ? t().graphTopLevel : row.area.title || t().untitled}
              </span>
            );
          if (col.id === "out") return related(row.out);
          if (col.id === "in") return related(row.in);
          return <Format.RelativeTime value={row.updatedAt} base={props.now} />;
        }}
      />
    </div>
  );
}
