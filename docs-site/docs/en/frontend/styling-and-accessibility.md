---
title: Styling and accessibility
navTitle: Styling and accessibility
section: Frontend
order: 890
description: Apply Cloud's visual and interaction rules without forking shared primitives.
tags: [css, accessibility, themes, design]
updated: 2026-10-15
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

Keep screens clean and flat. Put the most important value first, use one type
scale per page, and leave out data the person does not need at that moment. Do
not place a box inside a box. A flat screen lets the content carry the
hierarchy, so a person finds the value they came for without reading the
frame around it. Flatness never justifies weaker usability, contrast, or
keyboard behavior: check those again after you remove decoration.

## Group content without decorative lines

Do not use lines to group ordinary application content. This includes
`<hr>`, `divide-y`, full-width `border-t` or `border-b`, pseudo-element rules,
and inset-shadow hairlines. Making a line thinner, lighter, shorter, or more
transparent does not change its role.

Do not add these separators between list rows, cards, settings, detail
sections, menu items, form sections, metadata groups, empty states, or
pagination. Use whitespace, alignment, a quiet shared surface, or a short
semantic section label. Prefer one clear group over nested papers; do not
replace a removed line with a box or hover fill around every row.

Do not draw a line between the header, content, and footer of an app-owned
surface, such as a dialog, panel, card, or page section. Spacing and type
already show where the header ends.

App code draws no vertical or horizontal borders between workspace regions
either: not between sidebar, list, and detail, not under header rows, and not
at the edge between the app rail and the application. The regions separate
through the surfaces, spacing, and edges that `AppWorkspace`, `Panes`, and
`SettingsModal` own. A line that app code adds between regions splits one
workbench into separate boxes and competes with the content for attention.

To verify, look at the changed screen in light and dark mode and search the
diff for `border-t`, `border-b`, `border-l`, `border-r`, `divide-`, and `<hr>`
in app-owned markup.

Boundaries are valid when they explain how a shared component operates:

- `DataTable` may expose row and column structure.
- A compound control may separate functional parts.
- A resizable layout may expose an interactive separator.
- A shared workspace layout may mark the edge between adjacent panes or a
  drawer.
- The app bar separates its shortcuts from the ordinary apps with one group
  divider.

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
- Use `InlineGuidance`, `Placeholder`, `NotFoundState`, `NoticeCard`, and `StatusBadge` for their
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
provided by the host. The host's `--ui-focus` is a complete `box-shadow`: use
`var(--ui-focus)` only as a `box-shadow` value, because the browser drops a
border, outline, background, or `color-mix()` declaration that uses it as a
color. A standalone `@k2b/ui` consumer can configure the
documented `--k2b-*` tokens on its scoped root.

Avoid fixed light backgrounds, black text, hardcoded app colors, and arbitrary
borders. They break dark mode, focus treatment, or application theming. Do not
override a shared component to make one screen look different; fix a recurring
gap in the owning primitive and update its UI context and showcase.

### Mix variable colors in separate rules

In a standalone application, give each `color-mix()` that references a CSS
variable or `currentColor` its own rule in `src/styles/app.css`. Until a Bun
release includes [oven-sh/bun#38589](https://github.com/oven-sh/bun/pull/38589),
the `@k2b/cloud` build keeps only one such value per rule. The others show
Tailwind's fallback, usually the first color of the mix. Mixes of literal
colors are computed at build time and are not affected.

```css
/* Avoid: only the background keeps its mixed color. */
.project-highlight {
  background: color-mix(in oklab, var(--k2b-action) 12%, var(--k2b-surface));
  border-color: color-mix(in oklab, var(--k2b-action) 40%, var(--k2b-surface));
}

/* Use: both keep their mixed colors. */
.project-highlight {
  background: color-mix(in oklab, var(--k2b-action) 12%, var(--k2b-surface));
}

.project-highlight {
  border-color: color-mix(in oklab, var(--k2b-action) 40%, var(--k2b-surface));
}
```

The same applies to `@apply`: an opacity modifier on a variable or
`currentColor` color, such as `bg-(--k2b-action)/12`, compiles to such a
`color-mix()`. Split `@apply bg-(--k2b-action)/12 border-(--k2b-action)/40`
into one rule per utility. Used as classes in markup, the same utilities are not
affected, because each class compiles to its own rule.

A custom property that holds a mixed color counts as such a declaration. To
reuse a mixed color, declare it in its own rule and read it with `var()`:

```css
.project-highlight {
  --project-highlight-border: color-mix(in oklab, var(--k2b-action) 40%, var(--k2b-surface));
}

.project-highlight {
  background: color-mix(in oklab, var(--k2b-action) 12%, var(--k2b-surface));
  border: 1px solid var(--project-highlight-border);
}
```

### Render Mermaid diagrams with Cloud colors

Initialize Mermaid with `mermaidConfig` from `@k2b/cloud/browser/mermaid`
instead of Mermaid's built-in themes. Pass the current theme, and render again
after a theme change:

```ts
import { mermaidConfig } from "@k2b/cloud/browser/mermaid";
import mermaid from "mermaid";

mermaid.initialize(mermaidConfig({ dark: document.documentElement.classList.contains("dark") }));
const { svg } = await mermaid.render(id, source);
```

The configuration uses Cloud's surface, border, and text colors. It keeps
`securityLevel: "strict"` and ignores diagram directives that change the
theme, colors, CSS, or security settings. Flowchart, class, state, ER, and
requirement diagrams use the dagre layout. An author can set `layout: elk` in
a diagram's front matter; the ELK layout code then loads only for that diagram.
On Safari, diagrams need Safari 17.4 or later.

## Choose surfaces deliberately

- Use one surface to group related content; do not stack papers to manufacture
  hierarchy.
- Take depth from the shared surface. An in-flow surface gets its depth from
  the surface step and inset shading of the shared component, such as the
  quiet well of an input, never from an outer shadow, a nested border, or a
  box inside a box. Floating layers, such as dialogs, popovers, menus, and
  toasts, keep their soft outer shadow, because they sit above the page and
  must read as separate from it. Shared components that own their frame,
  shadow, or inner sections, such as the workspace card, an `elevated`
  `Paper`, or a floating `PanelDialog`, keep them; app code does not add its
  own.
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

## Keep the layout still

A Cloud screen has no layout shift: a state change never moves or resizes the
content around it. This applies to focus, hover, pressed, and selected states;
loading and async results; validation messages; unsaved-changes and save bars;
badges and counts; fonts and icons that load late; and scrollbars that appear
or disappear. Content that jumps makes a person lose their place and can turn
a click into a click on the wrong target.

- Reserve the space for a state before it appears, for example the row for a
  validation message, the size of a loading result, or the slot of a badge.
- Draw focus with an outline or an inset ring, not with a border or added
  padding. Shared components already do this; see
  [Focus rings](/en/ui/focus).
- Change the color of an existing border, never its width.
- Never fix clipping with margins or padding. Use `k2b-focus-inset` or the
  shared component that owns the clipping region.
- For scrollbars, follow [Keep dynamic scroll regions stable](#keep-dynamic-scroll-regions-stable).

To verify, decide which neighbors must stay put, then compare their bounding
boxes before and after each state change, at desktop width and at phone width.
A browser test can read them with `getBoundingClientRect()` and expect them to
be equal. When a person opens something on purpose, such as the formatting
row of a composer, the opened region may grow: test that it grows in the
intended direction and that content anchored to it follows in the same frame
instead of jumping. The test "Aa adds one row above the
field; … never move the field, a control, or the newest message" in
`packages/ui/src/chat/chat-composer.browser.test.ts` shows the pattern: it
toggles each state at 720 px and 360 px and checks that the field and every
control keep their position. While the formatting row opens, it also checks in
every frame that the newest message stays directly above the composer.

## Respond to hover without movement

Hover and focus never move, resize, or lift an element: no translate, no
scale, and no growing shadow. Paint changes are fine, such as a color, a focus
ring, or an action or affordance that the shared component reveals in space it
already reserves. Movement under the pointer makes a target harder to hit and
draws attention away from the content. This is the general form of the rule that
[cards](/en/ui/surfaces/cards) and
[file drop targets](/en/ui/input/file-drop-target) already follow.

To verify, hover and focus the element and compare its bounding box with the
resting state. Search the changed CSS for `transform`, `translate`, `scale`,
and `rotate` inside `:hover` and `:focus` rules, and for an outer `box-shadow`
inside `:hover` rules. A focus ring drawn with `box-shadow`, such as the inset
ring that [Focus rings](/en/ui/focus) describes, is paint, not movement. In
the Cloud repository, the `hover-motion` repository check rejects these
patterns in package sources, including Tailwind variants such as
`hover:shadow-sm` and `group-hover:translate-x-0.5`.

## Move with the shared motion tokens

Every duration and curve comes from the `--k2b-motion-*` and `--k2b-ease-*`
tokens of `@k2b/ui`. Set the state first and animate after it: a result never
waits for an animation. Animate transform, opacity, and color, never width,
height, padding, margin, or position. Nothing animates on first paint or on
mount, and popovers and menus close at once. Reduced motion makes all of it
instant. [Motion](/en/ui/motion) lists the tokens, their uses, and the
`motion` repository check.

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
`DetailPanel.Body`, `PanelDialog.Body`, `DataTable`, `ChatTimeline`,
`VirtualFeed`, `Timeline`, or another component that already owns scrolling
in an additional `ScrollArea`. Do not use it for a horizontal-only strip or
add a bounded scroll region where the page should grow naturally.

For a long feed that loads more items at either end and must keep the reading
position, such as messages or activity, use
[`VirtualFeed`](/en/ui/content/virtual-feed) instead of a hand-made list. It
renders only the items near the visible area and keeps the visible item in
place while pages load and rows change size.
For messages in a conversation, render each item with
[`MessageRow`](/en/ui/content/message-rows), which groups messages by author,
renders safe Markdown, and keeps every row's height from the moment it mounts.
For dated items across days, such as meetings and deadlines, where duration
and free time matter, use [`Timeline`](/en/ui/content/timeline). It loads days
at both ends and keeps what the reader sees in place.

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
- Keep focus rings whole. Shared containers that clip their content, such as
  `AppWorkspace`, `ScrollArea`, `DetailPanel`, dialogs, and `DataTable`, draw
  the rings of the controls inside them within the controls. Add
  `k2b-focus-inset` to your own element that clips focusable content with
  `overflow`. Never add padding or margins so that a ring fits. See
  [Focus rings](/en/ui/focus).
- Progressive actions follow input mode: touch keeps them visible; mouse or
  trackpad reveals them on hover, focus, or an open menu. Sidebar actions also
  show on the current row, and close controls on the selected tab. Before
  input, `any-hover` supplies the default. Add `k2b-progressive-row` and
  `k2b-progressive-action` to your own rows and actions. Custom rest rules need
  the media and attribute pair from [Input mode](/en/ui/input-mode); mode
  changes only opacity, visibility, or pointer-events of reserved boxes.
  Primary-pointer queries and Tailwind hover variants miss a tablet's
  secondary mouse.
- Use `InlineGuidance` for a short local hint, action error, or loading message
  while the affected content remains visible. Use its `loading` prop for inline
  progress rather than assembling a spinner and text.
- Use `Placeholder` for a region that is empty, loading, or failed. Use
  `NotFoundState` for a whole-page dead end or missing resource.
- Use `NoticeCard` for a persistent finding and a toast for short confirmation.
  Use `StatusBadge` for a compact health or lifecycle label.

The application owns feedback copy and recovery actions. Distinguish an empty
result from a failed request, and do not replace field validation or
domain-specific states with a generic `Placeholder`.

### Choose feedback by scope

| Situation | Component |
| --- | --- |
| Invalid field value | The input's validation props |
| Local prerequisite, action error, or inline progress | [InlineGuidance](/en/ui/feedback/blocks) |
| Empty, loading, or failed content region | [`Placeholder`](/en/ui/surfaces/empty-states) |
| Persistent finding that needs emphasis | [NoticeCard](/en/ui/feedback/blocks) |
| Compact health or lifecycle label | [StatusBadge](/en/ui/feedback/badges) |
| Brief confirmation after an action | [Toast](/en/ui/feedback/toast) |

Keep static descriptions and metadata as ordinary text. Button loading belongs
on the button; progress with a known completion percentage belongs in a progress
indicator. Keep retry actions beside the feedback and preserve existing content
when a refresh fails.

## Treat phones as first-class

Design and verify every screen at phone width with touch, in WebKit as well as
Chromium. A phone is a full Cloud client, not a fallback, and Safari and most
iOS browsers run WebKit, so a screen checked only in a desktop Chromium is not
checked.

Use `Layout`, `AppWorkspace`, dialogs, and shared sidebars for responsive
geometry. Content must not depend on pointer hover. Dialogs must fit the
viewport and keep their primary actions reachable.

A phone layout is a composed state, not a squeezed desktop layout. Move
navigation and details into their shared mobile behavior, keep touch targets
usable, and contain table overflow inside the table region. A standalone page
shows its one card flat on phones; see
[Layout and navigation](/en/docs/frontend/layout-and-navigation#show-the-pages-one-card-flat-on-phones).

To verify, run the browser tests in both engines as described in
[Test in Chromium and WebKit](/en/docs/contributing/testing#test-in-chromium-and-webkit),
and check the primary flow at phone width with touch input.

## Preserve keyboard and screen reader access

- Use native buttons for actions and anchors for navigation.
- Give icon-only controls an accessible name.
- Keep a visible focus state.
- Do not use color as the only status signal.
- Associate labels, descriptions, and errors with inputs.
- Keep heading order and landmarks meaningful.
- Return focus when a dialog closes. Shared overlays return it with a ring
  only when the keyboard opened or worked them; see
  [Focus rings](/en/ui/focus#focus-after-an-overlay-closes).
- Announce async changes when they are not otherwise visible.

Use the interaction behavior provided by the component that owns it. For
example, `Panes` owns its resize interaction and `AppWorkspace.NavTree` owns
tree keyboard navigation. `NavTree.Item` only forwards optional native drag
events; an application using them still owns the drag payload, permission
checks, drop behavior, mutation, and an equivalent keyboard path.

`InlineGuidance loading` supplies status, live-region, and busy semantics. Avoid
adding another live region around the same message. A `danger` tone alone does
not announce an error: add `role="alert"` when a newly appearing action error
needs immediate attention. Do not announce every historical error as an alert
when a list renders. Keep field errors associated with their inputs.

On a Cloud page, the OS reduced-motion setting or `data-k2b-motion="reduced"`
on `<html>` makes CSS transitions, animations, and scrolling inside `.k2b-ui`
instant and stops view transitions. Color may still change, movement does
not. A delay that only keeps a fast request from flashing a loading indicator
must keep its wait under reduced motion. Motion that your code drives, such as a smooth `scrollIntoView()` or
`element.animate()`, checks `prefersReducedMotion()` from `@k2b/ui`; see
[Motion](/en/ui/motion).

Do not add `aria-grabbed` as a substitute for keyboard-operable movement and
clear announcements.

## Follow the person's theme

People choose **Light**, **Dark**, or **Automatic**. Automatic is the default
and follows the device's appearance. Cloud sets the `<html>` class to the
resolved `light` or `dark` before the first paint. Browser code reads that
class and observes class changes to follow live updates.

On the server, `readThemeFromCookieHeader()` from `@k2b/cloud/shared` returns
the resolved theme. For Automatic, it is only a best-effort hint: the head
script reports the device's scheme in the `color-scheme` cookie on each page
load and on each change, so the value can be stale when the device switched
while no Cloud page was open, and it is `light` before the first report.
`readThemePreferenceFromCookieHeader()` returns the choice itself: `light`,
`dark`, or `system`. When server-rendered markup depends on the theme, read
the preference: for `system`, render both variants and let the `<html>` class
show one, or decide in the browser. When server work such as rendering a chart
must match exactly, send the `<html>` class with the request. Set `page.theme`
to fix a public display to one theme. Never read `prefers-color-scheme` in
application CSS.

## Verify both themes and interaction modes

Review every changed surface in light and dark mode. Check resting, hover,
focus, active, selected, disabled, loading, empty, and error states.

Use automated accessibility checks as a baseline, then complete the keyboard
flow manually. Test touch behavior when actions use progressive disclosure.
The [Frontend testing](/en/docs/frontend/testing) guide lists the full
verification pass.

## Review a changed screen

Before accepting a component or screen, verify:

- [The layout stays still](#keep-the-layout-still): focus, hover, loading,
  async results, validation, save bars, and badges move or resize nothing.
- [Hover and focus never move, resize, or lift](#respond-to-hover-without-movement)
  an element; they change only paint.
- [Motion uses the shared tokens](#move-with-the-shared-motion-tokens),
  animates no layout property, and is instant under reduced motion.
- Hierarchy works without decorative color or separator lines.
- Lists, settings, forms, details, and pagination use spacing or shared
  surfaces instead of `<hr>`, `divide-y`, or app-owned hairlines.
- [App code draws no lines](#group-content-without-decorative-lines) between
  header, content, and footer, or between workspace regions.
- [App-owned in-flow surfaces take depth](#choose-surfaces-deliberately) from
  the shared surface; app code adds no outer shadow, nested border, or box
  inside a box.
- [The screen is clean and flat](#build-hierarchy-before-decoration): the most
  important value comes first, and data the person does not need is left out.
- The closest shared primitive owns geometry and interaction behavior.
- App identity, action, status, selection, and data colors remain independent.
- App-owned CSS uses semantic host tokens and does not copy a shared component.
- Hover, focus, active, selected, disabled, loading, empty, and error states
  are covered.
- [Every action answers at once](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state)
  with an optimistic update or a pending state on the acted element, and
  offers Undo only where the server can reverse it.
- Progressive disclosure works with pointer, keyboard, and touch.
- Height-constrained dynamic content keeps a stable width as overflow changes.
- Desktop and mobile layouts avoid page-level overflow.
- [Phone width works with touch](#treat-phones-as-first-class) in WebKit and
  Chromium.
- Light and dark modes preserve the same hierarchy.
- Icon-only actions have accessible names and useful focus treatment.
