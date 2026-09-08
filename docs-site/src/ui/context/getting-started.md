# Getting started

`@k2b/ui` is a standalone, production-ready component library for SolidJS. It includes accessible interaction patterns, scoped styles, configurable design tokens, and separate browser and server builds. Use it inside Cloud or in another Solid application.

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
that provide their own fonts or icons can import only the required layers:

```ts
import "@k2b/ui/fonts/plex.css";
import "@k2b/ui/icons/tabler.css";
```

Omit either preset when your application already provides that asset.

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

Most themes only need the font and accent stack. Override semantic tokens such as `--k2b-action`, `--k2b-surface`, `--k2b-text`, or `--k2b-border` when a specific role needs different treatment. See [Theme and styles](./surfaces/utilities) for the complete token reference.

## Solid and SSR

Import components directly from `@k2b/ui`. Package conditions select the SSR build on the server and the interactive build in the browser. State remains controlled by your application and continues seamlessly during hydration:

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

## Set the render locale

Components format numbers and dates in one inherited locale. Wrap the SSR page in `LocaleProvider` and emit the same locale as `<html lang>`:

```tsx
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

## Migrate by behavior

Classify an existing control before replacing its markup:

1. Use `Button`, `Dropdown`, or `ContextMenu` for actions and links.
2. Use `Select` or `SelectChip` for one controlled value.
3. Use `MultiSelectInput` for a controlled value list.
4. Use `FilterChip` only for filters, not for persisted record fields.
5. Use `Combobox` when choosing a result immediately performs an action and clears the query.

Do not mechanically replace every native menu button with the general `Button`
component. Declarative `Dropdown` items own menu alignment and keyboard
semantics; selection components own field state and selected-option semantics.
When a dropdown needs a fixed width, pass a CSS length such as `width="16rem"`,
not a utility class such as `w-64`.

Dropdown menus are declarative action surfaces. They do not accept arbitrary
interactive content. Use a dialog for composite workflows and a selection
component for controlled values.
