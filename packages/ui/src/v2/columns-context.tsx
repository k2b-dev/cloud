import { type Accessor, createContext, type JSX } from "solid-js";
import { BarPlaceContext, HeadPlaceContext } from "./bar-place";

/**
 * A column of the workspace and what it needs at least: its minimum, or 400 px for a column without a width; a detail
 * says so, since the workspace counts it once, open or closed. A context column beside a single main column (`away`)
 * needs no room: where there is none beside, it stands under the main column.
 */
export type Column = { readonly need: number; readonly detail: boolean; readonly away?: boolean };
/**
 * The columns of a workspace register here: the panes at its top, alone or side by side in a `Pane.Split`. The split
 * at the top also learns what stands in the place of a declared detail while none is open.
 */
/** What stands in a declared detail's place while none is open. */
export type DetailEmpty = { icon: string; text: string; hero?: JSX.Element };
export type Columns = { register: (column: Column) => void; empty: () => DetailEmpty | undefined };
export const ColumnsContext = createContext<Columns | undefined>();

/**
 * A split inside a column tells that column what its panes need beside each other (a list beside a main column), so
 * the column asks the workspace for that much, not for 400 px. A detail in it counts nothing: its room is the
 * workspace's declared `detail`, open or closed.
 */
export const InnerContext = createContext<(need: Accessor<number>) => void>();

/**
 * What stands over the page (a dialog, a popover's panel) is no column of the workspace behind it: a pane or a split in
 * it asks that workspace for no room, and a main action in it joins no "+" of the head it was opened from. Solid's
 * context passes through a portal, so the overlay ends it here.
 */
export const OverPage = (props: { children: JSX.Element }) => (
  <ColumnsContext.Provider value={undefined}>
    <InnerContext.Provider value={undefined}>
      <BarPlaceContext.Provider value={undefined}>
        <HeadPlaceContext.Provider value={undefined}>{props.children}</HeadPlaceContext.Provider>
      </BarPlaceContext.Provider>
    </InnerContext.Provider>
  </ColumnsContext.Provider>
);
