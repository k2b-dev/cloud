### Thumbnail updates must keep the photo button

- **What happened:** A long photo strip jumped back while thumbnails arrived. The Tools host test then timed out waiting for its left fade; the timeout closed the browser. Focus and a press could also disappear.
- **Root cause:** The host produced new item objects after thumbnail and dirty-state updates. A reference-keyed list replaced every photo button and temporarily collapsed the scrollable content. The centering effect also depended on the item array even when its length stayed equal.
- **Error class:** A presentation refresh replaces interactive elements whose domain identity has not changed.
- **Guard:** The public editor browser test rebuilds equal photo items, verifies scroll position, element and focus preservation, then rebuilds between pointer down and up and requires the original photo selection. The Tools host guard reaches the Add photos action by keyboard and checks that it remains inside the strip.
- **Fix:** The existing internal `KeyedFor` keeps each photo button by its public item ID while its thumbnail and dirty state update. A memoized item count prevents equal-length refreshes from recentering the strip. Decorative children ignore pointer events so a changing status mark cannot swallow a press.
