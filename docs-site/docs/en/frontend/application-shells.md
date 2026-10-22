---
title: Application shells
navTitle: Application shells
section: Frontend
order: 830
description: Choose the shared shell that matches an application's information structure.
tags: [shells, workspace, ui]
updated: 2026-10-17
---

# Application shells

Choose a shared shell before arranging domain content. A shell gives the page
stable responsive geometry and interaction behavior; it does not load data,
authorize resources, or register the app in Cloud navigation.

Wrap the shell in the shared [Layout](/en/docs/frontend/layout-and-navigation),
then keep domain data and actions inside the application-owned content slots.

With `defineApp({ pageSwap: true, ... })`, in-app navigation replaces the
`Layout` content column while the rail, phone tab bar, panel slot, and provider
document stay mounted. The panel keeps drafts and pending work across swaps.
See [Page swaps](/en/docs/frontend/url-state-and-navigation#cloud-page-swaps).

## Choose a shell

| Surface | Primitive |
| --- | --- |
| App start page with resource cards | `AppOverview` |
| Sidebar, main content, and optional detail | `AppWorkspace` |
| IDE-like resizable editor | `Panes` inside `AppWorkspace.Main` |
| Stable list and reader split | `AppWorkspace.MainPane` |
| Contextual selected item | `AppWorkspace.Detail` |
| Activity, preview, or composer | `AppWorkspace.BottomDrawer` |
| Resource settings | `SettingsModal` |
| Complex editor dialog | `PanelDialog` |
| Tabular records | `DataPanel` and `DataTable` |
| Metrics | `StatGrid` and `StatCell` |
| Page in the mobile app (preview) | `PwaLayout`; see [Pages in the mobile app](/en/docs/frontend/mobile-app-pages) |


## Build an overview

`AppOverview` contains a page header, a main area, and an optional aside. Put
the single primary action, such as a create button or menu, in its `actions`
slot, and lay out a small set of objects with `AppOverview.Cards` and
`LinkCard`.

Use it for orientation and first actions. Do not turn it into a dashboard of
every application capability.

## Build a workspace

```tsx
<Layout c={c} title="Inventory" fullWidth fullPage>
  <AppWorkspace mobileSurface="flush">
    <InventoryWorkspaceNavigation />
    <AppWorkspace.Sidebar collapsible>
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody>
          <InventoryNavigation />
        </AppWorkspace.SidebarBody>
        <AppWorkspace.SidebarFooter>
          <AppWorkspace.SidebarItem icon="ti ti-settings">
            Settings
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarFooter>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
    <AppWorkspace.Content>
      <AppWorkspace.Main>
        <InventoryTable />
      </AppWorkspace.Main>
      <AppWorkspace.Detail
        id="item-detail"
        open={Boolean(selected)}
        width="md"
      >
        {selected && <ItemDetail item={selected} />}
      </AppWorkspace.Detail>
    </AppWorkspace.Content>
  </AppWorkspace>
</Layout>
```

Selection belongs in the URL. The server must be able to render the same
detail after reload. See
[URL state and navigation](/en/docs/frontend/url-state-and-navigation).

`AppWorkspace.Content` hosts Main and floating Detail. Detail must be a direct
child, possibly through a Solid island wrapper.
Keep geometry IDs stable. Do not add another grid or resize handle.

From 768 px, signed-in layouts expose Help and Search through the app bar.
Their header controls exist only on phones.

## Offer a page beside other apps

Declare `panel: { href, label, icon, requiresRoles? }` in `defineApp()` to offer
one application page in Cloud's panel slot. Render that route with
`PanelLayout` from `@k2b/cloud/ssr`. From 1024 px, the open column narrows the
app area, which Cloud supplies as the workspace's `k2b-app-area` host. At
smaller widths it overlays the app as a drawer or phone sheet.
See [Offer a panel](/en/docs/platform/panels) for authorization, opening,
keyboard controls, loading, and persistence.

## Add contextual detail

Below 768 px, Detail is a sheet over the lower 55% of the window; Main's rows
scroll above it and the grabber switches to full height. From 768 px it is a
column if it fits beside Main's minimum, otherwise it waits behind **Details**.
The column shares the workspace surface, with an 8 px inset. Selecting an
item opens a waiting Detail directly as a drawer, flush with the app card's
edge. Escape parks it without closing the selection. Opening Cloud's panel
parks the drawer; closing the panel restores the column if it fits.

Pass `onClose` the existing close or deselect action for column Escape and
phone dismissal gestures. A waiting drawer parks without calling it.
`onStep` steps through the items for J and K; return the Main element that
shows the new item so Escape, F6 and the reveal follow it. A detail that
the page renders on the server only cannot pass a function; mark the panel’s
own close button or link with `data-workspace-detail-close`; column Escape
and phone dismissal click it. Omit both for permanent context. The application still
owns `open` and URL selection. The panel’s Escape, J, K, and F6 run after the
page’s own keyboard handlers, so a handler that uses one of these keys for
local state calls `preventDefault()`.

Opening reserves the column immediately, then slides the panel in. Closing
slides it out over 140 ms with the column still reserved, then returns the
room in one step. The initial server-rendered panel appears without motion;
the OS reduced-motion setting or `data-k2b-motion="reduced"` on `<html>`
makes opening and closing instant; see [Motion](/en/ui/motion).

For DataTable, pass `scrollClass="k2b-detail-trail"` to keep column widths
while the scroller narrows beside the panel. Closing returns the full width
without extra space. The trail is the clipping scroll viewport and carries
`--k2b-radius-surface`, one border less inside a Paper frame. Put it directly in Main's content box with
`scroll={false}` on Main and no vertical scroller around it; a reserved
scrollbar gutter would widen the gap before the panel beyond
`--k2b-workspace-detail-inset`. Mark a board's horizontal scroller with
`k2b-detail-trail` as well: under an open waiting drawer, the marked scroller gets
the drawer's width as space at its end, so its last column scrolls out from
under the drawer.
The week and day views of `Calendar` mark themselves.
See [AppWorkspace](/en/ui/layout/workspace#detail-and-panel) for focus, keyboard
shortcuts, gestures, motion, and sizing.

## Choose a dialog

- Use `prompts.form()` for a small form.
- Use `prompts.dialog()` for custom compact content.
- Use `SettingsModal` for tabbed resource settings.
- Use `PanelDialog` for a multi-section editor.

The shared dialog core owns focus trapping, Escape, backdrop, and layering.

See [Forms, prompts, and feedback](/en/docs/frontend/forms-prompts-and-feedback)
for input and mutation behavior.

Do not restyle a shared shell locally. Improve the primitive when the design
system cannot express a recurring requirement.

Inspect current examples in the [UI catalog](/ui).

## Supply mobile navigation

Cloud owns one mobile menu below 768 px. The header launcher opens the current
workspace menu by default; **All apps** switches to the application grid.
On pages with `WorkspaceNavigation`, the phone title becomes **Name ⌄** and
opens that same menu. Pages without workspace navigation keep a plain title.
The sheet header combines the workspace name and **All apps** in one segmented
control. An application without its own navigation gets no header row: the
sheet shows only the application grid, and the handle, backdrop, Escape, and
Back dismiss it. All apps uses a three-column grid and a local search over app
names and descriptions. Signed-in users also find their profile, theme, language, and
sign-out actions there; the mobile header has no separate profile menu.
From 768 px the app bar replaces the header, and `AppWorkspace` shows its own
navigation. Between 768 and 1023 px, a tablet range, the workspace keeps its
list panes side by side, and its sidebar is an overlay: the head at the
top of the workspace holds the button that opens it and the page title.
The overlay closes with Escape, a tap beside it, or a choice in the
navigation, and focus returns to the button. A `mobile="stacked"` overview
list becomes one horizontally scrolling row of object chips above the content
instead. **All** at its end opens the complete sidebar: a bottom sheet below
48 rem and a centered dialog from 48 rem. From 1024 px the sidebar sits beside the
work area. Applications need no code for the tablet range.

For SSR link navigation, render the public island once alongside the outer
sidebar:

```tsx
import WorkspaceNavigation from "@k2b/cloud/ssr/WorkspaceNavigation.island";

<WorkspaceNavigation label="Inventory" items={[
  { id: "items", label: "Items", href: "/app/inventory/items", active: true },
]} />
```

For reactive state or local actions, use `WorkspaceNavigationProvider` inside
the owning application island:

```tsx
import { createNavigation } from "@k2b/ui";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";

const navigation = createNavigation({
  items: () => [
    { id: "items", label: "Items", href: "/app/inventory/items", badge: count() },
    { id: "new", label: "New item", action: "new", disabled: saving() },
  ],
  onAction: action => { if (action === "new") openEditor(); },
});
<WorkspaceNavigationProvider label="Inventory" navigation={navigation} />
```

Keep permission filtering, labels, counts, URLs, and actions application-owned.
The provider emits an SSR snapshot, binds handlers on mount, and unregisters on
cleanup. When navigation has a `switcher`, the snapshot also carries its
presentation: current ID, name, optional fact, icon, optional color, and purpose
label. The phone menu therefore shows the same head before hydration, with
**Loading...** in its panel until the island supplies options and handlers;
registering the owner adds no second head or space. The menu opens outside the
app canvas, so Cloud gives it the current app's accent: its active row, the
switcher icon, and the check on the current container look as they do in the
sidebar. Links remain usable before
the application island loads. Until the owner is ready, action-only entries, also in `actions`, and every inline action
remain disabled, and `expanded` items only set where their disclosure starts,
then toggle locally. Do not register embedded
inspectors, reference windows, or builder previews as the Cloud workspace.
They keep local content controls.

Cloud closes its menu and removes its temporary history entry before running a
selection. An action with `keepOpen: true` runs while the menu stays open; use
it for a filter or a sort order that changes only the menu's own rows. An
address change it makes with `history.replaceState` belongs to the menu's
temporary entry: keep `history.state` as it is, and expect the earlier address
to return when the menu closes without a selection. Back, Escape, backdrop, the
close button, and a handle drag dismiss the menu. Changing to desktop also
closes it. The menu renders its rows anew
each time it opens; keep folds between openings with `expanded` items and an
`onExpandedChange` handler on the controller. App-to-app navigation replaces
the registered owner; an old island cannot unregister the new owner's menu.

`provideWorkspaceNavigation(navigation, { label, owner })` is the lower-level
binding for hosts that already own a stable element. Both options are accessors;
`owner` must return the mounted outer navigation marker. Prefer the component
unless that explicit DOM ownership is needed.
