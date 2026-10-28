# Cards and identity

`LinkCard` is a single-destination navigation tile. `ResourceCard` stands for an element that something refers to, such as a task or a document in a message, and keeps the same size in every state. `Avatar` renders an application-owned image URL, a semantic icon, or an initials fallback.

## Use cards and identity

Use `LinkCard` when the complete surface leads to one destination. Use `ResourceCard` for a reference to an element whose details the application looks up later or per reader. Use `Avatar` beside a visible name when identity matters. Do not place unrelated interactive controls inside a link card.

## Import

```tsx
import { Avatar, LinkCard, ResourceCard, type ResourceCardState } from "@k2b/ui";
```

`LinkCard` accepts a title, description, icon, destination, optional semantic color, and one optional trailing `meta` fact. Its icon sits in a soft chip of its color. Without `color`, the glyph uses `--k2b-app-workspace-active`, the same optional accent hook as `AppOverview`'s icon, which defaults to the action color; Cloud maps it to the active application's accent. For navigation in place, pass `navigation="enhanced"` and `onNavigate`, as with `ButtonLink`. Without both, the card follows its link with a full page load. Use `meta` for one count or one non-interactive badge, such as a role; counts render with tabular figures. `Avatar` accepts a name, optional image URL or icon, fallback, size, shape, and loading behavior. `shape="circle"` is the default for people;
use `shape="square"` for agents and service accounts. Both image and fallback
respect the shape. See [AvatarStack](/en/ui/surfaces/avatar-stack) for a compact
list of people. Image content takes precedence over the icon, which takes precedence over initials. Initials and icons sit on a calm tint that the name decides: the person color (`personColor`, see [Colors and selection](/en/ui/surfaces/color#one-color-per-person)), so the same name has the same color wherever an avatar, a cursor or a comment shows it and people stay apart in long lists and conversations. Pass the display name the application shows for the person, so their avatar matches across surfaces.

Use `Avatar`'s `ring` for a live status such as someone working on a task, or a collaborator's own color, not for selection or focus. `"success"` uses the theme's success text color; `{ color }` accepts any CSS color the application owns. The ring and its small transparent gap lie inside the avatar's own box: it keeps its size, nothing moves when the ring appears or disappears, and a scrolling panel edge does not cut it off.

## Show a referenced element

`ResourceCard` shows an element in one of five `state`s:

- `"ok"` (the default) shows the element's `icon`, `title`, a line with its `source` and `location` joined by " · ", and one line of `preview` text. Empty lines are left out; a blank title shows "Untitled", so a card that opens always has a name.
- `"loading"` shows a quiet placeholder while the application looks the element up.
- `"no_access"` shows "Item not available" without saying whether the item exists, `"deleted"` shows "Item deleted", and `"unavailable"` shows "Not available right now", each with a neutral icon.

The card has the same width and height in every state, at most the width of its container, so a card that resolves, loses access, or is deleted moves nothing around it. Long text is cut off with an ellipsis. The labels follow the inherited `@k2b/ui` locale.

Outside `"ok"`, the card renders none of the element's fields and opens nothing, even when the caller passes them. A mistake in the caller therefore never shows a reader without access the element's name, source, location, or preview. The card is the last line of defense: the server still sends each reader only what that reader may see.

In `"ok"`, `onOpen` makes the card a button, for example to open the element in a panel; otherwise `href` makes it a link. `href` must be absolute `https` or `http`, or relative; other links, such as `javascript:`, render a card that opens nothing. In [message rows](/en/ui/content/message-rows), pass the card as `card`.

## API reference

```ts
type LinkCardColor = "blue" | "emerald" | "violet" | "orange" | "red" | "amber" | "zinc" | "cyan" | "rose";

type LinkCardProps = {
  href: string; title: string; description: string; icon: string; color?: LinkCardColor; meta?: JSX.Element;
  navigation?: "document" | "enhanced"; onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
};

type ResourceCardState = "ok" | "loading" | "no_access" | "deleted" | "unavailable";

type ResourceCardProps = {
  state?: ResourceCardState; title?: string; icon?: string; source?: string; location?: string; preview?: string;
  onOpen?: () => void; href?: string; class?: string;
};

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
type AvatarRing = "success" | { color: string };
type AvatarShape = "circle" | "square";

type AvatarProps = {
  name: string; src?: string | null; icon?: string; alt?: string; fallback?: string; size?: AvatarSize; shape?: AvatarShape;
  ring?: AvatarRing; loading?: "eager" | "lazy"; class?: string; style?: JSX.CSSProperties | string;
};
```

`href`, `title`, `description`, and `icon` are required. The card never moves on hover; only its colors respond. `Avatar` defaults to `size="md"` and `loading="lazy"`. `alt` overrides the image alternative; `fallback` overrides initials.

## Accessibility

The card remains one native link with a visible focus indicator. A `ResourceCard` that opens is one native link or button, read with its title, source, location, and preview; it never moves on hover or focus. A card that cannot show its element is plain text and takes no focus. A card that leaves `"ok"` while it has focus, for example because the element was deleted, becomes plain text, and focus returns to the page. A loading card is marked busy and names "Loading" for screen readers without a live region, so a list of cards does not announce each one. Avatar supplies an image alternative or fallback `role="img"` label.

Pair a ring with a visible text label or an avatar `alt` that explains what it means; color alone does not carry meaning.

## Runtime

All three components render on the server. Link navigation works without browser code; enhanced navigation requires browser code and keeps native modified-click behavior; a `ResourceCard` with `onOpen` and the avatar image-failure fallback require browser code.

## Example

```tsx
<LinkCard
  href="/runtime"
  title="Runtime"
  description="Open runtime details"
  icon="ti ti-server"
  color="cyan"
/>

<LinkCard href="/app/capabilities/pulse" title="Pulse" description="Telemetry sources" icon="ti ti-activity" meta="5 capabilities" />

<ResourceCard
  title="Onboarding checklist"
  icon="ti ti-notebook"
  source="Notebooks"
  location="Team handbook"
  preview="Laptop, accounts, and the first week"
  href="/notebooks/onboarding"
/>

<ResourceCard state="no_access" />

<Avatar name="Ada Lovelace" src={profileImageUrl} size="sm" />
<Avatar name="Workflow" icon="ti ti-route" size="sm" />
<Avatar name="Grace Hopper" size="xs" ring="success" alt="Grace Hopper is working on it" />
<Avatar name="Ada Lovelace" size="sm" ring={{ color: "#7c3aed" }} alt="Ada Lovelace is online" />
```
