### Preserve existing axes when keeping endpoint units visible

- **What happened:** A speedtest label correction changed shared endpoint anchors and removed a whole interval of ticks. Pulse lost its precise time labels and Venue lost a single day's label.
- **Root cause:** The unit-clipping fix changed the shared scale and alignment without checking existing consumers that reserve label padding or hide fractional day labels.
- **Error class:** A consumer layout fix changed shared axis semantics.
- **Fix:** Preserve the original ticks and centered numeric labels by default. Only Speedtest opts into `insetEndpointLabels`, which reserves room beside its exact endpoints and points their units inward.
- **Guard:** Default-axis and one-slot tests retain the original ticks, centered endpoint labels and single day. Existing Pulse time-axis and Venue feedback tests remain unchanged; the speedtest browser guard checks that formatted endpoint units fit the SVG on phone and desktop. Search all real consumers before changing shared axis defaults and run their affected test files separately.
