# Colors and selection

These are the color style guidelines for `@k2b/ui` and for the apps that use
it. They say when color carries meaning, which states use the selection color
(in a Cloud app, the app color), what stays platform blue, and what stays
neutral.

The look stays clean and flat. Type, space, and order make the hierarchy.
Color goes only where it means something.

## Use color with meaning

- **Color comes from content.** Tags, status, places, and stock carry color.
  A Kanban card may take the color of its tag.
- **Color is never the only signal.** A name, an icon, a count, or an
  underline always goes with it.
- **Surfaces stay neutral.** Menus, popovers, dialogs, sheets, the chat
  composer, the model card, and cards without meaning get no tinted
  background.
- **One selection rule.** On a white surface a selection is tinted. On a
  colored surface it is white. Only the one main action of a view is fully
  filled, so two accent fills never sit side by side.
- **No fake depth.** No paper, stone, grooves, or decorative shadows. A
  surface is flat; depth comes from inset space and the shared surface roles.

## Contrast

Text uses strong contrast: darker secondary text, stronger level steps,
slightly larger secondary sizes, and tighter titles. The exact roles, sizes,
and contrast floors are in [Ink hierarchy](/en/ui/surfaces/utilities#ink-hierarchy).

Keep the current container and its destinations easy to distinguish from
other selectable containers: use strong ink for the current container and
the readable muted text tone for the others' names and icons. Preserve status
colors and active destination fills. Do not fade an entire navigation subtree
or make another container look disabled. [Navigation's optional context
marker](/en/ui/layout/navigation#container-context) expresses this without
changing callers that omit it.

Content weight also carries meaning. In a mail list, read senders and subjects
use regular weight; unread rows add semibold type and the unread marker.
Selection keeps its fill independently of unread emphasis.

## Selection color

Selection marks where the person is or what they picked. Three optional host
hooks carry it:

- `--k2b-app-workspace-selected` fills selected navigation and the selection
  controls below. It defaults to `var(--k2b-selected)`.
- `--k2b-app-workspace-active` is the ink on that fill. It defaults to
  `var(--k2b-action)`.
- `--k2b-row-selected` fills selected content rows. It defaults to
  `var(--k2b-selected)`.

Without a host value, selection keeps the platform selection color. A host
sets the hooks on its own scope to give selection its color. Cloud maps them
to the active app's color, so in a Cloud app the selected row, the selected
navigation row, and the selected view carry the app color, not gray and not
platform blue.

Selection changes the fill and the ink. Padding and border width stay the
same, so nothing moves when a row or option is selected. Only a selected
sidebar row also turns semibold; its label reserves that width in advance.

### Navigation fill

| State | Primitive | Class |
| --- | --- | --- |
| Selected sidebar row, object chip, or sidebar icon action | `AppWorkspace.SidebarItem` | `k2b-app-workspace` |
| Selected navigation row | `Navigation` | `k2b-navigation` |
| Selected settings category | `SettingsModal` | `k2b-settings` |

### Selected tabs, segments, and filters

A selected tab, view tab, or segment and an active filter chip are selection
states, in the same family as the selected navigation row. They mark where
the person is or what they picked, so they share the navigation fill and its
ink. This is a decision of 19 October 2026; the shell designs approved on
17 October 2026 show exactly this.

| State | Primitive | Class |
| --- | --- | --- |
| Selected tab | `Tabs` | `k2b-tabs` |
| Current view | `ViewTabs` | `k2b-view-tabs` |
| Selected segment | `SegmentedControl` | `k2b-segmented-control` |
| Active filter | `FilterChip`, `FilterToggle` | `k2b-filter-chip` |

Do not draw a chosen view, range, or filter as a filled primary button such
as `variant={chosen ? "primary" : "secondary"}`. That makes a choice look like
the main action.

### Row fill

| State | Primitive | Class |
| --- | --- | --- |
| Selected table row | `DataTable` | `k2b-data-table` |
| Selected file tile or list row | `FileGrid` | `k2b-file-grid` |
| Selected file tree row | `FileTree` | `k2b-content-file-tree` |

## Controls stay platform blue

Controls say what a person can do or what a field holds, not where they are.
They keep the platform colors `--k2b-action`, `--k2b-action-solid`, and
`--k2b-selected` by default. The selection hooks never change these controls:
buttons, inputs, checkboxes, radios, switches, and every focus ring
(`--k2b-focus-ring`), plus keyboard-active options, pressed toolbar buttons,
and checked cards.

| State | Primitive | Class |
| --- | --- | --- |
| Primary button, the one main action | `Button` | `k2b-button` |
| Checked checkbox | `Checkbox` | `k2b-check` |
| Switch that is on | `Switch` | `k2b-switch` |
| Checked card | `CheckboxCard` | `k2b-checkbox-card` |
| Keyboard-active or selected option | `Select`, `Combobox`, `MultiSelectInput` | `k2b-choice-option` |
| Checked choice chip in a field or picker filter | `ChoiceChips`, `Select` | `k2b-choice-groups` |
| Chosen tile with a preview | `ChoiceTiles` | `k2b-choice-tiles` |
| Keyboard-active suggestion | `AutocompleteEditor` | `k2b-autocomplete` |
| Current page | `Pagination` | `k2b-pagination` |
| Selected date, month, or duration | `DatePicker` | `k2b-date-grid`, `k2b-date-months`, `k2b-date-durations` |
| Selected range | `RangePicker` | `k2b-range-picker` |
| Selected tone or emoji group | `EmojiPicker` | `k2b-emoji-picker` |
| Pressed toolbar button | `Toolbar` | `k2b-toolbar` |
| Pressed formatting tool | `MarkdownEditor` | `k2b-markdown-editor` |

An application's main action may deliberately use its app accent through
`--k2b-action-solid` and `--k2b-action-solid-hover`, scoped to that action.
Mail's approved Compose and Send actions use this exception. In this repository,
each exception has an exact entry in `scripts/checks/selection-tokens.ts`.
Other controls, focus rings, status colors, and tag colors retain their roles;
this does not change navigation or content-row selection tokens.

### Drop targets

Drop targets and other control states keep the platform fill.

| State | Primitive | Class |
| --- | --- | --- |
| File over a dropzone | `FileDropzone` | `k2b-dropzone` |
| Item over a drop target | `DropTarget` | `k2b-drop-target` |
| Files over a page or region | `FileDropTarget` | `k2b-file-drop` |
| Item over a folder | `FileTree` | `k2b-content-file-tree` |
| Event over a day while it moves | `Calendar` | `k2b-calendar-month` |

### Links

Link text in content stays body ink. Its underline, and the arrow of a web
link, use `--k2b-link-accent`, which defaults to `var(--k2b-action)`. It is a
separate host hook; the selection hooks do not change it. Cloud maps it to the
app ink, as described in [Markdown](/en/ui/content/markdown#links-and-references).

## Status stays green, yellow, and red

Status uses the shared intent tones `info`, `success`, `warning`, and
`danger`. Status color never marks an app, and an app color never marks a
status. A red app must not make normal navigation look destructive. See
[Badges](/en/ui/feedback/badges).

## Icon tiles

App, file-type, and model icons sit in a soft chip of their color:
`k2b-icon-tile` takes its fill from the glyph color. Status icons and avatars
do not use it. Folder icons and the icons of object rows, overview headers, and
panel dialogs take the selection ink `--k2b-app-workspace-active`, so in a
Cloud app they carry the app color. Sizes, fill shares, and states are in
[Icon tile](/en/ui/surfaces/utilities#icon-tile).

## One color per person

A person has one color wherever they appear: the tint behind their avatar
initials, their cursor in a shared text, and the passages they comment on.
`personColor(name)` returns it from the display name, and `Avatar` uses the
same palette (`PERSON_COLORS`), so build person colors from it instead of a
second palette. The palette has no cyan, which means AI, and no yellow, which
reads as a text highlight. Two people can share a color, so the name always
appears next to it.

## App color in Cloud

A Cloud app declares one six-digit `accent`. Cloud derives the app ink and
both selection fills from it, for light and dark mode. The app ink keeps at
least 4.5:1 contrast (WCAG AA) on its own fills and on the shared surfaces. A
light accent, such as yellow `#eab308`, is darkened only as far as needed. Any
six-digit accent works. See
[Define an application](/en/docs/build/define-app#set-the-application-appearance) and
[Styling and accessibility](/en/docs/frontend/styling-and-accessibility#keep-color-roles-independent).

## Import

```css
@import "@k2b/ui/global.css";
```

The hooks are CSS custom properties on a `.k2b-ui` scope. Nothing else needs
importing.

## Accessibility

- Selected ink on the selection fill keeps at least 4.5:1 contrast, and so do
  descriptions and counts on a selected navigation row.
- Color is never the only signal. A filter chip names its value, a status
  badge has a label, and a link has an underline.
- Selection keeps its semantics: `aria-current`, `aria-selected`,
  `aria-checked`, or `aria-pressed` say what is selected, not the fill.
- Keyboard focus keeps the platform focus ring on every control, also on a
  selected one.
- In forced-color mode, where fills disappear, the selected tab, view tab,
  and segment are underlined.

## Runtime

The colors are plain CSS. They work in the server response, need no browser
code, and follow the light and dark theme of the `.k2b-ui` scope.

## Example

Set the hooks for light and dark mode on an element inside the `.k2b-ui`
scope, so selected text stays readable in both themes:

```css
.teal-app {
  --k2b-app-workspace-selected: #e8f8f6;
  --k2b-app-workspace-active: #0d7b6f;
  --k2b-row-selected: #effaf9;
}

.k2b-ui[data-theme="dark"] .teal-app,
.k2b-ui.k2b-dark .teal-app,
.dark .k2b-ui .teal-app {
  --k2b-app-workspace-selected: #123133;
  --k2b-app-workspace-active: #14b8a6;
  --k2b-row-selected: #112c2e;
}
```

```tsx
import { Button, FilterToggle, ViewTabs } from "@k2b/ui";

<div class="teal-app">
  <ViewTabs
    label="Views"
    current="board"
    items={[
      { id: "board", label: "Board", href: "?view=board" },
      { id: "list", label: "List", href: "?view=list" },
    ]}
  />
  <FilterToggle label="Only mine" icon="ti ti-user" active href="?mine=0" />
  <Button>Create task</Button>
</div>
```
