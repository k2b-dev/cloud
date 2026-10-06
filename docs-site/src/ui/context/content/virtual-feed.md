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

## Import

```tsx
import { VirtualFeed, type VirtualFeedController, type VirtualFeedProps } from "@k2b/ui";
```

## Use VirtualFeed

Pass the loaded items oldest first, a stable `getKey`, an `estimateSize` in
pixels, a `label`, and a render function as children. Replace the `items`
array to add, remove, or change items; the feed compares keys to tell an
append from a prepend or another change. A changed item object with the same
key renders again. Keys must be unique.

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
callback once until its promise settles and marks itself busy meanwhile.
Handle errors inside the callback; a rejected promise only ends the busy
state.

When the newest items are not loaded, for example after jumping to an old
item, pass `onLoadNewest`. "Jump to latest" then calls it once running loads
have finished, starts no other page meanwhile, and lands at the end of the new
`items`. Without `onLoadNewest`, the feed follows the end while `onLoadNewer`
pages arrive, until the newest item is loaded or the reader scrolls away.

### Jump to an item

The `controller` callback receives a `VirtualFeedController` once the feed is
mounted:

- `scrollToKey(key, { align, highlight })` scrolls to a loaded item and
  returns `false` if no loaded item has that key, so you can load a page
  around it first and call it again. `align` is `"center"` (default) or
  `"start"`; `highlight` tints the item briefly. The item stays in place
  afterwards.
- `scrollToEnd()` follows the end again.
- `isAtEnd()` tells whether new items keep the feed at the end.

`onEndChange` reports when the reader reaches or leaves the end, for example
to mark items as seen.

### Separators and the marker

`separator(item, previous)` returns a short label shown above an item, such as
a date when the day changes; return nothing for no separator. `markerKey`
names the first item the reader has not seen yet and shows a "New" label above
it; change the text with `markerLabel`. Both are part of their item's row, so
they never move other rows.

### Jump to latest

While the reader is away from the end, an overlay button "Jump to latest"
appears above the bottom edge. It counts the items added since the reader left
the end; pass `newCount` to show your own number instead. The button overlays
the feed, so it never changes the layout.

### Long feeds

The feed lays out at most about 8 million pixels at once and moves this
window as the reader scrolls, so a feed of 100,000 items scrolls normally in
every engine. Firefox would draw a taller element with no height at all. The
scrollbar therefore covers the laid-out window, not every loaded item.

## Accessibility

The feed uses the `feed` role with your `label`, and every item is an
`article`, named by `itemLabel` when you pass it. Items carry
`aria-posinset` and `aria-setsize`: with `hasOlder` or `hasNewer`, pass
`firstPosition` and `totalCount` when you know them, otherwise positions are
left out and the size is `-1`. The feed is `aria-busy` while `busy` is set
or a page loads.

One item is in the tab order, by default the newest visible one. Arrow keys
and Page Up or Page Down move between items and scroll along, Ctrl+Home goes
to the first loaded item, and Ctrl+End to the end. The focused item stays
mounted while the reader scrolls elsewhere, so focus never falls back to the
page. The scroll area itself is not a tab stop.

New items at the end are announced in a separate, visually hidden `log`
region, bundled per second ("3 new items"). Pass `announce` to word it
yourself or to stay silent, for example for the reader's own items: it gets
the added items and returns the text or nothing. Items loaded at the start or
replaced are not announced.

## Runtime

The server renders the empty scroll area with its label; rows appear after
hydration, because they need the browser to measure them. Pass `empty` for
content shown while `items` is empty.

On iOS, writing the scroll position during a touch or momentum scroll stops
the scroll. While a finger or momentum moves the feed, measuring corrections
wait until scrolling comes to rest, and content may shift briefly during that
time. Loading pages is never held back.

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
    onLoadOlder={async () => setEntries((current) => [...(await loadBefore(current[0])), ...current])}
    controller={(controller) => (feed = controller)}
  >
    {(entry) => <ActivityRow entry={entry} />}
  </VirtualFeed>
  <ReplyField />
</div>;
```
