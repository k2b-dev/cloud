# Spotlight search

`SpotlightButton` launches the portable search prompt with a consistent accessible name across navigation contexts.

## Use Spotlight search

Use it for a global or scoped entity search that should open from several navigation surfaces.

## Import

```tsx
import { openSpotlightSearch, SpotlightButton } from "@k2b/ui";
```

## Example

```tsx
const openSearch = () => openSpotlightSearch({
  title: "Open project",
  resolve: ({ query }) => projects.filter((project) => project.label.includes(query)),
});

<SpotlightButton variant="chip" onClick={openSearch} />
```

Variants cover default, compact, chip, sidebar, sidebar-mobile, and icon launchers.

## API reference

```ts
type SpotlightButtonVariant = "default" | "compact" | "chip" | "sidebar" | "sidebar-mobile" | "icon";

type SpotlightButtonProps = {
  variant?: SpotlightButtonVariant; label?: string; title?: string; icon?: string;
  shortcut?: string; shortcutLabel?: string | false; ariaLabel?: string; disabled?: boolean; class?: string;
  onClick: () => void | Promise<void>;
};
```

The default variant is `"default"`. Shortcut caps are opt-in and show only in the `chip` and `sidebar` variants; without `shortcut` or `shortcutLabel`, none show. The default title is the button label. `openSpotlightSearch<T>(options)` uses the [prompts.search options and result](/en/ui/feedback/prompts#api-reference) and resolves to `PromptSearchItem<T> | undefined`; handle the selected value.

## Accessibility

Every variant retains an accessible label. The component does not register or assume a keyboard shortcut. Cloud applications register context commands through the platform; standalone hosts own their keyboard behavior.

## Runtime

The button renders during SSR; opening and resolving the prompt require browser code.

## Shortcut caps

Pass `shortcut="mod+k"` to show the shortcut. This is the recommended way:
the caps are platform and locale aware, as in [Kbd](/en/ui/content/kbd). Use
`shortcutLabel` only when the host already has a ready-made label; `false`
hides it. `shortcut` takes precedence when both are supplied.
