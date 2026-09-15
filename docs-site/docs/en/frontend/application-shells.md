---
title: Application shells
navTitle: Application shells
section: Frontend
order: 830
description: Choose the shared shell that matches an application's information structure.
tags: [shells, workspace, ui]
updated: 2026-08-12
---

# Application shells

Choose a shared shell before arranging domain content. A shell gives the page
stable responsive geometry and interaction behavior; it does not load data,
authorize resources, or register the app in Cloud navigation.

Wrap the shell in the shared [Layout](/en/docs/frontend/layout-and-navigation),
then keep domain data and actions inside the application-owned content slots.

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


## Build an overview

`AppOverview` contains a main area and an optional aside. Put create actions in
`AppOverview.Aside`.

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

`AppWorkspace.Content` is the required flex row for `Main` and `Detail`.
Keep geometry IDs stable. Do not add another grid or resize handle.

Authenticated desktop layouts expose Help and Search through the application
rail. Their header controls are compact-layout fallbacks and stay mobile-only.

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

Cloud owns one mobile menu below 1024 px. The header launcher opens the current
workspace menu by default; **All apps** switches to the application grid.
The sheet header combines the workspace name and **All apps** in one segmented
control. All apps uses a three-column grid and a local search over app names and
descriptions. Signed-in users also find their profile, theme, language, and
sign-out actions there; the mobile header has no separate profile menu.
At 1024 px and above, the existing desktop rail and workspace sidebar apply.
There is no intermediate tablet menu.

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
cleanup. Links remain usable before the application island loads; action-only
entries remain disabled until their owner is ready. Do not register embedded
inspectors, reference windows, or builder previews as the Cloud workspace.
They keep local content controls.

Cloud closes its menu and removes its temporary history entry before running a
selection. Back, Escape, backdrop, the close button, and a handle drag dismiss
the menu. Changing to desktop also closes it. App-to-app navigation replaces
the registered owner; an old island cannot unregister the new owner's menu.

`provideWorkspaceNavigation(navigation, { label, owner })` is the lower-level
binding for hosts that already own a stable element. Both options are accessors;
`owner` must return the mounted outer navigation marker. Prefer the component
unless that explicit DOM ownership is needed.
