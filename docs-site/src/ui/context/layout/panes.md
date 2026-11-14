# Panes

`Panes` arranges peer tools as tabs and resizable nested splits. The application owns the serializable layout and the runtime item definitions.

## Use Panes

Use it for code editors, query explorers, dashboard editors, and other workspaces where users open, close, move, or split peer tools.

Use `Tabs` for one fixed tab group. Use `AppWorkspace.MainPane` for a fixed
list-and-reader layout, with 12 px of space between regions. Their resize
grips appear on hover, keyboard focus, or drag, without a separator line.

## Look

Panes are one surface. Every boundary carries the quiet column shade of the
workspace, beside a column boundary as between list and reader and above a
row boundary as at a drawer's edge. A resizable boundary shows a neutral grip,
3 px by 2 rem, also at rest; hovering, focusing, or dragging it darkens the
shade, and keyboard focus turns the grip blue. A fixed boundary keeps its
shade and has no grip. There is no line and no colour at a boundary.

A selected tab has the app colour's selection fill and 2 px edge, and every
tab keeps one weight, so selecting or hovering never changes a tab's width. A
movable tab shows a grip before its icon: on the selected tab, on hover and
focus, and always on a touch screen. Its place is always kept.

The drop previews while a tab is dragged (green targets, edge trapezoids, the
centre "+", insertion marks between tabs, and the floating tab) are a finished
design. They stay as they are, and nothing at a boundary paints over them.

## Import

```tsx
import {
  activatePanesItem,
  addPanesItem,
  applyPanesIntent,
  createPanesLayout,
  isPanesItemVisible,
  PANES_LAYOUT_VERSION,
  parsePanesLayout,
  Panes,
  reconcilePanesLayout,
  removePanesItem,
  resizePanesSplit,
  applyPanesPreset,
  type PanesItem,
  type PanesPreset,
  type PanesLayout,
  type PanesNode,
} from "@k2b/ui";
```

## Own the layout

Create the initial controlled value with `createPanesLayout(itemIds)`. It creates one tab group, or an empty workspace when the list is empty.

Pass the current `PanesLayout` to `layout` and replace it from `onLayoutChange`. A layout is a versioned binary tree:

- a `group` stores a non-empty ordered list of item ids and its active id;
- a `split` stores its direction, ratio, and two child nodes;
- `root: null` represents an empty workspace.

The tree contains no DOM ids or render functions and can be stored as JSON. Helpers emit `version: PANES_LAYOUT_VERSION`. `parsePanesLayout(value)` accepts only a valid current layout and returns `null` for malformed, unsupported, duplicate, or excessively deep input. Choose an explicit product fallback when persisted input is invalid.

Keep item ids stable. `reconcilePanesLayout(layout, desiredOpenIds)` removes other ids and appends missing desired ids to the first group. Use it when the complete desired set should also be open. For workspaces where available items and open items differ, use `addPanesItem` and `removePanesItem` instead.

The pure helpers support the same operations outside the component:

- `activatePanesItem` selects an item;
- `addPanesItem` opens an item in a target group;
- `removePanesItem` closes an item and collapses empty split branches;
- `applyPanesIntent` applies a tab move, reorder, or split;
- `resizePanesSplit` changes a split ratio;
- `isPanesItemVisible` reports whether an item is active in its group.

Each layout-mutating helper returns the original layout when the requested operation is invalid or has no effect.

## Define runtime items

Pass runtime-only `PanesItem` descriptors separately from the layout:

See `PanesItem` in the [API reference](#api-reference).

`render` is lazy: Panes invokes it only for the active item in each group. Switching tabs unmounts the previous content. Reordering a group does not recreate its active content.

The presence of `onClose` enables the close control. Its callback only reports intent; the application updates its domain state and layout. The close control is available on hover or keyboard focus and does not start a drag.

An empty workspace shows a round mark and "No pane is open." without a box. Pass `onAddItem` to show a plus control in every group and below that sentence. It receives an item id from the target group, or `null` for an empty workspace. The application chooses or creates the item, then updates the layout with `addPanesItem`.

## Interaction

`movable`, `resizable`, and `split` configure the available operations. `split` accepts `false`, `"horizontal"`, `"vertical"`, or `"both"`; all interactions are enabled by default.

Tab groups stay on one line and scroll horizontally when their tabs no longer fit. A thin overlay scrollbar appears while the tab row is hovered or contains keyboard focus without changing the row height.

Once dragging starts, Panes shows every valid destination at the same time: exact tab insertion positions, add-to-group targets, and explicit Add left, right, top, and bottom targets. Duplicate and no-op destinations are not offered. Releasing elsewhere cancels the move.

## Arrange

A movable workspace with two or more open items has one **Arrange** text
button, at the end of the top group on the trailing side. Its menu offers:

- the presets **Two** (the first item beside the rest as tabs), **Three** (the
  first two items beside the rest), **Stacked** (the first item beside the
  second above the rest), and **Tabs** (one group), as tiles; a preset that
  needs more items or a split direction that `split` forbids is left out;
- for the tab chosen last, by click or focus, every place it can move to, each
  naming its neighbour: Above, Below, Left of, and Right of an item, As a tab
  with an item, and one step left or right within its own group. Every drop
  target has an entry, so keyboard and screen reader users reach every
  arrangement without dragging;
- **Reset arrangement** when `defaultLayout` is set and names the same open
  items; it is disabled while the layout already has that arrangement and
  those sizes.

The same menu opens with a right click on a tab, Shift+F10, or the context
menu key. Presets arrange the open items in the order of `items`. Choosing
the preset that matches `defaultLayout` restores its ratios, also when it is
the current arrangement, and a double
click or Enter on a boundary restores that boundary's ratio from
`defaultLayout`, or 0.5 when the arrangement differs. Focus returns to the
moved tab, and a screen reader hears where it went.

Pass `arrangeHint` to show a one-time hint at the first tab grip, "Panes can
be arranged", with an Arrange action. The application decides whether it was
seen and stores `onDismiss`, as with every `MovedHint`. The hint steps aside
while a tab is dragged, so it never covers a drop target.

## Narrow containers

Below 640 px of its own width, Panes shows every open item as one row of
tabs in tree order, opening on the tab chosen last or the first group's
active tab. It is a projection: it never calls `onLayoutChange`, offers no
grips, Arrange, or boundaries, and the stored layout returns once the
container is wide again. Many tabs scroll sideways. The width is measured
after the first render, so server HTML and hydration agree.

## Resize

While resizing, a separator snaps to a nearby separator of the same direction in a neighboring pane. This aligns adjacent pane heights or widths without adding alignment metadata to the persisted layout. Pointer and keyboard resizing use the same visible geometry. A pointer resize never selects page text.

## API reference

```ts
type PanesDirection = "horizontal" | "vertical";

type PanesSide = "left" | "right" | "top" | "bottom";

type PanesPathSegment = "first" | "second";

type PanesPath = readonly PanesPathSegment[];

type PanesGroup = {
  type: "group"; items: string[]; active: string;
};

type PanesSplit = {
  type: "split"; direction: PanesDirection; ratio: number; first: PanesNode; second: PanesNode;
};

type PanesNode = PanesGroup | PanesSplit;

type PanesLayout = {
  version: typeof PANES_LAYOUT_VERSION; root: PanesNode | null;
};

type PanesIntent =
  | {
      type: "tab";
      itemId: string;
      targetItemId: string;
      beforeItemId: string | null;
    }
  | {
      type: "split";
      itemId: string;
      targetItemId: string;
      side: PanesSide;
    };

type PanesItem = {
  id: string; title: string; icon?: string; render: () => JSX.Element; onClose?: () => void;
};

type PanesProps = {
  layout: PanesLayout; onLayoutChange: (layout: PanesLayout) => void; items: readonly PanesItem[];
  movable?: boolean; resizable?: boolean; split?: false | "horizontal" | "vertical" | "both";
  onAddItem?: (targetItemId: string | null) => void;
  defaultLayout?: PanesLayout; arrangeHint?: { open: boolean; onDismiss: () => void };
  ariaLabel?: string; class?: string;
};

type PanesPreset = "two" | "three" | "stacked" | "tabs";

type AddPanesItemOptions = {
  itemId: string; targetItemId: string | null; beforeItemId?: string | null;
};
```

`PANES_LAYOUT_VERSION` is `2`. `ratio` is the first child's fraction; resize helpers clamp it to 0.08–0.92. IDs must be unique, nonempty stable IDs no longer than 160 characters. Parsing accepts at most 64 nodes and depth 12; invalid input returns null.

```ts
declare function createPanesLayout(itemIds: readonly string[]): PanesLayout;
declare function parsePanesLayout(value: unknown): PanesLayout | null;
declare function activatePanesItem(layout: PanesLayout, itemId: string): PanesLayout;
declare function addPanesItem(layout: PanesLayout, options: AddPanesItemOptions): PanesLayout;
declare function removePanesItem(layout: PanesLayout, itemId: string): PanesLayout;
declare function reconcilePanesLayout(layout: PanesLayout, desiredOpenItemIds: readonly string[]): PanesLayout;
declare function applyPanesIntent(layout: PanesLayout, intent: PanesIntent): PanesLayout;
declare function resizePanesSplit(layout: PanesLayout, path: PanesPath, ratio: number): PanesLayout;
declare function isPanesItemVisible(layout: PanesLayout, itemId: string): boolean;
declare function applyPanesPreset(
  preset: PanesPreset,
  itemIds: readonly string[],
  options?: { active?: string; fallback?: PanesLayout },
): PanesLayout | null;
```

`applyPanesPreset` arranges the items in the given order as a preset, keeps
`active` visible in its group, and takes the ratios of a `fallback` with the
same arrangement. It returns `null` when there are too few items: Two and Tabs
need two, Three and Stacked need three.

A `PanesPath` locates a split through `first`/`second` edges; `[]` addresses the root. `AddPanesItemOptions.targetItemId` locates a target group by an existing item; it is not a group ID.

## Accessibility

Give every item a concise title. Set `ariaLabel` when the surrounding context does not already identify the workspace clearly; it defaults to `"Pane workspace"`.

Clicking or tapping a tab activates it. Left and Right Arrow move through the tabs; Home and End select the first and last tab. `Delete` and `Backspace` request closing the focused tab when `onClose` is available.

Start a focused tab move with Space or Enter, select a visible target with the arrow keys, then confirm with Space or Enter; Escape cancels the move. Shift+F10 or the context menu key opens the Arrange menu for the focused tab, and Ctrl+Shift+Left or Right moves it one step within its group. Focus a separator and use the arrow keys for its orientation to resize the panes. Hold Shift for a larger step; Home and End move to the minimum and maximum supported ratio, and Enter restores the default ratio, as a double click does. Announcements while moving use the inherited locale.

## Runtime

`Panes` is controlled interactive Solid code and requires browser code. Its initial active contents can render on the server.

Persist only `PanesLayout`. Runtime descriptors contain functions and stay in application code; they never cross the serialization boundary. Use the same deterministic initial layout on the server and in the browser.

## Example

```tsx
const definitions = [
  { id: "result", title: "Result", icon: "ti ti-table", render: () => <ResultView /> },
  { id: "query", title: "Query", icon: "ti ti-code", render: () => <QueryEditor /> },
  { id: "schema", title: "Schema", icon: "ti ti-database", render: () => <SchemaBrowser /> },
] as const;

const [layout, setLayout] = createSignal<PanesLayout>(
  createPanesLayout(["result", "query"]),
);

const items: readonly PanesItem[] = definitions.map((item) => ({
  ...item,
  onClose: () => setLayout((current) => removePanesItem(current, item.id)),
}));

const openItem = (targetItemId: string | null) =>
  setLayout((current) =>
    addPanesItem(current, { itemId: "schema", targetItemId }),
  );

const schemaIsOpen = () => {
  const contains = (node: PanesNode | null): boolean =>
    node?.type === "group"
      ? node.items.includes("schema")
      : node?.type === "split" && (contains(node.first) || contains(node.second));
  return contains(layout().root);
};

<Panes
  layout={layout()}
  onLayoutChange={setLayout}
  items={items}
  onAddItem={schemaIsOpen() ? undefined : openItem}
  ariaLabel="Query workspace"
/>;
```
