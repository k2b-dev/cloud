# MovedHint

`MovedHint` points from a known old place to its new location with a one-time,
non-modal callout. It never shifts the surrounding layout.

## Use MovedHint

Use it when a familiar path moves. Name the new place and offer a link or
an action that takes the person there. Render the hint directly after its
target so its controls follow the target in keyboard order.

The owner stores whether the person has seen the hint and decides `open` on
the server. Show it only to people who may use the new path. Using the new path
also counts as seen. Cloud applications get server-side storage for this; see
[One-time hints for moved paths](/en/docs/frontend/ssr-pages-and-routing#one-time-hints-for-moved-paths).

## Import

```tsx
import { MovedHint, type MovedHintAction, type MovedHintProps } from "@k2b/ui";
```

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `open` | `boolean` | required | Server-owned visibility; false renders nothing. |
| `onDismiss` | `() => void` | required | Stores dismissal; called at most once per open period, including action use. |
| `target` | `() => HTMLElement \| undefined` | required | Identifies the element at the old place. |
| `children` | `JSX.Element` | required | Short text naming the new place. |
| `action` | `MovedHintAction` | required | `{ label, href }` for navigation or `{ label, onClick }` for an action. |
| `placement` | `TooltipPlacement` | `"bottom"` | Preferred side; flips and clamps to the viewport. |
| `class` | `string` | none | Additional classes on the surface. |

## Accessibility

The hint is a named group, never a modal. It announces its text politely once
per mount through the shared live region, without moving focus. Tab from the
target reaches the action, then **Got it** (**Verstanden** in German).
Escape on the target or inside the hint and the dismiss button close it.
When focus was inside, closing returns it to the element focused before entry,
or to the target when it can receive focus. Action use dismisses first, then
follows the link or runs the callback.

## Runtime

The component has no storage dependency. An open hint renders a manual popover
on the server; the browser keeps it hidden before hydration. Browser code opens
and positions it only when the target has client rectangles, and repositions on
resize, captured scroll, and target size changes. A hidden target hides the
hint until it is visible again. Closing hides immediately while the owner
persists dismissal. All listeners and observers are released on close.

The Popover API is required to show the hint. No animation runs in component
logic, including under reduced motion.

## Example

```tsx
const [open, setOpen] = createSignal(initiallyOpen);
let tags: HTMLButtonElement | undefined;

<Button ref={tags} variant="ghost">Tags</Button>
<MovedHint
  open={open()}
  target={() => tags}
  onDismiss={() => { saveSeen(); setOpen(false); }}
  action={{ label: "Show filters", href: "/files?filters=1" }}
>
  Tags moved to the filter chips in the head.
</MovedHint>
```
