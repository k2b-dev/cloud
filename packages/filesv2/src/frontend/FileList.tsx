import { type CollectionSelection, Format, IconButton } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { FileEntry } from "../contracts";
import FileThumbnail from "./FileThumbnail";

/** One flat row list; tree mode adds depth and disclosure, search mode shows the path below the folder. */
export type FileRow = FileEntry & { depth?: number; expanded?: boolean; loading?: boolean; more?: boolean };
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
  /** Present when the listing has a parent folder; rendered as the first row. */
  onUp?: () => void;
  messages: { name: string; size: string; modified: string; details: (name: string) => string; toggle: (name: string) => string; more: string; up: string };
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
  return (
    <div class="filesv2-list" role="grid" aria-label={props.label} aria-multiselectable="true" data-tree={props.tree ? "true" : undefined}>
      <div role="row" class="filesv2-list__head">
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--icon" />
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--name">
          {props.messages.name}
        </span>
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--size">
          {props.messages.size}
        </span>
        <Show when={props.showModified}>
          <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--modified">
            {props.messages.modified}
          </span>
        </Show>
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--info" />
      </div>
      <Show when={props.onUp}>
        <div role="row" class="filesv2-list__row filesv2-list__row--up" tabIndex={-1} onClick={() => props.onUp?.()} onKeyDown={(event) => event.key === "Enter" && props.onUp?.()}>
          <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--icon">
            <i class={props.opening === ".." ? "ti ti-loader-2 animate-spin" : "ti ti-folder-up"} aria-hidden="true" />
          </span>
          <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--name">
            <span class="filesv2-list__name">..</span>
            <span class="sr-only">{props.messages.up}</span>
          </span>
          <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--size" />
          <Show when={props.showModified}>
            <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--modified" />
          </Show>
          <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--info" />
        </div>
      </Show>
      <For each={props.rows}>
        {(row) => (
          <Show
            when={!row.more}
            fallback={
              <div role="row" class="filesv2-list__row filesv2-list__row--more" style={{ "--depth": row.depth ?? 0 }}>
                <span class="filesv2-list__cell filesv2-list__cell--icon" />
                <span class="filesv2-list__cell filesv2-list__cell--name">
                  <button type="button" class="filesv2-list__more" onClick={() => props.onLoadMore?.(row)}>
                    {props.messages.more}
                  </button>
                </span>
              </div>
            }
          >
            <div
              role="row"
              class="filesv2-list__row"
              style={{ "--depth": row.depth ?? 0 }}
              aria-selected={props.selection.selected().has(row.path)}
              aria-expanded={props.tree && row.directory ? !!row.expanded : undefined}
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
    </div>
  );
}
