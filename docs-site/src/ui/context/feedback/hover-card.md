# Hover card

`HoverCard` is a larger hint beside one control. It shows what a compact value
means in full: a small path as large stages with words and days, a place as
rows of facts, or a small graphic with a title. It is the large sibling of
`Tooltip`.

## Use HoverCard

Use it when a row or a header shows a compact value, and people want the full
picture without leaving the page: the stages behind a small progress glyph,
what lies at a storage place, or the parts of a total. The card explains; it
never replaces the place where people act on the thing.

Choose by what the card does:

| Need | Component |
| --- | --- |
| One line that names or explains a control | `Tooltip` |
| Rich details about one control's value | `HoverCard` |
| A quick look at list items, one card for the whole list | `HoverPreview` |
| Content with controls, such as a slider or links | `AnchoredPopover` |

Keep the card to information. It holds no links, buttons, or fields: nobody can
reach them with the keyboard without opening it some other way, and on a phone
the card closes on the next tap. When the details need an action, put the
action on the control itself, as a place that filters on click, and say so in
`hint`. Use `AnchoredPopover` when the card must hold controls.

## Import

```tsx
import { HoverCard, type HoverCardProps, type HoverCardTriggerProps, ProgressPath, DescriptionList } from "@k2b/ui";
```

## Two forms

- **`HoverCard`** wraps a control that already has its own action, such as a
  link, a button, or a chip that filters. Hover and keyboard focus open the
  card. Using the control closes it, as for a tooltip. On touch, a tap keeps
  the control's own meaning and opens no card, so the details must also be
  reachable where the control leads.
- **`HoverCard.Trigger`** renders a button that exists to show the card, around
  content without a control of its own, such as a small graphic. Hover and
  keyboard focus open the card, and a click or tap pins it open until a second
  press, a press outside, or Escape. On a phone a tap opens it as a bottom
  sheet. Give the button an `aria-label` that names what it shows, such as
  "Path of B7A02".

## Contracts

| Prop | Type | Default | Purpose |
| --- | --- | --- | --- |
| `content` | `JSX.Element` | required | The card body: a `ProgressPath`, a `DescriptionList`, a small graphic, or a few lines. |
| `title` | `JSX.Element` | none | A bold first line, such as the name of the value. |
| `detail` | `JSX.Element` | none | A quiet line under the title, such as where the thing belongs. |
| `hint` | `JSX.Element` | none | A quiet last line, such as what a click on the control does. |
| `side` | `"below" \| "above"` | `"below"` | The side tried first. |
| `align` | `"start" \| "end"` | `"start"` | Which edge of the card lines up with the control. |
| `width` | CSS length | `20rem` | Width of the card; never wider than the screen minus 1rem. |
| `delay` | `number` | `400` | Milliseconds a resting pointer waits before the card opens. |
| `disabled` | `boolean` | `false` | Keeps the card closed; an open card closes. |
| `class` | `string` | none | Extra class on the card. |

`HoverCard` passes other attributes to its wrapping `span`.
`HoverCard.Trigger` passes them to its `button`; `triggerClass` styles the
button and `class` the card. The trigger looks like its content and shows only
the focus ring; on a coarse pointer its hit area grows to 2.75rem.

## Behavior

- A resting pointer opens the card after `delay`. A pass over the control that
  leaves earlier opens nothing.
- Keyboard focus opens the card at once and keeps it open while focus stays on
  the control. Focus from a click or a tap opens nothing.
- The card stays open while the pointer is on the control or the card. The gap
  between them belongs to the card, and the card closes 200 ms after the
  pointer left both.
- Escape closes the card. It opens again only after the pointer and the focus
  left the control.
- A card that the pointer opened closes when the page scrolls. A pinned or
  focused card follows its control.

## Placement

The card opens 6px below its control, lined up with the control's start edge,
and stays 8px inside the visible viewport. It flips above only when that side
has more room, and keeps the side it chose while open, so content that grows
never makes it jump. It is placed in the same task as it opens, so its first
frame is already in place, and it never moves anything in the page. On a phone,
a tap on a `HoverCard.Trigger` opens it as a bottom sheet across the screen
with the safe area kept clear. Hover and keyboard focus keep the card beside
its control at every width.

`AnchoredPopover` uses the same placement.

## Accessibility

The card is a `tooltip` that describes its control: `HoverCard` adds its id to
the `aria-describedby` of the first focusable element inside, after any
description the control already has, and `HoverCard.Trigger` sets it on its
button. The control keeps its own role and name, and screen readers read the
card's text after them. The card takes no focus and holds no tab stops, so it
can never trap the focus. `HoverCard.Trigger` reports `aria-expanded` while the
card is open.

A `Tooltip` that an icon-only control inside a `HoverCard` would show stays
off; the card covers it.

## Runtime

The card renders on the server as a closed manual popover next to its control,
so its text is in the first HTML and in the description from the start. It
never dismisses a menu or another popover. It floats on layer 3 of
[Layers and shadows](/en/ui/surfaces/elevation): the elevated surface, a light
1px edge, `--k2b-shadow-float` outside, and no lines inside. The bottom sheet
uses `--k2b-shadow-sheet` and a backdrop. The card fades in and out unless
reduced motion is requested. Do not place a `HoverCard` inside a `p`: the
card's block content would end the paragraph.

## Example

```tsx
<HoverCard.Trigger
  aria-label="Path of B7A02"
  title="B7A02 Pewter jug with lid"
  width="34rem"
  content={
    <ProgressPath
      label="Path of B7A02"
      steps={[
        { label: "Received", detail: "Nov 7", done: true },
        { label: "Booked in", detail: "Nov 9", done: true },
        { label: "Owner told", detail: "not yet", icon: "ti ti-mail" },
      ]}
    />
  }
>
  <SmallPath done={2} />
</HoverCard.Trigger>

<HoverCard
  title="R4 › Bin 7"
  detail="Return stack 1 of Lea Lorem"
  content={
    <DescriptionList
      layout="compact"
      size="sm"
      items={[
        { term: "From Lea Lorem", description: "22 items, the first since Nov 9" },
        { term: "At this place", description: "22 items from 1 person" },
      ]}
    />
  }
  hint="A click filters by this place."
>
  <Button size="xs" variant="secondary" onClick={() => filterBy("R4 › Bin 7")}>
    R4 › Bin 7
  </Button>
</HoverCard>
```
