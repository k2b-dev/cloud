import { For, type JSX } from "solid-js";
import type { CollectionSelection } from "./collection-selection";

export type FileGridProps<T> = {
  rows: readonly T[];
  getRowId: (row: T) => string;
  selection: CollectionSelection;
  label: string;
  size?: "sm" | "md" | "lg";
  /** `list` shows one compact row per item: preview, name, and meta beside each other. Defaults to `grid`. */
  layout?: "grid" | "list";
  /**
   * Items that cannot be opened or selected, for example a file the host cannot accept. Leave their IDs out of the
   * selection's `ids` and explain why in `renderMeta`.
   */
  isDisabled?: (row: T) => boolean;
  renderPreview: (row: T) => JSX.Element;
  renderLabel: (row: T) => JSX.Element;
  renderMeta?: (row: T) => JSX.Element;
  renderActions?: (row: T) => JSX.Element;
  onRowClick?: (row: T) => void;
  onOpen: (row: T) => void;
  onContextMenu?: (row: T) => void;
  /** Extra attributes for one tile, for example drag-and-drop handlers or data attributes the host styles. */
  itemProps?: (row: T) => JSX.HTMLAttributes<HTMLDivElement>;
  class?: string;
};

/** File presentation only; the host owns data, menus, leases and permissions. */
export function FileGrid<T>(props: FileGridProps<T>) {
  let grid: HTMLDivElement | undefined;
  const columns = () => (grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length) : 1);
  const nested = (event: Event) =>
    event.target instanceof Element &&
    !!event.target.closest("button,a,input,label,select,textarea,summary,[contenteditable],[role=button],[role=menu]");
  return (
    <div
      ref={grid}
      class={`k2b-file-grid ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      data-layout={props.layout ?? "grid"}
      role="grid"
      aria-label={props.label}
      aria-multiselectable={props.selection.multiple}
    >
      <For each={props.rows}>
        {(row) => {
          const id = () => props.getRowId(row);
          const disabled = () => props.isDisabled?.(row) ?? false;
          return (
            <div role="row" class="k2b-file-grid__row">
              <div
                {...props.itemProps?.(row)}
                role="gridcell"
                class="k2b-file-grid__item"
                aria-selected={props.selection.selected().has(id())}
                aria-disabled={disabled() || undefined}
                ref={(element) => props.selection.register(id(), element)}
                tabIndex={props.selection.focused() === id() ? 0 : -1}
                onFocus={() => props.selection.markFocused(id())}
                onClick={(event) => {
                  if (!nested(event) && !disabled()) {
                    props.selection.select(id(), event);
                    props.onRowClick?.(row);
                  }
                }}
                onDblClick={(event) => {
                  if (!nested(event) && !disabled()) props.onOpen(row);
                }}
                onContextMenu={() => props.onContextMenu?.(row)}
                onKeyDown={(event) => {
                  if (nested(event)) return;
                  if (props.selection.keyDown(event, id(), columns())) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    props.onOpen(row);
                  }
                }}
              >
                <div class="k2b-file-grid__preview">{props.renderPreview(row)}</div>
                <div class="k2b-file-grid__name">{props.renderLabel(row)}</div>
                <div class="k2b-file-grid__meta">{props.renderMeta?.(row)}</div>
                <div class="k2b-file-grid__actions">{props.renderActions?.(row)}</div>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
