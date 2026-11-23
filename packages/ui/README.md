# @k2b/ui

Over 100 SolidJS components and growing, for forms, content, and application
layouts. Includes scoped, precompiled CSS, configurable design tokens, and
separate browser and server builds.

[Documentation and live examples](https://cloud.k2b.dev/en/ui)

## Installation

In an existing SolidJS project:

```bash
bun add @k2b/ui 'solid-js@^1.9.10' '@k2b/ssr@^0.12.0'
```

`solid-js` and `@k2b/ssr` are required peer dependencies. Use your application's
existing Solid setup.

## Quick Start

Import the stylesheet once and wrap your components in `.k2b-ui`:

```tsx
import { createSignal } from "solid-js";
import { Button, TextInput } from "@k2b/ui";
import "@k2b/ui/global.css";

export default function App() {
  const [name, setName] = createSignal("");
  const [savedName, setSavedName] = createSignal("");

  return (
    <form
      class="k2b-ui"
      onSubmit={(event) => {
        event.preventDefault();
        setSavedName(name().trim());
      }}
    >
      <TextInput label="Project name" value={name} onValueChange={setName} required />
      <Button type="submit" variant="primary" disabled={!name().trim()}>
        Save
      </Button>
      <p role="status">{savedName() && `Saved: ${savedName()}`}</p>
    </form>
  );
}
```

Value fields share `label`, `description`, `error`, `required`, and `disabled`
props. Use `value` and `onValueChange` for controlled edits; `onValueCommit`
reports a completed edit, such as leaving a text field or confirming a picker.
See the [TextInput guide](https://cloud.k2b.dev/en/ui/input/text) for details.

## Components

| Area | Examples |
| --- | --- |
| Actions | Buttons, menus, tabs, toolbars |
| Inputs | Text fields, selectors, date pickers, file inputs |
| Layout | Panels, settings, split panes, floating windows, TableOfContents, watchAppHostWidth |
| Surfaces | Cards, avatars, badges, empty states |
| Feedback | Dialogs, prompts, tooltips, toasts, screen-reader announcements |
| Content | Tables, charts, calendars, Markdown, file previews, MapView, Kbd, LabelChip, Steps, message rows, ReactionBar |
| Chat | Timeline, messages, composer, context usage |
| Widgets | Dashboard summaries, lists, statistics |
| Formatting | Numbers, currencies, dates, durations |

Browse the [component catalog](https://cloud.k2b.dev/en/ui) for APIs and
interactive examples.

## Styling

`global.css` includes component styles, IBM Plex fonts, and Tabler icons.
To choose the assets yourself, replace it with these individual imports:

```ts
import "@k2b/ui/styles.css";
import "@k2b/ui/fonts/plex.css";   // Optional font preset
import "@k2b/ui/icons/tabler.css"; // Icon preset used by built-in controls
```

Styles stay inside `.k2b-ui` without resetting the page's global styles.
Customize fonts and colors through CSS variables on that scope. For dark mode,
set `data-theme="dark"` on the scope.

See [Theme and styles](https://cloud.k2b.dev/en/ui/surfaces/utilities) for
configuration and accessible color choices.

For a page written in plain HTML, `@k2b/ui/base.css` is a classless
stylesheet with the same tokens: semantic elements look like the components in
light and dark, without classes or JavaScript. See the
[Base stylesheet](https://cloud.k2b.dev/en/ui/surfaces/base-stylesheet) guide.

## v2 (provisional)

`@k2b/ui/v2` is the next generation of the library, built beside v1. It is
**provisional until the maintainer approves it**: names, props, and styles may
change in any release until then.

```ts
import "@k2b/ui/v2.css";
import { typeRoles } from "@k2b/ui/v2";
```

- Styles stay inside `.k2-ui`, with classes named `k2-*` and custom
  properties named `--k2-*`. A page can load `styles.css` (v1, `.k2b-ui`) and
  `v2.css` side by side.
- Text uses four roles: meta 12/16, row 13/20, body 14/20, and lead 18/24,
  with the weights 400, 500, and 600.
- There is one hairline. Radii belong to controls, marks, and overlays;
  structure is square.
- Text starts 20 px from the column edge (16 px below 768 px), or 24 px
  further in after an icon.
- For dark mode, put `.k2-ui` inside `.dark`, or add `.dark` or
  `data-theme="dark"` to the scope. A scope with `data-theme="light"` stays
  light inside a dark page.

Primitives own spacing, lines, and type. They take no `class`, `style`,
`size`, or `gap`, and an application adds no layout CSS of its own; free
drawing belongs in `Canvas`. See
[UI v2 rules](https://cloud.k2b.dev/en/ui/v2/rules).

What a list has open belongs in the address. Render `Pane detail` only while
the address names an entry, and give its `back` an `href` to the list without
that entry, so reload, back, and forward show the same page. On the phone the
detail is the page and `back` its way to the list. A detail that closes in
place returns the focus to the row that opened it.

## Documentation

- [Getting started and SSR setup](https://cloud.k2b.dev/en/ui/getting-started)
- [Component reference and live examples](https://cloud.k2b.dev/en/ui)
- [Locale, formatting, and SSR consistency](https://cloud.k2b.dev/en/ui/content/intl)

## Background

Originally developed as the component library for `@k2b/cloud`, `@k2b/ui` is
now an independent, application-agnostic SolidJS library. It has no dependency
on Cloud services, routes, or application state.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).

Bundled IBM Plex fonts use the SIL Open Font License; Tabler Icons and the
emoji names and keywords from Emojibase use the MIT license. Their complete
notices ship in `dist/licenses`.
