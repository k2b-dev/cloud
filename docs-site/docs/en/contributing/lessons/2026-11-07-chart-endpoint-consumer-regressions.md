### Preserve existing axes when keeping endpoint units visible

- **What happened:** A speedtest label correction changed shared endpoint anchors and removed a whole interval of ticks. Pulse lost its precise time labels and Venue lost a single day's label.
- **Root cause:** The unit-clipping fix changed the shared scale and alignment without checking existing consumers that reserve label padding or hide fractional day labels.
- **Error class:** A consumer layout fix changed shared axis semantics.
- **Fix:** Keep numeric labels centered, retain ticks half an interval from exact bounds, and reserve the speedtest's unit space through the public chart padding option.
- **Guard:** A one-slot axis test retains its only day. Existing Pulse time-axis and Venue feedback tests remain unchanged; the speedtest browser guard checks that formatted endpoint units fit the SVG on phone and desktop.
