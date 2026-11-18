# PullToRefresh

`PullToRefresh` wraps one scroll container and turns a downward pull on a list
that is already at its top into a single refresh. It owns the gesture and the
indicator; the application owns the refresh action.

Three inputs share one model: a touch pull, a mouse or pen drag that starts on
non-interactive space, and trackpad or wheel overscroll. During a touch or
drag pull, a round indicator with the refresh icon slides in from above by the
damped pull distance and turns with the progress. Past 64 px of damped travel
(the same distance Android's swipe-to-refresh uses) the indicator switches to
the accent color; releasing there calls `onRefresh` once. Wheel overscroll
does not move the indicator: it adds up quietly, and the same distance calls
`onRefresh` once and slides the indicator in. While the refresh runs, the
indicator shows a continuously spinning loader; when the returned promise
settles, it slides out and fades. A shorter pull, an upward move, or a
cancelled pointer resets without a call.

The indicator floats above the list with a very light shadow
(`--k2b-shadow-raised`). A mouse or pen pull ends when its
button is released, even outside the list, so moving the pointer afterwards
never pulls. While a pull runs, the page selects no text.

## Import

```tsx
import { PullToRefresh } from "@k2b/ui";
```

## Use PullToRefresh

Give `PullToRefresh` exactly one scroll container as its child, usually a
`ScrollArea`, and pass the same refresh the view already exposes elsewhere:

```tsx
<PullToRefresh class="flex-1" onRefresh={() => reloadConversations()} label="Refreshing conversations">
  <ScrollArea scrollPreserveKey="conversations">
    <ConversationRows />
  </ScrollArea>
</PullToRefresh>
```

The wrapper is a flex column with `min-height: 0` and leaves height and flex
growth to the surrounding layout. Only the indicator moves; the wrapped
content never shifts and nothing is clipped.

The gesture starts only while every element between the input and the wrapper
is scrolled to the top, so a scrolled list keeps scrolling normally. Mouse and
pen drags that start on links, buttons, inputs, or editable content are left
to those controls; wheel overscroll and touch pulls work anywhere in the list.
A trackpad has no release event, so overscroll triggers as soon as the
distance is reached. The added-up distance resets when the user scrolls back
down. A wheel gesture ends after 300 ms without wheel input; the gesture that
started a refresh, including the trackpad's momentum, cannot start another
one, however long it outlasts the refresh.

`onRefresh` must return a promise. From the start of a refresh until the
indicator has slid out again, every input is ignored, so neither a slow
refresh nor a quick one can be triggered twice and the indicator never
flickers back in. Pass `disabled` while the view is already loading for
another reason.

## Accessibility

The indicator is a polite live region that announces `label` (or the shared
"Refreshing" message) only while the refresh runs; it is otherwise silent and
takes no pointer events. The gesture is an enhancement: keep a keyboard-reachable
refresh next to it, such as an existing refresh or retry button or the page
reload. Under `prefers-reduced-motion` or the reduced-motion setting, the indicator
neither eases, slides out, turns, nor spins; it still appears at the pull
distance, shows a static loader icon while busy, and disappears at once.

## Runtime

The wrapper is server-renderable in its idle state. The gesture, the
indicator movement, and the busy state require browser code; before mount, the
child scrolls natively and nothing else happens.

## Example

```tsx
<PullToRefresh
  onRefresh={async () => {
    await conversations.refresh();
  }}
  label="Refreshing conversations"
>
  <ScrollArea role="region" aria-label="Needs action" style={{ height: "18rem" }}>
    <ConversationRows />
  </ScrollArea>
</PullToRefresh>
```
