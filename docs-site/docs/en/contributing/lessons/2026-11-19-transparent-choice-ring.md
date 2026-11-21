### Distinguish transparent focus rings from raised choices

- **What happened:** Sync 62 browser checks rejected a transparent focus-ring layer introduced by the shared thin-edge styles.
- **Root cause:** The survey expected only one shadow layer, while the block check mistook the ring's spread for blur.
- **Error class:** A computed-style assertion confuses an invisible state layer with a visible surface change.
- **Guard:** Browser assertions permit only the exact transparent, unblurred 3 px ring beside the existing edges. The survey checks 1 px resting edges and a 2 px selected edge; block hull, media, overflow, and raised-shadow assertions remain in place.
