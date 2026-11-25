import { For, Show } from "solid-js";
import { useTileGrid } from "./behavior/tiles";
import { ActionButton } from "./button";
import { RowOpen } from "./content";
import { MarkCheck } from "./controls";
import { type DragMove, useDragMove } from "./drag";
import { Icon } from "./marks";
import type { Action, OnNavigate } from "./types";

/**
 * A tile with a picture box, such as a file in the grid of Files: its picture (a thumbnail) fills a box of a fixed
 * shape above the name. The `icon` of its kind stands there while the picture loads, when it fails and when there is
 * none, so nothing moves.
 */
export type PictureTile = {
  /** Stable and unique among the tiles: selection, the open tile and dragging name a tile by it. */
  key: string;
  /** A Tabler icon for the kind of thing, such as `file-type-pdf`. */
  icon: string;
  /** The name, such as a file name; cut with "…". */
  title: string;
  /** A quiet line under the name, such as the size. */
  meta?: string;
  /** The address of the picture; the browser loads it when it comes near the view. */
  image?: string;
  /** The tile opens this page or file; with `onNavigate` in place. */
  href?: string;
  onNavigate?: OnNavigate;
  /** A deed in place instead of a page, such as opening a preview. */
  onOpen?: () => void;
};

export type PictureTilesProps = {
  items: readonly PictureTile[];
  /**
   * Tiles with a picture box in a grid, in the size the person chose (the grid view of Files, media): `s` from 128,
   * `m` from 176, `l` from 248 px wide; the grid fills each line with as many as fit.
   */
  size: "s" | "m" | "l";
  /** A name for the tiles, for assistive technology. */
  label: string;
  /** One deed after the tiles, such as "Weitere laden". */
  more?: Action;
  /** A box on each tile to select it, as in a table; Space selects the focused tile. */
  select?: { selected: readonly string[]; onChange: (keys: readonly string[]) => void };
  /** The key of the open tile, in the tint of the app. */
  current?: string;
  /** Tiles drag onto folders, and folders among them take tiles, rows and files (see `DragMove`). */
  drag?: DragMove;
};

/**
 * The grid of picture tiles: one Tab stop, arrows to the nearest tile on screen, Home and End; Enter or a press opens
 * a tile, Space selects it. The behaviour is core's roving focus with its spatial move.
 */
export const PictureTiles = (props: PictureTilesProps) => {
  const grid = useTileGrid(() => ({ current: props.current ?? null }));
  const selected = (key: string) => props.select?.selected.includes(key) ?? false;
  const toggle = (key: string, on: boolean) => {
    const select = props.select;
    if (!select) return;
    select.onChange(on ? [...select.selected.filter((other) => other !== key), key] : select.selected.filter((other) => other !== key));
  };
  const dragging = useDragMove(() => props.drag, {
    targets: () => props.items.filter((tile) => props.drag?.target?.(tile.key)).map((tile) => tile.key),
    selected: () => props.select?.selected ?? [],
  });
  // A press anywhere on a tile opens it, unless it was meant for its box or a control in it.
  const open = (event: MouseEvent & { currentTarget: HTMLElement }) => {
    if (!(event.target instanceof Element) || event.target.closest("a, button, input, label")) return;
    event.currentTarget.querySelector<HTMLElement>(".k2-row-open")?.click();
  };
  return (
    <>
      <grid.Root
        class="k2-tiles"
        data-k2-part="Tiles"
        data-size={props.size}
        data-selecting={(props.select?.selected.length ?? 0) > 0 ? "" : undefined}
        role={props.select ? "listbox" : "list"}
        aria-multiselectable={props.select ? "true" : undefined}
        aria-label={props.label}
      >
        <For each={props.items}>
          {(tile) => {
            const drag = dragging.entry(tile.key);
            return (
              <grid.Item
                value={tile.key}
                {...drag}
                class="k2-tile"
                role={props.select ? "option" : "listitem"}
                aria-selected={props.select ? (selected(tile.key) ? "true" : "false") : undefined}
                aria-current={props.current === tile.key ? "true" : undefined}
                aria-label={tile.title}
                data-selected={selected(tile.key) ? "" : undefined}
                data-open={tile.href !== undefined || tile.onOpen ? "" : undefined}
                onClick={open}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.target !== event.currentTarget || !(event.currentTarget instanceof HTMLElement)) return;
                  if (event.key === " " && props.select) {
                    event.preventDefault();
                    toggle(tile.key, !selected(tile.key));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.querySelector<HTMLElement>(".k2-row-open")?.click();
                  }
                }}
              >
                <span class="k2-tile-pic">
                  <Icon name={tile.icon} />
                  {/* over the symbol: transparent while it loads, nothing drawn when it fails (empty alt) */}
                  <Show when={tile.image}>{(src) => <img src={src()} alt="" loading="lazy" decoding="async" draggable={false} />}</Show>
                  <Show when={props.select}>
                    <span class="k2-tile-check">
                      <MarkCheck
                        label={tile.title}
                        checked={selected(tile.key)}
                        onChange={(on) => toggle(tile.key, on)}
                        focusable={false}
                      />
                    </span>
                  </Show>
                </span>
                <span class="k2-tile-text">
                  <span class="k2-tile-title">
                    <RowOpen href={tile.href} onNavigate={tile.onNavigate} onOpen={tile.onOpen} rowFocus>
                      {tile.title}
                    </RowOpen>
                  </span>
                  <Show when={tile.meta}>
                    <span class="k2-t-meta">{tile.meta}</span>
                  </Show>
                </span>
              </grid.Item>
            );
          }}
        </For>
        <Show when={props.more}>{(more) => <ActionButton action={more()} variant="text" />}</Show>
      </grid.Root>
      {dragging.zone()}
    </>
  );
};
