import { Checkbox, type CollectionSelection, Format, IconButton } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";

export type RowAttributes = JSX.HTMLAttributes<HTMLDivElement> & { [key: `data-${string}`]: string | undefined };
import type { FileEntry } from "../contracts";
import FileThumbnail from "./FileThumbnail";

/** One flat row list; tree mode adds depth and disclosure, search mode shows the path below the folder. */
export type FileRow = FileEntry & { depth?: number; expanded?: boolean; loading?: boolean; more?: boolean };
export type VirtualRow = { key: "up" | "trash"; label: string; icon: string; onClick: () => void; depth?: number };
export default function FileList(props: {
  baseId: string;
  rows: readonly FileRow[];
  selection: CollectionSelection;
  label: string;
  tree?: boolean;
  /** Search hits below a folder show their path relative to that folder. */
  pathBase?: string | null;
  showModified: boolean;
  /** Folder currently being opened; its icon becomes a spinner instead of a separate loader. */
  opening?: string | null;
  /** In tree mode the folder whose contents actions target. */
  currentPath?: string | null;
  /** Checkboxes are shown only while the user is selecting. */
  selecting?: boolean;
  /** Rows that lead somewhere instead of representing an entry: parent folder before, trash after the entries. */
  before?: readonly VirtualRow[];
  after?: readonly VirtualRow[];
  /** Host attributes per row, for example drag-and-drop handlers and the attributes their styling reads. */
  rowProps?: (row: FileRow) => RowAttributes;
  virtualProps?: (row: VirtualRow) => RowAttributes;
  messages: { name: string; size: string; modified: string; details: (name: string) => string; toggle: (name: string) => string; select: (name: string) => string; more: string; up: string };
  /** Current order; clicking a column header asks the host to sort by it. */
  sort?: { key: "name" | "modified" | "size" | "type"; direction: "asc" | "desc" };
  onSort?: (key: "name" | "modified" | "size") => void;
  onOpen: (row: FileRow) => void;
  onToggle?: (row: FileRow) => void;
  onLoadMore?: (row: FileRow) => void;
  onDetails: (row: FileRow) => void;
  onContextMenu?: (row: FileRow) => void;
  onRowClick?: (row: FileRow, event: MouseEvent) => void;
}) {
  const nested = (event: Event) => event.target instanceof Element && !!event.target.closest("button,a,input,label,[role=button]");
  const label = (row: FileRow): JSX.Element =>
    props.pathBase !== undefined && props.pathBase !== null ? `/${props.pathBase ? row.path.slice(props.pathBase.length + 1) : row.path}` : row.name;
  const icon = (row: FileRow) => {
    const busy = row.loading || props.opening === row.path;
    if (busy) return <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />;
    if (props.tree && row.directory) return <i class={row.expanded ? "ti ti-folder-open" : "ti ti-folder"} aria-hidden="true" />;
    return <FileThumbnail baseId={props.baseId} entry={row} />;
  };
  const ariaSort = (key: "name" | "modified" | "size") => (props.sort?.key === key ? (props.sort.direction === "asc" ? "ascending" : "descending") : undefined);
  const header = (key: "name" | "modified" | "size", label: string) => (
    <span role="columnheader" aria-sort={ariaSort(key)} class={`filesv2-list__cell filesv2-list__cell--${key}`}>
      <Show when={props.onSort} fallback={label}>
        <button type="button" class="filesv2-list__sort" onClick={() => props.onSort?.(key)}>
          {label}
          <Show when={ariaSort(key)}>
            <i class={props.sort?.direction === "asc" ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
          </Show>
        </button>
      </Show>
    </span>
  );
  const virtual = (row: VirtualRow) => (
    <div
      {...props.virtualProps?.(row)}
      role="row"
      class={`filesv2-list__row filesv2-list__row--virtual filesv2-list__row--${row.key}`}
      style={{ "--depth": row.depth ?? 0 }}
      tabIndex={0}
      aria-label={row.key === "up" ? props.messages.up : row.label}
      onClick={row.onClick}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), row.onClick())}
    >
      <Show when={props.selecting}>
        <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--check" />
      </Show>
      <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--icon">
        <i class={props.opening === row.key ? "ti ti-loader-2 animate-spin" : row.icon} aria-hidden="true" />
      </span>
      <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--name">
        <span class="filesv2-list__name">{row.label}</span>
      </span>
      <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--size" />
      <Show when={props.showModified}>
        <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--modified" />
      </Show>
      <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--info" />
    </div>
  );
  return (
    <div
      class="filesv2-list"
      role="grid"
      aria-label={props.label}
      aria-multiselectable="true"
      data-tree={props.tree ? "true" : undefined}
      data-selecting={props.selecting ? "true" : undefined}
    >
      <div role="row" class="filesv2-list__head">
        <Show when={props.selecting}>
          <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--check" />
        </Show>
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--icon" />
        {header("name", props.messages.name)}
        {header("size", props.messages.size)}
        <Show when={props.showModified}>{header("modified", props.messages.modified)}</Show>
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--info" />
      </div>
      <For each={props.before ?? []}>{virtual}</For>
      <For each={props.rows}>
        {(row) => (
          <Show
            when={!row.more}
            fallback={
              <div role="row" class="filesv2-list__row filesv2-list__row--more" style={{ "--depth": row.depth ?? 0 }}>
                <Show when={props.selecting}>
                  <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--check" />
                </Show>
                <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--icon" />
                <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--name">
                  <button type="button" class="filesv2-list__more" onClick={() => props.onLoadMore?.(row)}>
                    {props.messages.more}
                  </button>
                </span>
              </div>
            }
          >
            <div
              {...props.rowProps?.(row)}
              role="row"
              class="filesv2-list__row"
              style={{ "--depth": row.depth ?? 0 }}
              aria-selected={props.selection.selected().has(row.path)}
              aria-expanded={props.tree && row.directory ? !!row.expanded : undefined}
              aria-current={props.tree && props.currentPath === row.path ? "location" : undefined}
              ref={(element) => props.selection.register(row.path, element)}
              tabIndex={props.selection.focused() === row.path ? 0 : -1}
              onFocus={() => props.selection.markFocused(row.path)}
              onClick={(event) => {
                if (nested(event)) return;
                props.onRowClick?.(row, event);
              }}
              onDblClick={(event) => {
                if (!nested(event)) props.onOpen(row);
              }}
              onContextMenu={() => props.onContextMenu?.(row)}
              onKeyDown={(event) => {
                if (nested(event)) return;
                if (props.tree && row.directory && event.key === "ArrowRight" && !row.expanded) {
                  event.preventDefault();
                  props.onToggle?.(row);
                  return;
                }
                if (props.tree && row.directory && event.key === "ArrowLeft" && row.expanded) {
                  event.preventDefault();
                  props.onToggle?.(row);
                  return;
                }
                if (props.selection.keyDown(event, row.path)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.onOpen(row);
                }
              }}
            >
              <Show when={props.selecting}>
                <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--check">
                  <Checkbox
                    value={props.selection.selected().has(row.path)}
                    label={<span class="sr-only">{props.messages.select(row.name)}</span>}
                    onValueChange={() => props.selection.toggle(row.path)}
                  />
                </span>
              </Show>
              <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--icon">
                <Show when={props.tree && row.directory} fallback={icon(row)}>
                  <button type="button" class="filesv2-list__disclosure" aria-label={props.messages.toggle(row.name)} aria-expanded={!!row.expanded} onClick={() => props.onToggle?.(row)}>
                    {icon(row)}
                  </button>
                </Show>
              </span>
              <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--name">
                <span class="filesv2-list__name" title={row.path}>
                  {label(row)}
                </span>
              </span>
              <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--size">
                <Show when={!row.directory}>
                  <Format.Bytes value={row.size} />
                </Show>
              </span>
              <Show when={props.showModified}>
                <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--modified">
                  <Format.DateTime value={row.modified} />
                </span>
              </Show>
              <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--info">
                <IconButton size="xs" variant="ghost" class="filesv2-list__info" label={props.messages.details(row.name)} onClick={() => props.onDetails(row)}>
                  <i class="ti ti-info-circle" aria-hidden="true" />
                </IconButton>
              </span>
            </div>
          </Show>
        )}
      </For>
      <For each={props.after ?? []}>{virtual}</For>
    </div>
  );
}
