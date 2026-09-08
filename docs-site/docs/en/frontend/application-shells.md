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
  <AppWorkspace>
    <AppWorkspace.Sidebar collapsible>
      <AppWorkspace.SidebarMobileTrigger label="Inventory" />
      <AppWorkspace.SidebarMobile>
        <InventoryMobileNavigation />
      </AppWorkspace.SidebarMobile>
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
