### Invisible inspection paths must keep their pointer targets

- **What happened:** Radar keyboard inspection worked, but hovering or tapping an axis stalled after merging the bars styles.
- **Root cause:** The shared category-band rule sets `stroke: none`. Radar's transparent stroke was also its pointer target; the default painted hit testing let the series polygon intercept those events.
- **Error class:** Pointer hit testing coupled to a helper shape's paint.
- **Guard:** Radar axis paths explicitly use `pointer-events="stroke"`. The browser guard checks the computed pointer policy and exercises real hover and tap at desktop and phone widths, alongside keyboard and selected-outline assertions.
