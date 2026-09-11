# Theme and styles

`@k2b/ui` ships precompiled component CSS without a page-global reset. Every selector is scoped below `.k2b-ui`, so the package can be embedded in an existing SSR application. Its small scoped normalization lives in the CSS `base` layer, allowing consumer utilities to override native control typography and sizing normally.

## Use theme and styles

Load the stylesheet once and wrap the part of the page that renders package components. Nested applications can override tokens on their own `.k2b-ui` scope without changing the surrounding page.

The scope establishes body text at `0.9375rem` (15px with the browser's
default root size) and weight `400`. Components override that baseline only
when their role needs a different type scale. The package never styles the
document's global `body`.

## Import

```css
@import "@k2b/ui/global.css";
```

For applications with their own fonts or icons, the same layers remain
available separately:

```ts
import "@k2b/ui/styles.css";
import "@k2b/ui/fonts/plex.css";
import "@k2b/ui/icons/tabler.css";
```

## Theme tokens

Override fonts through `--k2b-font-sans`, `--k2b-font-condensed`, and `--k2b-font-mono`.

Accent, neutral, success, warning, and danger stacks are CSS variables. Semantic aliases such as `--k2b-action`, `--k2b-surface`, `--k2b-text`, and `--k2b-border` derive from those stacks.

Input placeholders use `--k2b-placeholder-color`, independently of helper text.
The default is neutral-500 in light mode and a mix of 70% neutral-400 with
30% neutral-500 in dark mode. Native inputs, selection controls, and editor
placeholders share this color without additional placeholder opacity. Override
the token on your `.k2b-ui` scope to adjust them together.

The default dark theme uses a cool ink hierarchy for canvas, content,
navigation, elevated surfaces, borders, and hover states. These semantic dark
surface roles are purpose-built rather than direct neutral-stack aliases. When
customizing them, override the complete surface hierarchy together so nested
layouts and floating UI keep their intended depth.

Override a complete stack when its semantic aliases use several steps for hover, focus, selected, light, and dark states. Changing custom properties at runtime updates the scoped components immediately; the package does not maintain a separate theme store.

AI presentation has a separate semantic theme:
`--k2b-ai-accent`, `--k2b-ai-accent-hover`, `--k2b-ai-border`,
and `--k2b-ai-surface`. Override these roles when the assistant identity should
differ from the general application accent.

Component APIs use the shared `IntentTone` vocabulary (`neutral`, `info`, `success`, `warning`, `danger`) when they describe user-facing intent, and `AccentColor` (`zinc`, `blue`, `emerald`, `amber`, `red`) for data presentation. Operational states such as `running`, `degraded`, and `error` remain a separate status vocabulary.

Use `data-theme="dark"` or `k2b-dark` on the scope, or place it inside a host `.dark` element.

## Accessibility

Keep contrast between semantic text and surfaces when overriding color stacks. Focus, danger, success, and warning treatments must remain distinguishable without relying on hue alone.

Do not remove component focus treatments or reduced-motion behavior.

## Runtime

The styles need no JavaScript. Theme variables work in the initial server response and do not read Cloud state or browser storage. An application may still update those variables from an island when it offers an interactive theme picker.

## Example

```tsx
import { Button } from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";

const violetAccent = {
  "--k2b-accent-50": "#f5f3ff",
  "--k2b-accent-100": "#ede9fe",
  "--k2b-accent-200": "#ddd6fe",
  "--k2b-accent-300": "#c4b5fd",
  "--k2b-accent-400": "#a78bfa",
  "--k2b-accent-500": "#8b5cf6",
  "--k2b-accent-600": "#7c3aed",
  "--k2b-accent-700": "#6d28d9",
  "--k2b-accent-800": "#5b21b6",
  "--k2b-accent-900": "#4c1d95",
  "--k2b-accent-950": "#2e1065",
} as JSX.CSSProperties;

const [violet, setViolet] = createSignal(false);

<main class="k2b-ui" style={violet() ? violetAccent : undefined}>
  <Button
    aria-pressed={violet()}
    onClick={() => setViolet((value) => !value)}
  >
    Switch accent
  </Button>
  <Application />
</main>
```
