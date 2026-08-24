# @k2b/ui

`@k2b/ui` is a standalone, production-ready component library for SolidJS. It
uses accessible interaction patterns, scoped precompiled styles, configurable
design tokens, and separate browser and server builds. Use it inside Cloud or
in another Solid application.

```css
@import "@k2b/ui/global.css";
```

Or load only the component styles when the application provides its own fonts
and icons:

```ts
import "@k2b/ui/styles.css";
import { Button, DatePicker, StatusBadge, prompts } from "@k2b/ui";
```

Wrap the rendered application in the UI scope:

```tsx
<main class="k2b-ui">
  <Placeholder title="Nothing here yet" />
</main>
```

The scope uses `0.9375rem` body text at weight `400` without changing the
document's global `body`.

Fonts and theme stacks are CSS variables and can be replaced without
JavaScript:

```css
.k2b-ui {
  --k2b-font-sans: Inter, sans-serif;
  --k2b-accent-50: #f5f3ff;
  --k2b-accent-100: #ede9fe;
  --k2b-accent-300: #c4b5fd;
  --k2b-accent-400: #a78bfa;
  --k2b-accent-500: #8b5cf6;
  --k2b-accent-600: #7c3aed;
  --k2b-accent-700: #6d28d9;
  --k2b-accent-950: #2e1065;
}
```

`--k2b-action` is the accessible foreground color for links and text actions.
`--k2b-action-solid` is the background color for filled controls; override both
with matching hover tokens when defining a custom theme.

AI surfaces can use a distinct semantic treatment without changing the general
application accent:

```css
.k2b-ui {
  --k2b-ai-accent: #0891b2;
  --k2b-ai-accent-hover: #0e7490;
  --k2b-ai-border: #06b6d4;
  --k2b-ai-surface: #ecfeff;
}
```

IBM Plex is an optional preset:

```ts
import "@k2b/ui/fonts/plex.css";
```

Tabler's webfont is the supported icon preset:

```ts
import "@k2b/ui/icons/tabler.css";
```

## Component tranches

The public package surface only exposes components that have passed the
standalone SSR, behavior, styling, and migration checks:

- Actions: buttons, menus, context menus, filter/select chips, spotlight
  search, copy, remove, segmented controls, controlled tabs, native
  disclosures, and semantic toolbars
- Inputs: text, number, checkbox and switch controls; select, combobox,
  multi-select, freeform tags, managed tag editing, icons, PIN, slider, color,
  and date/time pickers;
  dropzones, image selection/cropping, completion-aware plain text,
  Markdown, and template editors
- Layout: `AppOverview`, `DataPanel`, `PanelHeader`, `PanelDialog`,
  `SettingsModal`, `AppWorkspace`, `Panes`, `FloatingWindow`, and generic
  settings-form helpers
- Surfaces: `Paper`, `Avatar`, `LinkCard`, `StatGrid`, `StatCell`, `StatusBadge`,
  `ProgressBar`, `NoticeCard` (with `NoticeCard.Grid`), `Tag`,
  `DescriptionList`, `Placeholder`, and `NotFoundState`
- Feedback: the complete scoped prompt family, `Tooltip`, and scoped `toast`
- AI: the controlled compound `Chat` surface with timeline, messages,
  activity, composer, and compact context usage
- Content: data and log tables, charts and interactive state timelines,
  calendars, file trees/browsers/previews, lightboxes, PDF previews,
  documentation primitives, pagination, range navigation, code and Markdown
  views, and structured-data previews
- Widgets: `Widget`, `WidgetHero`, `WidgetList`, `WidgetPills`,
  `WidgetStat`, and `WidgetStatus`
- Intl: `LocaleProvider`, `useLocale`, and the unstyled `Format` namespace
  (`Number`, `Percent`, `Currency`, `Bytes`, `Date`, `Time`, `DateTime`,
  `RelativeTime`, `Duration`, `DurationMs`)

`MarkdownView` renders escaped Markdown by default. Pre-rendered HTML requires
the explicit `trustedHtml` prop and stays an application-owned trust boundary.
Authoring previews may pass an exact `inlineTokens` allowlist to emphasize
standalone placeholders during safe Markdown parsing.

## Field contract

Form controls share one controlled contract. The same prop always has the same
meaning:

- `id`, `class`, `label`, `description`, `error`, `required`, and `disabled`
  describe the field around the control.
- Use a visible `label` whenever possible. If the surrounding UI already
  provides the label, use the native `"aria-label"` or `"aria-describedby"`
  props. A placeholder is never an accessible label.
- `value` accepts either a direct value or a Solid accessor.
- `onValueChange` reports every controlled edit.
- `onValueCommit` reports the value when the user finishes the edit: on blur
  or Enter for text-like controls, and on an explicit selection or Apply action
  for pickers.

```tsx
const [name, setName] = createSignal("");
const [date, setDate] = createSignal<string | null>(null);

<TextInput
  label="Project name"
  value={name}
  onValueChange={setName}
  onValueCommit={saveName}
/>
<DatePicker
  label="Release date"
  value={date}
  onValueChange={setDate}
  onValueCommit={saveReleaseDate}
/>
```

Select, date, combobox, tags, and text controls use the same field metadata,
ARIA wiring, disabled and invalid states, and stable one-border focus shell.
Control-specific props only describe genuinely different behavior. For
example, `Combobox` owns a transient search `query` and hands the selected
domain object to `onSelect`; `FileDropzone` and `ImageCropper` are action/editor
primitives rather than value fields.

The package does not read Cloud routes, services, permissions, or application
state. Product-specific composition stays with the consuming application.
`Avatar` is therefore an additive portable presentation adapter. It does not
migrate Cloud's routed `./misc/Avatar` source contract, which remains
Cloud-specific.

Composition components intentionally use semantic data instead of application
stores:

```tsx
<Widget title="Platform health" icon="ti ti-heartbeat">
  <WidgetStatus title="Operational" tone="success" />
  <WidgetPills pills={[{ label: "Checks", value: 48, tone: "emerald" }]} />
</Widget>
```

Portable presentation components use shared semantic vocabularies:
`IntentTone` (`neutral`, `info`, `success`, `warning`, `danger`) and
`AccentColor` (`zinc`, `blue`, `emerald`, `amber`, `red`). Specialized state
components such as `StatusBadge` keep a smaller domain-specific vocabulary
where the states carry meaning beyond color.

## Locale and formatting

Locale-aware components resolve their locale in one order: an explicit
component `locale` prop, the nearest `LocaleProvider`, the browser's
`document.documentElement.lang`, then `"en"`. The package never reads
`navigator.language` and holds no global locale state, so one server can
render different locales concurrently.

```tsx
import { Format, LocaleProvider } from "@k2b/ui";

<html lang={locale}>
  {/* ... */}
  <LocaleProvider locale={locale}>
    <Format.Currency value={1999.5} currency="EUR" />
    <Format.DateTime value={order.createdAt} timeZone="Europe/Berlin" />
  </LocaleProvider>
</html>;
```

The server-side provider controls SSR output. A browser island rendered with
`@k2b/ssr` is an independent Solid root: an outer server provider does not
survive the island's browser re-render, which falls back to `<html lang>`.
Emit `<html lang>` equal to the provider locale to keep both passes identical.
Changing the language without a reload is out of scope.

`Format` components are unstyled and semantic: numeric components render a
`<span>`, temporal components render `<time>` with a canonical `datetime`
attribute. `Format.Percent` takes a ratio (`0.12` → `12%`), `Format.Currency`
requires an ISO 4217 code, and `Format.Date`/`Time`/`DateTime` format in UTC
unless an explicit `timeZone` is passed, so server and browser text cannot
drift with the runtime timezone. Null and invalid input renders a `"—"`
fallback (override with `fallback`).

`NumberInput` derives its decimal separator from the effective locale while
keeping the controlled value a canonical number; `DatePicker` and `Calendar`
prefer an explicit `dateConfig.locale` and inherit the render locale
otherwise. Timezone is never part of the locale context.

## Catalog groups

The source tree and component documentation use the same groups as the Cloud
UI showcase: AI, Inputs, Actions, Layout, Surfaces, Feedback, Content, and
Widgets. Cloud-specific integrations are intentionally not part of this
package.

The chat family accepts portable data and callbacks. Applications keep their
protocol, persistence, tool rendering, approvals, and file storage:

```tsx
const [draft, setDraft] = createSignal("");

<Chat>
  <Chat.Timeline
    items={items()}
    hasMore={hasMore()}
    onLoadOlder={loadOlder}
  />
  <Chat.Composer
    value={draft()}
    onValueChange={setDraft}
    onSubmit={sendMessage}
    state={runState()}
    models={models}
    selectedModelId={modelId()}
    onModelChange={setModelId}
    contextUsage={{ usage: usage(), contextWindow: 128_000 }}
  />
</Chat>;
```

Return `false` or throw from `onSubmit` to restore the controlled draft and
attachments. A synchronous throw and a rejected promise are treated identically,
and the failure is handed to
`onError` for user-facing reporting. Raw selected files are handed to
`fileSelection.onSelect`; storage and upload policy remain application-owned.
`Chat.Timeline` requests older items through `hasMore`/`onLoadOlder` and keeps
the reader's position once they are prepended.

`Panes` is a controlled, serializable layout for IDE-like workspaces. The
package owns tabs, nested splits, resize and drag-and-drop; applications own
pane content, open and close behavior, routing, and persistence:

```tsx
const [layout, setLayout] = createSignal(createPanesLayout(["result", "query"]));
const items: PanesItem[] = [
  {
    id: "result",
    title: "Result",
    icon: "ti ti-table",
    render: () => <ResultView />,
    onClose: () => setLayout((current) => removePanesItem(current, "result")),
  },
  {
    id: "query",
    title: "Query",
    icon: "ti ti-code",
    render: () => <QueryEditor />,
  },
];

<Panes layout={layout()} onLayoutChange={setLayout} items={items} />;
```

Persist only `PanesLayout`, never the runtime item descriptors containing
render functions. Validate stored input with `parsePanesLayout`; invalid or
unsupported values require an explicit application fallback. Panes invokes an
item's `render` function only while that item is active in its tab group.
Tab rows remain one line and scroll horizontally when needed. Dragging exposes
separate tab-insertion, group, and directional split targets while the pointer
preview retains the source tab's compact pill treatment.

Cloud applications import portable components directly from `@k2b/ui`.
Product-owned behavior such as permissions, account routes, stored AI
protocols, and workflow contracts stays behind focused Cloud package exports;
there is no generic Cloud UI compatibility layer.

The Fibel component showcase is the canonical acceptance consumer. Its
portable pages import `@k2b/ui` directly, while Cloud API integrations remain
in a visibly separate section. Together with `packages/ui/fixture`, it
exercises the package boundary and public API ergonomics outside the Cloud
shell. The fixture provides automated server-render and shipped-class checks;
the catalog owns representative browser interaction, theme, responsive, and
accessibility states.

## Verification

```bash
bun run typecheck          # package sources
bun run test               # builds the stylesheet first, then runs every suite
bun run build              # dist/styles.css and the optional font/icon presets
bun run fixture:typecheck  # standalone consumer fixture
bun run fixture:build      # standalone SSR build, no Cloud CSS or runtime
```

The JavaScript build preserves per-component ESM modules for browser and SSR
conditions. Bundlers can therefore tree-shake unused component families instead
of retaining the complete package through the root export.

Do not use bare `bun test` as the package verification command: several guards
compare rendered markup with `dist/styles.css`. The fixture render guard rejects
a missing or stale stylesheet so this mistake fails loudly, but `bun run test`
is the supported one-step command.

Three contracts are enforced by tests rather than convention, because each one
regressed silently during the extraction:

- `src/styles/class-contract.test.ts` — the package renders no class its own
  stylesheet cannot style, renders only `k2b-`-prefixed names, and claims no
  unprefixed name inside the `.k2b-ui` scope. `styles/entry.css` imports the six
  scoped source sheets; Tailwind `@reference` directives live in source sheets
  such as `index.css` and `content-parity.css` and emit no generic utilities, so
  a leftover utility class in markup styles nothing.
- `src/styles/focus-contract.test.ts` — at most one focus signal per selector
  and cascade context, box-shadow-only focus rings have a forced-colors outline
  fallback, and AI tokens stay inside AI surfaces.
- Per-group single-ownership tests — a selector may be declared in only one
  stylesheet. Two partial declarations of the same selector merge into a third
  geometry matching neither Cloud nor either source.
