---
title: Styling and accessibility
navTitle: Styling and accessibility
section: Frontend
order: 890
description: Apply Cloud's visual and interaction rules without forking shared primitives.
tags: [css, accessibility, themes, design]
updated: 2026-08-12
---

# Styling and accessibility

Use this page when composing or reviewing a Cloud screen. Start with the
[shared component guidance](/en/docs/frontend#choose-shared-components) before
adding local markup or CSS.

The ownership boundary is deliberate:

- `@k2b/ui` owns portable components, interaction behavior, component states,
  and their scoped styles.
- Cloud owns product composition, application shells, app identity, and the
  integration of shared UI into light and dark themes.
- An application owns its domain content, copy, and layout where no shared
  component contract applies.

## Build hierarchy before decoration

Cloud uses a quiet canvas and a small number of neutral work surfaces. App
identity is strongest in the rail and workspace identity; ordinary content
stays neutral and readable.

Apply these rules in order:

1. Remove decoration that does not explain structure or behavior.
2. Group with spacing, alignment, typography, and shared surfaces.
3. Use color only for identity, action, status, selection, or data.
4. Match density to the task: compact navigation, scannable data, and more
   space for forms and reading.
5. Design loading, empty, error, hover, focus, selected, disabled, mobile, and
   dark states as part of the same component contract.

## Group content without decorative lines

Do not use horizontal lines to group ordinary application content. This
includes `<hr>`, `divide-y`, full-width `border-t` or `border-b`,
pseudo-element rules, and inset-shadow hairlines. Making a line thinner,
lighter, shorter, or more transparent does not change its role.

Do not add these separators between list rows, cards, settings, detail
sections, menu items, form sections, metadata groups, empty states, or
pagination. Use whitespace, alignment, a quiet shared surface, or a short
semantic section label. Prefer one clear group over nested papers; do not
replace a removed line with a box or hover fill around every row.

Boundaries are valid when they explain how a shared component operates:

- `DataTable` may expose row and column structure.
- A compound control may separate functional parts.
- A resizable layout may expose an interactive separator.

The shared table, control, or layout primitive owns those boundaries. App code
must not invent an exception. If content needs explicit row boundaries to be
understood, model it as tabular data and use `DataTable`.

## Keep color roles independent

Do not use one color for unrelated meanings.

- **App identity** marks the active app, workspace, and selected resource.
- **Actions** use the shared action hierarchy and focus treatment.
- **Status** uses information, success, warning, and danger semantics.
- **Data** colors distinguish domain values and remain understandable without
  color alone.

An app accent must not recolor every primary button. A red app must not make
normal navigation look destructive. Status color must not identify an app.

## Use shared components first

Import `@k2b/ui/global.css` once through the application build and render shared
components below a `.k2b-ui` scope. It includes the component styles and the
supported font and icon presets. Applications with their own assets may use the
granular `styles.css`, `fonts/plex.css`, and `icons/tabler.css` exports instead.
Do this in the third-party application's own browser bundle; do not depend on
styles or source files from a built-in app.

Choose the public component that owns the required appearance and behavior:

- Use `Button`, `ButtonLink`, `IconButton`, or `IconButtonLink` for actions and
  action links. Express hierarchy with the component's `variant` prop.
- Use `TextInput`, `Select`, `MultiSelectInput`, and the other shared input
  components for controlled fields and their validation states.
- Use `Dropdown` or `ContextMenu` for menu behavior instead of assembling a
  local trigger and popup.
- Use `AppWorkspace.SidebarItem` and its compound members for workspace
  navigation rows.
- Use `PanelDialog`, `AppWorkspace`, `Panes`, `DataTable`, and the other layout
  primitives for the geometry and interaction they document.
- Use `Placeholder`, `NotFoundState`, `NoticeCard`, and `StatusBadge` for their
  specific feedback and status roles.
- Use `Paper` for one neutral application-owned group when no more specific
  shared surface owns the content. It deliberately leaves padding and layout
  to the application.

For example, render a primary action as a component rather than recreating it
with a class:

```tsx
import { createSignal } from "solid-js";
import { Button, TextInput } from "@k2b/ui";

export function ProjectForm(props: { onSave: (name: string) => void }) {
  const [name, setName] = createSignal("");

  return (
    <div>
      <TextInput label="Project name" value={name()} onValueChange={setName} />
      <Button variant="primary" onClick={() => props.onSave(name())}>
        Save project
      </Button>
    </div>
  );
}
```

Do not recreate these contracts with classes such as `btn-primary`, `input`,
`sidebar-item`, or `focus-ui`. Those Cloud classes support existing product
integration; they are not an alternative component API for new controls.

Third-party applications use `Paper` rather than depending on Cloud's internal
`paper` utility. A built-in Cloud application may keep the utility for
app-owned grouping that has no more specific shared surface. Do not copy the
internal markup, selectors, or CSS of a shared component.

## Style app-owned content semantically

Inside a Cloud application, use `app-accent-text` and `app-accent-border`
sparingly for app identity. They are Cloud integration utilities, not
standalone `@k2b/ui` APIs and not general action or status colors.

When app-owned CSS is necessary, use the semantic theme variables already
provided by the host. A standalone `@k2b/ui` consumer can configure the
documented `--k2b-*` tokens on its scoped root.

Avoid fixed light backgrounds, black text, hardcoded app colors, and arbitrary
borders. They break dark mode, focus treatment, or application theming. Do not
override a shared component to make one screen look different; fix a recurring
gap in the owning primitive and update its UI context and showcase.

## Choose surfaces deliberately

- Use one surface to group related content; do not stack papers to manufacture
  hierarchy.
- Keep in-flow surfaces quiet. Reserve stronger shadows for dialogs, popovers,
  menus, and other floating layers.
- Keep one visible dialog frame. With `PanelDialog`, the header and footer stay
  fixed while `PanelDialog.Body` owns scrolling.
- Inputs are quiet wells with a clear focus state, not permanently emphasized
  cards.
- Use shared radius and spacing families. Nested frame, surface, and control
  geometry should remain visually distinct.

`AppWorkspace` is one clipped workbench. Sidebar, main, detail, and bottom
drawer are sibling regions inside that frame, not adjacent cards. Use
`AppWorkspace.Detail`, `AppWorkspace.MainPane`, `AppWorkspace.BottomDrawer`,
and `Panes` for their documented roles instead of recreating their geometry.
See [Application shells](/en/docs/frontend/application-shells).

## Keep dynamic scroll regions stable

Let normal page content grow with the document. When a region is already
height-constrained and may cross its overflow boundary, use
[`ScrollArea`](/en/ui/layout/scroll-area) or the scrolling part of the shared
component that owns the region. Its stable scrollbar gutter keeps text,
controls, and aligned columns from moving horizontally when a scrollbar
appears or disappears.

Treat the content length as dynamic when it can change through:

- filters, search results, tabs, or view switches;
- disclosures, expandable sections, validation messages, or optional fields;
- pagination, incremental loading, or live updates;
- user-created, user-edited, or otherwise unbounded domain content.

The surrounding layout still owns the region's height, flex behavior, padding,
and spacing. Keep one scroll owner for each full-height region. Do not wrap
`DetailPanel.Body`, `PanelDialog.Body`, `DataTable`, `ChatTimeline`, or another
component that already owns scrolling in an additional `ScrollArea`. Do not
use it for a horizontal-only strip or add a bounded scroll region where the
page should grow naturally.

When a standalone scroll region needs to be announced, give it an appropriate
landmark and accessible name. Add a tab stop only when keyboard users would
otherwise have no focusable content through which to reach the scrollport.

## Keep controls and feedback consistent

A shared control owns its resting, hover, focus, active, selected, disabled,
loading, error, and dark treatments.

- Use `primary` for the main forward or write action and `danger` only for a
  destructive action.
- Give icon-only controls an accessible name. Add the shared tooltip when the
  visible context does not explain the action.
- Keep one continuous, visible focus indicator. Do not stack unrelated border
  and ring colors on the same edge.
- Keep progressive actions discoverable by keyboard focus and touch when they
  are hidden at rest on fine pointers.
- Use `Placeholder` for a region that is empty, loading, or failed. Use
  `NotFoundState` for a whole-page dead end or missing resource.
- Use `NoticeCard` for a persistent finding and a toast for short confirmation.
  Use `StatusBadge` for a compact health or lifecycle label.

The application owns feedback copy and recovery actions. Distinguish an empty
result from a failed request, and do not replace field validation or
domain-specific states with a generic `Placeholder`.

## Compose responsive layouts

Use `Layout`, `AppWorkspace`, dialogs, and shared sidebars for responsive
geometry.

Test narrow and wide viewports. Content must not depend on pointer hover.
Dialogs must fit the viewport and keep their primary actions reachable.

Mobile is a composed state, not a squeezed desktop layout. Move navigation and
details into their shared mobile behavior, keep touch targets usable, and
contain table overflow inside the table region.

## Preserve keyboard and screen reader access

- Use native buttons for actions and anchors for navigation.
- Give icon-only controls an accessible name.
- Keep a visible focus state.
- Do not use color as the only status signal.
- Associate labels, descriptions, and errors with inputs.
- Keep heading order and landmarks meaningful.
- Return focus when a dialog closes.
- Announce async changes when they are not otherwise visible.

Use the interaction behavior provided by the component that owns it. For
example, `Panes` owns its resize interaction and `AppWorkspace.NavTree` owns
tree keyboard navigation. `NavTree.Item` only forwards optional native drag
events; an application using them still owns the drag payload, permission
checks, drop behavior, mutation, and an equivalent keyboard path.

Do not add `aria-grabbed` as a substitute for keyboard-operable movement and
clear announcements.

## Verify both themes and interaction modes

Review every changed surface in light and dark mode. Check resting, hover,
focus, active, selected, disabled, loading, empty, and error states.

Use automated accessibility checks as a baseline, then complete the keyboard
flow manually. Test touch behavior when actions use progressive disclosure.
The [Frontend testing](/en/docs/frontend/testing) guide lists the full
verification pass.

## Review a changed screen

Before accepting a component or screen, verify:

- Hierarchy works without decorative color or separator lines.
- Lists, settings, forms, details, and pagination use spacing or shared
  surfaces instead of `<hr>`, `divide-y`, or app-owned hairlines.
- The closest shared primitive owns geometry and interaction behavior.
- App identity, action, status, selection, and data colors remain independent.
- App-owned CSS uses semantic host tokens and does not copy a shared component.
- Hover, focus, active, selected, disabled, loading, empty, and error states
  are covered.
- Progressive disclosure works with pointer, keyboard, and touch.
- Height-constrained dynamic content keeps a stable width as overflow changes.
- Desktop and mobile layouts avoid page-level overflow.
- Light and dark modes preserve the same hierarchy.
- Icon-only actions have accessible names and useful focus treatment.
