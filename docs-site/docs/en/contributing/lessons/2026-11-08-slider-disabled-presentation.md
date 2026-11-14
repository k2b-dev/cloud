### A disabled slider must mute its fill as well as its thumb

- **What happened:** A disabled slider still displayed a blue fill and dark label, suggesting that it was available.
- **Root cause:** The public Slider computed the same accent gradient for enabled and disabled inputs; only the thumb and opacity changed.
- **Error class:** A disabled control retains the visual signals of an available action.
- **Guard:** Slider render tests cover both value placements and centered and ordinary tracks. Browser tests check the muted fill, label and changed output in light and dark, unchanged geometry, and restoration when enabled again.
