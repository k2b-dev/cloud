### Measure feed geometry before writing it

- **What happened:** Opening a conversation blocked the browser while the feed corrected estimated row heights.
- **Root cause:** Each correction wrote feed height, scroll position and row translations before reading layout again; edge and visibility checks repeated geometry reads.
- **Error class:** Interleaved layout reads and writes during synchronous mount.
- **Guard:** The VirtualFeed browser test counts viewport height reads and feed height writes before the first visible-range report; existing frame probes cover anchoring, jumps and resizes.
