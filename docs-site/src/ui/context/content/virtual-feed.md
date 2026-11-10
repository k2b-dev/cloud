# VirtualFeed

`VirtualFeed` shows a long, time-ordered feed of items with different heights,
such as messages, activity, or log events. It renders only the items near the
visible area, loads more items at both ends, and keeps the reading position:
while the reader is at the end, the feed stays there as items arrive and rows
or the surrounding layout change size. A reader who scrolled up stays on the
same item, to the pixel, whatever loads or grows around it.

With `anchor="start"`, the same feed is a work list such as an inbox: it opens
at the first item, loads more below, and never follows the end (see
[Lists that start at the top](#lists-that-start-at-the-top)).

The application owns the items, their order, paging, and every row's content.
The component owns scrolling, measuring, the reading position, the "Jump to
latest" and "New above" overlays, and the feed semantics for assistive
technology.

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

### One reading column

Items, their separators, and the marker share one reading column of at most
`--k2b-reading-column` (47.5 rem, 760 px), centered in the feed. A wide
window therefore keeps others' and the reader's own messages close together
instead of at its far edges. The scrollbar stays at the feed's edge, and
scrolling over the empty sides scrolls the feed. A feed narrower than the
column fills its width. Put the composer of a conversation in the same column:
the `Chat.Composer` conversation variant does so by itself. Opening a panel or
collapsing a sidebar only changes the free space; the column keeps its width
and centers itself again.

`estimateSize` only needs to be close. Every row is measured when it mounts,
and the feed makes up the difference before the frame is drawn, so what the
reader sees does not move. Close estimates make the scrollbar steadier during
fast scrolling. Give rows their final height at mount where possible, for
example with reserved space for images of known size. Content that grows later
is handled, but it moves the rows below it within the visible area.

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
  item, so the item shows even while the feed still coasts from a fling. With
  `anchor="start"` it shows the last loaded item and follows nothing.
- `scrollToStart()` shows the first loaded item, for example when the reader
  opens the same list again.
- `isAtEnd()` tells whether new items keep the feed at the end. It is always
  `false` with `anchor="start"`.

`onEndChange` reports when the reader reaches or leaves the end.

`onVisibleChange?: (visible: { first: T; last: T } | null) => void` reports
changes to the first and last item whose whole height is in view. An item
taller than the view counts while it covers the view; the callback receives
`null` when no item is in view. It runs only when the pair of item keys changes.
Newly shown items count only after the feed has measured them, so a fast scroll
never reports an item at its estimated height.
Use this range to track reading progress, together with the application's
window visibility and focus checks.

### Separators and the marker

`separator(item, previous)` returns a short label shown above an item, such as
a date when the day changes; return nothing for no separator. While `hasOlder`
is set, the first loaded item has no known predecessor and gets no separator
until the older page arrives. `markerKey` names the first item the reader has
not seen yet and shows a "New" label above it; change the text with
`markerLabel`. Both are part of their item's row. When one appears or goes
away, the content of the item at the top of the view stays where it is.

Set `stickySeparators` to keep the separator of the group in view at the top
of the visible area until the next separator pushes it away. It stays also
when its own item is far above and no longer rendered. The feed draws one
copy of that separator over the rows, on the same pixels as the row's own, so
the two never show at once; the copy is hidden from assistive technology,
which reads the row's own separator. In a conversation the copy is a floating
label that lets clicks through beside it; in a list that starts at the top it
is an opaque group heading that takes clicks itself, so a click never reaches
a row hidden under it.

### Jump to latest

While the reader is away from the end, an overlay button "Jump to latest"
appears above the bottom edge. It counts the new items added since the reader
left the end; pass `newCount` to show your own number instead. Items are new
when they come after the newest item the feed had loaded while no newer items
existed. Pages of older history that `onLoadNewer` brings in after a jump do
not count. The button overlays the feed, so it never changes the layout.

### Lists that start at the top

`anchor="start"` makes the feed a work list whose first item matters most,
such as an inbox, receipts, or an activity log with the newest event first.
Pass `items` in display order, first item first. Read once, when the feed is
created.

- The feed opens at the first item and never follows the end. Appended pages
  and growing rows below keep what the reader sees in place.
- `hasMore` and `onLoadMore` load the next page below, with the same meaning
  as on `DataTable`: the feed calls `onLoadMore` when the reader nears the end
  while `hasMore` is true, and appends nothing itself. The end of the list is
  the shared [`LoadMore`](/en/ui/content/load-more) edge: "Load more" while
  idle, "Loading more…" while the promise runs, and the error with "Try
  again" when it rejects. A failed page waits for "Try again" instead of
  retrying while the reader scrolls.
- Items that arrive above the first loaded one, for example from a live
  update, keep the reading position, also when the reader is at the very top:
  a row the reader is about to click never moves. A "New above" button with
  the number of new items appears at the top; it scrolls to the first item and
  moves focus there. Reaching the start by scrolling counts the new items as
  seen. The new items are announced in the `log` region ("3 new items
  above"). Items that a new `items` array sorts in above the first known item,
  such as a conversation that moved to the top, count as new above too.
- A shorter or taller view keeps the item at its top in place.
- `hasOlder`, `hasNewer`, `onLoadOlder`, `onLoadNewer`, `onLoadNewest`, and
  `onEndChange` belong to feeds that open at the end; the types do not allow
  them with `anchor="start"`.

Rows fill the feed's width instead of the reading column, and separators read
as the list's group headings. Combine with `stickySeparators` for headings
that stay while their group scrolls.

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
stays in place. A scroll step that reveals an item above in the same frame
as that item changes size moves the items the reader saw by the step alone:
the item that was at the top before the step keeps its place.

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
  `scrollToEnd()` or `scrollToKey()`, and other scrolls without the reader's
  input in that short time (see "Jumps during a scroll").

The end is judged in the geometry the position was last applied to. A scroll
step that lands in the same frame as a viewport resize counts against the
height from before the resize. Items appended while the reader scrolls away
from the end do not move the end the reader is heading for. A scroll that
reaches that end follows the end. The new items show with the feed's next
correction, at the latest when the scroll ends, and from then on the end
includes them: a reader who moves up again leaves the end.

### During a scroll

From the first touch or scroll until the scroll ends, the feed does not write
the scroll position when rows grow or shrink, items are appended, or the
viewport resizes: a write would fight the finger, its momentum, or a scroll
animation. The feed moves the rows instead, so what the reader sees stays
where the reader put it in every frame. Touches are followed on
the element they began on, so a touch ends even when the feed removed that
row meanwhile.

Near the start, moved rows would show empty space above the first item, or
put the first items out of the scroll range's reach. Within 600 px of the
start, the feed therefore writes corrections at once, also during a scroll,
together with any correction it held back until the reader got there. That
write moves nothing on screen either.

A scroll ends at the engine's `scrollend` when no movement follows in the next
two frames. Engines also fire `scrollend` for the feed's own writes, and iOS
delivers it late enough to land in a later fling, even in a pause of its slow
tail. The first `scrollend` within 1 second of a write that moved the position
is therefore that write's, and a `scrollend` followed by movement does not
count. When no `scrollend` comes, the scroll ends 1 second after its last
move; in engines without `scrollend`, after 300 ms. A finger that lifts after
its scroll ended ends it when no momentum follows in the next two frames. When
the scroll ends, the feed writes the held-back correction in one step that
moves nothing on screen.

Structural changes are corrected at once, also during a scroll: pages loaded
above the reader, removed or reordered items, the loaded window moving, and
keyboard moves between items.

### Jumps during a scroll

`scrollToEnd()` and `scrollToKey()` win over a scroll that is still coasting.
The feed jumps at once and stops the momentum where the engine allows it. It
puts back what is left of the momentum until nothing has moved for 300 ms,
or until the reader touches, clicks, wheels, or presses a key. Until then,
other scrolls that no such input started are put back as well, for example
from focus that the application moves without `preventScroll`,
`scrollIntoView`, or assistive technology.

## Accessibility

The feed uses the `feed` role with your `label`, and every item is an
`article`, named by `itemLabel` when you pass it. Items carry
`aria-posinset` and `aria-setsize`. Pass `firstPosition` and `totalCount`
when you know them. Without `firstPosition`, positions are left out while
`hasOlder` is set. Without `totalCount`, the size is `-1` while `hasOlder` or
`hasNewer` is set. The feed is `aria-busy` while `busy` is set or a page
loads.

One item is in the tab order, by default the newest visible one, or the top
visible one with `anchor="start"`. Arrow keys and Page Up or Page Down move
between items and scroll along, Ctrl+Home goes to the first loaded item, and
Ctrl+End to the end; a list that starts at the top goes to its last loaded
item without following the end. The focused item stays
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

The server renders the items at the starting point without virtualization:
the last items for a feed that opens at the end, the first items with
`anchor="start"`, as many as fill about 1,600 px by their `estimateSize`. They
sit in the normal flow, at the end of the scroll area or at its top, exactly
where the browser places them. When the island mounts, the browser renders
the same rows at the same pixels before it paints, so the server's picture is
the first picture and nothing jumps. The scroll area cannot scroll until then.
A sticky separator appears with the browser: on the server, the first item's
own separator is in its place. Pass `empty` for content shown while `items` is
empty.

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

A work list, newest first, with day headings that stay at the top and older
pages below:

```tsx
<VirtualFeed
  anchor="start"
  items={rows()}
  getKey={(row) => row.id}
  estimateSize={(row) => (row.detail ? 58 : 50)}
  label="Mailbox events"
  separator={(row, previous) => (previous?.day === row.day ? undefined : row.day)}
  stickySeparators
  hasMore={Boolean(nextCursor())}
  onLoadMore={loadOlderPage}
>
  {(row) => <EventRow row={row} />}
</VirtualFeed>
```
