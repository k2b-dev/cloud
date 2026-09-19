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

`Main` and `MainPane` show subtle 16 px overflow hints by default when they
own scrolling. Set `scrollFade={false}` to opt out. A split `Main` wrapper
never masks its panes; each scrolling pane owns its hint. Regions with
`scroll={false}` do not add a hint around their child scrollport. The workspace
controller also initializes marked server-rendered scrollports and cleans them
up during navigation, sharing observers with hydrated components.

Set `scroll={false}` when a bounded child such as `ScrollArea`, `DataTable`, a reader, editor, or an explicit `overflow-auto` region owns scrolling. Do the same on `MainPane` when its child owns the pane's scrollport. Keep exactly one vertical scroll owner for each region; do not place another scrollport inside a still-scrolling `Main` or `MainPane`.

Use `MainPane` for a stable peer region such as a list beside a reader. Use `Detail` for contextual information about the current selection. Use `BottomDrawer` for activity, preview, or a composer below the work area.

Give every pane, detail, and drawer a stable purpose-based `id`. Do not use the selected record id. The host can use these ids with the exported layout-state helpers to restore geometry.

Set `resizable={false}` on the root to disable shared resizing. A region can override the root with its own `resizable` property.

An open `MainPane` keeps its content mounted when layout state, mobile selection, or another pane changes. Closing a `MainPane` unmounts its content; reopening it creates a fresh instance.

`Detail` and `BottomDrawer` remain mounted while closed. Their `open` property
controls visibility, so local state and SSR DOM identity remain stable.

## Navigation

`Sidebar` with `SidebarDesktop` supplies the persistent desktop navigation at
1024 px and above. Below 1024 px, the host renders its mobile navigation using
[createNavigation and Navigation](/en/ui/layout/navigation), usually inside a
[BottomSheet](/en/ui/layout/bottom-sheet). AppWorkspace adds no mobile launcher,
second application title, or tablet menu. Sidebar items with an `href` remain real links.

Set `mobileSurface="flush"` on an outer workspace when the host supplies the
mobile chrome. This removes its exterior border, radius, shadow, and background
on mobile. Embedded workspaces keep the default contained surface.

Sidebar links use document navigation by default. Set `navigation="enhanced"`
only inside an island that loads and applies the target state before committing
history through `onNavigate`. The enhanced helper does not run server loaders
or re-render an SSR page. If `onNavigate` is absent, the link safely keeps
document navigation. See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).

Set `collapsible` on `Sidebar` to let the shared resize controller snap it to
the compact rail. The collapsed flag is part of `AppWorkspaceLayoutState`, so
the host can restore the same navigation state on the next mount.

Set `scrollPreserveKey` on scrolling sidebar bodies when enhanced navigation should restore their position.

`SidebarBody` fades its top and bottom edges automatically while more content
is available in that direction. Scrolling, resizing, and live content changes
update the hint without reserving layout space. Set `scrollFade={false}` to
opt out. Forced-color mode keeps content unmasked. Card items retain subtle
surfaces in dark themes.

On hover-capable fine pointers, `SidebarBody` keeps its scrollbar thumb hidden
until the sidebar is hovered or contains keyboard focus. Its scrollbar geometry
does not change. Touch, coarse-pointer, and forced-color environments retain
their normal visible scrollbar treatment.

The sidebar compound members cover these jobs:

- `SidebarDesktop`, `SidebarBody`, `SidebarSection`, and `SidebarFooter`
  compose the persistent navigation;
- `SidebarItem`, `SidebarItemIcon`, `SidebarItemLabel`, `SidebarItemMeta`,
  `SidebarItemAction`, and `SidebarItemActions` compose a navigation row;
- `NavTree` and `NavTree.Item` compose nested folder, mailbox, category, or tag
  navigation with automatic indentation and keyboard interaction;
- `SidebarIconGrid` and `SidebarIconAction` provide compact icon-only actions.

Desktop sidebars are action-first: begin with primary actions or navigation,
not a repeated application title. Put persistent secondary navigation in
`SidebarFooter`; when Settings exists, it is the final footer item. The host owns the mobile trigger and application identity.

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

## API reference

```ts
type AppWorkspaceProps = {
  mobileSurface?: "contained" | "flush";
  children: JSX.Element; class?: string; resizable?: boolean;
  layoutState?: () => AppWorkspaceLayoutState | null | undefined;
  onLayoutChange?: (state: AppWorkspaceLayoutState) => void; controller?: false;
};

type AppWorkspaceLayoutStateProviderProps = {
  children: JSX.Element; state: AppWorkspaceLayoutState | null | undefined;
};

type AppWorkspaceContentProps = { children: JSX.Element; class?: string };

type AppWorkspaceMainProps = {
  children: JSX.Element; class?: string; mobilePane?: string; scroll?: boolean; scrollFade?: boolean;
  scrollPreserveKey?: string | false;
  "aria-busy"?: boolean | "true" | "false";
};

type AppWorkspaceMainPaneProps = {
  id: string; label: string; surface?: "default" | "navigation"; open?: boolean; resizable?: boolean;
  resizeShadow?: boolean; defaultSize?: number; minSize?: number; maxSize?: number; class?: string;
  scroll?: boolean; scrollFade?: boolean; children: JSX.Element;
};

type AppWorkspaceDetailProps = {
  children: JSX.Element; open: boolean; id: string; class?: string; width?: AppWorkspaceDetailWidth;
  viewTransitionName?: string; resizable?: boolean; minWidth?: number; maxWidth?: number;
};

type AppWorkspaceBottomDrawerProps = {
  children: JSX.Element; open: boolean; id: string; class?: string; height?: AppWorkspaceBottomDrawerHeight;
  minHeight?: number; maxHeight?: number; viewTransitionName?: string; resizable?: boolean;
};

```

### Sidebar

```ts
type AppWorkspaceSidebarProps = {
  label?: string;
  children: JSX.Element; class?: string; resizable?: boolean; resizeShadow?: boolean; collapsible?: boolean;
  defaultSize?: number; minSize?: number; maxSize?: number;
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
  variant?: "row" | "card"; context?: JSX.Element; contextMeta?: JSX.Element;
  description?: JSX.Element; preview?: { label: string; content: JSX.Element | ((close: () => void) => JSX.Element); trigger?: "action" | "row"; align?: "center" | "end"; viewportSize?: "compact"; onOpenChange?: (open: boolean) => void };
  children: JSX.Element; href?: string; navigation?: "enhanced" | "document"; replace?: boolean;
  scroll?: NavigationScrollMode; onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  onClick?: (event: MouseEvent) => void; active?: boolean; activeClass?: string; disabled?: boolean;
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

type AppWorkspaceSidebarItemLabelProps = { children: JSX.Element; marquee?: boolean };

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

```

### Navigation tree

```ts
type AppWorkspaceNavTreeProps = {
  children: JSX.Element; ariaLabel: string; selectedId?: string | null; expandedIds?: readonly string[];
  defaultExpandedIds?: readonly string[]; onSelectedIdChange?: (id: string) => void;
  onExpandedIdsChange?: (ids: readonly string[]) => void; indented?: boolean; class?: string;
};

type AppWorkspaceNavTreeItemProps = {
  id: string; label: JSX.Element; children?: JSX.Element; href?: string; navigation?: "enhanced" | "document";
  replace?: boolean; scroll?: NavigationScrollMode;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>; onSelect?: (event: MouseEvent) => void;
  disabled?: boolean; icon?: string; expandedIcon?: string; meta?: JSX.Element;
  metaVisibility?: AppWorkspaceSidebarAccessoryVisibility; actions?: JSX.Element;
  tone?: AppWorkspaceSidebarItemTone; title?: string; viewTransitionName?: string; class?: string;
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
| MainPane | 320 | 240 | 640 |
| Detail | 384 | 288 | 640 |
| BottomDrawer | 240 | 160 | 560 |

The main area reserves 320px width / 240px height; the available container may reduce maxima. Collapsed sidebar width is 64px; the collapse threshold is 128px. Detail widths `sm/md/lg/xl` are 288/384/480/544px (default md); Drawer heights `sm/md/lg` are 192/240/320px (default md). Restored geometry takes precedence. `resizable` defaults on; `collapsible` is opt-in. `Main.scroll` and `MainPane.scroll` default on.

`LinkNavigateEvent` and `NavigationScrollMode` use [navigation conventions](/en/ui/getting-started#icons-tones-and-navigation). `navigation` defaults to `"document"`. Event callbacks do not load data automatically.

```ts
declare function normalizeAppWorkspaceLayoutState(value: unknown): AppWorkspaceLayoutState | null;
declare function parseAppWorkspaceLayoutState(value: string | null | undefined): AppWorkspaceLayoutState | null;
declare function serializeAppWorkspaceLayoutState(state: AppWorkspaceLayoutState): string;
declare function appWorkspaceLayoutStyle(state: AppWorkspaceLayoutState | null | undefined): string | undefined;
declare function installAppWorkspaceController(options?: AppWorkspaceControllerOptions): () => void;
declare function safeAppWorkspacePanelId(panelId: string): string;
declare function appWorkspacePanelVariable(kind: "pane" | "detail" | "drawer", panelId: string): string;
declare function appWorkspaceResizeLimits(options: { kind: "sidebar" | "pane" | "detail" | "drawer"; workspaceSize: number; reservedSize: number; min?: number; max?: number; sidebarCollapsible?: boolean }): { min: number; max: number };
declare function shouldCollapseAppWorkspaceSidebar(width: number, collapsible: boolean): boolean;
declare function resolveAppWorkspaceSidebarWidth(width: number, maxWidth: number, collapsible: boolean): { width: number; collapsed: boolean };
```

Parse/serialize use a URI-encoded JSON string; normalize accepts a decoded object. The installer returns cleanup. Most consumers use the automatic controller and only persist `onLayoutChange` results.

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

Main-pane borders separate adjacent desktop regions. The last visible pane has
no outer border, and single-pane mobile layouts do not retain split borders.

### Live rows and detail previews

`SidebarItem.description` supplies an optional passive second line. Compose a
`StatusBadge`, short status text or progress there; keep interactive controls in
`actions` or the preview. Existing one-line rows keep their compact layout.
Compound icon, label, metadata and action props remain reactive. Applications own
the data source: no socket, task lifecycle or subscription belongs in the library.

Use `preview={{ label: "Item details", content: <Details /> }}` for interactive
secondary information. Fine-pointer hover and keyboard focus open it after a short
delay. A dedicated details button opens it on touch-capable devices and moves focus
into the non-modal dialog. With hover and a fine pointer, this button is hidden
visually until keyboard focus reaches it. A coarse pointer on hybrid devices
keeps it visible too. This behavior depends on input capabilities, not screen width. Escape and outside clicks dismiss it. The preview stays mounted
while closed; live content updates preserve its controls and focus. Do not start
expensive subscriptions merely because a row exists. The preview can hold an
explicit action that loads additional details.

For asynchronous catalogs, set `preview.viewportSize="compact"` to reserve a
stable 18.75rem (300 px at the default font size) scrollport, capped at 60dvh.
Loading, empty, error, and populated states then keep the same height. Use
`<ScrollArea viewportSize="compact">` for the equivalent mobile dialog content.
The default preview remains content-sized; do not nest another scrollport.

Hover previews use the shared `ScrollArea` internally. Overflowing content fades
at the top and bottom while the popup border and shadow remain visible. Fades
follow the current scroll position and disappear when an edge is reached.

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
clicking the row or its trailing chevron keeps it open. The chevron appears on
hover or keyboard focus and remains visible on touch devices. Keyboard focus on
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

Use `SidebarItem variant="card"` for work that benefits from context above its
title. `context` holds a project or category; `contextMeta` holds a short time
or secondary value. Both accept reactive JSX. Keep commands in actions or the
preview. Cards truncate titles with an ellipsis by default. Set
`SidebarItemLabel marquee={false}` for the same truncation in ordinary rows.
Completed work can retain `variant="row"` without context or description.

Card context headers keep their width when trailing actions appear; only the title area yields space. Use `Format.RelativeTime` for relative timestamps. The desktop scroll track occupies the existing right inset and keeps its gutter when content fits, without adding space on the left. Keyboard focus on the main card action outlines the complete card.

Inactive context cards use a transparent surface and border; the active item retains its selection treatment.
