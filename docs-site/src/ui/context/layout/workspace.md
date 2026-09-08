# AppWorkspace

`AppWorkspace` is the full-height shell for application workspaces. It owns the sidebar, primary work area, contextual detail panels, and optional bottom drawer.

The application owns the content and which regions are open.

The frame owns its surface hierarchy: `Main` uses the base surface, while the
navigation, contextual details, and bottom drawer use the subtle surface.
Applications should keep region wrappers transparent and add cards or panels
only where the content needs another visual level.

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

## Compose the regions

`AppWorkspace.Content` is required. Put `Main` first and each `Detail` after it
inside `Content`. Put `BottomDrawer` at the workspace root.

`Main` adds no padding. Pass an application class through `class` when the workspace needs an inset. Omit it for edge-to-edge tables, editors, canvases, or `Panes`. `Main` is the default scroll owner and reserves a stable scrollbar gutter. Pass `scrollPreserveKey` when enhanced navigation should restore its position.

Set `scroll={false}` when a bounded child such as `ScrollArea`, `DataTable`, a reader, editor, or an explicit `overflow-auto` region owns scrolling. Do the same on `MainPane` when its child owns the pane's scrollport. Keep exactly one vertical scroll owner for each region; do not place another scrollport inside a still-scrolling `Main` or `MainPane`.

Use `MainPane` for a stable peer region such as a list beside a reader. Use `Detail` for contextual information about the current selection. Use `BottomDrawer` for activity, preview, or a composer below the work area.

Give every pane, detail, and drawer a stable purpose-based `id`. Do not use the selected record id. The host can use these ids with the exported layout-state helpers to restore geometry.

Set `resizable={false}` on the root to disable shared resizing. A region can override the root with its own `resizable` property.

`Detail` and `BottomDrawer` remain mounted while closed. Their `open` property
controls visibility, so local state and SSR DOM identity remain stable.

## Navigation

Provide both `SidebarMobile` and `SidebarDesktop` when the workspace has navigation. Sidebar items with an `href` remain real links.

Sidebar links use document navigation by default. Set `navigation="enhanced"`
only inside an island that loads and applies the target state before committing
history through `onNavigate`. The enhanced helper does not run server loaders
or re-render an SSR page. If `onNavigate` is absent, the link safely keeps
document navigation. See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).

Set `collapsible` on `Sidebar` to let the shared resize controller snap it to
the compact rail. The collapsed flag is part of `AppWorkspaceLayoutState`, so
the host can restore the same navigation state on the next mount.

Set `scrollPreserveKey` on scrolling sidebar bodies when enhanced navigation should restore their position.

On hover-capable fine pointers, `SidebarBody` keeps its scrollbar thumb hidden
until the sidebar is hovered or contains keyboard focus. Its scrollbar geometry
does not change. Touch, coarse-pointer, and forced-color environments retain
their normal visible scrollbar treatment.

The sidebar compound members cover these jobs:

- `SidebarMobileTrigger` supplies the compact menu label and standard menu icon;
- `SidebarMobile`, `SidebarMobileItems`, and `SidebarMobileBody` compose the
  compact navigation;
- `SidebarDesktop`, `SidebarBody`, `SidebarSection`, and `SidebarFooter`
  compose the persistent navigation;
- `SidebarItem`, `SidebarItemIcon`, `SidebarItemLabel`, `SidebarItemMeta`,
  `SidebarItemAction`, and `SidebarItemActions` compose a navigation row;
- `NavTree` and `NavTree.Item` compose nested folder, mailbox, category, or tag
  navigation with automatic indentation and keyboard interaction;
- `SidebarIconGrid` and `SidebarIconAction` provide compact icon-only actions.

Desktop sidebars are action-first: begin with primary actions or navigation,
not a repeated application title. Put persistent secondary navigation in
`SidebarFooter`; when Settings exists, it is the final footer item. The compact
trigger is mobile-only and deliberately owns no application-specific icon or
accent tile.

Pass labelled shared controls through `SidebarSection.actions` when a section
needs a compact header action such as creating a resource. The section owns
the header alignment; the control still owns its accessible name and action
behavior. Section headers and their actions are hidden with the compact rail
and mobile section layout, so expose an equivalent reachable action in those
compositions. On hover-capable fine pointers, section actions remain quiet
until the header is hovered or contains keyboard focus. They remain visible on
touch and coarse-pointer devices. An open dropdown keeps its section action
visible and interactive until the menu closes.

Section titles are quiet sentence-case labels. Keep them short and let the
navigation rows carry the stronger visual emphasis.

Active rows use the workspace accent color and a stronger text weight without
a persistent fill. Hover retains its quiet background, and keyboard focus keeps
the shared focus ring. Standalone themes can override
`--k2b-app-workspace-active`; Cloud maps it to the current application accent.

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

### Row metadata and actions

Use `SidebarItemMeta` for passive trailing information such as counts and
status icons. Use `SidebarItemAction` for one labelled button or link. For two
or more controls, pass `SidebarItemActions` through the row's `actions` prop so
the controls remain siblings of the row link or button instead of invalid
nested interactive content.

Set `visibility="hover"` on metadata or actions only when the information is
optional. On fine pointers it consumes no space until the row is hovered or
keyboard-focused. It remains visible on touch devices. Keep errors, unread
counts, and other important state visible with the default `"always"` value.

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

### Nested navigation

Use `NavTree` when navigation has parent and child rows. It provides one
accessible tree contract, roving keyboard focus, disclosure behavior, and
depth-based indentation. Set `indented={false}` only when hierarchy should be
communicated without horizontal nesting.

Expansion can be uncontrolled with `defaultExpandedIds`, or controlled with
`expandedIds` and `onExpandedIdsChange`. Persistence remains application-owned:
if an application stores expansion in a cookie or another store, pass the same
initial ids during SSR to avoid a hydration layout shift.

Branches normally keep their leading icon and receive a trailing disclosure
chevron. For folder navigation, set both `icon` and `expandedIcon`; the leading
icon then reflects the branch state and acts as the disclosure target, so no
second chevron is rendered. The row label keeps its normal select or navigation
behavior, and the keyboard contract is unchanged.

Optional drag event handlers on `NavTree.Item` are forwarded to the tree item
container. Applications still own drag payloads, permission checks, drop
effects, and mutations.

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
component installs a controller scoped to its root after hydration. Pointer and
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
settles or a keyboard step completes.

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
disposes its controller after hydration.

The package exports parse, normalize, serialize, and style helpers for layout state. The application decides where that state is stored and can apply the same state during SSR to avoid geometry jumps.

## Example

```tsx
<AppWorkspace class="app-shell-frame">
  <AppWorkspace.Sidebar collapsible>
    <AppWorkspace.SidebarMobileTrigger label="Inventory" />
    <AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarItem
          href="/app/inventory"
          icon="ti ti-list"
          active
        >
          All items
        </AppWorkspace.SidebarItem>
      </AppWorkspace.SidebarMobileItems>
    </AppWorkspace.SidebarMobile>
    <AppWorkspace.SidebarDesktop>
      <AppWorkspace.SidebarBody scrollPreserveKey="inventory-sidebar">
        <AppWorkspace.SidebarSection title="Views">
          <AppWorkspace.SidebarItem
            href="/app/inventory"
            icon="ti ti-list"
            active
          >
            All items
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
