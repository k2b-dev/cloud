### Crop shading belongs to the photo

- **What happened:** In the Files media dialog, the editor's light canvas and glass overlays looked grey even though the canvas had the correct computed background.
- **Root cause:** The crop frame cast a `100vmax` shadow outside the photo. The glass sampled that darkened canvas.
- **Error class:** A visual mask escapes the content whose discarded area it represents.
- **Guard:** The Files host browser test checks the editor's computed background and samples the rendered canvas outside the photo in both themes. A background assertion alone cannot detect an overlaid shadow.
- **Fix:** A photo-sized shade has a crop-shaped hole. Crop handles stay outside that mask and remain reachable.
