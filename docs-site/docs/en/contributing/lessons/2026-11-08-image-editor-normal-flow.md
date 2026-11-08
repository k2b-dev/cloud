### Reveal selected content without overlapping or clipping its neighbours

- **What happened:** A sticky active thumbnail covered neighbouring images after scrolling. On desktop, the Mark up pane clipped annotation rows, especially after a save error reduced its available height.
- **Root cause:** Sticky positioning moved the selected thumbnail without moving its neighbours. The annotation tool also combined a non-scrolling outer body with a shrinking inner list, hiding rows without a clear scroll boundary.
- **Error class:** Layout corrections that preserve a target while overlapping or clipping adjacent content.
- **Fix:** Keep thumbnails in normal flow and reveal the selected or focused item by scrolling. Let the desktop pane body scroll the entire tool, including all layer rows; retain the bounded phone layer list.
- **Guard:** Browser guards compare neighbouring thumbnail boxes at the first, middle and last selection on desktop and phone, including manual browsing. A three-layer desktop case scrolls every row into the pane viewport before and after a rejected save, and verifies that the inner list does not clip its rows. Existing selection-reveal, late-thumbnail and WebKit End/Add guards remain.
