# Getting started

`@k2b/ui` is a standalone component library for SolidJS. It includes accessible interaction patterns, scoped styles, configurable design tokens, and separate browser and server builds. Use it inside Cloud or in another Solid application.

## License

`@k2b/ui` uses AGPL-3.0-or-later, the same license as Cloud. The npm package
includes the license and the separate notices for IBM Plex and Tabler Icons.

## Install

Add the package to an existing Solid project:

```bash
bun add @k2b/ui
```

`solid-js` and `@k2b/ssr` are peer dependencies. Install them as well when the project does not already provide them.

## Load the styles

Import the complete UI stylesheet once from your application's global CSS
entry point:

```css
@import "@k2b/ui/global.css";
```

The stylesheet only applies below `.k2b-ui`, so it does not reset the surrounding page. Add the class to the application root or to the subtree that renders UI components:

```tsx
import { createSignal } from "solid-js";
import { Button, TextInput } from "@k2b/ui";

export function ProfileForm() {
  const [name, setName] = createSignal("Ada");

  return (
    <main class="k2b-ui">
      <TextInput label="Display name" value={name} onValueChange={setName} />
      <Button>Save profile</Button>
    </main>
  );
}
```

Portalled surfaces such as prompts, menus, and tooltips preserve the scope automatically.

## Fonts and icons

`global.css` includes IBM Plex and the supported Tabler icon font. Applications
that provide their own fonts or icons can load component styles and choose the optional assets:

```ts
import "@k2b/ui/styles.css";
import "@k2b/ui/fonts/plex.css";
import "@k2b/ui/icons/tabler.css";
```

Omit either preset when your application already provides that asset.

A page written in plain HTML instead of Solid components can use the
classless [Base stylesheet](./surfaces/base-stylesheet), `@k2b/ui/base.css`.
It styles the document itself, so load it only into a page that it owns.

The icon preset gives every Tabler icon a fixed width of one em. An icon keeps
that width while the icon font loads, so buttons and text next to it do not
grow or move sideways when the font arrives. Because each icon is its own box,
running text can wrap between an icon and the word next to it, even across a
no-break space, and link underlines and letter spacing skip the icon. To keep an
icon with its label, put both in a flex row with a gap, as buttons do, or inside
running text in an element with `white-space: nowrap`.

The Plex preset references separate WOFF2 files in its adjacent `fonts/`
directory. Keep these assets with the stylesheet when copying it for direct
serving. Their filenames contain a content hash, so they can be cached
independently. CSS bundlers resolve the relative URLs normally.

## Theme the package

Override tokens on your scoped root. Components derive focus, selection, and action colors from the accent stack while retaining accessible light and dark surfaces:

```css
.product-ui {
  --k2b-font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --k2b-accent-50: #f5f3ff;
  --k2b-accent-100: #ede9fe;
  --k2b-accent-200: #ddd6fe;
  --k2b-accent-300: #c4b5fd;
  --k2b-accent-400: #a78bfa;
  --k2b-accent-500: #8b5cf6;
  --k2b-accent-600: #7c3aed;
  --k2b-accent-700: #6d28d9;
  --k2b-accent-800: #5b21b6;
  --k2b-accent-900: #4c1d95;
  --k2b-accent-950: #2e1065;
}
```

```tsx
<main class="k2b-ui product-ui">...</main>
```

Most themes only need the font and accent stack. Override semantic tokens such as `--k2b-action`, `--k2b-surface`, `--k2b-text`, `--k2b-text-secondary`, `--k2b-text-muted`, or `--k2b-border` when a specific role needs different treatment. See [Ink hierarchy](./surfaces/utilities#ink-hierarchy) for text roles and contrast floors, and [Theme and styles](./surfaces/utilities) for other theme roles and overrides.

`--k2b-app-workspace-active` controls selected navigation ink and defaults to
`var(--k2b-action)`. The optional `--k2b-app-workspace-selected` hook fills
selected navigation rows and object chips; `Tabs`, `ViewTabs`,
`SegmentedControl`, and an active `FilterChip` share it. The optional
`--k2b-row-selected` hook fills selected content rows. Both default to
`var(--k2b-selected)`. Cloud maps them to the active app's navigation and row
selection fills. Other control options and pressed states keep
`--k2b-selected`.

## Solid and SSR

Import components directly from `@k2b/ui`. Package conditions select the SSR build on the server and the interactive build in the browser. State remains controlled by your application:

```tsx
import { createSignal } from "solid-js";
import { Tabs } from "@k2b/ui";

export function ProjectSections() {
  const [tab, setTab] = createSignal("overview");

  return (
    <Tabs ariaLabel="Project sections" value={tab} onValueChange={setTab}>
      <Tabs.Item value="overview" label="Overview">Overview content</Tabs.Item>
      <Tabs.Item value="activity" label="Activity">Activity content</Tabs.Item>
    </Tabs>
  );
}
```

Components that change state require browser code: an island, a client component, or a page that a hydrating framework hydrates. A component mounts when it first renders in the browser; Solid's `onMount` runs right after that render. Render the same markup from the same initial values on the server and in the browser. Depending on the host, the browser hydrates the server HTML or replaces it with a new render, so do not rely on state that exists only in the server HTML, such as text typed before mount.

## Set the render locale

Components format numbers and dates in one inherited locale. Wrap the SSR page in `LocaleProvider` and emit the same locale as `<html lang>`:

```tsx
import { LocaleProvider } from "@k2b/ui";

<html lang={locale}>
  <body>
    <main class="k2b-ui">
      <LocaleProvider locale={locale}>{children}</LocaleProvider>
    </main>
  </body>
</html>
```

The provider controls the server pass. Browser islands are independent Solid roots and fall back to `document.documentElement.lang`, so a matching `<html lang>` keeps both passes identical. Without either source the locale is `"en"`. Timezone stays separate: pass it explicitly to date and time components. See the Locale and formatting page for the `Format` components and the exact resolution order.

## Package boundary

Every component in the portable catalog comes from `@k2b/ui`. Product-specific integrations live in a separate section when they depend on authenticated APIs, permissions, sessions, or other host contracts.

## Shared API conventions

Reference types use `JSX.Element` for Solid content and `MaybeAccessor<T>` for
`T | (() => T)`. A prop only accepts an accessor when its type says so; pass
`items={items()}` to plain array props. Optional props use `?`. Omission means
no extra behavior unless a default is stated. Native attributes pass through
only where the component explicitly inherits them.

### Pending states keep the control

While a change saves, keep the same control in the same place and size.
Disable it or mark it loading; never swap it for a badge, text, or placeholder.
Only the changed item shows progress. Keyboard focus stays with the control, or returns
to it when the change ends.

### Shared field props

Input pages use these public types from `@k2b/ui`:

```ts
type MaybeAccessor<T> = T | (() => T);
type FieldProps = {
  id?: string; class?: string;
  label?: JSX.Element; description?: JSX.Element;
  error?: MaybeAccessor<JSX.Element | undefined>;
  required?: boolean; disabled?: boolean;
  "aria-label"?: string; "aria-describedby"?: string;
};
type ValueFieldProps<T> = FieldProps & {
  value: MaybeAccessor<T>;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```

The parent updates `value` and owns validation and persistence. `required`
marks a field; it does not save or validate application data. `error` displays
the supplied message. `label` supplies the visible accessible name; use
`aria-label` for a label-free control. Change/commit timing and the empty value
are component-specific and documented on each input page. Callback omission
does not universally mean disabled or read-only; use the explicit supported prop.

Fields placed side by side in a grid align their controls. When a grid contains
only fields and at least one of them has a description, every field subgrids
its label, description, control, and error rows, so a longer description in one
column does not push that column's control down. Keep paired fields direct
children of the same grid; a wrapper, button, or other sibling in the grid
returns the fields to their stacked layout, as do flex rows and fill fields.
A parent that is not a grid, such as a form dialog body or a flex column, keeps
every field, including a multi-line one, at its stacked height.

### Icons, tones and navigation

Most `icon` props take a complete Tabler class, such as `"ti ti-search"`.
[Documentation components](/en/ui/content/docs) and
[Combobox](/en/ui/input/combobox) document their bare-name exceptions.
`IntentTone` is `"neutral" | "info" | "success" | "warning" | "danger"`;
`AccentColor` is `"zinc" | "blue" | "emerald" | "amber" | "red"`.
A component may expose a different explicit union, such as Calendar colors or
StatusBadge tones; those local types take precedence.

URL controls retain native `href` links. Their optional `onNavigate` callback
uses the [`@k2b/ssr` navigation contract](/en/docs/frontend/url-state-and-navigation).
The host loads and renders the destination; passing a callback alone does not
fetch data. See each component for scroll policy and other navigation callbacks.

### Progressive actions in your own rows

Components with row actions, such as `AppWorkspace` sidebar rows,
`DetailPanel`, `Discussion`, `DescriptionList`, and closable `Tabs`, decide
on their own when the actions show. For a row, card, or list item of your own,
add `k2b-progressive-row` to the item and `k2b-progressive-action` to each
optional action or its wrapper:

```tsx
<li class="k2b-progressive-row flex items-center gap-2">
  <a href={member.href}>{member.name}</a>
  <IconButton class="k2b-progressive-action" label={`Remove ${member.name}`} onClick={remove}>
    <i class="ti ti-x" aria-hidden="true" />
  </IconButton>
</li>
```

Touch input keeps actions visible. Mouse or trackpad input hides them until
the row is hovered, focused, or has an open menu; shared components also keep
current-row actions visible where supported. Before input, `any-hover`
supplies the default: hovering pointers hide actions at rest, touch-only
screens show them. Only opacity changes, so nothing moves. Do not nest
progressive rows. See [Input mode](/en/ui/input-mode) to start the controller
and write custom rules. Primary-pointer queries and Tailwind's `hover:` or
`group-hover:` variants miss a tablet's secondary mouse.

## Choose a control

Choose a component from the interaction it needs to support:

1. Use `Button`, `Dropdown`, or `ContextMenu` for actions and links.
2. Use `Select` or `SelectChip` for one controlled value.
3. Use `MultiSelectInput` for a controlled value list.
4. Use `FilterChip` only for filters, not for persisted record fields.
5. Use `Combobox` when choosing a result immediately performs an action and clears the query.

Do not mechanically replace every native menu button with the general `Button`
component. Declarative `Dropdown` items own menu alignment and keyboard
semantics; selection components own field state and selected-option semantics.
Dropdown menus size to their entries. When one must have an exact width, pass
a CSS length such as `width="16rem"`, not a utility class such as `w-64`.

Dropdown menus are declarative action surfaces. They do not accept arbitrary
interactive content. Use a dialog for composite workflows and a selection
component for controlled values.
