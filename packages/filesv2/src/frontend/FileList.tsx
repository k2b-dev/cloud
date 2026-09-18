import { type CollectionSelection, Format, IconButton } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { FileEntry } from "../contracts";
import FileThumbnail from "./FileThumbnail";

/** One flat row list; tree mode adds depth and disclosure, search mode shows the full path. */
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
  messages: {
    name: string;
    size: string;
    modified: string;
    details: (name: string) => string;
    toggle: (name: string) => string;
    more: string;
  };
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
  return (
    <div class="filesv2-list" role="grid" aria-label={props.label} aria-multiselectable="true" data-tree={props.tree ? "true" : undefined}>
      <div role="row" class="filesv2-list__head">
        <span role="columnheader" class="filesv2-list__cell filesv2-list__cell--info" />
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
      </div>
      <For each={props.rows}>
        {(row) => (
          <Show
            when={!row.more}
            fallback={
              <div role="row" class="filesv2-list__row filesv2-list__row--more" style={{ "--depth": row.depth ?? 0 }}>
                <span class="filesv2-list__cell filesv2-list__cell--info" />
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
              <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--info">
                <IconButton
                  size="xs"
                  variant="ghost"
                  class="filesv2-list__info"
                  label={props.messages.details(row.name)}
                  onClick={() => props.onDetails(row)}
                >
                  <i class="ti ti-info-circle" aria-hidden="true" />
                </IconButton>
              </span>
              <span role="gridcell" class="filesv2-list__cell filesv2-list__cell--name">
                <Show when={props.tree && row.directory} fallback={<FileThumbnail baseId={props.baseId} entry={row} />}>
                  <button
                    type="button"
                    class="filesv2-list__disclosure"
                    aria-label={props.messages.toggle(row.name)}
                    aria-expanded={!!row.expanded}
                    onClick={() => props.onToggle?.(row)}
                  >
                    <i
                      class={row.loading ? "ti ti-loader-2 animate-spin" : row.expanded ? "ti ti-folder-open" : "ti ti-folder"}
                      aria-hidden="true"
                    />
                  </button>
                </Show>
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
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
