# AvatarStack

`AvatarStack` shows a compact group of people as one button that opens the full
list. The application supplies identity, presence details, and selection behavior.

## Use AvatarStack

Pass `people`, a list `title`, and an accessible `label` that describes who is
present. The stack shows up to `max` faces (three by default), then “+n”.
A person marked `self` stays out of the faces and appears last in the list,
separated by a gap. The list count includes everyone, including `self`.

Use `src` for a picture, `icon` for a semantic fallback, and `shape="square"`
for an agent or service account. Without a picture or icon, the avatar uses
initials. `badge` follows the name; `detail` is one truncated line below it,
optionally preceded by `detailIcon`. `trailing` holds short text such as “2 tabs”.
`hint` adds one quiet line below the list.

A person with `onSelect` becomes a button. The list closes before the callback
runs. Omit it for a person whose row has no destination.

## Import

```tsx
import { AvatarStack, type AvatarStackPerson } from "@k2b/ui";
```

## Example

```tsx typecheck
import { AvatarStack } from "@k2b/ui";

export const people = (
  <AvatarStack
    title="Here now"
    label="Here now: Jana Berger and Stock bot"
    hint="Select a person to jump to their cursor."
    people={[
      { id: "jana", name: "Jana Berger", detail: "Writing · Intake", detailIcon: "ti ti-pencil", onSelect: () => {} },
      { id: "bot", name: "Stock bot", shape: "square", icon: "ti ti-robot", badge: "Agent" },
      { id: "me", name: "You", self: true },
    ]}
  />
);
```

## API reference

```ts
type AvatarStackPerson = {
  id: string; name: string; src?: string | null; icon?: string; shape?: AvatarShape;
  badge?: JSX.Element; detail?: JSX.Element; detailIcon?: string; trailing?: JSX.Element;
  self?: boolean; onSelect?: () => void;
};

type AvatarStackProps = {
  people: readonly AvatarStackPerson[]; title: string; label: string; hint?: JSX.Element;
  max?: number; class?: string;
};
```

`AvatarShape` is `"circle" | "square"`; its default is `"circle"`.

## Accessibility

The trigger is one labelled button with expanded state and a relationship to
its dialog. Decorative faces do not repeat their names to screen readers.
The open list shows every person's name. Selectable rows are native buttons;
other rows remain text. When a focused row stops being selectable or its
person leaves, focus moves to the nearest selectable row, or to the list.
Keyboard dismissal returns focus to the trigger.

## Runtime

Faces and the list content render on the server. Opening the list and selecting
a person require browser code. Below 48rem the list opens in a bottom sheet;
otherwise it uses a popover beside the trigger.
