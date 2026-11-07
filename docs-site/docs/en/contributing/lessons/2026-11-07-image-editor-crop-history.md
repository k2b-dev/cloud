### Crop constraints belong to the same history as the rectangle

- **What happened:** Undo restored the crop rectangle while leaving the aspect selector and portrait orientation at the latest value. Rotating a locked widescreen crop also changed the promised output ratio.
- **Root cause:** Aspect metadata lived in independent signals rather than the edit entry. Rotation preserved the rectangle without refitting the caller constraint.
- **Error class:** Split edit history and constraint drift.
- **Guard:** The public ImageEditor browser guards undo aspect changes, portrait swaps and rotation, then resize from a keyboard corner and check the resulting ratio. A separate locked 16:9 caller rotates and saves; its encoded output must remain 16:9.
