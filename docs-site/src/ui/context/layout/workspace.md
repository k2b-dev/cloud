# AppWorkspace

`AppWorkspace` is the full-height shell for application workspaces. It owns the sidebar, primary work area, contextual detail panels, and optional bottom drawer.

The application owns the content and which regions are open.

For browser printing, mark the complete readable content with `data-print-region`, or provide an export hint through Cloud Layout `printHint`. See [Browser printing](/en/ui/layout/print) for the region and fallback contract.

The sidebar and `Main` share one base surface, white in the light theme,
separated by space. A Detail
column is part of that surface, with no fill, frame, or shadow. The bottom
drawer uses the subtle surface.
Keep region wrappers transparent. A view that fills `Main`—a canvas, graph,
editor, or empty state—is `Main`'s surface and draws no radius or border of its
own. Placeholders in `Main` draw no box, and new views add no inset cards or
table frames (maintainer decision, 16 October 2026); applications remove their
existing frames in their own changes. An object, such as a Kanban card that you
drag and open, may be a rounded surface; a group of objects uses space and a
heading instead.

## Use AppWorkspace

Use it for resource lists, readers, editors, and operational screens that need persistent navigation around a primary work area.

Use `AppOverview` for a simple landing page. Use `Panes` inside `AppWorkspace.Main` when users must rearrange or split several peer tools.

## Import

```tsx
import {
  AppWorkspace,
  normalizeAppWorkspaceLayoutState,
  type AppWorkspaceLayoutState,
} from "@k2b/ui";
```

## Objects on the left, views in the head

Where things go is one rule for every application: objects in the sidebar,
views and filters in the head, the detail beside the content.

| Rule | What it says |
| --- | --- |
| R1 Objects, not views | The sidebar shows objects: things you open and go to, such as Spaces, tables, books, and mailboxes. Actions on an object (settings, iCal, share) sit in its head or under "…". An app with only one object has no sidebar. |
| R2 Views as tabs | Views are tabs in the head, right beside the title. From about five views, "More +n" appears and the selected view stays visible. On the phone they are tabs at the top of the card, in every app. A tab keeps its full label and count; a strip too narrow for its views scrolls sideways, cut at the card edge, starts with the selected view in view, and fades the edges where more views wait. The selected view stays in the URL (`?view=`). |
| R3 Filters as chips | Filters are chips in the same row as the tabs when there is room; otherwise they wrap to a second row. The workspace's width decides, not the window's. An active filter is tinted and names its value ("Tags: Customer"; set `showValue`, which toolbars outside the head row do not use yet); while filters are active, "Reset" appears. The count on a tab is enough; a quiet result count appears only while a filter is active and is the first thing to go when space is short. A single on/off filter is a `FilterToggle`. |
| R4 One surface | Head, filters, and content lie on the same white surface: no gray column trays, no `Paper` box, no line under the head. Space and a clear group heading (dot, name, count) separate groups. |
| R5 Color from content | Status dots, tag colors, places, and stock carry color. The accent carries only the selection; controls stay platform blue, and only the one main action is filled. See [Colors and selection](/en/ui/surfaces/color). |
| R6 Space, not lines | Rows and tables have no dividers and no grid; rows are 40–44 px high with a hover fill. |

Three exceptions:

1. An object may be a rounded surface in the main card, such as a Kanban
   card that you drag and open; a group may not.
2. The sidebar is white: it lies on the content's surface, separated by space.
3. Wide editing tables (more than about eight columns) may draw a hairline
   between rows.

The head follows these rules as well:

- It shows no title while the visible sidebar marks the object (from
  64 rem). The title follows the page trail: a page with a page above it
  shows its title and back link with the sidebar collapsed or hidden, on
  focus pages that the sidebar does not mark (such as Compose or Preview),
  and on tablet and phone. An app's root page shows its title only beside
  the overlay sidebar's button. A page without its own `h1` keeps a visually
  hidden one.
- The back link goes with the title. Beside a visible sidebar it remains
  only for pages deeper than the sidebar lists: the sidebar marks their
  container with `active="ancestor"`, not the page itself.
- Tabs, chips, and actions share one row while they fit. As the head narrows,
  the quiet count goes first, filters wrap, and views become compact with
  “More +n” before scrolling sideways. The primary action then keeps only its
  icon and accessible name. If the lead and actions still do not fit, they
  use separate rows. The head measures its own width, including space lost
  to neighboring panels; controls never draw over each other.
- Exactly one action is filled. On the phone it becomes a round button; a
  host with a bottom bar, such as Cloud, places it beside the bar.
- Files keeps its path in the head (exception D1 to "no title").

The sidebar stays resizable; its handle shows on hover and focus. The minimal
Grids table is the reference for tables.

### Compose the head row

Place `AppWorkspace.Head` as a **direct child** of `AppWorkspace`, in any
position. It is a slot: the workspace renders its parts in the existing head,
leaving the other children in order. Individual parts may be islands. Give
the chips `showValue`, keep secondary actions quiet, and put the one filled
action in `primary`.

```tsx
import { AppWorkspace, ViewTabs } from "@k2b/ui";

<AppWorkspace>
  <AppWorkspace.Head
    views={<ViewTabs label="Views" current="list" items={[
      { id: "list", label: "List", href: "?view=list", count: 12 },
      { id: "board", label: "Board", href: "?view=board" },
    ]} />}
    filters={filterChips}
    filtered={filtered}
    resetHref="?view=list"
    count="12 results"
    actions={searchAction}
    primary={{ label: "New task", icon: "ti ti-plus", href: "?new=task" }}
  />
  <AppWorkspace.Content>
    <AppWorkspace.Main>{tasks}</AppWorkspace.Main>
  </AppWorkspace.Content>
</AppWorkspace>;
```

The server reads `current` from `?view=`. No client measurement changes the
strip or head layout after mounting. Only the view strip's own scroll position
is set, by an inline script before the first paint, so a strip that scrolls
on a phone shows the current view in the first frame
([ViewTabs](/en/ui/actions/tabs#viewtabs)). `resetHref` works before JavaScript;
`onReset` handles an interactive reset. With both, the callback handles a
plain click while the URL remains available to the browser. The result count
and Reset appear only while `filtered` is true.

A head rendered on the server outside an island runs no callbacks. Give
`primary` an `href` there, such as a command link that the page's island runs
on load, and let that island handle a plain click in place. Filter chips with
state of their own belong in an island in `filters` with their own Reset.

```ts
type AppWorkspaceHeadProps = {
  views?: JSX.Element;
  filters?: JSX.Element;
  filtered?: boolean;
  resetHref?: string;
  onReset?: () => void;
  count?: JSX.Element;
  actions?: JSX.Element;
  primary?: {
    label: string;
    icon: string;
    href?: string;
    onClick?: (event: MouseEvent) => void;
  };
};
```

The host supplies the page trail. A visible sidebar item marked `active`
names the object on desktop; the head keeps its views while hiding the repeated
title. A hidden `h1` supplies the page heading only when Main has no `h1`.
The primary label stays in the DOM when CSS turns the phone action into an
icon button, preserving its accessible name.

## Compose the regions

`AppWorkspace.Content` is required. Put `Main` first and each `Detail` after it
as direct children of `Content`, possibly through a Solid island wrapper. The
column and drawer geometry depend on that placement. Put `BottomDrawer` at the workspace root.

`Main` adds no padding. Pass an application class through `class` when the workspace needs an inset. Omit it for edge-to-edge tables, editors, canvases, or `Panes`. Set `width="content"` on an overview or reading page: each direct child then becomes one centered column with the shared 72 rem page width on large screens and full width below, while the detail panel occupies its own full-height column at the workspace's end. `Main` is the default scroll owner and reserves a stable scrollbar gutter. Pass `scrollPreserveKey` when enhanced navigation should restore its position.

`Main` and `MainPane` show subtle 16 px overflow hints by default when they
own scrolling. Set `scrollFade={false}` to opt out. A split `Main` wrapper
never masks its panes; each scrolling pane owns its hint. Regions with
`scroll={false}` do not add a hint around their child scrollport. The workspace
controller also initializes marked server-rendered scrollports and cleans them
up during navigation, sharing observers with components with browser code.

Set `scroll={false}` when a bounded child such as `ScrollArea`, `DataTable`, a reader, editor, or an explicit `overflow-auto` region owns scrolling. Do the same on `MainPane` when its child owns the pane's scrollport. Keep exactly one vertical scroll owner for each region; do not place another scrollport inside a still-scrolling `Main` or `MainPane`.

Use `MainPane` for a stable peer region such as a list beside a reader, or for each column in levels mode. Use `Detail` for contextual information about the current selection. Use `BottomDrawer` for activity, preview, or a composer below the work area.

Give every pane, detail, and drawer a stable purpose-based `id`. Do not use the selected record id. The host can use these ids with the exported layout-state helpers to restore geometry.

Set `resizable={false}` on the root to disable shared resizing. A region can override the root with its own `resizable` property.

An open `MainPane` keeps its content mounted when layout state, mobile selection, or another pane changes. Closing a `MainPane` unmounts its content; reopening it creates a fresh instance.

`Detail` and `BottomDrawer` remain mounted while closed. Their `open` property
controls visibility, so local state and SSR DOM identity remain stable.

A host that places the workspace on the window's bottom edge sets
`--k2b-workspace-inset-bottom` on it, for example to
`env(safe-area-inset-bottom, 0px)` in an installed app on a tablet. The default
is 0. The surfaces on that edge still reach it and fill the inset with their
own background: the sidebar, `Main` or each of its panes, and an open
`BottomDrawer`. Their content ends above the inset, so the last row clears the
home indicator. A scrolling `Main` or pane fades its last rows above the
inset, and the inset keeps the end of that fade. A Detail column keeps its 0.5 rem inset above it. Cloud
sets the property on the outermost workspace of its tablet and laptop shell, so
applications need nothing.

## Host width

The nearest `k2b-app-area` inline-size container supplies the app's width.
The component stylesheet declares `html { container: k2b-app-area / inline-size; }`
by default. Standalone pages therefore follow the window. A classic document
scrollbar reduces the root's content width; overlay scrollbars do not.

Cloud provides this host from 1024 px when its panel column is open: the app
area beside the panel becomes the nearest `k2b-app-area` container from the
first server frame. Drawer and phone sheet modes keep the app's width.

A host that puts another column beside the app declares the same container
around the app area:

```tsx
<div style={{ container: "k2b-app-area / inline-size", width: appWidth }}>
  <AppWorkspace>{/* regions */}</AppWorkspace>
</div>
```

The nearest named container wins. Its width selects the sidebar column from
64 rem and the two or three level classes at 80 rem. Even in a wide host, the
sidebar becomes an overlay when its column plus Main's minimum do not fit.
From a 48 rem viewport, Detail fit follows the content region beside the
sidebar at every host width. A narrowed host such as Cloud's panel column
therefore follows the same rule without a host marker
([#1381](https://github.com/k2b-dev/cloud/issues/1381)). The 48 rem phone split
and phone sheet still follow the viewport. CSS decides the first frame;
no browser measurement chooses the initial layout.

App stylesheets query `k2b-app-area` for workspace chrome tied to the sidebar
or levels. Use `@container k2b-app-area (min-width: 64rem)` in CSS,
`@min-[64rem]/k2b-app-area:` in Tailwind classes, and
`watchAppHostWidth(element, 64, update)` from `@k2b/ui` in script; call its
returned stop function on cleanup. Levels use the 80 rem threshold.
In app stylesheets, avoid `max-width` and `@max-` container variants:
fractional widths can fall between ranges. Hide below a threshold with base
`hidden` plus a minimum display class, or use
`@container k2b-app-area not (min-width: 64rem)` to preserve a component's own
display. Dialogs, floating windows, and toasts mount outside the app's host,
so their CSS follows the window; decide such chrome in script with
`watchAppHostWidth` on an element inside the app. Keep viewport rules for the
48 rem phone split and for pointer capabilities.

Because the document root is a container, an unnamed `@container` query in
application CSS without a nearer container now follows the window. Name the
container a query belongs to, as in `@container my-form (min-width: 54rem)`.

The root's containment also stops `body` from handing its background and
`overflow` to the canvas and the viewport. Paint the page color on `html` as
well as on `body`, and lock page scrolling on `html`, as the @k2b/ui dialogs
do. A `body` that alone sets `overflow: hidden` clips its own box and leaves
the document scrollable.

Declare a host's container name in its stylesheet or markup from the first
paint. Keep it stable while the workspace's width stays the same. The name
may change together with the workspace's own width, as Cloud's panel does:
the controller follows both the initial host and the workspace's own resizes.
Changing only the name without a resize does not trigger that update.

## Levels

Use `Main level` for a hierarchy of columns, such as settings areas, a list,
and a reader. Every child must be a `MainPane`. Their DOM order runs from
shallowest to deepest. Only open panes count as levels. Give every level except
the last an `href` that selects it.

The viewport keeps one level on phones. Above that, the host decides:

| Class | Width | Levels shown |
| --- | --- | --- |
| 1 | Viewport below 48 rem (768 px) | 1 |
| 2 | Viewport from 48 rem; host below 80 rem (1280 px) | Up to 2 |
| 3 | Host from 80 rem (1280 px) | Up to 3 |

The window rule is: **the deepest levels that fit, the selection decides**.
The selected level ends the window unless the first levels already fit.
For three levels, selecting level 3 shows level 3 on a phone, levels 2–3 at
1024 px, and levels 1–3 at 1440 px. Selecting level 1 shows levels 1, 1–2,
or 1–3 at those widths. An unknown id selects the first level.
Hidden levels stay mounted; CSS hides them without losing local state.

The width classes count the host, not the room beside the sidebar: from a
64 rem host the sidebar column takes its width from all of them, and below
that it is an overlay outside phones. The server render and first client frame show the same levels.
Give `Main level` the workspace's full width: the deepest level takes the
place of a `Detail`, so do not open one beside it. If Main still has less
room than the shown levels need, it scrolls sideways so the selected level
stays reachable.

Keep the selection in the URL and pass its level id to `level`. Reload and
back/forward then restore the same selection. When a shallower level is hidden,
a back step sits at the start of the first visible level's head, left of its
title, at every width. It links to the parent of the selected level and its
accessible name names the hidden level, for example "Back to AI". Its target is
44 px. Pass `onLevelNavigate` for enhanced navigation when the owning island
applies the destination state. Otherwise it is a normal document link. When a
level change hides the focused control, such as the back step itself or a row
of a list the phone no longer shows, focus moves to the title of the selected
level.

Each level head is a 46 px row without a line under it: the `label` as the
title, an optional one-line `description`, and trailing `actions`. Every level
starts below the same 8 px top inset, so the titles of side by side heads share
one line when the heads have the same form, all with or all without a
description. Selecting a row keeps every visible level where it is.

The levels draw no lines between them. The last visible level fills the
remaining width, whatever its content: a long title or text in the selected
item never narrows the levels before it. When another level shows before it,
it is a raised surface with an 8 px inset. On a
phone the one level is flat. Levels do not animate.

Resize earlier levels by dragging their separators or using Left/Right (8 px),
Shift+Left/Right (32 px), Home (minimum), and End (maximum). Double-click a
separator to reset that pane to its default size. On a touch screen a separator
is a 44 px gap of its own between two levels, so a tap on the edge of a row
never starts a resize. `minSize` and `maxSize` use pixels; the default limits
are 240–640 px. `defaultSize` accepts pixels or a workspace width share
(see [Detail and panel](#detail-and-panel)). Available space may reduce the
maximum, because the last level keeps 320 px.

A resize starts from the widths on screen. When the window is too narrow for
the stored widths, the shown levels give way; the first step on a separator
then stores the widths they show, so the step moves by exactly its size and a
reload shows the same columns. Their wider widths from a larger window are
replaced.

Persist the full state from `onLayoutChange`. Restore it through `layoutState`
or `AppWorkspace.LayoutStateProvider`, and apply `appWorkspaceLayoutStyle`
to an ancestor during SSR. The widths are then right in the first frame,
before any browser code runs. Pane widths are stored by stable pane id; the
persistence envelope is 160–960 px and each pane still applies its declared
limits. Cloud persists this state automatically
in its per-app workspace cookie.

```tsx
<AppWorkspace.Content>
  <AppWorkspace.Main level={levelFromUrl}>
    <AppWorkspace.MainPane id="areas" label="Areas" href="?level=areas">
      <a href="?level=providers">AI providers</a>
    </AppWorkspace.MainPane>
    <AppWorkspace.MainPane
      id="providers" label="Providers" href="?level=providers"
      description="Available services"
    >
      <a href="?level=model">Atlas</a>
    </AppWorkspace.MainPane>
    <AppWorkspace.MainPane id="model" label="Model" actions={<ModelActions />}>
      <ModelDetails />
    </AppWorkspace.MainPane>
  </AppWorkspace.Main>
</AppWorkspace.Content>
```

The phone-only `mobilePane` remains available for Mains without `level`.
Levels mode ignores it. In levels mode each pane body owns scrolling below its
head; `scroll={false}` lets a bounded child own scrolling instead.

## Detail and panel

From a 48 rem viewport, Detail and a host panel follow six rules:

1. Main keeps its minimum width.
2. When Detail fits beside Main, it is a column.
3. Otherwise Detail waits behind **Details**. Clicking that button, a contact,
   or a file opens it as a drawer.
4. The drawer sits flush with the app card's edge, below the workspace head,
   never as a third card beside the panel. Escape parks it.
5. Opening the host panel parks an open drawer. Closing the panel restores
   the Detail column automatically if it fits.
6. The host panel never closes by itself.

Set `AppWorkspace.Main minWidth` in pixels or as `AppWorkspaceWidthShare`
when the work needs more than the 320 px default. Numeric values at or below
320 and non-finite values keep the default.
The minimum reserves Main's space beside the sidebar and Detail. CSS uses it
from the first server frame, before any island mounts. Sidebar resizing keeps
that minimum too; it cannot drag the sidebar into its overlay form. The
minimum is bounded by the host's width (see [Host width](#host-width)): a
workspace narrower than the window needs a named `k2b-app-area` host, as for
the sidebar decision.

A width share is `{ share, offset?, min, max }`, all widths in pixels. It
computes `clamp(min, share × workspace width + offset, max)`. `share` must be
between 0 and 1, excluding both. `offset` defaults to 0. The offset and limits
must be finite, with `min <= max`. An invalid share keeps the default.
Workspace width means the workspace root's border-box width, including its
1 px border on each side. It follows the app card, even inside a narrower host.
CSS resolves the share in the first server frame. Phones keep their existing
layout.

For a list that grows with the workspace, derive Main's minimum from the same
share plus the space its reader needs:

```tsx
<AppWorkspace.Main minWidth={{ share: 0.25, offset: 428, min: 772, max: 892 }}>
  <AppWorkspace.MainPane
    id="list"
    label="Items"
    defaultSize={{ share: 0.25, offset: -12, min: 332, max: 452 }}
  >
    <ItemList />
  </AppWorkspace.MainPane>
  <ItemReader />
</AppWorkspace.Main>
```

The list grows from 332 to 452 px, including its 12 px region gap. Main keeps
that width plus 440 px for the reader before Detail can become a column.
`MainPane.defaultSize` uses the share while there is no stored or live width.
Its own `minSize` and `maxSize` still apply, and it gives way while Main's
primary region keeps 320 px. Resetting its handle restores the share.
CSS fits each share default against Main alone. Beside other panes, keep the
defaults' sum within Main's room: the controller fits crowding panes only
after it attaches, which moves them once after the server frame.

Waiting depends on the width of the content region beside the sidebar at
every host width and with every input device. Column fit requires Main's
minimum plus the Detail width token plus an 8 px inset:

| Detail width | Fits with the default 320 px Main |
| --- | --- |
| `sm` (320 px) | 648 px |
| `md` (416 px) | 744 px |
| `lg` (480 px) | 808 px |
| `xl` (544 px) | 872 px |

An open waiting drawer uses `--k2b-shadow-side` to cast a soft shadow toward
the covered content. The token mirrors the phone sheet: a leftward shadow
in light and dark, with no change to the drawer size or Main.

The column has no fill, frame, radius, or shadow; it shares the workspace
surface. Its top, right, and bottom inset is 8 px. This replaces the earlier
floating-detail appearance.

A waiting Detail stays mounted and `open` stays true. Its **Details** button
in the head controls it through `aria-controls` and `aria-expanded`. The head
reserves the row whenever a Detail of that width token would wait, open or
closed, so opening or closing never moves Main.

The button opens a raised drawer flush with the workspace's right and bottom
edges and the head's bottom edge. Main keeps its width. Keyboard activation
focuses the Detail title; pointer activation keeps focus on the button.
Choosing an item in Main opens a waiting Detail as the drawer when the Detail
opens with that choice. While the Detail stays open, a choice reopens it only
when the application marks the chosen item or an ancestor inside Main with
`aria-selected="true"`, `aria-current` other than `"false"`, `"date"`, or
`"time"`, or `data-selected="true"` (as DataTable's `selectedRowId` does) after activation.
The mark may arrive later, for example after a load; the choice waits for it
until another interaction replaces it. Tabs and date selections on calendar
day cells do not count as a choice.
A control inside the selected row that discloses, toggles, opens a menu, or
takes input does not count as a choice.
Enter, Space (except on links, which it does not activate), and
assistive-technology clicks count as keyboard choices and focus the Detail
title; a completed primary pointer click keeps focus on the
item. Live content updates alone leave it waiting. An initially open Detail,
or one opened without a fresh Main choice, keeps waiting. The drawer is not modal.

Set `openOnChoice={false}` when Main shows the chosen item, as in Mail's reader
beside a list. The waiting drawer then opens only from **Details** or a toggle
in Main with `aria-pressed`, `aria-expanded`, or `aria-controls`. Give a toggle
`aria-controls={appWorkspaceDetailElementId(id)}` to target its Detail. From a
48 rem viewport, when that Detail is open and waiting, a click opens or parks
its drawer and leaves the application's `open` state true. This also works
for a control inside Detail. The application's click handler does not run in
that case. Keyboard activation focuses the Detail title; pointer activation
keeps focus on the control. A click with Ctrl, Cmd, Shift, or Alt, a
non-primary button, or an already prevented click stays with the application
and the browser, so a link still opens in a new tab. While waiting, the
controller sets `aria-expanded` to the drawer's state. When Detail becomes a
column, the application's rendered attribute is restored; when it closes, a
control that rendered `aria-expanded` reads `false`. `aria-pressed` remains
application-owned, so a toggle that controls a Detail uses `aria-expanded`
alone. For a column, a closed Detail, or a phone sheet below 48 rem, the
application's handler runs as usual.

Escape parks the drawer and returns focus to **Details**, without calling
`onClose`. The button also parks it. A rightward touch swipe parks an open
waiting drawer from 48 rem, returning focus only if it was inside the drawer.
Dialogs, popovers, text entry, and consumed keys keep their own behavior.
Escape does nothing to a Detail that only waits, and F6 skips it. Widening
restores the column and clears drawer state; narrowing again starts waiting.
When a column starts waiting under focus, focus moves to **Details**. When
it returns while that button has focus, focus moves to the title.

A host parks drawers before opening its panel column:

```tsx
import { parkWorkspaceDetailDrawers } from "@k2b/ui";

function openHostPanel() {
  parkWorkspaceDetailDrawers(appArea);
  setPanelOpen(true);
}
```

The helper defaults to `document`. It updates each open drawer's button and
returns focus only when it was inside that drawer.

Pass `onClose` to close or deselect a column with Escape or a phone sheet with
a downward drag. Server-rendered panels mark their close button or link with
`data-workspace-detail-close` instead. Without either, these gestures keep the
Detail open. `onStep` receives `1` for J and `-1` for K; return the Main item
that now shows the selection so the workspace can reveal it and return focus.
F6 switches between the remembered item and the Detail title. Keyboard
selection also waits for a title that arrives after loading. Pointer selection
focuses the title only on phones. Closing returns focus to the remembered item
when focus was inside the Detail. The application owns `open`.

Use `scrollClass="k2b-detail-trail"` on DataTable to preserve its column widths
beside Detail. Mark a board's horizontal scroller with `k2b-detail-trail` too.
Under an open waiting drawer, a trail gets the drawer's width as space at its
end, so the last column or card can scroll beside it. A trail inside Detail
gets no extra space. Calendar's day and week views mark their own scrollers.
The trail clips to the surface radius; inside Paper it follows the inner
radius. Put it directly in Main's content box with `scroll={false}` on Main
and no vertical scroller around it. A reserved scrollbar gutter would add a
second gap before Detail.

Below 48 rem, the default sheet covers the lower 55% of the window. Main
reserves space at its end and reveals the selected row above the sheet.
Tap the grabber to switch half/full height. Drag the grabber or header up to
expand, down to return to half, and down from half to close a closable sheet.
Pulling down from content at its scroll top also lowers it. Fields, sliders,
editable text, canvases, draggable elements, and elements that own the gesture
keep their own input. A frame embedding a workspace in a longer page sets
`contain: layout` to keep the sheet inside it.

Use `phone="page"` for a destination such as chat info. Below 48 rem it fills
the window with the page surface and safe-area padding, without sheet gestures,
detents, or extra Main space. The rest of the workspace is inert. From 48 rem
it follows the same column/waiting rules as every Detail.

The first server-rendered or newly inserted Detail appears without motion.
After two frames, column opening reserves its space immediately and slides
Detail in; closing gives the column back after the slide. Reduced motion
makes opening, closing, and item reveal immediate. Parking a drawer always
hides it at once.

## Navigation

`Sidebar` with `SidebarDesktop` supplies the workspace navigation. Its form
follows the host width above the viewport’s 48 rem phone split:

| Width | Navigation | Work area |
| --- | --- | --- |
| Viewport below 48 rem (768 px) | Hidden; the host renders its mobile navigation | One pane at a time; Detail is a sheet over the lower 55% of the window, and Main scrolls its rows above it; full height covers Main |
| Viewport from 48 rem; host below 64 rem | An overlay that a button in the head opens; a `mobile="stacked"` sidebar stays above the content | Panes side by side; Detail is a column if it fits, otherwise waits behind Details |
| Host from 64 rem (1024 px) | A column if sidebar + Main minimum fit, otherwise an overlay | Detail is a column if it fits beside Main, otherwise waits behind Details |

Below 48 rem the host renders its mobile navigation using
[createNavigation and Navigation](/en/ui/layout/navigation), usually inside a
[BottomSheet](/en/ui/layout/bottom-sheet). AppWorkspace adds no mobile
launcher or second application title there. Sidebar items with an `href`
remain real links.

From a 48 rem viewport, an overlay sidebar makes the workspace show its head above the content: a
button labeled **Show navigation** and, if the host provides a page trail, the
page title. The button opens the sidebar over the work area, and over the head, as a
raised surface with a scrim beside it; the work area keeps its geometry and the
sidebar takes no width from a `Detail`. While it is open, the rest of the
workspace is inert, regions the application made inert stay inert after it
closes, and Tab moves only between the sidebar's tab stops. Focus starts on the
current item, or on the tree item around it in a `NavTree`. Escape, a click on
the scrim, choosing a link or an item, hiding the sidebar, regaining column
space, or crossing the viewport’s 48 rem phone boundary closes it; Escape and the scrim return focus to the button.
A tree folder that only expands, a row that opens its preview, a section
toggle, and an item's own actions keep it open. The head, the overlay, and the
scrim draw no border lines. A sidebar collapsed to its rail on a wide screen
opens expanded. The shared controller binds the button, so a server-rendered
workspace gets the overlay without browser code of its own; the button does
nothing before a controller runs. In a nested workspace, its own button opens
its own overlay.

### Head

Without a Head slot, the head is one 46 px row above the work area, beside the
sidebar column. A Head slot makes it a 56 px row that is always there and lets
its filters wrap.
It draws no line; only its place separates it from the content. The default head shows:

- from a 48 rem viewport whenever the sidebar is an overlay, with its navigation
  button and page title;
- whenever a Detail of the present width token would wait, with room for Details;
- at every width, when the host's page trail has a page above the current one.
  It then holds a [PageTitle](/en/ui/layout/page-title) with the way up: from
  48 rem `‹ Parent` or a path above the title, below 48 rem a back arrow left
  of it. The title is the page's `h1`. From a 64 rem host, a visible, non-collapsed
  column sidebar with `[aria-current="page"]` hides the repeated title and its back link;
  the `h1` remains visually hidden for assistive technology. Mark the exact
  current page with `SidebarItem active`; on a page deeper than the sidebar
  lists, mark the containing item with `active="ancestor"` so it stays
  highlighted and the page keeps its back link. Compact layouts keep the way
  up. A host's Alt+Up shortcut still reads the trail.

The title comes from the host's page trail: a host renders
`PageTrailProvider` around the page during server rendering and calls
`setPageTrail()` after an in-page navigation (see
[PageTitle](/en/ui/layout/page-title)). Without a trail, the default head holds only the button; a Head slot adds its
views, filters, and actions. When the page renders its own `PageTitle`, for
example in an application header, the head's title steps back while its other
controls stay available. A nested workspace's head never shows the title. CSS decides all
of this on the server-rendered markup, so the head arrives in its final place
and nothing moves when a controller attaches. A server-rendered head follows a
new trail once the host runs `followPageTrail()`; Cloud's `Layout` does.

Set `mobileSurface="flush"` on an outer workspace when the host supplies the
phone chrome. This removes its exterior border, radius, shadow, and background
below 48 rem. Embedded workspaces keep the default contained surface.

Set `flat` on a workspace that is the page itself, such as an app's overview.
It removes the workspace's own border, corner radius, and shadow. Where the
host shows the app area as a card, the outermost workspace is that card and
gets its radius and frame, flat or not, so every app shows the same rounded
card. Cloud does this from 1024 px for signed-in people and from 768 px on
anonymous pages.

Sidebar links use document navigation by default. Set `navigation="enhanced"`
only inside an island that loads and applies the target state before committing
history through `onNavigate`. The enhanced helper does not run server loaders
or re-render an SSR page. If `onNavigate` is absent, the link safely keeps
document navigation. See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).

Set `collapsible` on `Sidebar` to let the shared resize controller snap it to
the compact rail. The collapsed flag is part of `AppWorkspaceLayoutState`, so
the host can restore the same navigation state on the next mount.

Set `hidden` on `Sidebar` to hide the desktop navigation completely, for
focused work or when others can see the screen. A hidden sidebar renders none
of its children and no resize handle, so its labels are neither visible nor
reachable, and main panes with `surface="navigation"` hide with it. The work
area takes the full width. Below 48 rem the host's mobile navigation menu
stays available; a `mobile="stacked"` sidebar hides there as well. With a viewport
from 48 rem and a host below 64 rem, the head of a hidden sidebar has no button,
so the application's control
that shows it again is the only way back. Pass
`onHiddenChange` as well to make a drag of the resize handle below half the
minimum width hide the sidebar; the shared controller dims the sidebar at its
minimum width as a preview during the drag, requests `true` on release, and
keeps the width from before the drag for the next time it shows. The work area
therefore changes width once, when the application applies `hidden`.
The hidden state belongs to the application like a persisted layout: render it
on the server so a hidden navigation never paints, and give the control that
shows it again `aria-expanded` and `aria-controls` with the sidebar's `id`.
Every view that renders the hidden sidebar needs such a visible control, not
only the view that hid it. When focus is inside the sidebar or on its resize
handle as it hides, the focused element disappears; move focus to a defined
target, such as the work area or the control that shows the sidebar again.

```tsx
const [hidden, setHidden] = createSignal(initiallyHidden);

<>
  <AppWorkspace.Sidebar id="project-navigation" label="Navigation" hidden={hidden()} onHiddenChange={setHidden}>
    <AppWorkspace.SidebarDesktop>{/* navigation */}</AppWorkspace.SidebarDesktop>
  </AppWorkspace.Sidebar>
  <IconButton
    label={hidden() ? "Show navigation" : "Hide navigation"}
    aria-expanded={!hidden()}
    aria-controls="project-navigation"
    onClick={() => setHidden(!hidden())}
  >
    <i class={`ti ${hidden() ? "ti-layout-sidebar-left-expand" : "ti-layout-sidebar-left-collapse"}`} aria-hidden="true" />
  </IconButton>
</>;
```

Set `scrollPreserveKey` on scrolling sidebar bodies when enhanced navigation should restore their position.
The key also names the sidebar's memory across reloads and document navigations.

Across reloads and document navigations, `SidebarBody` restores the scroll offset the person
left the page with before the first paint, including when an island or other
client render replaces the server markup. The item marked current stays in
view, and the scroll fade matches from the first paint. Memory is per
`scrollPreserveKey` and sidebar position. Without a key, memory is per page path
and sidebar position. Nothing outlives the tab.

`SidebarBody` fades its top and bottom edges automatically while more content
is available in that direction. Scrolling, resizing, and live content changes
update the hint without reserving layout space. Set `scrollFade={false}` to
opt out. Forced-color mode keeps content unmasked. Card items retain subtle
surfaces in dark themes.

On hover-capable fine pointers, `SidebarBody` keeps its scrollbar thumb hidden
until the sidebar is hovered or contains keyboard focus. Its scrollbar geometry
does not change. Touch, coarse-pointer, and forced-color environments retain
their normal visible scrollbar treatment. Rows keep the same inset on the
right as on the left: the narrow scrollbar track sits in the sidebar's right
inset, and a browser with overlay scrollbars draws its scrollbar over that
inset. A browser that ignores the narrow track width and draws a wider classic
scrollbar, such as Firefox on Windows, leaves a right inset as wide as its
scrollbar.

The sidebar compound members cover these jobs:

- `SidebarDesktop`, `SidebarBody`, `SidebarSection`, and `SidebarFooter`
  compose the persistent navigation;
- `SidebarItem`, `SidebarItemIcon`, `SidebarItemLabel`, `SidebarItemMeta`,
  `SidebarItemStatus`, `SidebarItemAction`, and `SidebarItemActions` compose a
  navigation row;
- `NavTree` and `NavTree.Item` compose nested folder, mailbox, category, or tag
  navigation with automatic indentation and keyboard interaction. A flat
  `NavTree` also serves a filtered list with the same rows and keys; an item's
  `description` adds a passive second line, such as a date and tags;
- `SidebarIconGrid` and `SidebarIconAction` provide compact icon-only actions.

Desktop sidebars are action-first: begin with primary actions or navigation,
not a repeated application title. Put persistent secondary navigation in
`SidebarFooter` as `SidebarItem` rows with an icon and visible label, like the
tree rows above them. Use it for app-level destinations such as Attachments and
Settings; when Settings exists, it is the final footer item. The host owns the
mobile trigger and application identity.

Pass labelled shared controls through `SidebarSection.actions` when a section
needs a compact header action such as creating a resource. The section owns
the header alignment; the control still owns its accessible name and action
behavior. Section headers and their actions are hidden with the compact rail
and mobile section layout, so expose an equivalent reachable action in those
compositions. A `SidebarSection` in the content area, such as a list page
that replaces the sidebar on a phone, keeps its header and actions at every
width. With a mouse or trackpad, including a tablet with a mouse,
section actions stay hidden until the header is hovered or contains keyboard
focus. Touch-only screens always show them. An open dropdown keeps its section
action visible and interactive until the menu closes.

Section titles are quiet sentence-case labels. Keep them short and let the
navigation rows carry the stronger visual emphasis.

Active rows use `--k2b-app-workspace-selected` with `--k2b-app-workspace-active` ink
and weight 600, and keep their fill on hover. Ordinary hover uses
`--k2b-app-workspace-hover`; active cards also keep an accent-tinted border.
Keyboard focus keeps the shared focus ring. See [Colors and selection](/en/ui/surfaces/color)
for standalone defaults and Cloud mappings.

Mark the exact current page with `active`; on a page deeper than the sidebar
lists, use `active="ancestor"` on the containing item to keep its highlight and
the page's back link.

```tsx
<AppWorkspace.SidebarSection
  title="Projects"
  actions={
    <IconButton size="xs" variant="ghost" label="Create Project">
      <i class="ti ti-folder-plus" aria-hidden="true" />
    </IconButton>
  }
>
  <ProjectsTree />
</AppWorkspace.SidebarSection>
```

### Switcher

`AppWorkspace.SidebarSwitcher` heads the sidebar with the container the app
works in: its icon, name, an optional fact, and a chevron. Use it for a notebook,
space, mailbox, base, or venue chosen from several containers. Ordinary filters
and lists remain sidebar rows; an app without a current container needs no
switcher.

Put it first in `SidebarDesktop`, before `SidebarBody`. Beside another button,
place both in a row and give the switcher `class="flex-1"`. Its panel lists the
containers as links, marks the current one with a check, and offers search from
8 options (`APP_WORKSPACE_SWITCHER_SEARCH_FROM`). Search matches names and
descriptions without regard to case. Supply **New …** only when the person may
create a container; **All …** leads to the overview. The component adds no
actions of its own.

The panel opens below the trigger, or above it when it would not fit below at
its tallest (28 rem, at most 80% of the viewport) and there is more room above,
for example low in the phone menu. It keeps that side while it is open, so
loading options, an error, or a narrowed search never flip it; only a viewport
resize chooses again. Above the trigger, its bottom edge stays beside the
trigger and it does not shrink while open, so the search field stays where the
person types. It never covers its trigger: it takes at most the room on its side
and scrolls its option list.
In a collapsed rail from a 64 rem host, the trigger shows only its icon and the panel
opens to the side. On phones, pass the same props through
`createNavigation({ items, switcher: () => switcher })` so the host menu shows
the same head. `Navigation` hands its `beforeSelect` to the switcher: a plain
click on a container or an action first lets the host menu finish closing, and
`false` cancels the choice. Modified clicks, such as opening a new tab, stay
native links. The panel is at least as wide as the trigger and 16 rem where
space allows, and stays within the viewport with an 8 px inset, also when
options, an error, or search arrive after it opened.

Leave `options` undefined until they load. `onLoad` asks for them on pointer
entry, focus, and opening; ignore repeated calls while a request runs. The
panel shows **Loading...** and holds focus while waiting. Set `error` after a
failed request to show its message and a retry button that calls `onLoad`.
The head always reserves two name lines and centres its text in them, so a
short and a long name give it the same height from the server's first paint
on. Switching containers, hover, opening, loading, and arriving options keep the
trigger and the rows below it in place. The name takes up to two balanced lines
and fades out when it overflows; beside the optional fact it takes
one line, and the fact takes the second. The check on the current container
uses the app's workspace accent, like the sidebar's active row. Hover and open
use a neutral fill, and sidebar rows use the same neutral fill on hover.

Enter, Space, or ArrowDown opens at the current option, or at search when
present. On touch, search waits for a tap so the keyboard does not cover the
list. ArrowUp on the closed trigger opens at the last row. In the panel, arrow
keys move between search, options, retry, and actions and wrap; Home and End
jump to the ends except while editing search. Enter in search follows the
first result. Typing a letter on a row moves it into search. Escape closes
only the panel and returns focus to the trigger, leaving a compact sidebar
overlay open; Tab out and an outside press close it too. Choosing the current
container closes without navigation.

The full container name stays in the trigger's `title` and accessible name.
Its description combines the optional fact and `switchLabel`, which also names
the dialog.
`aria-expanded` and `aria-controls` connect trigger and panel; the current link
has `aria-current="true"`. Loading, errors, and empty results are status text.
The UI locale supplies search, loading, empty, and retry messages; the app
supplies container names and the purpose label.

```tsx
const switcher = {
  currentId: notebook.id,
  label: notebook.name,
  icon: "ti ti-notebook",
  switchLabel: "Switch notebook",
  get options() { return notebooks(); },
  onLoad: loadNotebooks,
  actions: [
    ...(mayCreate ? [{ id: "new", label: "New notebook", icon: "ti ti-plus", action: createNotebook }] : []),
    { id: "all", label: "All notebooks", icon: "ti ti-layout-grid", href: "/app/notebooks" },
  ],
};
const navigation = createNavigation({ items, switcher: () => switcher });

<AppWorkspace.Sidebar collapsible>
  <AppWorkspace.SidebarDesktop>
    <AppWorkspace.SidebarSwitcher {...switcher} />
    <AppWorkspace.SidebarBody>{/* notebook navigation */}</AppWorkspace.SidebarBody>
  </AppWorkspace.SidebarDesktop>
</AppWorkspace.Sidebar>
```

### Row metadata and actions

Use `SidebarItemMeta` for passive trailing information such as counts and
status icons. Use `SidebarItemAction` for one labelled button or link. For two
or more controls, pass `SidebarItemActions` through the row's `actions` prop so
the controls remain siblings of the row link or button instead of invalid
nested interactive content.

Set `visibility="hover"` on metadata or actions only when the information is
optional. With any pointer that can hover, such as a mouse or trackpad,
including a tablet with a mouse, actions stay hidden until their own row is
hovered, keyboard-focused, current, or has its menu open. Optional metadata
appears on row hover or keyboard focus. In a `NavTree`, parent and child rows
reveal theirs independently. A hover `SidebarItemAction` overlays the end of
the row when it appears, so the label keeps its width and the text or metadata under the
button fades out. In a row that also shows an always-visible action or a
`SidebarItemActions` group, the hover action keeps its own slot after them
instead. A hover `SidebarItemActions` group that ends the row overlays its end
the same way, before the chevron of a `NavTree` row, so revealing it moves
nothing in the row; the fade covers one or two controls. Hidden metadata keeps
its space, so revealing it moves nothing. Hidden actions are out of the tab order until their
row shows them. The current row always shows its actions, so they stay in
the tab order, also in a `NavTree` while focus is on another item. Touch-only
screens always show them. Actions also stay
visible while a menu or other popup they opened is open, so the pointer can
leave the row to reach it. Keep errors, unread counts, and other important
state visible with the default `"always"` value.

```tsx
<AppWorkspace.SidebarItem href="/app/inventory/alerts">
  <AppWorkspace.SidebarItemIcon icon="ti ti-bell" />
  <AppWorkspace.SidebarItemLabel>Alerts</AppWorkspace.SidebarItemLabel>
  <AppWorkspace.SidebarItemMeta>
    <span class="tabular-nums">3</span>
  </AppWorkspace.SidebarItemMeta>
  <AppWorkspace.SidebarItemAction
    icon="ti ti-settings"
    label="Alert settings"
    visibility="hover"
    onSelect={openAlertSettings}
  />
</AppWorkspace.SidebarItem>

<AppWorkspace.NavTree.Item
  id="drafts"
  label="Drafts"
  actions={
    <AppWorkspace.SidebarItemActions visibility="hover">
      <IconButton size="xs" label="Pin draft">…</IconButton>
      <Dropdown.Root items={draftActions}>
        <Dropdown.Trigger iconOnly label="Draft actions" variant="ghost">…</Dropdown.Trigger>
      </Dropdown.Root>
    </AppWorkspace.SidebarItemActions>
  }
/>
```

### Unread counts, dots, and mentions

Put `SidebarItemStatus` in `meta`, `SidebarItemMeta`, or a `NavTree.Item`
`meta` to show what is new in a conversation, inbox, or feed:

- `unread` as a positive number shows a count, above 99 as "99+", and sets
  the label in a stronger weight than the regular label of its row variant;
- `unread={true}` shows a quiet dot for new activity that should not draw
  attention, such as in a muted conversation or a channel that notifies only
  on mentions; the label keeps its regular weight;
- `mention` adds "@" and accents the count;
- `muted` adds a muted bell;
- `waiting={{ count, label }}` shows how many items wait for the person, such
  as requests to approve, in the same slot instead of `unread`. `label` is the
  phrase screen readers hear, for example "3 waiting". The label keeps its
  regular weight, and `0` stays as a muted count for a count that dropped to
  zero while the row is still shown.

Each mark has a fixed width and fits the label line, so the row keeps its
height in every state. Whenever the status shows anything, it reserves the
unread slot at the end of the row, which a count and a dot share; the bell and
then "@" sit before it. New activity, a mention, or reading therefore never
moves another mark, and counts, dots, and bells stay aligned across rows.
Unread rows differ in weight and count, never in color alone.

The marks are hidden from assistive technology; the row's accessible name gets
one phrase instead, such as "Design, 3 unread, mentions you", in the
inherited locale. Above 99 the phrase says "more than 99 unread", like the
badge, so an application can pass a capped count such as 100. A row whose
preview opens from the whole row (`trigger: "row"`) is named by the preview
label and keeps the phrase as its description. Without unread items, a
mention, or muting, the status shows nothing and takes no space, but it keeps
the row's label on one line. Render it from the row's first paint, also at
zero, so the first count never changes the row's height. The collapsed rail shows only row icons, so the marks hide there
with the label. The application decides which state applies, for example
whether a muted conversation shows a count or only a dot.

```tsx
<AppWorkspace.SidebarItem href="/app/chat/c/design" icon="ti ti-hash">
  <AppWorkspace.SidebarItemLabel>Design</AppWorkspace.SidebarItemLabel>
  <AppWorkspace.SidebarItemMeta>
    <AppWorkspace.SidebarItemStatus unread={3} mention />
  </AppWorkspace.SidebarItemMeta>
</AppWorkspace.SidebarItem>

<AppWorkspace.SidebarItem href="/app/chat/c/releases" icon="ti ti-hash" meta={<AppWorkspace.SidebarItemStatus unread muted />}>
  Releases
</AppWorkspace.SidebarItem>
```

### Nested navigation

Use `NavTree` when navigation has parent and child rows. It provides one
accessible tree contract, roving keyboard focus, disclosure behavior, and
depth-based indentation. Set `indented={false}` only when hierarchy should be
communicated without horizontal nesting.

Expansion can be uncontrolled with `defaultExpandedIds`, or controlled with
`expandedIds` and `onExpandedIdsChange`. Persistence remains application-owned:
if an application stores expansion in a cookie or another store, pass the same
initial ids during SSR to avoid a layout shift when the component mounts.

Branches normally keep their leading icon and receive a trailing disclosure
chevron. For folder navigation, set both `icon` and `expandedIcon`; the leading
icon then reflects the branch state and acts as the disclosure target, so no
second chevron is rendered. The row label keeps its normal select or navigation
behavior, and the keyboard contract is unchanged.

Icons are decorative by default. When an icon carries meaning the label does
not, such as a home icon that marks a notebook's homepage among its notes, set
`iconLabel`: the icon then becomes an image with that name, and screen readers
announce it together with the label.

Optional drag event handlers on `NavTree.Item` are forwarded to the tree item
container. Applications still own drag payloads, permission checks, drop
effects, and mutations.

Set `onMove` on the tree and `movable` on items when people may arrange items
among their siblings, such as notes in a notebook. A movable item can be
dragged on fine pointers, where a line in the gap between rows marks the new
place without moving any row, and moved one place with Alt+ArrowUp or
Alt+ArrowDown while it has focus. Moves stay within the item's level; offer a
separate action to move an item under another parent. Items without `movable`
keep their place and nothing moves past them, so a pinned first item stays
first. The tree reports the requested place as the neighbours `beforeId` and
`afterId`; the application saves it and renders the new order, and the tree
keeps focus on an item moved by keyboard. Offer the same moves in the item's
menu, because touch devices do not drag tree rows. Every item reports its
place with `aria-posinset` and `aria-setsize`.

```tsx
<AppWorkspace.NavTree ariaLabel="Chapters" onMove={(move) => saveChapterPlace(move)}>
  <For each={chapters()}>
    {(chapter) => <AppWorkspace.NavTree.Item id={chapter.id} label={chapter.title} movable={canEdit()} />}
  </For>
</AppWorkspace.NavTree>
```

```tsx
const [selected, setSelected] = createSignal("inbox");
const [expanded, setExpanded] = createSignal<readonly string[]>(["mail"]);

<AppWorkspace.NavTree
  ariaLabel="Mailbox navigation"
  selectedId={selected()}
  expandedIds={expanded()}
  onSelectedIdChange={setSelected}
  onExpandedIdsChange={setExpanded}
>
  <AppWorkspace.NavTree.Item id="mail" label="Mail" icon="ti ti-folder" expandedIcon="ti ti-folder-open">
    <AppWorkspace.NavTree.Item id="inbox" label="Inbox" meta={4} />
    <AppWorkspace.NavTree.Item id="archive" label="Archive" />
  </AppWorkspace.NavTree.Item>
</AppWorkspace.NavTree>
```

## API reference

```ts
/** Park open waiting-detail drawers; rescue focus only from inside a drawer. */
function parkWorkspaceDetailDrawers(root?: ParentNode): void;
```

```ts
type AppWorkspaceProps = {
  mobileSurface?: "contained" | "flush"; flat?: boolean;
  children: JSX.Element; class?: string; resizable?: boolean;
  layoutState?: () => AppWorkspaceLayoutState | null | undefined;
  onLayoutChange?: (state: AppWorkspaceLayoutState) => void; controller?: false;
};

type AppWorkspaceLayoutStateProviderProps = {
  children: JSX.Element; state: AppWorkspaceLayoutState | null | undefined;
};

type AppWorkspaceContentProps = { children: JSX.Element; class?: string };

type AppWorkspaceWidthShare = { share: number; offset?: number; min: number; max: number };

type AppWorkspaceMainProps = {
  children: JSX.Element; class?: string; width?: "full" | "content"; minWidth?: number | AppWorkspaceWidthShare; mobilePane?: string; scroll?: boolean; scrollFade?: boolean;
  scrollPreserveKey?: string | false;
  level?: string; onLevelNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  "aria-busy"?: boolean | "true" | "false";
};

type AppWorkspaceMainPaneProps = {
  id: string; label: string; surface?: "default" | "navigation"; open?: boolean; resizable?: boolean;
  resizeShadow?: boolean; defaultSize?: number | AppWorkspaceWidthShare; minSize?: number; maxSize?: number; class?: string;
  scroll?: boolean; scrollFade?: boolean; children: JSX.Element;
  href?: string; description?: JSX.Element; actions?: JSX.Element;
};

type AppWorkspaceDetailProps = {
  children: JSX.Element; open: boolean; id: string; class?: string; width?: AppWorkspaceDetailWidth; phone?: "sheet" | "page";
  viewTransitionName?: string; resizable?: boolean; minWidth?: number; maxWidth?: number;
  onClose?: () => void; onStep?: (direction: 1 | -1) => HTMLElement | null | undefined | void;
};

type AppWorkspaceBottomDrawerProps = {
  children: JSX.Element; open: boolean; id: string; class?: string; height?: AppWorkspaceBottomDrawerHeight;
  minHeight?: number; maxHeight?: number; viewTransitionName?: string; resizable?: boolean;
};

```

### SidebarSwitcher

`AppWorkspace.SidebarSwitcher` takes `AppWorkspaceSidebarSwitcherProps`.

```ts
type AppWorkspaceSidebarSwitcherProps = {
  currentId: string; label: string; description?: string; icon: string; color?: string;
  switchLabel: string; options?: readonly AppWorkspaceSwitcherOption[];
  error?: string; onLoad?: () => void; actions?: readonly AppWorkspaceSwitcherAction[];
  beforeSelect?: () => boolean | void | Promise<boolean | void>; class?: string;
};

type AppWorkspaceSwitcherOption = {
  id: string; label: string; description?: string; icon?: string; color?: string; href: string;
};

type AppWorkspaceSwitcherAction = {
  id: string; label: string; icon: string; disabled?: boolean;
} & ({ href: string; action?: never } | { action: () => void; href?: never });

const APP_WORKSPACE_SWITCHER_SEARCH_FROM = 8;
```

### Sidebar

```ts
type AppWorkspaceSidebarProps = {
  id?: string; label?: string;
  children: JSX.Element; class?: string; mobile?: "hidden" | "stacked"; resizable?: boolean; resizeShadow?: boolean;
  collapsible?: boolean; defaultSize?: number; minSize?: number; maxSize?: number;
  hidden?: boolean; onHiddenChange?: (hidden: boolean) => void;
};

type AppWorkspaceSidebarBodyProps = {
  children: JSX.Element; class?: string; scrollPreserveKey?: string | false;
  sidebarMode?: AppWorkspaceSidebarVisibility;
};

type AppWorkspaceSidebarSectionProps = AppWorkspaceSidebarBodyProps & {
  title?: string; actions?: JSX.Element; count?: number; collapsible?: boolean;
  open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void;
};

type AppWorkspaceSidebarItemProps = {
  variant?: "row" | "card" | "object"; context?: JSX.Element; contextMeta?: JSX.Element;
  description?: JSX.Element; preview?: { label: string; content: JSX.Element | ((close: () => void) => JSX.Element); trigger?: "action" | "row"; align?: "center" | "end"; viewportSize?: "compact"; onOpenChange?: (open: boolean) => void };
  children: JSX.Element; href?: string; navigation?: "enhanced" | "document"; replace?: boolean;
  scroll?: NavigationScrollMode; onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  onClick?: (event: MouseEvent) => void; active?: boolean | "ancestor"; activeClass?: string; disabled?: boolean;
  icon?: string; meta?: JSX.Element; metaVisibility?: AppWorkspaceSidebarAccessoryVisibility;
  actions?: JSX.Element; tone?: AppWorkspaceSidebarItemTone; title?: string; viewTransitionName?: string;
  class?: string; depth?: number; actionIcon?: string; actionLabel?: string;
  onActionClick?: (event: MouseEvent) => void;
  data?: Record<string, string | number | boolean | null | undefined>;
  sidebarMode?: AppWorkspaceSidebarVisibility;
};

type AppWorkspaceSidebarIconGridProps = AppWorkspaceSidebarBodyProps & { title?: string; columns?: 2 | 3 };

type AppWorkspaceSidebarIconActionProps = {
  href?: string | null; navigation?: "enhanced" | "document"; replace?: boolean;
  scroll?: NavigationScrollMode; onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  icon: string; label: string; active?: boolean; disabled?: boolean; tone?: AppWorkspaceSidebarIconActionTone;
  viewTransitionName?: string; onClick?: (event: MouseEvent) => void;
  sidebarMode?: AppWorkspaceSidebarVisibility;
};

type AppWorkspaceSidebarItemIconProps = { icon?: string; children?: JSX.Element };

type AppWorkspaceSidebarItemLabelProps = {
  children: JSX.Element;
  /** False keeps one line that fades out; rows wrap long labels onto a second line by default. */
  marquee?: boolean;
};

type AppWorkspaceSidebarItemMetaProps = {
  children: JSX.Element; visibility?: AppWorkspaceSidebarAccessoryVisibility;
};

type AppWorkspaceSidebarItemActionProps = {
  icon?: string; label: string; disabled?: boolean; visibility?: AppWorkspaceSidebarAccessoryVisibility; href?: string;
  navigation?: "enhanced" | "document"; onSelect?: (event: MouseEvent) => void; children?: JSX.Element;
};

type AppWorkspaceSidebarItemActionsProps = {
  children: JSX.Element; visibility?: AppWorkspaceSidebarAccessoryVisibility;
};

type AppWorkspaceSidebarItemStatusProps = {
  unread?: number | boolean; mention?: boolean; muted?: boolean;
};

```

### Navigation tree

```ts
type AppWorkspaceNavTreeProps = {
  children: JSX.Element; ariaLabel: string; selectedId?: string | null; expandedIds?: readonly string[];
  defaultExpandedIds?: readonly string[]; onSelectedIdChange?: (id: string) => void;
  onExpandedIdsChange?: (ids: readonly string[]) => void; indented?: boolean;
  onMove?: (move: AppWorkspaceNavTreeMove) => void; class?: string;
};

type AppWorkspaceNavTreeMove = { id: string; parentId: string | null; beforeId: string | null; afterId: string | null };

type AppWorkspaceNavTreeItemProps = {
  id: string; label: JSX.Element; description?: JSX.Element; children?: JSX.Element; href?: string;
  navigation?: "enhanced" | "document";
  replace?: boolean; scroll?: NavigationScrollMode;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>; onSelect?: (event: MouseEvent) => void;
  disabled?: boolean; icon?: string; iconLabel?: string; expandedIcon?: string; meta?: JSX.Element;
  metaVisibility?: AppWorkspaceSidebarAccessoryVisibility; actions?: JSX.Element;
  tone?: AppWorkspaceSidebarItemTone; title?: string; viewTransitionName?: string; class?: string; movable?: boolean;
  onDragEnter?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
  onDragOver?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
  onDragLeave?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
  onDrop?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
};

```

### Size tokens and persisted state

```ts
type AppWorkspaceDetailWidth = "sm" | "md" | "lg" | "xl";

type AppWorkspaceBottomDrawerHeight = "sm" | "md" | "lg";

type AppWorkspaceSidebarVisibility = "always" | "expanded" | "collapsed";

type AppWorkspaceSidebarAccessoryVisibility = "always" | "hover";

type AppWorkspaceSidebarItemTone = "default" | "success" | "danger";

type AppWorkspaceSidebarIconActionTone = "default" | "success" | "danger";

type AppWorkspaceLayoutState = {
  version: 2; sidebarWidth?: number; sidebarCollapsed?: boolean; paneWidths?: Record<string, number>;
  detailWidths?: Record<string, number>; drawerHeights?: Record<string, number>;
};

type AppWorkspaceControllerOptions = {
  root?: Document | HTMLElement; readState?: () => AppWorkspaceLayoutState | null | undefined;
  writeState?: (state: AppWorkspaceLayoutState) => void;
};
```

The prop names map to compound members (`AppWorkspaceMainPaneProps` → `AppWorkspace.MainPane`). `SidebarDesktop` accepts JSX children. `layoutState` is an accessor; the LayoutStateProvider `state` is a direct value. Widths/heights and numeric limits are CSS pixels. IDs identify independently persisted regions and must stay stable.

| Region | Default | Minimum | Maximum |
| --- | --- | --- | --- |
| Sidebar | 208 | 176 | 360 |
| MainPane (peer pane or hierarchy level) | 320 | 240 | 640 |
| Detail | 416 | 320 | 640 |
| BottomDrawer | 240 | 160 | 560 |

The main area reserves 320px width (raised with `Main minWidth`, in pixels or a workspace width share) / 240px height; the available container may reduce maxima. Collapsed sidebar width is 64px; the collapse threshold is 128px. A sidebar with `onHiddenChange` hides below half its minimum width. Detail widths `sm/md/lg/xl` are 320/416/480/544px (default md); Drawer heights `sm/md/lg` are 192/240/320px (default md). `MainPane.defaultSize` also accepts a workspace width share. Restored geometry takes precedence. `resizable` defaults on; `collapsible` is opt-in. `Main.scroll` and `MainPane.scroll` default on.

`LinkNavigateEvent` and `NavigationScrollMode` use [navigation conventions](/en/ui/getting-started#icons-tones-and-navigation). `navigation` defaults to `"document"`. Event callbacks do not load data automatically.

```ts
declare function normalizeAppWorkspaceLayoutState(value: unknown): AppWorkspaceLayoutState | null;
declare function parseAppWorkspaceLayoutState(value: string | null | undefined): AppWorkspaceLayoutState | null;
declare function serializeAppWorkspaceLayoutState(state: AppWorkspaceLayoutState): string;
declare function appWorkspaceLayoutStyle(state: AppWorkspaceLayoutState | null | undefined): string | undefined;
declare function installAppWorkspaceController(options?: AppWorkspaceControllerOptions): () => void;
declare function appWorkspaceDetailElementId(id: string): string;
declare function watchAppHostWidth(element: Element, minRem: number, update: (matches: boolean) => void): () => void;
declare function safeAppWorkspacePanelId(panelId: string): string;
declare function appWorkspacePanelVariable(kind: "pane" | "detail" | "drawer", panelId: string): string;
declare function appWorkspaceResizeLimits(options: { kind: "sidebar" | "pane" | "detail" | "drawer"; workspaceSize: number; reservedSize: number; min?: number; max?: number; sidebarCollapsible?: boolean }): { min: number; max: number };
declare function shouldCollapseAppWorkspaceSidebar(width: number, collapsible: boolean): boolean;
declare function resolveAppWorkspaceSidebarWidth(width: number, maxWidth: number, collapsible: boolean): { width: number; collapsed: boolean };
```

Parse/serialize use a URI-encoded JSON string; normalize accepts a decoded object. The installer returns cleanup. Most consumers use the automatic controller and only persist `onLayoutChange` results.

`appWorkspaceDetailElementId` returns the Detail region's DOM id for
`aria-controls`. Pass the same stable `id` as `AppWorkspace.Detail`.

## Accessibility

`MainPane.label` names the region. Sidebar icon actions and item actions require a clear `label`.
Every control inside `SidebarItemActions` must also provide its own accessible
name.
Every `NavTree` requires `ariaLabel`; each item requires a stable `id` and a
human-readable `label`. Arrow keys move through visible rows, Right and Left
expand, collapse, or move between parent and child, and Home and End jump to
the first and last visible row.

Resize handles are separators with orientation, limits, and the controlled
region. Their pointer target is wider than the visible one-pixel guide. Do not
replace them with application-specific handles.

## Activate resizing

The complete workspace and its separator metadata render on the server. The
component installs a controller scoped to its root after mount. Pointer and
keyboard resizing therefore work by default without an additional island or
installer call.

Persistence remains application-owned. Pass an accessor through `layoutState`
and receive settled changes through `onLayoutChange`. The application may use
memory, local storage, a cookie endpoint, or no persistence. The UI package does
not know an application id or cookie name.

```tsx
<AppWorkspace
  layoutState={() => storedLayout()}
  onLayoutChange={(state: AppWorkspaceLayoutState) => saveLayout(state)}
>
  {/* regions */}
</AppWorkspace>;
```

The controller handles pointer and keyboard resizing, clamps sizes to the
available workspace, updates separator values, and writes only after a resize
settles or a keyboard step completes. While a pointer drags a handle, the page
selects no text in any browser, including Safari and every other browser on
iPadOS; outside a drag, text selects as usual.

A custom pointer drag gets the same behavior from `suppressTextSelection`.
Call it with the pointer's id when the drag starts and call the function it
returns when the drag ends. Start a drag only on a primary-button press: a
context menu can swallow the release of a secondary press, and the hold would
then last until the pointer's next release. The pointer's `pointerup` or
`pointercancel` and a window `blur` also end it, overlapping drags share it,
and the last release restores the page's inline styles exactly. A selection
from before the press stays; one the press or the drag makes is cleared.

```ts
declare function suppressTextSelection(pointerId: number): () => void;
```

Set `controller={false}` only when a custom host installs the exported
`installAppWorkspaceController` itself. Installing both controllers would
register every interaction twice.

## Restore layout state

Use `normalizeAppWorkspaceLayoutState` to normalize an unknown decoded value.
`parseAppWorkspaceLayoutState` and `serializeAppWorkspaceLayoutState` handle the
encoded string representation.

`appWorkspaceLayoutStyle` converts a state into CSS variable declarations for
SSR. Apply the returned string to an ancestor of `AppWorkspace` so the first
render uses the stored geometry.

The lower-level exports support custom hosts:

- `safeAppWorkspacePanelId` bounds ids used in CSS variables;
- `appWorkspacePanelVariable` returns the variable for a pane, detail, or
  drawer;
- `appWorkspaceResizeLimits`, `resolveAppWorkspaceSidebarWidth`, and
  `shouldCollapseAppWorkspaceSidebar` expose the controller's sizing rules;
- the geometry constants themselves, in pixels, one `DEFAULT`/`MIN`/`MAX`
  triple per resizable region:
  `APP_WORKSPACE_SIDEBAR_DEFAULT`, `APP_WORKSPACE_SIDEBAR_MIN`,
  `APP_WORKSPACE_SIDEBAR_MAX`;
  `APP_WORKSPACE_PANE_DEFAULT`, `APP_WORKSPACE_PANE_MIN`,
  `APP_WORKSPACE_PANE_MAX`;
  `APP_WORKSPACE_DETAIL_DEFAULT`, `APP_WORKSPACE_DETAIL_MIN`,
  `APP_WORKSPACE_DETAIL_MAX`;
  `APP_WORKSPACE_DRAWER_DEFAULT`, `APP_WORKSPACE_DRAWER_MIN`,
  `APP_WORKSPACE_DRAWER_MAX`;
  plus `APP_WORKSPACE_SIDEBAR_COLLAPSED` and
  `APP_WORKSPACE_SIDEBAR_COLLAPSE_THRESHOLD`.
- `APP_WORKSPACE_MAIN_MIN` and `APP_WORKSPACE_MAIN_MIN_HEIGHT` are the space
  the main region always keeps. They are not a resizable region of their own:
  every other region's usable maximum is the container minus this floor, which
  is why dragging a detail panel or drawer stops before the work area is
  squeezed away. `appWorkspaceResizeLimits` applies them for you.

Most applications should use the controller and state helpers instead of
reimplementing those lower-level rules.

## Runtime

Rendering and state normalization are SSR-safe. `AppWorkspace` installs and
disposes its controller after mount.

The package exports parse, normalize, serialize, and style helpers for layout state. The application decides where that state is stored and can apply the same state during SSR to avoid geometry jumps.

## Example

```tsx
<AppWorkspace class="app-shell-frame">
  <AppWorkspace.Sidebar collapsible>
    <AppWorkspace.SidebarDesktop>
      <AppWorkspace.SidebarBody scrollPreserveKey="inventory-sidebar">
        <AppWorkspace.SidebarSection title="Tables">
          <AppWorkspace.SidebarItem
            href="/app/inventory"
            icon="ti ti-list"
            active
          >
            Inventory
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarSection>
      </AppWorkspace.SidebarBody>
      <AppWorkspace.SidebarFooter>
        <AppWorkspace.SidebarItem icon="ti ti-settings">
          Settings
        </AppWorkspace.SidebarItem>
      </AppWorkspace.SidebarFooter>
    </AppWorkspace.SidebarDesktop>
  </AppWorkspace.Sidebar>

  <AppWorkspace.Content>
    <AppWorkspace.Main mobilePane={selectedId() ? "reader" : "list"}>
      <AppWorkspace.MainPane id="list" label="Inventory">
        <InventoryList />
      </AppWorkspace.MainPane>
      <AppWorkspace.MainPane id="reader" label="Item reader">
        <ItemReader id={selectedId()} />
      </AppWorkspace.MainPane>
    </AppWorkspace.Main>
    <AppWorkspace.Detail
      id="item"
      open={selectedId() !== null}
      onClose={closeDetails}
      width="lg"
    >
      <ItemDetail id={selectedId()} />
    </AppWorkspace.Detail>
  </AppWorkspace.Content>
  <AppWorkspace.BottomDrawer
    id="activity"
    open={showActivity()}
    height="sm"
  >
    <ActivityLog />
  </AppWorkspace.BottomDrawer>
</AppWorkspace>
```

From 48 rem, 12 px of space separates adjacent MainPanes. Sidebar and pane
resize handles show only their grip on hover, keyboard focus, or drag; they
draw no separator line. The last pane has no trailing gap.
A side pane keeps its size while the main region keeps 320 px and gives way
down to its minimum; the stylesheet applies the same fit as the controller, so
a server-rendered split arrives at its final widths. Detail is a column when
it fits beside Main's minimum, otherwise it waits behind Details. See
[Detail and panel](#detail-and-panel).
Double-click a pane or detail resize handle to clear its saved width and return
to its default size.

### Live rows and detail previews

`SidebarItem.description` supplies an optional passive second line. Compose a
`StatusBadge`, short status text or progress there; keep interactive controls in
`actions` or the preview. Existing one-line rows keep their compact layout.
Compound icon, label, metadata and action props remain reactive. Applications own
the data source: no socket, task lifecycle or subscription belongs in the library.

Use `preview={{ label: "Item details", content: <Details /> }}` for interactive
secondary information. A resting fine pointer and keyboard focus open it after a
short delay. A dedicated details button opens it on touch-capable devices and moves focus
into the non-modal dialog. With hover and a fine pointer, this button is hidden
visually until keyboard focus reaches it. It then overlays the end of the row
and, while focused, takes the place of the row action before it, which stays
one Tab stop earlier. A coarse pointer on hybrid devices keeps the button
visible in the row, as on touch devices, with a hover action revealed beside it. This behavior depends on input capabilities, not screen width. Escape and outside clicks dismiss it. The preview stays mounted
while closed; live content updates preserve its controls and focus. Do not start
expensive subscriptions merely because a row exists. The preview can hold an
explicit action that loads additional details.

For asynchronous catalogs, set `preview.viewportSize="compact"` to reserve a
stable 18.75rem (300 px at the default font size) scrollport, capped at 60dvh.
Loading, empty, error, and populated states then keep the same height. Use
`<ScrollArea viewportSize="compact">` for the equivalent mobile dialog content.
The default preview remains content-sized; do not nest another scrollport.

Previews are `HoverPreview` cards (see Feedback): they open beside the row, use
the same surface, border, and inner depth, and keep their content in the shared
`ScrollArea`. Overflowing content fades at the top and bottom while the card
border remains visible. Fades follow the current scroll position and disappear
when an edge is reached.

Use `SidebarSection` with `collapsible`, `count`, and `defaultOpen={false}` for
completed items or other secondary groups. `open` and `onOpenChange` support
controlled expansion. Counts remain application-owned; collapsing keeps child
state mounted. Give every collapsible section a descriptive title. Place a
persistent secondary group in `SidebarFooter`, with a bounded list if it can grow.

```tsx
<AppWorkspace.SidebarItem
  description={<StatusBadge label={status()} tone="running" variant="dot" />}
  preview={{ label: "Import details", content: <ImportDetails /> }}
>
  <AppWorkspace.SidebarItemIcon icon={icon()} />
  <AppWorkspace.SidebarItemLabel>{title()}</AppWorkspace.SidebarItemLabel>
</AppWorkspace.SidebarItem>
<AppWorkspace.SidebarSection title="Done" count={done().length} collapsible defaultOpen={false}>
  {/* The application chooses and renders completed items. */}
</AppWorkspace.SidebarSection>
```

The live navigation showcase demonstrates generic jobs, documents and projects,
manual or automatic status changes, an attention state, and moving items into and
out of a completed section. Completion is a host action, separate from progress.

For a row whose only action is opening its preview, set `preview.trigger="row"`
and omit `href` and `onClick`. Hover and focus still open the same preview;
clicking the row or its trailing chevron keeps it open. The chevron appears
over the end of the row on hover or keyboard focus, without narrowing the
label, and remains visible on touch devices. A hover action appears beside it;
next to an always-visible action, the chevron keeps its own slot instead. Keyboard focus on
the row or chevron outlines the complete row. Set `preview.align="end"` to align the menu
bottom edge with the navigation row, constrained to the viewport. The default
keeps menus vertically centered on their row. Existing previews
keep their separate info button and independent row navigation by default.
A content callback receives `close` so selecting a destination can dismiss the
preview before navigating or opening another dialog:

```tsx
<AppWorkspace.SidebarItem
  icon="ti ti-folders"
  preview={{
    label: "Projects",
    trigger: "row",
    content: (close) => (
      <AppWorkspace.SidebarItem href="/projects/example" onClick={close}>
        Example project
      </AppWorkspace.SidebarItem>
    ),
  }}
>
  Projects
</AppWorkspace.SidebarItem>
```

Use `DescriptionList layout="compact"` inside previews for content-sized labels
and a smaller column gap, keeping each label visually paired with its value.

Use `preview.onOpenChange` to load authorized detail data only while the preview
is open. Cancel an outstanding request when it closes; the preview content
remains mounted so local input state is preserved.

`SidebarSection.icon` optionally adds a leading decorative icon beside the section title.

### Context cards

Use `SidebarItem variant="card"` only when the context above the title is
needed to tell items apart. A plain row with a section heading is calmer and
usually enough; Assistant lists its chats as rows under day headings with one
status icon in `meta`. `context` holds a project or category; `contextMeta` holds a short time
or secondary value. Both accept reactive JSX. Keep commands in actions or the
preview. Rows wrap a long label onto up to two balanced lines that fade out at
the end, with the shared
[fade utilities](/en/ui/layout/navigation#label-overflow). A selected row keeps its line count when its label is plain text; a
label built from elements, such as `<strong>`, gets no such reservation.
A row whose metadata holds a `SidebarItemStatus` keeps one line from its first
paint, also while the status shows nothing, so a new count never re-wraps the
label and moves the rows below. Any other metadata must keep its width while
the row is shown: put unread counts in `SidebarItemStatus` and render it at
zero too, and keep rows with other changing metadata on one line.
`SidebarItemLabel marquee={false}` keeps one line that fades out, as cards
and object rows do by default.
Completed work can retain `variant="row"` without context or description.

Card context headers keep their width when trailing actions appear; only the title area yields space. Use `Format.RelativeTime` for relative timestamps. The desktop scroll track occupies the existing right inset and keeps its gutter when content fits, without adding space on the left. Keyboard focus on the main card action outlines the complete card.

Inactive context cards use a transparent surface and border; the active item retains its selection treatment.

### Object rows

Use `SidebarItem variant="object"` when the sidebar lists the resources an
overview navigates into, such as mailboxes or notebooks, rather than views
inside one resource. The label is the resource title, `description` is one
quiet meta line with at most one secondary fact, and `SidebarItemMeta` stacks
trailing counts at the end of the row. Keep counts tabular and put their
accessible wording in visually hidden text. The count column keeps a minimum
width, so counts line up across rows. When an object row has trailing counts,
`SidebarItemActions visibility="hover"` overlays that column with a mouse or
trackpad, including a tablet with a mouse, instead of pushing it toward the
title. It appears when the row is hovered, keyboard-focused, current, or has
its menu open. Touch-only screens always show the actions. The counts stay in
the accessibility tree while hidden. Omit the leading icon when every object would show the same
one. A plain object-row icon sits in a soft chip of the accent ink
`--k2b-app-workspace-active`; custom
icon content, such as an avatar, keeps its own treatment in the same 2rem box.
Object rows keep their title on one line that fades out.

```tsx
<AppWorkspace.SidebarItem variant="object" href="/app/mail/support" description="support@example.test">
  <AppWorkspace.SidebarItemIcon icon="ti ti-mail" />
  <AppWorkspace.SidebarItemLabel>Support</AppWorkspace.SidebarItemLabel>
  <AppWorkspace.SidebarItemMeta>
    <span aria-hidden="true">12</span>
    <span class="k2b-sr-only">12 unread</span>
  </AppWorkspace.SidebarItemMeta>
</AppWorkspace.SidebarItem>
```

### Stacked mobile sidebar

Set `mobile="stacked"` on `Sidebar` when the sidebar is the primary object
list of an overview and the host's mobile navigation does not carry it. Below
64 rem, its items become one row of chips above the content. The row scrolls
sideways with fades at cut edges and keeps the current chip in view when the
page loads. From 64 rem, it is the regular sidebar column. The sidebar is a
`nav` landmark at every width; give it a `label` that names the objects.

A chip shows the icon, a label on one line that fades out, and metadata
such as a count or dot. Selection changes only its fill and color; its box
and font weight stay the same. Section titles, descriptions, row actions,
collapsible sections, the footer, and other content stay out of the row.

**All** at the end of the row opens the complete sidebar, including everything
the chips leave out. Below 48 rem it opens a bottom sheet; from 48 rem it
opens a centered dialog. Links close it. Escape and Close return focus to
All. Write the sidebar's children as JSX inside `AppWorkspace.Sidebar`:

```tsx
<AppWorkspace.Sidebar label="Notebooks" mobile="stacked">
  <AppWorkspace.SidebarDesktop>
    <AppWorkspace.SidebarBody>
      <AppWorkspace.SidebarItem variant="object" href="/app/notebooks/team" active>
        <AppWorkspace.SidebarItemLabel>Team</AppWorkspace.SidebarItemLabel>
        <AppWorkspace.SidebarItemMeta>4</AppWorkspace.SidebarItemMeta>
      </AppWorkspace.SidebarItem>
    </AppWorkspace.SidebarBody>
  </AppWorkspace.SidebarDesktop>
</AppWorkspace.Sidebar>
```

The children render a second time in the sheet and share the application's
signals. Markup built ahead of time and passed as a value cannot render a
second time: the sheet leaves it in the row, stays without it, and logs an
error. While the sheet is open, the row and the sheet both hold each row, so
code that looks a row up, for example to restore focus, searches the copy
that has focus (`.k2b-app-workspace__sidebar-sheet`) before the document.
For the same reason, sidebar children must not use fixed `id` values; use
`createUniqueId()` so labels and ARIA references resolve inside each copy.
A chosen link runs its own handlers in the sheet, then the sheet closes; a
tree branch's disclosure only expands the branch. When the workspace widens
into the sidebar column, the sheet closes and focus moves to the current
item in the column.

The sheet adds no history entry, so Back leaves the page while it is open.
Other phone sheets close on Back, but a sidebar may replace the URL while
the sheet is open, such as a search, and the sheet's entry would then stay
behind as a stale step in the history.

Hosts can set `--k2b-workspace-chip-inset` for the row's content inset
(default `clamp(1rem, 3vw, 2.5rem)`, `1rem` below a 40 rem viewport),
`--k2b-workspace-chip-background` for chip fill (default
`--k2b-surface-muted`), and `--k2b-app-workspace-selected` for selected fill
(default `--k2b-selected`), the same hook as a selected sidebar row; see
[Colors and selection](/en/ui/surfaces/color).

Leave the default `mobile="hidden"` when the host's phone navigation already
provides the object list. Views of an object belong in the head.

### Cloud phone title menu

On Cloud pages with `WorkspaceNavigation`, the phone header shows **Name ⌄**
in place of the plain title. It opens the same app menu sheet as the app-menu
button, so a hidden sidebar's navigation stays reachable. Pages without
workspace navigation keep the plain title. Nothing changes from 48 rem.
