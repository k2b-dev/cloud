# Cards and identity

`LinkCard` is a single-destination navigation tile. `Avatar` renders an application-owned image URL, a semantic icon, or an initials fallback.

## Use cards and identity

Use `LinkCard` when the complete surface leads to one destination. Use `Avatar` beside a visible name when identity matters. Do not place unrelated interactive controls inside a link card.

## Import

```tsx
import { Avatar, LinkCard } from "@k2b/ui";
```

`LinkCard` accepts a title, description, icon, destination, optional semantic color, and one optional trailing `meta` fact. Without `color`, the glyph uses `--k2b-app-workspace-active`, the same optional accent hook as `AppOverview`'s icon, which defaults to the action color; Cloud maps it to the active application's accent. Use `meta` for one count or one non-interactive badge, such as a role; counts render with tabular figures. `Avatar` accepts a name, optional image URL or icon, fallback, size, and loading behavior. Image content takes precedence over the icon, which takes precedence over initials.

## API reference

```ts
type LinkCardColor = "blue" | "emerald" | "violet" | "orange" | "red" | "amber" | "zinc" | "cyan" | "rose";

type LinkCardProps = {
  href: string; title: string; description: string; icon: string; color?: LinkCardColor; meta?: JSX.Element;
};

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

type AvatarProps = {
  name: string; src?: string | null; icon?: string; alt?: string; fallback?: string; size?: AvatarSize;
  loading?: "eager" | "lazy"; class?: string; style?: JSX.CSSProperties | string;
};
```

`href`, `title`, `description`, and `icon` are required. The card never moves on hover; only its colors respond. `Avatar` defaults to `size="md"` and `loading="lazy"`. `alt` overrides the image alternative; `fallback` overrides initials.

## Accessibility

The card remains one native link with a visible focus indicator. Avatar supplies an image alternative or fallback `role="img"` label.

## Runtime

Both components render on the server. Link navigation works without hydration; avatar image-failure fallback activates after hydration.

## Example

```tsx
<LinkCard
  href="/runtime"
  title="Runtime"
  description="Open runtime details"
  icon="ti ti-server"
  color="cyan"
/>

<LinkCard href="/app/capabilities/pulse" title="Pulse" description="Metrics and dashboards" icon="ti ti-activity" meta="12 capabilities" />

<Avatar name="Ada Lovelace" src={profileImageUrl} size="sm" />
<Avatar name="Workflow" icon="ti ti-route" size="sm" />
```
