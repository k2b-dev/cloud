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
| Details with a few links or buttons, opened on purpose | `HoverCard.Trigger` with `actions` |
| Content with controls, such as a slider or a form | `AnchoredPopover` |

Keep a card that opens on hover to information. It holds no links, buttons, or
fields: nobody can reach them with the keyboard without opening it some other
way, and on a phone the card closes on the next tap. When the details need an
action, put the action on the control itself, as a place that filters on click,
and say so in `hint`. When the card itself needs a few actions, such as "Report
page" or "Try again", give `HoverCard.Trigger` its `actions`: the card becomes
a small dialog that only a press opens. Use `AnchoredPopover` for richer
controls, such as a slider or a form.

## Import

```tsx
import { HoverCard, type HoverCardProps, type HoverCardTriggerProps, ProgressPath, DescriptionList } from "@k2b/ui";
```

Code that loads on demand, such as an opened list in a chat, imports it from
its own entry instead, so the island's first JavaScript does not keep it:

```tsx
import { HoverCard } from "@k2b/ui/hover-card";
```

## Two forms

- **`HoverCard`** wraps a control that already has its own action, such as a
  link, a button, or a chip that filters. Hover and keyboard focus open the
  card. Using the control closes it, as for a tooltip, whether by pointer, key,
  or a click from assistive technology. On touch, a tap keeps
  the control's own meaning and opens no card, so the details must also be
  reachable where the control leads.
- **`HoverCard.Trigger`** renders a button that exists to show the card, around
  content without a control of its own, such as a small graphic. Hover and
  keyboard focus open the card, and a click or tap pins it open until a second
  press, a press outside, or Escape. On a phone a tap opens it as a bottom
  sheet, also when a hovering pen opened it beside the control first. Give the button an `aria-label` that names what it shows, such as
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
| `actions` | `JSX.Element` | none | `HoverCard.Trigger` only: links or buttons at the start of the last line, with `hint` at its end. Makes the card a non-modal dialog. |

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
- Escape closes the card. It opens again only after the pointer and the
  keyboard focus left the control.
- A card that the pointer opened closes when the page scrolls. A pinned or
  focused card follows its control, also when pinch zoom moves the visible
  area.
- The card is never taller than the room on its side: between the control and
  the edge of the visible area, less the 6px gap and the 8px margin, and at
  least 120px. It never covers its own control. A longer body scrolls inside
  the card and fades out below while more follows; the title and the last line
  stay. A sheet is at most the screen height less 3rem.

## A card with actions

`HoverCard.Trigger` with `actions` behaves like `AnchoredPopover`:

- Resting the pointer or keyboard focus on the trigger opens nothing. A click,
  a tap, Enter, or Space opens the card and moves the focus into it; Tab
  reaches its links and buttons.
- Escape, another press of the trigger, or a press outside closes it, and the
  focus returns to the trigger when it was inside or got lost, as when an
  action replaces itself with "Reported"; the ring returns only for the
  keyboard. Moving the focus on to the page, from the card or from the trigger,
  closes it too. Moving the pointer away keeps it open. A control inside that
  handles Escape itself, such as an open menu, keeps the card open.
- The card is a `dialog` named by its `title`, or by the trigger's
  `aria-label` without a title; the trigger reports
  `aria-haspopup="dialog"`, `aria-controls`, and `aria-expanded` instead of a
  description.
- The last line holds the actions at its start and `hint` at its end, in the
  12px meta step. Links there read as text; only their underline carries the
  link accent, so they follow the primary scope. Controls in the body, such as "Try again" after a failed
  load, count as actions as well; the card must then have `actions`.

A card without `actions` keeps the hint behaviour above; like every card it is
capped to the room on its side. Its body cannot take the focus, so keep such a
card short enough for the room it usually has.

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

Without actions, the card is a `tooltip` that describes its control: `HoverCard` adds its id to
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
so its text is in the first HTML. `HoverCard.Trigger` names it in
`aria-describedby` from the first HTML; `HoverCard` links it to the control
inside when the page becomes interactive. The card never dismisses a menu or
another popover. It floats on layer 3 of
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
