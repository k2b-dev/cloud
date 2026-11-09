### Bubble responsive bounds

- **Error class:** Responsive SVG geometry and label fitting.
- **What happened:** Small bubble drawings clipped outer points and overlapped the average values with the Y-axis title.
- **Root cause:** The responsive marker rule kept bubble radii in pixels while plot padding shrank. Average and axis labels also competed for the same header space.
- **Guard:** Core tests check radius-inclusive plot bounds; the browser guard measures circles and the gap between average values and the Y-axis title in narrow, short real Chart boxes.
