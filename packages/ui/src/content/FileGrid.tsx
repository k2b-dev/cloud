import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import type { CollectionSelection } from "./collection-selection";
import { useFileListMessages } from "./file-list-messages";

/** One part of an open file list, such as its files as rows and its images as tiles. */
export type FileGridGroup<T> = {
  id: string;
  label: JSX.Element;
  rows: readonly T[];
  /** `tiles` fills each item with its preview and lays the name over it. Defaults to `list`. */
  layout?: "list" | "tiles";
};

type FileGridBaseProps<T> = {
  rows: readonly T[];
  getRowId: (row: T) => string;
  label: string;
  size?: "sm" | "md" | "lg";
  /** `list` shows one compact row per item: preview, name, and meta beside each other. Defaults to `grid`. */
  layout?: "grid" | "list";
  renderPreview: (row: T) => JSX.Element;
  renderLabel: (row: T) => JSX.Element;
  renderMeta?: (row: T) => JSX.Element;
  renderActions?: (row: T) => JSX.Element;
  /**
   * `progressive` shows the actions on hover, keyboard focus, or an open menu with a mouse or trackpad, and always
   * on touch. Their slot is reserved in both states, so nothing moves. Defaults to `always`.
   */
  actionVisibility?: "always" | "progressive";
  onOpen: (row: T) => void;
  onContextMenu?: (row: T) => void;
  /** Extra attributes for one tile, for example drag-and-drop handlers or data attributes the host styles. */
  itemProps?: (row: T) => JSX.HTMLAttributes<HTMLDivElement>;
  class?: string;
};

/** A browser or picker: items are selected, and Enter or a double click opens them. */
export type FileGridSelectableProps<T> = FileGridBaseProps<T> & {
  selection: CollectionSelection;
  onRowClick?: (row: T) => void;
  limit?: never;
  expanded?: never;
  onExpandedChange?: never;
  moreMeta?: never;
  toolbar?: never;
  groups?: never;
};

/** A list without selection, as in a details panel: one click on an item opens it. */
export type FileGridOpenProps<T> = FileGridBaseProps<T> & {
  selection?: never;
  onRowClick?: never;
  /** Shows the first `limit` items, then "Show all N", which opens the full list in place. */
  limit?: number;
  /** Controls whether the full list is open. Without it, the list keeps its own state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** A quiet note at the end of "Show all N", such as how many duplicates were merged. */
  moreMeta?: JSX.Element;
  /** Shown above the full list, such as a count, an arrangement switch, or "Download all". */
  toolbar?: JSX.Element;
  /** How the full list arranges its items, such as files as rows, then images as tiles. Defaults to one list. */
  groups?: (rows: readonly T[]) => readonly FileGridGroup<T>[];
};

export type FileGridProps<T> = FileGridSelectableProps<T> | FileGridOpenProps<T>;

/**
 * File presentation only; the host owns data, menus, leases and permissions. Items the selection marks with
 * `isDisabled` stay reachable by keyboard but cannot be selected or opened; say why in `renderMeta`.
 */
export function FileGrid<T>(props: FileGridProps<T>) {
  return (
    <Show when={props.selection} fallback={<OpenFileGrid {...(props as FileGridOpenProps<T>)} />}>
      {(selection) => <SelectableFileGrid {...(props as FileGridSelectableProps<T>)} selection={selection()} />}
    </Show>
  );
}

function SelectableFileGrid<T>(props: FileGridSelectableProps<T>) {
  let grid: HTMLDivElement | undefined;
  // Both clicks of a double-click belong to the item that took the first one. When that click replaced the rows,
  // for example by opening a folder, the item now under the pointer ignores the rest of the gesture.
  let pressed: EventTarget | null | undefined;
  const ownsClick = (event: MouseEvent) => {
    if (event.detail > 1 && pressed !== event.currentTarget) pressed = null;
    else pressed = event.currentTarget;
    return pressed !== null;
  };
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
      data-action-visibility={props.actionVisibility ?? "always"}
      role="grid"
      aria-label={props.label}
      aria-multiselectable={props.selection.multiple}
    >
      <For each={props.rows}>
        {(row) => {
          const id = () => props.getRowId(row);
          const disabled = () => props.selection.isDisabled(id());
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
                  if (!nested(event) && ownsClick(event) && !disabled()) {
                    props.selection.select(id(), event);
                    props.onRowClick?.(row);
                  }
                }}
                onDblClick={(event) => {
                  if (!nested(event) && pressed !== null && !disabled()) props.onOpen(row);
                }}
                onContextMenu={() => props.onContextMenu?.(row)}
                onKeyDown={(event) => {
                  if (nested(event)) return;
                  if (props.selection.keyDown(event, id(), columns())) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (!disabled()) props.onOpen(row);
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

function OpenFileGrid<T>(props: FileGridOpenProps<T>) {
  const messages = useFileListMessages();
  const [ownExpanded, setOwnExpanded] = createSignal(false);
  const limited = () => props.limit !== undefined && props.rows.length > props.limit;
  const expanded = () => limited() && (props.expanded ?? ownExpanded());
  let more: HTMLButtonElement | undefined;
  let less: HTMLButtonElement | undefined;
  const toggle = (next: boolean) => {
    if (props.expanded === undefined) setOwnExpanded(next);
    props.onExpandedChange?.(next);
    // The pressed button leaves with the state it showed; focus moves to its counterpart.
    queueMicrotask(() => (next ? less : more)?.focus());
  };
  const groups = (): readonly FileGridGroup<T>[] =>
    expanded() && props.groups
      ? props.groups(props.rows).filter((group) => group.rows.length > 0)
      : [{ id: "rows", label: undefined, rows: expanded() || !limited() ? props.rows : props.rows.slice(0, props.limit) }];

  const list = (group: FileGridGroup<T>, labelId?: string) => (
    <div
      class={`k2b-file-grid ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      data-layout={group.layout === "tiles" ? "tiles" : (props.layout ?? "grid")}
      data-action-visibility={props.actionVisibility ?? "always"}
      data-open-items="true"
      role="list"
      aria-label={labelId ? undefined : props.label}
      aria-labelledby={labelId}
    >
      <For each={group.rows}>
        {(row) => {
          const id = `k2b-file-grid-${createUniqueId()}`;
          return (
            <div role="listitem" class="k2b-file-grid__row">
              <div {...props.itemProps?.(row)} class="k2b-file-grid__item" onContextMenu={() => props.onContextMenu?.(row)}>
                {/* The whole item opens the file; its actions lie above this layer in their own slot. */}
                <button
                  type="button"
                  class="k2b-file-grid__open"
                  aria-labelledby={`${id}-name`}
                  aria-describedby={props.renderMeta ? `${id}-meta` : undefined}
                  onClick={() => props.onOpen(row)}
                />
                <div class="k2b-file-grid__preview">{props.renderPreview(row)}</div>
                <div class="k2b-file-grid__name" id={`${id}-name`}>
                  {props.renderLabel(row)}
                </div>
                <div class="k2b-file-grid__meta" id={`${id}-meta`}>
                  {props.renderMeta?.(row)}
                </div>
                <div class="k2b-file-grid__actions">{props.renderActions?.(row)}</div>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );

  return (
    <div class="k2b-file-grid-stack" data-expanded={expanded() ? "true" : undefined}>
      <Show when={expanded() && props.toolbar}>
        <div class="k2b-file-grid-stack__toolbar">{props.toolbar}</div>
      </Show>
      <For each={groups()}>
        {(group) => (
          <Show when={group.label !== undefined} fallback={list(group)}>
            {(_) => {
              const labelId = `k2b-file-grid-group-${createUniqueId()}`;
              return (
                <div class="k2b-file-grid-stack__group">
                  <div class="k2b-file-grid-stack__label" id={labelId}>
                    {group.label}
                    <span class="k2b-file-grid-stack__count">{group.rows.length}</span>
                  </div>
                  {list(group, labelId)}
                </div>
              );
            }}
          </Show>
        )}
      </For>
      <Show when={limited()}>
        <Show
          when={expanded()}
          fallback={
            <button ref={more} type="button" class="k2b-file-grid-stack__more" aria-expanded="false" onClick={() => toggle(true)}>
              <span>{messages().showAll({ count: props.rows.length })}</span>
              <i class="ti ti-chevron-down" aria-hidden="true" />
              <Show when={props.moreMeta}>
                <span class="k2b-file-grid-stack__more-meta">{props.moreMeta}</span>
              </Show>
            </button>
          }
        >
          <button ref={less} type="button" class="k2b-file-grid-stack__more" aria-expanded="true" onClick={() => toggle(false)}>
            <span>{messages().showLess}</span>
            <i class="ti ti-chevron-up" aria-hidden="true" />
          </button>
        </Show>
      </Show>
    </div>
  );
}
