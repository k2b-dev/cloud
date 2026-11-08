### Refitting an image after floating overlays settle

- **What happened:** A phone photo editor could leave its image only 40 pixels high. The ZIP test failed before it started exporting.
- **Root cause:** The initial measurement used the desktop pane height before the phone layout applied. A later ResizeObserver delivery corrected the overlay height, but the fit calculation did not react because the canvas dimensions stayed unchanged.
- **Error class:** Derived geometry depends on measured overlays as well as container size.
- **Guard:** The Tools archive browser test defers overlay resize delivery until the preview loads, then requires the existing minimum displayed height. It also decodes both ZIP members and checks their full original dimensions, including the rotated photo and the previously unvisited photo.
