### Measure map documents and their export frame

- **What happened:** Saved-map notes used the ordinary book type scale, and the shared workspace-dialog width overrode the intended PDF preview width.
- **Root cause:** Application composition inherited larger typography and a more specific shared frame selector; the export sheet also needed to grow with long content.
- **Error class:** Shared presentation rules override a scoped document composition.
- **Guard:** Notebook map browser tests measure typography, spacing, map/list dimensions, the 640px export frame, and full white-sheet containment on phones. They also check editor map widgets retain zero padding and ordinary notes retain their existing typography and export controls.
