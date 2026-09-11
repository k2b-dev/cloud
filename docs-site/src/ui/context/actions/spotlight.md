# Spotlight search

`SpotlightButton` launches the portable search prompt with one shortcut and accessible-name contract across navigation contexts.

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
  shortcutLabel?: string | false; ariaLabel?: string; disabled?: boolean; class?: string;
  onClick: () => void | Promise<void>;
};
```

The default variant is `"default"`. `shortcutLabel={false}` hides the shortcut text. `openSpotlightSearch<T>(options)` uses the [prompts.search options and result](/en/ui/feedback/prompts#api-reference) and resolves to `PromptSearchItem<T> | undefined`; handle the selected value. `isSpotlightShortcut(event: KeyboardEvent): boolean` only recognizes the shortcut; the host registers its keyboard listener.

## Accessibility

Every variant retains an accessible label. `isSpotlightShortcut` recognizes Command+Shift+K and Control+Shift+K.

## Runtime

The button renders during SSR; opening and resolving the prompt require hydration.
