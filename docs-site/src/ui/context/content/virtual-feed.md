# VirtualFeed

`VirtualFeed` shows a long, time-ordered feed of items with different heights,
such as messages, activity, or log events. It renders only the items near the
visible area, loads more items at both ends, and keeps the reading position:
while the reader is at the end, the feed stays there as items arrive and rows
or the surrounding layout change size. A reader who scrolled up stays on the
same item, to the pixel, whatever loads or grows around it.

The application owns the items, their order, paging, and every row's content.
The component owns scrolling, measuring, the reading position, the "Jump to
latest" overlay, and the feed semantics for assistive technology.

For a conversation, render each item with
[`MessageRow`](/en/ui/content/message-rows); its rows have their final height
when they mount.

## Import

```tsx
import { VirtualFeed, type VirtualFeedController, type VirtualFeedProps } from "@k2b/ui";
```

## Use VirtualFeed

Pass the loaded items oldest first, a stable `getKey`, an `estimateSize` in
pixels, a `label`, and a render function as children. Replace the `items`
array to add, remove, or change items; the feed compares keys to tell an
append from a prepend or another change. A changed item object with the same
key renders again, and keeps focus when its row had it. Keys must be unique.
The render function runs once per item object, as with Solid's `For`; read
signals inside its JSX to update parts of a row.

Give the feed a bounded height, for example as the growing part of a flex
column. Content below it, such as a composer, belongs outside the feed. When
that content grows or an on-screen keyboard shortens the page, the feed keeps
its end in view while the reader is there. When the reader has scrolled up,
the item at the bottom edge stays in place.

`estimateSize` only needs to be close. Every row is measured when it mounts,
and the feed corrects the position before the frame is drawn. Close estimates
make the scrollbar steadier during fast scrolling. Give rows their final
height at mount where possible, for example with reserved space for images of
known size. Content that grows later is handled, but it moves the rows below it
within the visible area.

### Load more at both ends

Set `hasOlder` and `onLoadOlder` to load older items when the reader nears the
start, and `hasNewer` and `onLoadNewer` for the end. Prepend or append the page
to `items`; the visible item stays exactly where it was. The feed calls each
callback once until its promise settles and marks itself busy meanwhile. It
also loads when `hasOlder` or `hasNewer` turns on while the reader is at that
edge, so a reader at the end follows newer items reported by a live update.
Handle errors inside the callback; a rejected promise ends the busy state,
and when a load toward the end brought nothing, "Jump to latest" shows again.
A failed load is not repeated right away; the feed asks again when the reader
scrolls at that edge, or when the items or the layout change.

When the newest items are not loaded, for example after jumping to an old
item, pass `onLoadNewest`. "Jump to latest" then calls it once running loads
have finished, starts no other page meanwhile, and lands at the end of the new
`items`. Without `onLoadNewest`, the feed follows the end while `onLoadNewer`
pages arrive, until the newest item is loaded or the reader scrolls away.

When newer items appear that only `onLoadNewest` can load, or a load toward
the end fails, the feed stops following the end where it is, and "Jump to
latest" shows.

### Jump to an item

The `controller` callback receives a `VirtualFeedController` once the feed is
mounted:

- `scrollToKey(key, { align, highlight })` scrolls to a loaded item and
  returns `false` if no loaded item has that key, so you can load a page
  around it first and call it again. `align` is `"center"` (default) or
  `"start"`; `highlight` tints the item briefly. The item stays in place
  afterwards.
- `scrollToEnd()` follows the end again. Call it after the reader sends an
  item, so the item shows even while the feed still coasts from a fling.
- `isAtEnd()` tells whether new items keep the feed at the end.

`onEndChange` reports when the reader reaches or leaves the end, for example
to mark items as seen.

### Separators and the marker

`separator(item, previous)` returns a short label shown above an item, such as
a date when the day changes; return nothing for no separator. While `hasOlder`
is set, the first loaded item has no known predecessor and gets no separator
until the older page arrives. `markerKey` names the first item the reader has
not seen yet and shows a "New" label above it; change the text with
`markerLabel`. Both are part of their item's row. When one appears or goes
away, the content of the item at the top of the view stays where it is.

### Jump to latest

While the reader is away from the end, an overlay button "Jump to latest"
appears above the bottom edge. It counts the new items added since the reader
left the end; pass `newCount` to show your own number instead. Items are new
when they come after the newest item the feed had loaded while no newer items
existed. Pages of older history that `onLoadNewer` brings in after a jump do
not count. The button overlays the feed, so it never changes the layout.

### Long feeds

The feed lays out at most about 8 million pixels at once and moves this
window as the reader scrolls, so a feed of 100,000 items scrolls normally in
every engine. Firefox would draw a taller element with no height at all. The
scrollbar therefore covers the laid-out window, not every loaded item. A
focused item that the window leaves behind is unmounted, and focus moves to
the scroll area.

## Reading position

The feed follows the end while the reader is there. Otherwise it keeps the
item at the top of the view where it is. When the view gets shorter or taller,
for example when an on-screen keyboard opens, the item at its bottom edge
stays in place.

### What counts as the reader

Every change of the scroll position that the feed did not make is the
reader's, whatever caused it: touch and momentum, the wheel, keys, the
scrollbar, focus moving into the feed, `scrollIntoView`, find in page, or
assistive technology. The feed keeps the new position and leaves or reaches
the end with it. Three moves are not the reader's:

- the scroll event of the feed's own write;
- a clamp: when a size change shortens the scroll range, the engine moves the
  position onto the new end. The feed treats that as the size change, so a
  reader a few pixels above the end stays there;
- what is left of a momentum after the application jumped with
  `scrollToEnd()` or `scrollToKey()`.

The end is judged in the geometry the position was last applied to. A scroll
step that lands in the same frame as a viewport resize counts against the
height from before the resize. Items appended while the reader scrolls away
from the end do not move the end the reader is heading for. A scroll that
reaches that end follows the end, and the new items show when the scroll
ends.

### During a scroll

From the first touch or scroll until the scroll ends, the feed does not write
the scroll position when rows grow or shrink, items are appended, or the
viewport resizes: a write would fight the finger, its momentum, or a scroll
animation. The feed moves the rows instead, so what the reader sees stays
where the reader put it in every frame. Touches are followed on
the element they began on, so a touch ends even when the feed removed that
row meanwhile.

A scroll ends at the engine's `scrollend` when no movement follows in the next
two frames. Engines also fire `scrollend` for writes of the page, and iOS
delivers it late enough to land in a later fling, so a `scrollend` followed
by movement does not count. When no `scrollend` comes, the scroll ends 1
second after its last move; in engines without `scrollend`, after 300 ms. A
finger that lifts after its scroll ended ends it at once. When the scroll
ends, the feed writes the held-back correction in one step that moves nothing
on screen.

Structural changes are corrected at once, also during a scroll: pages loaded
above the reader, removed or reordered items, the loaded window moving, and
keyboard moves between items.

### Jumps during a scroll

`scrollToEnd()` and `scrollToKey()` win over a scroll that is still coasting.
The feed jumps at once and stops the momentum where the engine allows it. It
puts back what is left of the momentum until nothing has moved for 300 ms,
or until the reader touches, clicks, wheels, or presses a key.

## Accessibility

The feed uses the `feed` role with your `label`, and every item is an
`article`, named by `itemLabel` when you pass it. Items carry
`aria-posinset` and `aria-setsize`. Pass `firstPosition` and `totalCount`
when you know them. Without `firstPosition`, positions are left out while
`hasOlder` is set. Without `totalCount`, the size is `-1` while `hasOlder` or
`hasNewer` is set. The feed is `aria-busy` while `busy` is set or a page
loads.

One item is in the tab order, by default the newest visible one. Arrow keys
and Page Up or Page Down move between items and scroll along, Ctrl+Home goes
to the first loaded item, and Ctrl+End to the end. The focused item stays
mounted while the reader scrolls elsewhere in the laid-out window, so focus
never falls back to the page. The scroll area itself is not a tab stop.

New items at the end are announced in a separate, visually hidden `log`
region, bundled per second ("3 new items"). Pass `announce` to word it
yourself or to stay silent, for example for the reader's own items: it gets
the added items and returns the text or nothing. Items loaded at the start,
pages of older history loaded toward the end, and replaced items are not
announced. Announcements still pending when `items` switches to a different
feed are dropped.

## Runtime

The server renders the empty scroll area with its label; rows appear after
hydration, because they need the browser to measure them. Pass `empty` for
content shown while `items` is empty.

## Example

```tsx
const [entries, setEntries] = createSignal<Entry[]>(latestPage);
let feed: VirtualFeedController | undefined;

<div style={{ display: "flex", "flex-direction": "column", height: "32rem" }}>
  <VirtualFeed
    items={entries()}
    getKey={(entry) => entry.id}
    estimateSize={(entry) => (entry.preview ? 120 : 44)}
    label="Release activity"
    itemLabel={(entry) => `${entry.author}, ${entry.time}`}
    separator={(entry, previous) => (entry.day !== previous?.day ? entry.day : undefined)}
    markerKey={firstUnseenId()}
    hasOlder={hasOlder()}
    onLoadOlder={async () => {
      const page = await loadBefore(entries()[0]);
      setEntries((current) => [...page, ...current]);
    }}
    controller={(controller) => (feed = controller)}
  >
    {(entry) => <ActivityRow entry={entry} />}
  </VirtualFeed>
  <ReplyField />
</div>;
```
