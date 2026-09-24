# PullToRefresh

`PullToRefresh` wraps one scroll container and turns a downward pull on a list
that is already at its top into a single refresh. It owns the gesture and the
indicator; the application owns the refresh action.

Three inputs share one model: a touch pull, a mouse or pen drag that starts on
non-interactive space, and trackpad or wheel overscroll. A round indicator with
the refresh icon slides in from above by the damped pull distance and turns
with the progress. Past 64 px of damped travel (the same distance Android's
swipe-to-refresh uses) the indicator switches to the accent color; releasing
there, or overscrolling that far with a wheel, calls `onRefresh` once and shows
a continuously spinning loader until the returned promise settles. A shorter pull, an upward move,
or a cancelled pointer resets without a call.

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
distance is reached and resets after 300 ms without wheel input or when the
user scrolls back down.

`onRefresh` must return a promise. The indicator stays busy and ignores new
pulls until it settles, so a slow refresh cannot be triggered twice. Pass
`disabled` while the view is already loading for another reason.

## Accessibility

The indicator is a polite live region that announces `label` (or the shared
"Refreshing" message) only while the refresh runs; it is otherwise silent and
takes no pointer events. The gesture is an enhancement: keep a keyboard-reachable
refresh next to it, such as an existing refresh or retry button or the page
reload. Under `prefers-reduced-motion`, the indicator neither eases, turns, nor spins;
it still appears at the pull distance and shows a static loader icon while busy.

## Runtime

The wrapper is server-renderable in its idle state. The gesture, the
indicator movement, and the busy state need hydration; before that, the child
scrolls natively and nothing else happens.

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
