/**
 * Tiles in a grid for v2 `Tiles` with `size` (Files' grid view, media): one Tab stop, arrows to the tile nearest on
 * screen in their direction, Home and End. Roving focus and the spatial move are core's (`createRovingFocus`,
 * `spatialMove`); what Space and Enter do (select, open) stays with the component.
 */
import { createRovingFocus, definePrimitive, spatialMove } from "@ui-sdk/core";
import { type JSX, splitProps } from "solid-js";
import { type PartProps, part, usePrimitive } from "./adapter";

type TileGridOptions = { current?: string | null };

const tileGrid = definePrimitive({
  name: "k2-tile-grid",
  options: { current: "value" },
  state: (options: TileGridOptions) => ({ focused: options.current ?? (null as string | null) }),
  api: (context) => ({ roving: createRovingFocus(context, { slot: "item", key: "focused", move: spatialMove() }) }),
  slots: (slot) => ({
    root: slot({ keys: { none: "Each tile handles its own keys." } }),
    item: slot<{ value: string }>({
      props: { value: "key" },
      focus: "roving",
      attrs: (state, part) => ({ tabindex: part.api.roving.tabIndex(state, part) }),
      on: {
        keydown: (event, { el, api }) => {
          if (el && event.target === el) api.roving.keydown(event, el);
        },
      },
      bind: (el, part) => part.api.roving.bind(el, part),
    }),
  }),
});

/** The grid of tiles: `root` and `item(key)` render the elements with the props given for the v2 look. */
export function useTileGrid(options: () => TileGridOptions) {
  const handle = usePrimitive(tileGrid, options);
  return {
    Root: (props: PartProps) => part(handle, "root", undefined, props, "div"),
    Item: (props: PartProps & { value: string; children: JSX.Element }) => {
      const [own, rest] = splitProps(props, ["value"]);
      return part(handle, "item", () => ({ value: own.value }), rest, "div");
    },
  };
}
